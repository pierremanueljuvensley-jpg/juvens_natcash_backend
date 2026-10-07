'use strict';

/**
 * JuvensTopUp NatCash Backend v3
 *
 * NatCash SMS (SMS Forwarder) -> parsing -> wallet_topups (Supabase)
 *   -> RPC credit_wallet_topup -> wallet credited.
 *
 * Supabase est la source de verite. Aucun stockage local.
 * Tous les secrets viennent de process.env (jamais en dur).
 */

const crypto = require('crypto');

const VERSION = '3.0.0';
const SERVICE = 'juvens-natcash-backend';
const SUPABASE_TIMEOUT_MS = 10000;
const PHONE_SUFFIX_LEN = 8; // 8 derniers chiffres (numero local haitien, sans +509)

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function loadConfig(env = process.env) {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SMS_FORWARDER_SECRET'].filter(
    (k) => !env[k] || !String(env[k]).trim()
  );
  if (missing.length) {
    throw new Error('Missing required environment variables: ' + missing.join(', '));
  }

  const windowMinutes = env.NATCASH_WINDOW_MINUTES ? Number(env.NATCASH_WINDOW_MINUTES) : 120;
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    throw new Error('NATCASH_WINDOW_MINUTES must be a positive number');
  }

  const phoneColumn = (env.CUSTOMER_PHONE_COLUMN || 'phone').trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(phoneColumn)) {
    throw new Error('CUSTOMER_PHONE_COLUMN is invalid');
  }

  return {
    port: Number(env.PORT) || 3000,
    supabaseUrl: String(env.SUPABASE_URL).trim().replace(/\/+$/, ''),
    serviceRoleKey: String(env.SUPABASE_SERVICE_ROLE_KEY).trim(),
    forwarderSecret: String(env.SMS_FORWARDER_SECRET),
    windowMinutes,
    phoneColumn,
    corsOrigins: (env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/* ------------------------------------------------------------------ */
/* Logs (jamais de secret, jamais de stack envoyee au client)          */
/* ------------------------------------------------------------------ */

function log(level, event, data) {
  const line = { t: new Date().toISOString(), level, event, ...(data || {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

/* ------------------------------------------------------------------ */
/* Securite : comparaison du secret en temps constant                  */
/* ------------------------------------------------------------------ */

function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || provided.length === 0) {
    return false;
  }
  // Hash des deux valeurs -> longueurs identiques, requis par timingSafeEqual.
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ */
/* Parsing du SMS NatCash                                              */
/* ------------------------------------------------------------------ */

const CURRENCY = '(?:HTG|GDES?|GOURDES?|G)';
const NUMBER =
  '(\\d{1,3}(?:[ .,\\u00a0]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
// Mots qui indiquent que le montant est un solde / des frais et non le montant recu.
const NON_PAYMENT_WORDS = /(balance|balans|solde|frais|fees?|fr[eè]|commission|komisyon)/i;

function parseNumber(raw) {
  let s = String(raw).replace(/[\s\u00a0]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma > -1 && lastDot > -1) {
    const decimalChar = lastComma > lastDot ? ',' : '.';
    const thousandsChar = decimalChar === ',' ? '.' : ',';
    s = s.split(thousandsChar).join('').replace(decimalChar, '.');
  } else if (lastComma > -1 || lastDot > -1) {
    const sep = lastComma > -1 ? ',' : '.';
    const parts = s.split(sep);
    if (parts.length > 2 || parts[1].length === 3) {
      s = parts.join(''); // separateur de milliers
    } else {
      s = parts[0] + '.' + parts[1]; // separateur decimal
    }
  }

  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function extractAmount(text) {
  const reAfter = new RegExp('(?<![\\d.,])' + NUMBER + '\\s*' + CURRENCY + '(?![A-Za-z])', 'gi');
  const reBefore = new RegExp('(?<![A-Za-z])' + CURRENCY + '\\s*[:.]?\\s*' + NUMBER + '(?![\\d])', 'gi');

  const found = [];
  for (const re of [reAfter, reBefore]) {
    for (const m of text.matchAll(re)) {
      found.push({ index: m.index, raw: m[1] });
    }
  }
  found.sort((a, b) => a.index - b.index);

  for (const c of found) {
    const segment = text.slice(0, c.index).split(/\.\s+|\n|;/).pop().slice(-25);
    if (NON_PAYMENT_WORDS.test(segment)) continue;
    const value = parseNumber(c.raw);
    if (value !== null) return value;
  }
  return null;
}

function extractReference(text) {
  const re = new RegExp(
    '(?<![A-Za-z])(?:(?:code|k[òo]d)\\s+(?:de\\s+)?(?:transaction|tranzaksyon)|' +
      '(?:transaction|tranzaksyon)\\s*(?:code|k[òo]d|id|no|number)?|trans\\s*id|trans\\s*code|transcode|txn\\s*id|' +
      'code|k[òo]d|r[eé]f[eé]rence|ref)\\s*(?:[:#=]|-|\\bis\\b|\\best\\b)?\\s*([A-Z0-9][A-Z0-9-]{5,31})',
    'gi'
  );
  for (const m of text.matchAll(re)) {
    const candidate = m[1].replace(/-+$/, '');
    // Une vraie reference contient au moins un chiffre (evite "reussie", "confirmed"...).
    if (candidate.length >= 6 && /\d/.test(candidate)) {
      return candidate.trim().toUpperCase();
    }
  }
  return null;
}

function digitsOnly(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

function extractSenderNumber(text, payload) {
  const keyword = text.match(
    /(?:\bde\b|\bfrom\b|\bdepuis\b|\bdu\s+num[eé]ro\b|\bnimewo\b|\bnum[eé]ro\b|\bnumber\b|\bpar\b)\s*:?\s*(\+?\d[\d\s\-().]{6,18}\d)/i
  );
  if (keyword) {
    const d = digitsOnly(keyword[1]);
    if (d.length >= PHONE_SUFFIX_LEN) return d;
  }
  const intl = text.match(/\+?509[\s\-.]?(\d{4})[\s\-.]?(\d{4})/);
  if (intl) return '509' + intl[1] + intl[2];

  // Champs envoyes par SMS Forwarder (souvent "NATCASH" = pas un numero -> ignore).
  for (const key of ['from', 'sender', 'number']) {
    const d = digitsOnly(payload && payload[key]);
    if (d.length >= PHONE_SUFFIX_LEN) return d;
  }
  return null;
}

function parseNatcashSms(text, payload) {
  return {
    amount: extractAmount(text),
    reference: extractReference(text),
    sender: extractSenderNumber(text, payload || {}),
  };
}

function samePhone(a, b) {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (da.length < PHONE_SUFFIX_LEN || db.length < PHONE_SUFFIX_LEN) return false;
  return da.slice(-PHONE_SUFFIX_LEN) === db.slice(-PHONE_SUFFIX_LEN);
}

function extractMessage(body) {
  if (typeof body === 'string') return body.trim();
  if (!body || typeof body !== 'object') return '';
  for (const key of ['message', 'sms', 'body', 'text', 'content']) {
    if (typeof body[key] === 'string' && body[key].trim()) return body[key].trim();
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* Client Supabase REST (service role, cote serveur uniquement)        */
/* ------------------------------------------------------------------ */

class SupabaseError extends Error {
  constructor(status, body) {
    super('Supabase request failed with status ' + status);
    this.status = status;
    this.body = body;
  }
}

function createSupabase(config) {
  async function request(method, path, { query, body } = {}) {
    const url = new URL(config.supabaseUrl + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: 'Bearer ' + config.serviceRoleKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (_) {
          data = text;
        }
      }
      if (!res.ok) throw new SupabaseError(res.status, data);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    // Reference NatCash deja utilisee ?
    async findTopupByReference(reference) {
      const rows = await request('GET', '/rest/v1/wallet_topups', {
        query: {
          select: 'id,status',
          provider: 'eq.natcash',
          provider_reference: 'eq.' + reference,
          limit: '1',
        },
      });
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    },

    // wallet_topups natcash / pending / HTG / montant exact / dans la fenetre.
    async findPendingTopups(amount, sinceIso) {
      const rows = await request('GET', '/rest/v1/wallet_topups', {
        query: {
          select: 'id,customer_id,amount,created_at',
          provider: 'eq.natcash',
          status: 'eq.pending',
          currency: 'eq.HTG',
          amount: 'eq.' + amount.toFixed(2),
          created_at: 'gte.' + sinceIso,
          order: 'created_at.asc',
          limit: '50',
        },
      });
      return Array.isArray(rows) ? rows : [];
    },

    // Telephones des clients candidats (lecture seule). Retourne Map(id -> phone).
    async findCustomerPhones(customerIds) {
      const map = new Map();
      if (!customerIds.length) return map;
      const rows = await request('GET', '/rest/v1/customers', {
        query: {
          select: 'id,' + config.phoneColumn,
          id: 'in.(' + customerIds.join(',') + ')',
        },
      });
      for (const r of Array.isArray(rows) ? rows : []) {
        map.set(r.id, r[config.phoneColumn] || null);
      }
      return map;
    },

    // Credit atomique et idempotent cote PostgreSQL (jamais d'UPDATE direct de wallet_balance).
    async creditWalletTopup(topupId, reference, rawResponse) {
      return request('POST', '/rest/v1/rpc/credit_wallet_topup', {
        body: {
          p_topup_id: topupId,
          p_provider_reference: reference,
          p_raw_response: rawResponse,
        },
      });
    },
  };
}

function isAlreadyPaidResult(result) {
  const r = Array.isArray(result) ? result[0] : result;
  if (!r || typeof r !== 'object') return false;
  return (
    r.idempotent === true ||
    r.already_paid === true ||
    r.already_processed === true ||
    r.already === true ||
    r.status === 'already_paid' ||
    r.status === 'already_credited'
  );
}

/* ------------------------------------------------------------------ */
/* Handler principal : traitement d'un SMS                             */
/* ------------------------------------------------------------------ */

function reply(res, status, payload) {
  return res.status(status).json(payload);
}

function createSmsHandler(config, supabase) {
  return async function smsHandler(req, res) {
    try {
      const message = extractMessage(req.body);
      if (!message) return reply(res, 400, { ok: false, error: 'missing_message' });

      const { amount, reference, sender } = parseNatcashSms(message, req.body);
      if (amount === null) return reply(res, 422, { ok: false, error: 'amount_not_found' });
      if (!reference) return reply(res, 422, { ok: false, error: 'transaction_reference_not_found' });

      // Anti-doublon : reference deja enregistree -> aucun nouveau credit.
      const existing = await supabase.findTopupByReference(reference);
      if (existing) {
        log('info', 'sms_duplicate_reference', { reference });
        return reply(res, 409, { ok: false, error: 'transaction_already_processed' });
      }

      // Candidats : natcash + pending + HTG + montant exact + fenetre temporelle.
      const sinceIso = new Date(Date.now() - config.windowMinutes * 60 * 1000).toISOString();
      let candidates = await supabase.findPendingTopups(amount, sinceIso);
      if (candidates.length === 0) {
        log('info', 'sms_no_match', { reference, amount });
        return reply(res, 404, { ok: false, error: 'no_matching_pending_topup' });
      }

      // Plusieurs candidats : le numero du sender sert a departager (jamais seul).
      if (candidates.length > 1) {
        if (!sender) {
          log('warn', 'sms_ambiguous_no_sender', { reference, amount, candidates: candidates.length });
          return reply(res, 409, { ok: false, error: 'ambiguous_topup' });
        }
        let phones;
        try {
          phones = await supabase.findCustomerPhones([...new Set(candidates.map((c) => c.customer_id))]);
        } catch (err) {
          log('warn', 'customer_phone_lookup_failed', { status: err.status });
          return reply(res, 409, { ok: false, error: 'ambiguous_topup' });
        }
        candidates = candidates.filter((c) => samePhone(sender, phones.get(c.customer_id)));
      }

      if (candidates.length !== 1) {
        log('warn', 'sms_ambiguous', { reference, amount, candidates: candidates.length });
        return reply(res, 409, { ok: false, error: 'ambiguous_topup' });
      }

      const topup = candidates[0];
      const rawResponse = {
        source: 'natcash_sms_forwarder',
        message: message.slice(0, 1000),
        sender: sender || null,
        amount,
      };

      let result;
      try {
        result = await supabase.creditWalletTopup(topup.id, reference, rawResponse);
      } catch (err) {
        // Violation d'unicite sur provider_reference -> transaction deja traitee.
        const code = err && err.body && err.body.code;
        if (err instanceof SupabaseError && (code === '23505' || err.status === 409)) {
          log('info', 'sms_duplicate_on_credit', { reference, topup_id: topup.id });
          return reply(res, 409, { ok: false, error: 'transaction_already_processed' });
        }
        throw err;
      }

      if (isAlreadyPaidResult(result)) {
        log('info', 'sms_already_credited', { reference, topup_id: topup.id });
        return reply(res, 200, {
          ok: true,
          status: 'already_credited',
          topup_id: topup.id,
          amount,
          provider_reference: reference,
        });
      }

      log('info', 'sms_credited', { reference, topup_id: topup.id, amount });
      return reply(res, 200, {
        ok: true,
        status: 'credited',
        topup_id: topup.id,
        amount,
        provider_reference: reference,
      });
    } catch (err) {
      // Details uniquement dans les logs serveur (aucun secret), jamais cote client.
      log('error', 'sms_internal_error', {
        name: err && err.name,
        message: err && err.message,
        supabase_status: err && err.status,
        supabase_body: err && err.body,
      });
      return reply(res, 500, { ok: false, error: 'internal_error' });
    }
  };
}

function createAuthMiddleware(config) {
  return function authMiddleware(req, res, next) {
    const provided = req.get('x-sms-forwarder-secret');
    if (!secretsMatch(provided, config.forwarderSecret)) {
      return reply(res, 401, { ok: false, error: 'unauthorized' });
    }
    return next();
  };
}

function healthHandler(req, res) {
  return reply(res, 200, { ok: true, service: SERVICE, version: VERSION });
}

/* ------------------------------------------------------------------ */
/* Application Express                                                 */
/* ------------------------------------------------------------------ */

function createApp(config, supabase = createSupabase(config)) {
  const express = require('express');
  const app = express();
  app.disable('x-powered-by');

  // CORS : ferme par defaut (webhook serveur-a-serveur). Liste blanche via CORS_ORIGINS.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && config.corsOrigins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type,x-sms-forwarder-secret');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  app.get('/health', healthHandler);

  // Auth AVANT le parsing du body : une requete non autorisee n'est jamais traitee.
  app.post(
    '/sms',
    createAuthMiddleware(config),
    express.json({ limit: '256kb' }),
    express.urlencoded({ extended: false, limit: '256kb' }),
    express.text({ type: 'text/plain', limit: '256kb' }),
    createSmsHandler(config, supabase)
  );

  app.use((req, res) => reply(res, 404, { ok: false, error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return reply(res, 413, { ok: false, error: 'payload_too_large' });
    }
    if (err && err.type === 'entity.parse.failed') {
      return reply(res, 400, { ok: false, error: 'invalid_json' });
    }
    log('error', 'unhandled_error', { name: err && err.name, message: err && err.message });
    return reply(res, 500, { ok: false, error: 'internal_error' });
  });

  return app;
}

/* ------------------------------------------------------------------ */
/* Demarrage                                                           */
/* ------------------------------------------------------------------ */

function start() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('[startup] ' + err.message);
    process.exit(1);
  }

  const app = createApp(config);
  const server = app.listen(config.port, () => {
    log('info', 'server_started', { service: SERVICE, version: VERSION, port: config.port });
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) start();

module.exports = {
  VERSION,
  loadConfig,
  secretsMatch,
  parseNumber,
  parseNatcashSms,
  extractMessage,
  samePhone,
  isAlreadyPaidResult,
  createSupabase,
  createSmsHandler,
  createAuthMiddleware,
  healthHandler,
  createApp,
};
