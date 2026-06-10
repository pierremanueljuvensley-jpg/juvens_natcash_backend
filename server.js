// ╔══════════════════════════════════════════════════════════════════════╗
// ║        JUVENS TOP UP — NatCash Backend                               ║
// ║        Deploye sou Render.com (gratis)                               ║
// ╚══════════════════════════════════════════════════════════════════════╝

const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Konfigirasyon ────────────────────────────────────────────────────────────
const API_KEY  = process.env.API_KEY  || "juvens-2026";   // sekrè pou frontend
const SMS_FILE = path.join(__dirname, "sms_store.json");   // pèsistans sou disk

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Chaje SMS soti nan disk ──────────────────────────────────────────────────
let smsStore = [];
function loadSMS() {
  try {
    if (fs.existsSync(SMS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SMS_FILE, "utf8"));
      smsStore = Array.isArray(raw) ? raw : [];
      console.log(`📂 ${smsStore.length} SMS chaje depi disk`);
    }
  } catch (e) {
    console.error("Erè chajman SMS:", e.message);
    smsStore = [];
  }
}
function saveSMS() {
  try {
    fs.writeFileSync(SMS_FILE, JSON.stringify(smsStore.slice(0, 1000), null, 2));
  } catch (e) {
    console.error("Erè sove SMS:", e.message);
  }
}
loadSMS();

// ── Parser SMS NatCash ───────────────────────────────────────────────────────
// FIX: Sipòte tou de fòma — Kreyòl ak Fransè
//
// Fòma Kreyòl:  "Ou resevwa 500 HTG nan Unknow 56173183 nan 18:06 09/06/2026,
//                kontni: 500. Balans ou: 500.6 HTG. Transcode: 26060953549510."
//
// Fòma Fransè:  "Vous avez reçu 500.00 HTG de 55XXXXXXX. Ref:26XXXXXXXXXXXX"
//
function parseSMS(text) {
  if (!text || typeof text !== "string") return null;

  const t = text.trim();

  // ── 1. Montan ──────────────────────────────────────────────────────────────
  // Chèche: "500 HTG" / "500.00 HTG" / "Montant:500" / "reçu 500" / "resevwa 500"
  const amtMatch =
    t.match(/(\d+(?:[.,]\d+)?)\s*HTG/i) ||
    t.match(/[Mm]ontant[:\s]+(\d+(?:[.,]\d+)?)/i) ||
    t.match(/re[cç]u\s+(\d+(?:[.,]\d+)?)/i) ||
    t.match(/resevwa\s+(\d+(?:[.,]\d+)?)/i) ||
    t.match(/kontni[:\s]+(\d+(?:[.,]\d+)?)/i);

  const amount = amtMatch ? parseFloat(amtMatch[1].replace(",", ".")) : 0;

  // ── 2. Kòd referans (Transcode / Ref) ─────────────────────────────────────
  // Chèche: "Transcode: 26060953549510" / "Ref:26XXXX" / "Refi:NC26XXX"
  const refMatch =
    t.match(/[Tt]ranscode[:\s]+([A-Z0-9]{8,20})/i) ||
    t.match(/[Rr]ef[i]?[:\s]+([A-Z0-9]{8,20})/i) ||
    t.match(/(26\d{10,14})/);

  let refCode = refMatch ? refMatch[1].trim().toUpperCase() : null;

  // Retire prefiks "NC" si prezan (NC26...) → konpare fasil
  if (refCode && refCode.startsWith("NC")) refCode = refCode.slice(2);

  // ── 3. Nimewo ekspedyè ─────────────────────────────────────────────────────
  // Chèche: "nan Unknow 56173183" / "de 55XXXXXXX" / "De:55XXXXXXX"
  const sndMatch =
    t.match(/[Uu]nknow\s+([\d]{7,12})/i) ||
    t.match(/nan\s+(?:Unknow\s+)?([\d]{7,12})/i) ||
    t.match(/[Dd]e[:\s]+([\d\s\+]{8,15})/i) ||
    t.match(/[Ss]ender[:\s]+([\d\s\+]{8,15})/i);

  const sender = sndMatch
    ? sndMatch[1].replace(/\s/g, "").replace(/^509/, "")
    : "";

  // Si pa gen kòd referans → pa yon SMS NatCash valab
  if (!refCode) return null;

  return {
    refCode,
    amount,
    sender,
    raw: t.substring(0, 200),
  };
}

// ── Normalise kòd anvan konpare ───────────────────────────────────────────────
function normalizeCode(code) {
  return (code || "")
    .toString()
    .trim()
    .toUpperCase()
    .replace(/^NC/, "")
    .replace(/\s/g, "");
}

// ── Middleware verifye API key ────────────────────────────────────────────────
function auth(req, res, next) {
  const k = req.headers["x-api-key"] || req.query.apikey;
  if (k !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════

// ── GET / — Health check ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status   : "✅ OK",
    service  : "Juvens Top Up — NatCash Backend",
    smsCount : smsStore.length,
    uptime   : Math.floor(process.uptime()) + "s",
    version  : "2.0.0",
  });
});

