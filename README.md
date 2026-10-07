# JuvensTopUp NatCash Backend v3

Backend Node.js (Express) ki resevwa SMS NatCash ki soti nan aplikasyon Android SMS Forwarder, verifye peman an, jwenn `wallet_topup` ki koresponn nan Supabase, epi kredite wallet kliyan an otomatikman.

Backend sa a fè sèlman:

NatCash → SMS → Supabase `wallet_topups` → credit wallet

Supabase se sèl source of truth la.

Pa gen database lokal.
Pa gen `sms_store.json`.
Pa gen Firebase.
Pa gen supplier API nan backend sa a.

---

## 1. Architecture

```text
CLIENT
  ↓
JuvensTopUp Frontend
  ↓
wallet_topup = pending
  ↓
Client peye ak NatCash
  ↓
NatCash SMS rive sou telefòn Android
  ↓
SMS Forwarder
  ↓ HTTPS POST
JuvensTopUp NatCash Backend
  ↓
Parse SMS
  ↓
Verify amount + transaction reference
  ↓
Find pending wallet_topup
  ↓
Supabase RPC
  ↓
Wallet credited
  ↓
wallet_topup = paid
2. Stack
Node.js 18+
Express
Supabase PostgreSQL
Supabase RPC
SMS Forwarder Android
Render
3. Environment Variables
Backend lan bezwen variables sa yo:
PORT=3000
SUPABASE_URL=https://wcgywmsbketjwfipcygj.supabase.co
SUPABASE_SERVICE_ROLE_KEY=REPLACE_WITH_SUPABASE_SERVICE_ROLE_KEY
SMS_FORWARDER_SECRET=REPLACE_WITH_A_LONG_RANDOM_SECRET
NATCASH_WINDOW_MINUTES=120
Important
SUPABASE_SERVICE_ROLE_KEY ak SMS_FORWARDER_SECRET se secrets.
Pa mete yo nan frontend. Pa mete yo nan README ak valeur reyèl. Pa mete yo nan GitHub kòm valeur reyèl.
Nan Render, mete valeur reyèl yo nan Environment Variables.
4. Installation
Clone repository a:
git clone https://github.com/pierremanueljuvensley-jpg/juvens_natcash_backend.git
cd juvens_natcash_backend
Install dependencies:
npm install
Run:
npm start
Pou development:
npm run dev
5. Health Check
Backend lan gen endpoint:
GET /health
URL Render:
https://juvens-natcash-backend-qj2o.onrender.com/health
Li dwe retounen yon repons ki montre backend lan ap fonksyone.
6. SMS Endpoint
SMS Forwarder dwe voye SMS NatCash yo sou:
POST /sms
URL Render:
https://juvens-natcash-backend-qj2o.onrender.com/sms
Header obligatwa:
x-sms-forwarder-secret: YOUR_SMS_FORWARDER_SECRET
YOUR_SMS_FORWARDER_SECRET dwe menm valeur ak:
SMS_FORWARDER_SECRET
nan Render.
7. SMS Forwarder
Aplikasyon itilize:
SMS Forwarder — Kale-Studio
SMS Forwarder dwe:
resevwa SMS NatCash
fè yon HTTPS POST
voye request lan sou /sms
voye secret la nan header la
voye SMS la nan body request lan
Backend lan ka li mesaj la nan youn nan fields sa yo:
message
sms
body
text
content
Pou nimewo moun ki voye SMS la, backend lan ka li:
from
sender
number
Important
Non variables egzak SMS Forwarder itilize nan Body la depann de vèsyon aplikasyon an ak configuration li.
Se poutèt sa, pa mete yon placeholder tankou:
%from%
%body%
san verifye ke se egzak syntax aplikasyon an itilize.
Nou dwe itilize syntax/dynamic variables aplikasyon SMS Forwarder la sipòte aktyèlman.
8. NatCash Verification
Backend lan verifye:
SMS la gen yon montant.
Transaction reference la egziste.
Gen yon wallet_topup pending ki koresponn.
Montant lan egzak.
Transaction reference la poko itilize.
Si sender disponib, li verifye ak nimewo kliyan an.
Peman an fèt nan yon fenèt tan ki defini.
Default:
NATCASH_WINDOW_MINUTES=120
9. Supabase Wallet
Backend lan pa modifye wallet_balance dirèkteman.
Li itilize RPC Supabase:
credit_wallet_topup
RPC sa a fè credit wallet lan atomikman.
Li:
verifye wallet_topup
lock wallet topup la
lock customer la
ajoute lajan nan wallet
kreye transaction credit la
mete wallet_topup kòm paid
evite double credit
10. Idempotency
Si menm SMS / transaction reference lan rive plizyè fwa, backend lan pa dwe kredite wallet lan plizyè fwa.
Transaction reference la dwe inik.
Si peman an deja trete, backend lan retounen yon repons idempotent olye li fè yon lòt credit.
11. Security
Backend lan itilize:
Supabase Service Role Key sèlman sou server
SMS Forwarder secret
timing-safe secret comparison
Supabase RPC
RLS sou Supabase
validation sou amount
validation sou transaction reference
validation sou customer
duplicate protection
request size limit
CORS allowlist
Pa janm mete:
SUPABASE_SERVICE_ROLE_KEY
nan frontend.
Pa janm mete secret SMS Forwarder la nan frontend.
12. Render Deployment
Sou Render:
Build Command
npm install
Start Command
npm start
Environment Variables
Ajoute:
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SMS_FORWARDER_SECRET
NATCASH_WINDOW_MINUTES
Opsyonèl:
PORT
CUSTOMER_PHONE_COLUMN
CORS_ORIGINS
Pa mete secret values yo nan GitHub.
13. Production Flow
Client
  ↓
Recharger mon compte
  ↓
Create wallet_topup
  ↓
wallet_topup = pending
  ↓
Client peye NatCash
  ↓
NatCash SMS
  ↓
SMS Forwarder
  ↓
POST /sms
  ↓
NatCash Backend
  ↓
Verify payment
  ↓
Find pending wallet_topup
  ↓
credit_wallet_topup()
  ↓
wallet_balance + amount
  ↓
wallet_topup = paid
Apre sa kliyan an ka itilize balance li pou achte pwodwi sou JuvensTopUp.
14. Important: Manual Top-Up
Backend NatCash sa a pa fè recharge Free Fire otomatik.
Pou kounye a:
Client
  ↓
Wallet recharge
  ↓
Wallet credited
  ↓
Client buys product
  ↓
Wallet debited
  ↓
Order = pending
  ↓
Admin Dashboard
  ↓
Admin recharge Free Fire manually
  ↓
Admin marks order as delivered
Supplier API automation ap vini pita si sa nesesè.
15. Repository
GitHub:
https://github.com/pierremanueljuvensley-jpg/juvens_natcash_backend
Backend:
juvens-natcash-backend
Version:
3.0.0
16. Important Security Rules
Pa janm commit:
.env
SUPABASE_SERVICE_ROLE_KEY
SMS_FORWARDER_SECRET
README.md dwe sèlman genyen instructions ak placeholders.
Secrets reyèl yo dwe rete nan Render Environment Variables.
17. Current Status
Backend NatCash:
✅ Node.js / Express
✅ Supabase integration
✅ Wallet top-up verification
✅ NatCash SMS parsing
✅ Duplicate protection
✅ Atomic wallet credit
✅ Security checks
✅ Render ready
✅ Manual Free Fire delivery
Next step:
Deploy backend sou Render
        ↓
Test /health
        ↓
Configure SMS Forwarder
        ↓
Test NatCash payment
