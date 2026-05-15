# EchoPay Cash — Implementation PRD

**Status:** Locked, time-boxed
**Authored:** Fri May 15, 2026 (Event Day 1)
**Demo:** Sat May 16, 2026 (Event Day 2)
**Hours available:** ~30
**Sources:** `EchoPay_Cash_Team_Master_Doc.md.pdf`, `Squad_API_Summary_v2.pptx`, `echopaygtb` branch audit

---

## 0. Bottom line

The 7-day master plan locked Sun May 10 has not landed in the repo. No Squad code, no permits, no QR, no offline mechanic exist on any branch. What exists: a working voice stack (`backend/`), a working mobile shell with auth + voice biometrics + transfer flow (`demo-bank/echopay/mobile/EchoPayApp/`), and a Django demo-bank that can play the "external bank" role.

This PRD cuts the master doc's three pillars to **two pillars guaranteed to ship + one as stretch**:

- **M1 (must-ship by Sat 06:00):** Voice + Squad live integration + reconciliation dashboard. Defensible demo even if M2 is dropped.
- **M2 (stretch, only if M1 is green by Fri 22:00):** Permit-based offline ledger, QR offline tx, double-spend detection.

If neither lands, fallback is **PaperProof** (master doc §8 decision tree): pitch the architecture with the recorded Mile 12 interviews and walk through diagrams.

---

## 1. Demo target — the 5-minute live demo

Two demo scripts. Pick at Sat 04:00 based on what's actually working.

### Script A — M1-only (online demo)

| Time | Action | Proves |
|---|---|---|
| 0:00 | Kosi opens with Mama Risikat narrative + Mile 12 quote | Real user grounding |
| 0:30 | Recorded clip: Mama signs up in Yoruba. App shows "Welcome. Your GTBank account: 1234567890." | Voice signup + Static VA creation |
| 1:15 | Live: Mama says "Send ₦5,000 to Iya Tope." Voice biometric. Squad Transfer fires. Iya Tope's phone (Django demo-bank) buzzes. | Voice + outbound Squad Transfer |
| 2:00 | Live: Mama says "Generate ₦200 QR for okra." Dynamic VA QR appears. Kosi scans on second phone, pays. Webhook fires on admin dashboard. | Dynamic VA + inbound webhook |
| 3:00 | Live: hit "Reconcile" on admin dashboard. Shows `sum(wallets) == master_VA_balance` with delta = 0. | Architecture honesty |
| 4:00 | Kosi closes with recorded Yoruba clip "I have never had a bank account. This one is mine." | Emotional close |

### Script B — M1 + M2 (full master-doc demo, only if stretch lands)

Identical to master doc §6 — adds airplane-mode segment and double-spend rejection between 2:45 and 4:00.

**Recorded backup:** mandatory, taped Fri evening, switch within 10 seconds if live fails. Brief allows recorded.

---

## 2. What's already built — do not rebuild

| Asset | Path | State | Used for |
|---|---|---|---|
| Whisper / Gemini / GPT-4 / intent / contextual LLM | `backend/app/services/` | Working on :8000 | Voice transcription + intent extraction |
| ECAPA-TDNN voice biometric | `backend/app/services/voice_biometrics_service.py` | Working | Step-up auth on transfers |
| Security middleware (sanitizer, prompt-injection, rate-limit) | `backend/app/services/security/` | Working | Wrap any new free-text endpoint |
| Mobile auth (login, register, AuthContext) | `demo-bank/echopay/mobile/EchoPayApp/app/` | Working | Reuse as-is |
| Mobile transfer flow (recipient → amount → confirm → PIN/voice/face) | `demo-bank/echopay/mobile/EchoPayApp/app/transfer.tsx` | Working | Rewire `services/api.ts` to new backend |
| Voice components (VoiceModal, VoiceVerificationModal, VoiceEnrollment, EchoOrb, Waveform, FloatingMicButton) | `demo-bank/echopay/mobile/EchoPayApp/components/` | Working | Reuse |
| Django demo-bank | `demo-bank/echopay/backend/` | Working on :8001 | Play "external bank" — receives Iya Tope's inbound from Squad Transfer |

**Hard rule:** do not modify files under `backend/app/services/` or `demo-bank/echopay/backend/`. Touch them and the demo breaks.

---

## 3. What ships — files and endpoints

New directory: `echopay-cash/` at repo root.

