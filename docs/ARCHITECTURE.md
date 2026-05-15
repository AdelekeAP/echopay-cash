# EchoPay Cash — architecture

This document is the technical narrative for judges and reviewers. It maps
the components, the data flows, and the boundaries that hold the system
together. The exhaustive spec — endpoint shapes, table columns, hour-by-hour
plan — lives in [`EchoPay_Cash_PRD.md`](../EchoPay_Cash_PRD.md).

## System diagram

```
                ┌─────────────────────────────┐
                │   mobile/  (Expo SDK 54)    │
                │   • Voice signup            │
                │   • Send / receive screens  │
                │   • Wallet, QR, scan        │
                │   • Offline cache + outbox  │
                └─────────────┬───────────────┘
                              │ HTTPS / WSS (none yet)
                              ▼
                ┌─────────────────────────────┐
                │   backend/  (FastAPI :8100) │
                │   • Squad client + webhooks │
                │   • Ledger (SQLite, WAL)    │
                │   • Permits (M2)            │
                │   • Admin / reconcile       │
                └──────┬─────────────────┬────┘
                       │                 │
              HTTPS    │                 │  HTTPS
                       ▼                 ▼
       ┌──────────────────────┐  ┌──────────────────────────┐
       │  Squad sandbox       │  │  voice services (:8000)  │
       │  • Static VA         │  │  • Whisper STT           │
       │  • Dynamic VA        │  │  • Intent extraction     │
       │  • Transfer          │  │  • ECAPA-TDNN biometric  │
       │  • Requery, webhooks │  │  (external HTTP dep)     │
       └──────────────────────┘  └──────────────────────────┘
```

## Why these boundaries

### The voice services are external HTTP, not committed here

Our prior work — EchoPay v1 voice banking — already ships a hardened voice
stack: Whisper for Nigerian financial vocabulary, an intent layer
(Gemini/GPT-4 + LLaMA fine-tune), and ECAPA-TDNN voice biometric. That
service is mature. It would be wasteful to fork and dilute it here, and it
would mislead judges into thinking we built voice from scratch in 30
hours.

The boundary is HTTP. The echopay-cash backend on `:8100` calls the voice
service on `:8000` with raw audio bytes, gets back a transcript + intent +
biometric verdict, and proceeds. The voice service has no idea EchoPay
Cash exists. If we replace it tomorrow with a different STT provider, only
`backend/app/api/voice_proxy.py` changes.

### Squad through one client

All Squad calls go through `backend/app/squad/client.py`. The sandbox base
URL is pinned (`https://sandbox-api-d.squadco.com`). Webhook signature
validation is centralized in `backend/app/squad/webhook.py`. No screen, no
hook, no other service reaches Squad directly. When we move from sandbox
to production, exactly one constant changes.

### SQLite for the hackathon ledger

The PRD §5 schema fits in a single SQLite file with WAL mode. We're not
running Postgres for a 30-hour build that will serve ≤10 users on stage.
The atomic transactions we need (wallet update + tx insert + webhook event)
all fit inside `BEGIN IMMEDIATE`. The reconciliation invariant is computed
with two `SUM()`s. Postgres earns its place when there are concurrent
writers from multiple processes — not at hackathon scale.

## Data flow: voice signup → Squad Static VA

```
phone: record name in Yoruba
  │
  ▼  POST /auth/voice-signup { audio_b64, phone }
backend
  │── voice (:8000) → /api/transcribe   →  "I am Mama Risikat"
  │── voice (:8000) → /api/intent       →  { name: "Mama Risikat" }
  │── Squad         → POST /virtual-account
  │                     { customer_identifier, first_name, last_name,
  │                       mobile_num, email, bvn, dob, address, gender }
  │                  ←  { va_number: "1234567890", customer_id: ... }
  │── SQLite:  INSERT users, INSERT wallets (balance_kobo = 0)
  ▼
phone: "Welcome. Your GTBank account: 1234567890."
```

Voice biometric enrollment happens in a separate beat using the same
endpoint pattern — `voice (:8000) /api/biometric/enroll` returns a 256-dim
embedding that the backend stores in `users.voice_embedding`.

## Data flow: voice transfer → Squad Transfer