// ── POST /sms — SMS Forwarder webhook (app Android) ──────────────────────────
// App Android voye yon POST chak fwa SMS NatCash rive
// Body: { message: "...", from: "..." }
app.post("/sms", (req, res) => {
  try {
    const body    = req.body;
    const smsText = body.message || body.sms || body.body || body.text || body.content || "";
    const from    = body.from    || body.sender || body.number || "";

    console.log("📩 SMS resevwa:", smsText.substring(0, 100));

    if (!smsText) {
      return res.status(400).json({ success: false, error: "Kò mesaj vide" });
    }

    const parsed = parseSMS(smsText);

    if (parsed && parsed.refCode) {
      const normRef = normalizeCode(parsed.refCode);
      const exists  = smsStore.find(s => normalizeCode(s.refCode) === normRef);

      if (!exists) {
        const entry = {
          refCode    : normRef,
          amount     : parsed.amount,
          sender     : parsed.sender || from,
          smsPreview : parsed.raw,
          receivedAt : new Date().toISOString(),
          used       : false,
        };
        smsStore.unshift(entry);
        saveSMS();
        console.log(`✅ NatCash ref ${normRef} — ${parsed.amount} HTG sòti ${entry.sender}`);
        return res.json({ success: true, refCode: normRef, amount: parsed.amount });
      } else {
        console.log(`⚠️  Duplikat ${normRef} — inyore`);
        return res.json({ success: true, duplicate: true });
      }
    }

    // SMS pa NatCash oswa pa gen Transcode — inyore silansyezman
    console.log("ℹ️  SMS pa NatCash:", smsText.substring(0, 60));
    return res.json({ success: true, parsed: false });

  } catch (err) {
    console.error("Erè /sms:", err.message);
    return res.status(500).json({ success: false, error: "Erè entèn" });
  }
});

// ── GET /verify-natcash?code=XXXXX — Verifye TransCode (frontend) ────────────
app.get("/verify-natcash", auth, (req, res) => {
  try {
    const rawCode = normalizeCode(req.query.code);
    if (!rawCode) return res.json({ found: false, error: "Kòd vide" });

    // Chèche korespondans egzak
    let match = smsStore.find(s => !s.used && normalizeCode(s.refCode) === rawCode);

    // Si pa jwenn — eseye pasyèl (dènye 8 karaktè)
    if (!match && rawCode.length >= 8) {
      const tail = rawCode.slice(-8);
      match = smsStore.find(s => !s.used && normalizeCode(s.refCode).endsWith(tail));
    }

    if (match) {
      console.log(`🔍 Verifye ${rawCode} → jwenn ${match.amount} HTG`);
      return res.json({
        found      : true,
        amount     : match.amount,
        sender     : match.sender,
        smsPreview : match.smsPreview || `Ref:${match.refCode} Montant:${match.amount} HTG`,
        refCode    : match.refCode,
        receivedAt : match.receivedAt,
      });
    }

    console.log(`❌ Kòd ${rawCode} — pa jwenn`);
    return res.json({ found: false, error: "TransCode pa jwenn. Reesye nan 2 minit." });

  } catch (err) {
    console.error("Erè /verify-natcash:", err.message);
    return res.status(500).json({ found: false, error: "Erè entèn" });
  }
});

// ── POST /mark-used — Mak kòd kòm itilize apre depo ─────────────────────────
app.post("/mark-used", auth, (req, res) => {
  try {
    const rawCode = normalizeCode(req.body.code);
    if (!rawCode) return res.status(400).json({ success: false, error: "Kòd obligatwa" });

    const entry = smsStore.find(
      s => normalizeCode(s.refCode) === rawCode ||
           normalizeCode(s.refCode).endsWith(rawCode.slice(-8))
    );

    if (entry) {
      entry.used   = true;
      entry.usedAt = new Date().toISOString();
      saveSMS();
      console.log(`✅ Kòd ${rawCode} mak kòm itilize`);
      return res.json({ success: true });
    }

    return res.json({ success: false, error: "Pa jwenn" });

  } catch (err) {
    console.error("Erè /mark-used:", err.message);
    return res.status(500).json({ success: false, error: "Erè entèn" });
  }
});

// ── GET /admin/sms — Wè tout SMS (debug admin) ───────────────────────────────
app.get("/admin/sms", auth, (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const unused = req.query.unused === "true";
    const list   = unused ? smsStore.filter(s => !s.used) : smsStore;
    return res.json({
      total   : smsStore.length,
      showing : list.slice(0, limit).length,
      sms     : list.slice(0, limit),
    });
  } catch (err) {
    return res.status(500).json({ error: "Erè entèn" });
  }
});

// ── POST /admin/add-sms — Ajoute SMS manyèlman (fallback admin) ──────────────
app.post("/admin/add-sms", auth, (req, res) => {
  try {
    const { refCode, amount, sender } = req.body;
    if (!refCode) return res.status(400).json({ error: "refCode obligatwa" });

    const code = normalizeCode(refCode);
    if (smsStore.find(s => normalizeCode(s.refCode) === code)) {
      return res.json({ success: false, error: "Duplikat" });
    }

    smsStore.unshift({
      refCode    : code,
      amount     : parseFloat(amount) || 0,
      sender     : sender || "Admin",
      smsPreview : `Manuel: Ref:${code} ${amount} HTG`,
      receivedAt : new Date().toISOString(),
      used       : false,
    });
    saveSMS();
    return res.json({ success: true });

  } catch (err) {
    return res.status(500).json({ error: "Erè entèn" });
  }
});

// ── DELETE /admin/clear-used — Efase kòd itilize ─────────────────────────────
app.delete("/admin/clear-used", auth, (req, res) => {
  try {
    const before = smsStore.length;
    smsStore = smsStore.filter(s => !s.used);
    saveSMS();
    return res.json({ success: true, removed: before - smsStore.length });
  } catch (err) {
    return res.status(500).json({ error: "Erè entèn" });
  }
});

// ── Jere wout ki pa egziste ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Wout sa a pa egziste" });
});

// ── Jere erè jeneral ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Erè jeneral:", err.message);
  res.status(500).json({ error: "Erè entèn sevè" });
});

// ════════════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🚀 Juvens NatCash Backend aktif → port ${PORT}`);
  console.log(`🔑 API Key: ${API_KEY}`);
  console.log(`📂 SMS Store: ${SMS_FILE}\n`);
});