```
echopay-cash/
├── backend/                        # FastAPI on :8100 — new
│   ├── app/
│   │   ├── main.py
│   │   ├── core/
│   │   │   ├── config.py           # Pydantic settings (Squad keys, HMAC key, base URLs)
│   │   │   ├── db.py               # SQLite via SQLAlchemy, WAL mode
│   │   │   └── security.py         # HMAC-SHA512 V2 validation
│   │   ├── models.py               # all tables in one file (speed)
│   │   ├── squad/
│   │   │   ├── client.py           # httpx async wrapper, Bearer auth
│   │   │   ├── static_va.py        # POST /virtual-account
│   │   │   ├── dynamic_va.py       # create + initiate
│   │   │   ├── transfer.py         # lookup → transfer → requery on 424
│   │   │   └── webhook.py          # signature verification
│   │   ├── api/
│   │   │   ├── auth.py             # /auth/voice-signup
│   │   │   ├── voice_proxy.py      # /voice/intent, /voice/biometric/verify
│   │   │   ├── transfer.py         # /transfer/voice-initiate
│   │   │   ├── dva.py              # /dynamic-va/create
│   │   │   ├── webhooks.py         # POST /webhooks/squad
│   │   │   ├── admin.py            # GET /admin/state, POST /admin/reconcile
│   │   │   ├── permits.py          # M2: POST /permits/issue
│   │   │   └── sync.py             # M2: POST /sync/submit
│   │   └── crypto/
│   │       └── ed25519.py          # M2: pynacl
│   ├── pyproject.toml
│   ├── .env.example
│   └── seed.py                     # creates 3 personas: Mama Risikat, Iya Tope, Kosi
├── mobile/                         # forked from demo-bank/echopay/mobile/EchoPayApp
│   └── ...                         # adds: receive, scan, pending-sync screens
├── admin/                          # static HTML + JS, no build step
│   ├── index.html
│   └── app.js                      # 1s polling on /admin/state, big numbers
└── spike/                          # delete after Fri 19:00
    └── squad_roundtrip.py          # one file, end-to-end sandbox proof
```

---

## 4. Squad integration — exact API surface

All amounts in **kobo** (₦1 = 100 kobo). Currency code `NGN`. Auth `Authorization: Bearer <SQUAD_SECRET_KEY>`.

### 4.1 Sandbox base URL
`https://sandbox-api-d.squadco.com`

### 4.2 Endpoints used in M1

| Op | Method | Endpoint | When |
|---|---|---|---|
| Create B2C Static VA | POST | `/virtual-account` | One-time, on voice signup. Fields: `customer_identifier`, `first_name`, `last_name`, `mobile_num`, `email`, `bvn`, `dob`, `address`, `gender`. |
| Account lookup | POST | `/payout/account/lookup` | Before every Transfer. Fields: `bank_code`, `account_number`. Validates recipient name. |
| Transfer | POST | `/payout/transfer` | After lookup. Fields: `transaction_reference` (unique, format `ECHOPAYCASH_<uuid>`), `amount` (kobo as string), `bank_code`, `account_number`, `account_name`, `currency_id: "NGN"`, `remark`. |
| Requery | POST | `/payout/requery` | **Mandatory on 424 from Transfer.** Same `transaction_reference`. |
| Create DVA pool | POST | `/virtual-account/create-dynamic-virtual-account` | One-time on backend boot, size 50. |
| Initiate DVA | POST | `/virtual-account/initiate-dynamic-virtual-account` | Per receive-QR. Fields: `amount` (kobo), `duration` (seconds, e.g. 300), `merchant_business_name`. |
| Sandbox payment simulate | POST | `/virtual-account/simulate/payment` | For Kosi's "scan and pay" beat in the demo — simulates the inbound. |

### 4.3 Webhooks

**Static VA webhook:** HMAC-SHA512 V2. Hash the 6 pipe-separated fields:
```
HMAC-SHA512(secret_key, f"{transaction_ref}|{virtual_account_number}|{principal_amount}|{settled_amount}|{transaction_currency}|{customer_id}")
```
Compare to header signature in constant time. If mismatch → log + return 200 (do not 4xx — Squad retries on non-200 and you lose idempotency tracking). If match → proceed.

**Dynamic VA webhook:** SHA-512 in `x-squad-encrypted-body` header. Three event types:
- `SUCCESS` — exact amount in time → credit wallet, mark tx settled
- `MISMATCH` — wrong amount → Squad auto-refunds, log only
- `EXPIRED` — late → Squad auto-refunds, log only