```
phone: "Send ₦5,000 to Iya Tope."
  │
  ▼  POST /voice/intent { audio_b64 }
backend → voice (:8000) → intent { action: transfer, amount_kobo: 500000, recipient: "Iya Tope" }
  ▼
phone: voice biometric check (separate ECAPA call)
  ▼  POST /transfer/voice-initiate { user_id, intent, biometric_verified: true }
backend
  │── Squad → POST /payout/account/lookup  (validates recipient name)
  │── Squad → POST /payout/transfer        (unique transaction_reference)
  │            ├─ 200 → mark completed
  │            ├─ 412 → reversed, credit back
  │            └─ 424 → poll /payout/requery every 5s up to 60s
  │── SQLite: BEGIN IMMEDIATE; UPDATE wallet; INSERT tx; COMMIT
  ▼
phone: "Sent ₦5,000 to Iya Tope. Reference ECHOPAYCASH_abc123."
```

The 424 path is the load-bearing detail: Squad acknowledges the request
but cannot confirm the outcome. Retrying the Transfer with the same ref
would deduplicate on Squad's side; the right move is to call `/requery`
until Squad reports terminal status.

## Data flow: QR receive → Dynamic VA → webhook

```
phone: "Generate ₦200 QR for okra."
  │
  ▼  POST /dynamic-va/create { user_id, amount_kobo: 20000, ttl_seconds: 300 }
backend → Squad → POST /virtual-account/initiate-dynamic-virtual-account
  │              ←  { dva_number: "98765...", ... }
  ▼
phone: renders QR (qrcode-svg) of the DVA payload
  ▼
customer (other phone): scans QR, pays via their bank
  │
  ▼  Squad webhook → POST /webhooks/squad   (HMAC-SHA512 V2)
backend
  │── verify signature (constant-time)
  │── check webhook_events.transaction_ref UNIQUE  → return 200 if seen
  │── classify event:
  │      SUCCESS  → BEGIN IMMEDIATE; credit wallet; insert tx; mark webhook; COMMIT
  │      MISMATCH → log only (Squad auto-refunds wrong amount)
  │      EXPIRED  → log only (Squad auto-refunds late payment)
  │── always return HTTP 200 — even on signature failure (log alert internally)
  ▼
phone (polling balance): sees credit appear
```

The webhook handler rules are non-negotiable: never `json.dumps(
json.loads(body))` before HMAC (signature breaks on key reordering), and
always return 200 (Squad retries on non-2xx and you lose idempotency).

## The closed-loop ledger invariant

Every user's balance is a row in `wallets`. The pooled float is one Squad
B2B Static VA. The reconciliation check, computed on every admin refresh
and on every webhook landing:

```
  sum(wallets.balance_kobo)
+ sum(permits.max_amount_kobo WHERE status='outstanding')   -- M2 only
= master_va_balance_kobo
```

If the delta is non-zero, something is wrong (failed webhook, half-applied
transfer, manual sandbox payout, double-spend). The admin dashboard at
`admin/index.html` polls `/admin/state` once per second and shows the
delta in red whenever it's non-zero.

This is the honesty beat in the demo: the judges see the invariant
holding live, and they see that we know what would make it not hold.

## Honest offline scope

EchoPay Cash's offline magic (M2 stretch) is **EchoPay-to-EchoPay only.**
We don't claim cross-bank offline because Nigerian interbank rails don't
support it (NIBSS is synchronous). The permit-based ledger works because
both sender and recipient are EchoPay users — the server can atomically
update both sides on reconnect.

For cross-bank flows, EchoPay falls back to the standard online Squad
Transfer the moment the network returns. The offline beat in the demo is
deliberately framed: airplane mode, EchoPay sender, EchoPay receiver.

The mobile boot path is also offline-tolerant — see PRD §15.4 — even in
the M1-only build. Cached balance + tx history + a "syncing…" badge keep
the UX from collapsing when the venue Wi-Fi flakes.

## Cross-reference

- API endpoint shapes, body fields, error codes: `EchoPay_Cash_PRD.md` §4, §6.
- Database schema, table-by-table: `EchoPay_Cash_PRD.md` §5.
- Mobile screen list, dependencies: `EchoPay_Cash_PRD.md` §7.
- Mobile-internal layer architecture: `mobile/docs/ARCHITECTURE.md`.
- Offline shell, threat model, key material policy: `EchoPay_Cash_PRD.md` §15.
- Hour-by-hour execution plan: `EchoPay_Cash_PRD.md` §8.
- What we're explicitly NOT building, and why: `EchoPay_Cash_PRD.md` §9.
