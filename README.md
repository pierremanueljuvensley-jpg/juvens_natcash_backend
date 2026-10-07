# JuvensTopUp NatCash Backend v3

Backend Node.js (Express, CommonJS) qui reçoit les SMS NatCash transférés par une application Android **SMS Forwarder**, retrouve le `wallet_topup` correspondant dans Supabase et crédite automatiquement le portefeuille du client.

Ce backend fait **uniquement** : NatCash → SMS → Supabase `wallet_topups` → crédit du wallet.

## Architecture

```
CLIENT → JuvensTopUp frontend → wallet_topup PENDING (Supabase)
Client paie via NatCash → SMS reçu sur le téléphone Android
→ SMS Forwarder → HTTPS POST /sms → ce backend
→ analyse du SMS → recherche du wallet_topup → validations
→ RPC Supabase credit_wallet_topup → wallet crédité, wallet_topup = paid
```

Supabase est la **seule source de vérité**. Aucune base locale, aucun fichier de stockage.

## Installation et démarrage local

Prérequis : Node.js 18+.

```bash
npm install
cp .env.example .env      # puis remplir les vraies valeurs (ne jamais commiter .env)
# Charger les variables puis démarrer :
node --env-file=.env server.js     # Node 20.6+
# ou : export $(grep -v '^#' .env | xargs) && npm start
```

`npm run dev` lance le serveur avec rechargement automatique (`node --watch`).

## Variables d'environnement (Render)

| Variable | Obligatoire | Description |
|---|---|---|
| `PORT` | non (3000) | Port d'écoute (Render le définit automatiquement) |
| `SUPABASE_URL` | oui | `https://wcgywmsbketjwfipcygj.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | oui | Clé service role, **côté serveur uniquement** |
| `SMS_FORWARDER_SECRET` | oui | Long secret aléatoire partagé avec SMS Forwarder |
| `NATCASH_WINDOW_MINUTES` | non (120) | Fenêtre de recherche des topups pending |

Variables optionnelles : `CUSTOMER_PHONE_COLUMN` (nom de la colonne téléphone de `customers`, défaut `phone`) et `CORS_ORIGINS` (liste d'origines autorisées séparées par des virgules ; vide par défaut = CORS fermé).

Le serveur refuse de démarrer si une variable obligatoire manque. Aucun secret par défaut n'existe dans le code.

Générer un secret : `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

## Endpoints

### `GET /health`
Sans authentification.
```json
{ "ok": true, "service": "juvens-natcash-backend", "version": "3.0.0" }
```

### `POST /sms`
Header obligatoire : `x-sms-forwarder-secret: <SMS_FORWARDER_SECRET>`

Corps JSON (le texte du SMS peut être dans `message`, `sms`, `body`, `text` ou `content`) :
```json
{ "message": "Ou resevwa 500 HTG de 509 3700 0000. Transaction ID: ABC123456", "from": "NatCash" }
```
Champs optionnels : `from`, `sender`, `number`. Un corps `text/plain` est aussi accepté (le corps entier est le SMS).

Succès (HTTP 200) :
```json
{ "ok": true, "status": "credited", "topup_id": "...", "amount": 500, "provider_reference": "ABC123456" }
```

| HTTP | `error` | Cas |
|---|---|---|
| 401 | `unauthorized` | Secret absent ou incorrect |
| 400 | `missing_message` | Aucun texte de SMS |
| 422 | `amount_not_found` | Montant introuvable |
| 422 | `transaction_reference_not_found` | Référence introuvable |
| 404 | `no_matching_pending_topup` | Aucun topup pending correspondant |
| 409 | `transaction_already_processed` | Référence déjà utilisée |
| 409 | `ambiguous_topup` | Plusieurs topups possibles, aucun crédit |
| 500 | `internal_error` | Erreur serveur (détails dans les logs uniquement) |

Si la RPC signale une opération idempotente déjà payée, la réponse est `200` avec `status: "already_credited"` (aucun double crédit).

## Logique de traitement

1. Authentification du secret (comparaison en temps constant, `crypto.timingSafeEqual`), **avant** de lire le corps.
2. Extraction du montant (HTG, G, gourdes ; les montants de solde/frais sont ignorés), de la référence (transaction / code / ref / transcode, normalisée en majuscules) et du numéro du sender si présent.
3. Anti-doublon : si `provider_reference` existe déjà pour `provider = natcash` → 409.
4. Recherche des `wallet_topups` : `provider = natcash`, `status = pending`, `currency = HTG`, **montant exact**, `created_at` dans la fenêtre `NATCASH_WINDOW_MINUTES`.
5. Plusieurs candidats : le numéro du sender (comparaison normalisée sur les 8 derniers chiffres) sert à départager. S'il ne permet pas d'en isoler exactement un → `ambiguous_topup`, **aucun crédit**. Le numéro ne suffit jamais seul.
6. Crédit via `POST /rest/v1/rpc/credit_wallet_topup`.

## Rôle de `credit_wallet_topup`

Fonction PostgreSQL existante (`SECURITY DEFINER`, réservée au `service_role`). Elle verrouille le topup et le customer, vérifie le statut `pending` et que le customer est actif, incrémente `wallet_balance`, crée la transaction `credit`, passe le topup à `paid` et enregistre `provider_reference`, `raw_response` et `paid_at`, de façon atomique et idempotente. Le backend **ne modifie jamais** `wallet_balance` directement.

## Configuration SMS Forwarder

- URL : `https://<votre-service>.onrender.com/sms`
- Méthode : `POST`
- Header : `x-sms-forwarder-secret: <votre secret>`
- Content-Type : `application/json`
- Corps :
```json
{ "from": "%from%", "message": "%body%" }
```
(les noms des variables `%from%` / `%body%` dépendent de l'application utilisée ; adaptez-les à sa documentation). Filtrez pour ne transférer que les SMS NatCash.

## Sécurité

- Aucun secret dans le code ; tout vient de `process.env`.
- La clé service role n'est utilisée que côté serveur et n'est jamais loguée ni renvoyée.
- Limite de corps : 256 kb. CORS fermé par défaut (webhook serveur-à-serveur).
- Aucune stack trace envoyée au client.
- Ne jamais commiter `.env`.

## Déploiement Render

1. Pousser ce dossier sur GitHub.
2. Render → New → **Web Service** → choisir le dépôt.
3. Runtime : Node. **Build Command** : `npm install`. **Start Command** : `npm start`.
4. Ajouter les variables d'environnement ci-dessus.
5. Vérifier `GET https://<service>.onrender.com/health`.

Note : sur l'offre gratuite, Render met le service en veille ; le premier SMS peut être retardé. Pour un webhook de paiement, préférez une offre qui ne s'endort pas.