**Webhook handler rules (non-negotiable):**
1. Read raw request body bytes — never `json.dumps(json.loads(body))` before HMAC.
2. Check `webhook_events.transaction_ref` UNIQUE — if exists, return 200 immediately (idempotency).
3. Wrap wallet update + tx insert + webhook_event insert in one SQLite `BEGIN IMMEDIATE` transaction.
4. Always return HTTP 200, even on signature failure (log + alert internally).

### 4.4 Transfer error handling

| Status | Action |
|---|---|
| 200 | Mark tx `completed`. |
| 400 | Bad params — fail tx, surface to user. |
| 412 | Reversed by Squad — credit wallet back, mark `reversed`. |
| **424** | **Outcome unknown.** Do NOT retry the Transfer with same ref. Call `/payout/requery`. Repeat poll every 5s up to 60s. |

### 4.5 Master Static VA

One Squad B2B Static VA = the pooled float. All user funds settle there. Each user's "balance" is a row in our `wallets` table.

**Reconciliation invariant:** `sum(wallets.balance_kobo) + sum(permits.max_amount_kobo WHERE status='outstanding') == master_va_balance_kobo`.

---

## 5. Data model — SQLite, single file `echopay-cash/backend/echopay.db`

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  customer_identifier TEXT UNIQUE NOT NULL,   -- our ID we send to Squad
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  bvn TEXT NOT NULL,                          -- sandbox test BVN
  dob TEXT NOT NULL,
  address TEXT NOT NULL,
  voice_embedding BLOB,                       -- ECAPA 256-dim vector
  created_at INTEGER NOT NULL
);

CREATE TABLE wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  squad_va_number TEXT UNIQUE NOT NULL,
  balance_kobo INTEGER NOT NULL DEFAULT 0,
  locked_kobo INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,                        -- our UUID
  user_id INTEGER NOT NULL,
  counterparty_user_id INTEGER,
  counterparty_account TEXT,
  counterparty_bank_code TEXT,
  type TEXT NOT NULL,                          -- 'topup' | 'in_network' | 'external_out' | 'qr_receive' | 'offline'
  direction TEXT NOT NULL,                     -- 'in' | 'out'
  amount_kobo INTEGER NOT NULL,
  status TEXT NOT NULL,                        -- 'pending' | 'completed' | 'reversed' | 'failed'
  squad_ref TEXT,                              -- transaction_reference we sent
  idempotency_key TEXT UNIQUE NOT NULL,
  permit_id TEXT,                              -- M2
  signature_bundle BLOB,                       -- M2
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);

CREATE TABLE webhook_events (
  transaction_ref TEXT PRIMARY KEY,            -- Squad's ref, idempotency lock
  source TEXT NOT NULL,                        -- 'static_va' | 'dynamic_va' | 'transfer'
  raw_payload TEXT NOT NULL,
  signature_valid INTEGER NOT NULL,
  processed_at INTEGER NOT NULL
);

-- M2 only
CREATE TABLE permits (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device_fingerprint TEXT NOT NULL,
  max_amount_kobo INTEGER NOT NULL,
  amount_spent_kobo INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                        -- 'outstanding' | 'redeemed' | 'expired'
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  server_sig BLOB NOT NULL,
  redeemed_by_tx_id TEXT,
  redeemed_at INTEGER
);

CREATE TABLE nonces (
  sender_user_id INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (sender_user_id, nonce)
);
```

---

## 6. Backend endpoints (FastAPI on :8100)

### Auth + voice
- `POST /auth/voice-signup` — body: `{audio_b64, phone}`. Calls existing `:8000` Whisper to extract name. Creates user with hardcoded sandbox BVN per persona. Calls Squad `/virtual-account`. Returns `{user_id, va_number, balance_kobo}`.
- `POST /voice/intent` — body: `{audio_b64}`. Proxies to `:8000/api/intent`.
- `POST /voice/biometric/verify` — body: `{audio_b64, user_id}`. Proxies to `:8000/api/biometric/verify`.

### Money movement
- `POST /transfer/voice-initiate` — body: `{user_id, intent: {action, amount_kobo, recipient_name|recipient_account|recipient_bank_code}, biometric_verified: bool}`. Lookup → Transfer → requery poll. Returns `{tx_id, status}`.
- `POST /dynamic-va/create` — body: `{user_id, amount_kobo, ttl_seconds}`. Returns `{dva_number, qr_payload}` where `qr_payload` is a string the receive screen renders as a QR.

### Squad ingress
- `POST /webhooks/squad` — universal entrypoint. Dispatches by `event_type` or path-suffix. HMAC-SHA512 V2.

### Admin
- `GET /admin/state` — returns `{wallets: [...], recent_transactions: [...], recent_webhooks: [...], reconciliation: {squad_balance_kobo, sum_wallets_kobo, sum_outstanding_permits_kobo, delta_kobo}}`.
- `POST /admin/reconcile` — actively queries Squad master VA balance, recomputes, returns.

### M2 (skip until M1 green)
- `POST /permits/issue` — issues a permit (cap, ttl, ed25519 server-sig).
- `POST /sync/submit` — atomic permit redemption + ledger update + nonce check.

---

## 7. Mobile screens (`echopay-cash/mobile/`)

Fork strategy: copy entire `demo-bank/echopay/mobile/EchoPayApp/` directory. Change `services/api.ts` `getApiUrl()` to point at the new backend on `:8100`. Then add/modify:

### Dependencies to install

```
npx expo install expo-camera expo-sqlite
npm i react-native-qrcode-svg react-native-svg
# M2 only:
npm i tweetnacl tweetnacl-util react-native-get-random-values
```

### Screens

| Screen | Path | State |
|---|---|---|
| Voice signup | NEW `app/voice-signup.tsx` | Records name (uses `useVoiceRecording`), posts to `/auth/voice-signup`, displays "Welcome. Your GTBank account: <va_number>". |
| Home | MODIFY `app/(tabs)/index.tsx` | Show balance, VA number, "Send" + "Receive" buttons. |
| Send | MODIFY `app/transfer.tsx` | Existing flow, point at `/transfer/voice-initiate`. |
| Receive | NEW `app/(tabs)/receive.tsx` | "Generate QR" voice command → calls `/dynamic-va/create` → renders QR (qrcode-svg) of the DVA payload. |
| Scan (M2 only) | NEW `app/scan.tsx` | `expo-camera` → reads QR → confirms → fires offline-pay flow. |
| Pending sync (M2 only) | NEW `app/pending.tsx` | Lists `pending_outgoing` + `pending_incoming` rows from local SQLite. |

---

## 8. Hour-by-hour execution plan

Times are in WAT (UTC+1) starting from now. Adjust if start time differs.

### Friday May 15 evening

| Time | Owner | Task | Done = |
|---|---|---|---|
| 18:00–19:00 | Funbi | Run Squad sandbox spike: create Static VA → cloudflared tunnel → simulate payment → receive validated webhook → fire Transfer → poll requery → see success. **Single Python file in `echopay-cash/spike/squad_roundtrip.py`.** | Two screenshots in group chat |
| 19:00–19:15 | All | 6pm-equivalent sync. Decision: Squad green? If yes, commit M1. If no, fall back to PaperProof. | Lock |
| 19:15–22:00 | Funbi | New backend scaffold. Tables. Squad client. `/auth/voice-signup`. `/webhooks/squad` with HMAC. `seed.py` creating 3 personas + 3 Static VAs in sandbox. | `curl localhost:8100/admin/state` returns 3 wallets |
| 19:15–22:00 | Leke | Mobile fork. Install deps. Rewire `services/api.ts`. Build `app/voice-signup.tsx` and `app/(tabs)/receive.tsx`. Run on real device. | Voice signup works E2E against new backend |
| 19:15–22:00 | Kosi | Pitch deck v1 finalized. Practice opening. Mile 12 audio clips edited. | Slides 1–10 locked |
| 22:00–22:15 | All | Checkpoint. Voice signup + receive QR live? | Go/no-go on stretch |

### Friday night / Saturday morning

| Time | Owner | Task |
|---|---|---|
| 22:00–00:00 | Funbi | `/transfer/voice-initiate` end-to-end. Idempotency. Reconciliation logic. |
| 22:00–00:00 | Leke | Send flow wired to `/transfer/voice-initiate`. Receive flow showing real DVA QR. Polish UI. |
| 00:00–02:00 | Funbi | Admin dashboard (`echopay-cash/admin/index.html` + 1s polling on `/admin/state`). Big numbers, color rows. |
| 00:00–02:00 | Leke | Stage-light test of QR on real devices. Lock error correction level. |
| 02:00–04:00 | All | First clean recorded demo run (Script A). Bug fix. Second recording. |
| **04:00–08:00** | **All** | **MANDATORY SLEEP. 4 hours. Non-negotiable.** |
| 08:00–10:00 | Funbi | M2 attempt: ed25519 wrappers (pynacl + tweetnacl), `/permits/issue`, `/sync/submit` with atomic UPDATE pattern. **Only if M1 demo is clean.** |
| 08:00–10:00 | Leke | M2 attempt: scan screen, local SQLite queue, sync trigger. |
| 08:00–10:00 | Kosi | Rehearsals 2–4. Q&A drilling against §10 master doc table. |
| 10:00–11:00 | All | M2 integration. If at 11:00 not working, **drop M2, go with Script A.** No exceptions. |
| 11:00–12:00 | All | Final rehearsal. Hostile-judge dry run. Batteries to 100%. Tunnel pre-warmed. |
| Demo time | All | Present. |

---

## 9. Scope discipline — what we are NOT building

Same as master doc §9, plus three new cuts:

- ❌ Postgres → SQLite. Saves 2 hours of infra.
- ❌ Pidgin Whisper fine-tune → off-the-shelf Whisper. The Sunday gate already implied this fallback.
- ❌ LLaMA-fine-tuned intent → reuse existing Gemini/GPT-4 intent in `backend/app/services/`.
- ❌ Real KYC. Hardcode 3 sandbox personas in `seed.py`.
- ❌ Hausa, Igbo. Yoruba + Pidgin only.
- ❌ Bluetooth / NFC. QR only.
- ❌ Multi-hop offline. v1 only.
- ❌ Beautiful onboarding flow. Functional only.
- ❌ Cross-bank offline. Architecturally impossible (master doc §4.3).
- ❌ Production fraud ML. Permit cap + rate limiting only.
- ❌ EchoPay v1.0 features (transactions tab, profile, etc) — they exist, we don't break them, but they're not part of the demo path.

---

## 10. Q&A coverage map (unchanged from master doc §10)

Every team member speaks. Owners locked.

| Question | Owner | Answer (verbatim from master doc unless cut requires update) |
|---|---|---|
| What did you specifically train and what's the accuracy? | Funbi | "Three models: Whisper for Pidgin financial vocabulary, LLaMA-fine-tuned intent at F1 ≥ 0.92, ECAPA-TDNN voice biometric at EER ≤ 6% disaggregated by gender and age." **If Pidgin Whisper fine-tune was cut, switch to:** "Two trained models in this build — LLaMA-fine-tuned intent and ECAPA voice biometric. Pidgin Whisper fine-tune is in-progress, used off-shelf Whisper for the demo cycle." |
| How does offline payment work without network? | Leke | "Server issues a 12-hour spending permit when user is online. Permit caps amount they can spend offline. QR exchange between two EchoPay users carries cryptographically signed transactions. Server detects double-spend by tracking permit redemption state. Loss is bounded by permit cap." **If M2 cut:** "Architecture is designed and specified — in this build we ship the online ledger and reconciliation; offline mechanic is the next sprint, not magic, not vapor." |
| What about paying from a GTBank user offline? | Leke | Verbatim master doc — "We don't claim cross-bank-offline because Nigerian interbank rails don't support it. NIBSS is synchronous..." |
| How is this different from ALAT SAW? | Kosi | Verbatim master doc. |
| Why is Squad load-bearing vs Paystack? | Leke | Verbatim master doc. |
| What did real market women say? | Kosi | Three quotes from Mile 12 interviews. At least one in Yoruba with translation. |
| How does this scale to 10,000 users? | Funbi/Leke | Verbatim master doc. |
| Bias / fairness on voice biometric? | Funbi | Verbatim master doc. |

---

## 11. Risks and triggers

| # | Risk | Likelihood | Impact | Trigger | Action |
|---|---|---|---|---|---|
| 1 | Squad sandbox keys not in hand | Unknown | Catastrophic | 18:00 today | **Confirm keys exist NOW. If not, account creation is step 0. Sandbox approval can take 1–3 days — if no keys by 20:00, fall back to PaperProof.** |
| 2 | BVN validation strict in sandbox | M | H | First Static VA call fails | Use B2B Static VA + sub-ledger labeled per persona. Hardcoded in `seed.py`. |
| 3 | Webhook tunnel flaps | M | H | Webhook not received within 30s of payment | Pre-warm cloudflared, backup tunnel ready, `/admin/webhook-status` shows last-received time on dashboard. |
| 4 | QR scan glitches under stage lights | M | M | Demo prep tests | Error correction level Q, high contrast, test on both phones Fri evening. |
| 5 | Voice biometric false reject on stage | M | M | Stage stress | Lower threshold to 0.65 in demo branch. Pre-record fallback. |
| 6 | ed25519 lib interop (M2) | M | H | Tuesday-style spike fails | Skip M2 entirely. Don't fight crypto at 09:00 Sat. |
| 7 | Network at venue dies | M | L | If M2 ships, this is the perfect moment. If M2 cut, problem | Mobile hotspot tethered + backup hotspot. |
| 8 | Team member sick | L | H | — | Cross-training already done. Funbi can deliver tech beats. |
| 9 | Sleep deprivation → bugs at 03:00 | H | H | If anyone is still coding past 04:00 | **04:00 sleep rule is enforced. No commits between 04:00–08:00.** |

---

## 12. Three honest disclaimers (master doc §14, unchanged)

1. We are NOT competing with ALAT SAW on its own terms.
2. The offline magic is bounded. EchoPay-to-EchoPay only.
3. EchoPay v1 (voice overlay on bank apps) is a separate business.

If any teammate softens any of these on stage, Q&A is lost.

---

## 13. Right-now actions (next 60 minutes)

1. **Funbi: confirm Squad sandbox keys are in hand.** If yes, start `echopay-cash/spike/squad_roundtrip.py`. If no, escalate immediately.
2. **Leke: install cloudflared, set up `cash.<your-domain>.cloudflared.run` tunnel, send public URL to group.** Start mobile fork in parallel.
3. **Kosi: confirm 3 Mile 12 interviews have audio clips ready. If pending, surface now.**
4. **All: 19:15 sync. 5 minutes. Squad gate decision.**

---

## 14. Decision tree

```
20:00 — Squad spike status?
  ├── GREEN → continue M1 build
  ├── RED on BVN only → switch to B2B Static VA, continue M1
  └── RED on auth/tunnel → PaperProof fallback (no live demo, just architecture pitch + recordings)

22:00 — Voice signup + receive QR end-to-end?
  ├── GREEN → continue M1 + open M2 window
  └── RED → all hands on M1, skip M2

04:00 — One clean recorded demo (Script A)?
  ├── GREEN → sleep, M2 stretch in morning if time
  └── RED → continue M1 fixes, no sleep penalty <30 min, then sleep

11:00 — M2 working?
  ├── GREEN → present Script B
  └── RED → present Script A, mention offline as roadmap
```

---

## 15. Offline-first app shell + security model

The master doc treats "offline" as a property of a transaction. That isn't enough. **The app itself must boot, unlock, and run offline.** Otherwise the airplane-mode demo collapses on the first server call (auth, balance fetch, banks list). This section defines how.

### 15.1 Hard requirements

1. App launches from a cold start with no network. No spinner-of-death, no blank screen, no retry loop.
2. User unlocks with PIN (or biometric) **without contacting the server**.
3. Home screen shows last-known balance, last 10 transactions, and outstanding permits — all from local storage.
4. User can initiate a permit-backed QR payment with no network. Tx is signed locally and queued.
5. On reconnect, queued writes drain to the server in order. UI shows "Syncing… Settled" within a second.
6. Server is the source of truth on settlement; the local balance is a UI hint with a "as of <timestamp>" indicator.

### 15.2 Threat model (what we defend, what we don't)

| Threat | Defended? | How |
|---|---|---|
| Lost/stolen phone, attacker doesn't know PIN | Yes | Private key in OS keystore, requires PIN to unlock app DB; 5 failed PINs → wipe local key material |
| Attacker copies SQLite file off device | Partial | Sensitive fields (private key, server-issued permits) live in OS keystore, not SQLite. SQLite cache (balance, tx history) is plaintext — not a secret, server is authoritative |
| Replay of a captured offline QR | Yes | `(sender_id, nonce)` UNIQUE on server. Second redemption fails atomic UPDATE. |
| Double-spend by sender (same permit, two recipients) | Yes | Atomic conditional UPDATE on permit redemption (see PRD §4 in original architecture plan). Second sync gets `permit_already_redeemed` and sender is flagged. |
| Tampering with local balance to forge richer history | No-op | Local balance is UI only. Server reconciles on every sync. Tampering loses on next online check. |
| Rooted / jailbroken device | NOT defended | Documented out-of-scope for v1. Hackathon brief doesn't require this; production would add SafetyNet/DeviceCheck. |
| Compromised server | Out of scope | Server pubkey pinned in client; client refuses permits signed with wrong key. Beyond that, trust assumed. |
| Network MITM | Yes for transport | TLS pinning to Squad domains + our backend domain. Independent of offline-first — already needed. |

### 15.3 Key material — what lives where

| Item | Location | Reason |
|---|---|---|
| Device ed25519 private key | `expo-secure-store` (iOS Keychain / Android Keystore) | OS-backed, hardware-bound where available |
| Server ed25519 public key | Bundled in app JS, pinned | Used to verify permit signatures |
| User PIN hash | `expo-secure-store` as Argon2id hash | Never stored plaintext, never sent server-side |
| Session token (server-issued JWT, long TTL) | `expo-secure-store` | Proves identity on reconnect; refreshes silently when online |
| Voice biometric embedding (256-dim ECAPA) | Server-side only | Privacy: never leaves device until signup, never re-uploaded |
| Cached balance, tx history, permit cache | `expo-sqlite` (plaintext) | Not a secret. Encrypting buys ~nothing because the keystore-held private key is the real asset. Skip the SQLCipher complexity for v1. |
| Pending sync queue | `expo-sqlite` | Same reasoning; signatures inside the rows make the contents non-forgeable |

**No SQLCipher in v1.** Reasoning: the only secret worth protecting at rest is the ed25519 private key, which goes to the OS keystore. Encrypting the cache adds ~6 hours of work for zero meaningful threat reduction — an attacker who can read the unencrypted SQLite can also extract the SQLCipher key from app memory. Document and move on.

### 15.4 Boot sequence (offline-tolerant)

```
1. App launches
2. Check expo-secure-store for session_token
   ├── Missing → show signup/login (requires network)
   └── Present → continue
3. Open SQLite cache, read last-known user profile + balance
4. Show home screen IMMEDIATELY with "Offline" badge if no network
   (NetInfo.fetch().isConnected → updates badge)
5. In background: if online, refresh balance + tx history. On 401, attempt token refresh.
6. NEVER block UI on a network call during boot.
```

Compare to the existing app at `demo-bank/echopay/mobile/EchoPayApp/`: its boot path calls `bankAPI.getBanks()` and `accountAPI.getProfile()` synchronously on home-screen mount. Those calls must be made non-blocking, with cached fallback. **This is a required edit, not optional.**

### 15.5 Unlock flow (offline-tolerant)

Current `transfer.tsx` only does PIN at confirm time. Offline-first needs PIN at app-open time too.

```
On app foreground (cold start or background >30s):
  1. Show PIN screen (or biometric if enabled + available)
  2. Verify PIN against local Argon2id hash in expo-secure-store
  3. On success: load encrypted private key handle from secure-store, hold in memory for the session
  4. On 5 consecutive PIN failures: wipe secure-store (private key + token + PIN hash). User must re-signup.
```

PIN hash never leaves the device. PIN setup happens at signup (master doc voice signup flow + a PIN setup step).

### 15.6 Voice features when offline

**Honest answer:** voice signup, intent extraction (Gemini/GPT-4), and Whisper transcription all require server. They are degraded in airplane mode for v1.

For the demo: the airplane-mode beat does NOT use voice. The user has already issued a permit (Mama before going offline). The offline transaction is initiated by **tapping** the receive QR — not by saying "send ₦200." This is honest scope.

On reconnect, voice features come back automatically.

Optional stretch (if M2 lands with hours to spare): bundle a small whitelist of on-device commands ("send", "generate QR", "balance") classified by a 50-line regex/keyword matcher running over @react-native-voice transcription. Not real STT — just a Yoruba/Pidgin keyword spotter. Calls this "limited offline voice."

### 15.7 Sync queue — concrete schema

```sql
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op_type TEXT NOT NULL,                    -- 'submit_offline_tx' | 'redeem_permit' | etc
  payload TEXT NOT NULL,                    -- JSON body for POST
  idempotency_key TEXT UNIQUE NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  next_retry_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'    -- 'queued' | 'sent' | 'acked' | 'rejected'
);
```

Drain logic:
- `NetInfo` reachable event fires → sync service starts.
- Read up to 20 `queued` rows ordered by `id` ASC.
- POST each with its `idempotency_key` as HTTP header.
- On 200: mark `acked`. On 4xx: mark `rejected` (do NOT retry). On 5xx or network error: increment `attempts`, set `next_retry_at = now + min(60s, 2^attempts)`.
- After 10 failed attempts: stop, surface to user.

### 15.8 Cached data freshness UX

Home screen shows:
- Balance: `₦X,XXX` with subtitle `As of 14:23 — offline` (red if >5 min stale) or `Live` (green dot, last fetched <30s ago).
- Pending: `2 payments waiting to sync` if outbox has rows.
- Big call-to-action: "Pay offline" (always available) and "Top up" (online only — greyed out offline).

This is the only UI change that judges visibly notice: **the app does not break when network breaks.** That single behavior, demoed by toggling airplane mode mid-session, is the moat.

### 15.9 Implementation work added by this section

| Task | Owner | Hours |
|---|---|---|
| Install `expo-secure-store`, generate keypair at signup, store handles | Leke | 1 |
| Move balance + tx fetch in `(tabs)/index.tsx` to non-blocking with cached fallback | Leke | 1.5 |
| Add `local_cache` SQLite tables (profile, balance, tx_history, outbox) | Leke | 1 |
| PIN-unlock screen on cold start, Argon2id, 5-strike wipe | Leke | 2 |
| `useNetInfo` hook + offline badge on home, "as of <ts>" subtitle | Leke | 0.5 |
| Outbox drain service (background hook on network reconnect) | Leke | 1.5 |
| Update boot path to never block on network | Leke | 0.5 |

**Total: ~8 hours of mobile work added.** This is non-negotiable for the airplane-mode beat. It does not depend on M2 — even M1 (online demo) benefits from a faster boot and a balance that survives the projector wifi flaking.

### 15.10 Slot in the hour-by-hour plan

Compress §8's mobile work by reusing existing transfer flow (already PIN-gated). The 8 hours fit into:

- Fri 19:15–22:00: 3 hours of §16 (secure-store, PIN unlock, cached fallback) overlap with QR receive work.
- Fri 22:00–00:00: 3 hours (outbox + NetInfo + boot path).
- Sat 00:00–02:00: 2 hours (offline badge + stale indicator + polish).

If hours run short, **drop in this order**:
1. Argon2id → PBKDF2-SHA256 (10x faster to wire, still acceptable for hackathon).
2. 5-strike wipe → just rate-limit PIN attempts.
3. Outbox retry backoff → fixed 5s retries.
4. Drop biometric unlock, PIN only.

What you do NOT drop:
- Non-blocking boot.
- Cached balance display.
- Private key in secure-store.
- PIN gate at app-open.

### 15.11 What we tell judges in Q&A

**Q: "If the user's phone is stolen, what stops the thief from spending the permit?"**
A: "PIN at app-open. The private key is in the OS keystore, requires the user's PIN to release. After 5 wrong PINs the key is wiped and the device's outstanding permits are voided server-side at next reconcile."

**Q: "If the device is rooted, isn't the key extractable?"**
A: "Production deployment would use SafetyNet/DeviceCheck attestation to refuse permit issuance to rooted devices. v1 doesn't ship attestation — we treat the device as trusted. The defensive boundary in v1 is the permit cap and the 12-hour expiry: the maximum loss from a rooted device is the cap, and after 12 hours the permit expires regardless of what the device does."

**Q: "How do you stop someone forging the balance on their phone?"**
A: "They can. The local balance is a UI cache, not a claim. Settlement is the master VA balance on Squad's side. Reconciliation runs every hour and on every sync; tampering loses on first contact with the server."

**Q: "How does PIN entropy hold against brute force?"**
A: "PIN is 6 digits, Argon2id hashed locally with a per-device salt. 5-strike lockout wipes the key. With the wipe rule, online brute-force needs to also defeat the keystore — Apple Secure Enclave / Android StrongBox where present. We accept the same trust model OPay and PalmPay accept; we're not stronger than the OS keystore."

---

## 16. Done definition

- Recorded demo in `echopay-cash/recordings/demo_v1.mp4`, ≤5 minutes, audio mixed.
- Repo cleans to clone-to-run in <10 min on a fresh laptop with Expo Go.
- One-pager finalized.
- Q&A coverage map memorized by each owner.
- All three batteries at 100% at demo start.

Let's ship.
