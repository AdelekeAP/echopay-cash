# PRD — Funbi · Local Transfer

**Owner:** Funbi
**Branch:** `feat/local-transfer`
**Anchors:** [`EchoPay_Cash_PRD.md`](../EchoPay_Cash_PRD.md) §4 (atomic ledger SQL), §5 (data model), §6 (backend endpoints), §7 (mobile screens).

You own the **entire local-transfer vertical** end to end: mobile UI + backend endpoint + atomic ledger move + cache writes + tests. Everything below is yours unless explicitly marked otherwise. The one shared touchpoint is a single line in `app/(tabs)/index.tsx` that Leke leaves as a slot for your pill.

---

## 1. What "local transfer" is

PRD §4 — "In-network transfer (both users online, no Squad call)". Two EchoPay-Cash users move money between their wallets via a single atomic ledger operation. **No Squad API call. No bank rail.** The Master VA on Squad doesn't move; only the per-user rows in `wallets` change. This is the fastest payment in the system and the cleanest demo moment after voice signup.

In the demo runbook (PRD §1 / master doc §6), this is the **2:00 beat**: "Mama Risikat: 'Send ₦200 to Iya Tope' → both phones update in under a second." Your code is what makes that beat happen.

---

## 2. State of the code today (what exists in your lane)

| File | Lines | State |
|---|---|---|
| `mobile/app/local-transfer.tsx` | — | **does not exist** — you create it |
| `mobile/components/local-transfer/Pill.tsx` | — | **does not exist** — you create it |
| `mobile/services/transfer.ts` | — | **does not exist** — you create it |
| `mobile/services/cache.ts` | 3 | stub: `export {};` |
| `mobile/hooks/useWallet.ts` | 3 | stub: `export {};` |
| `mobile/hooks/useTransactions.ts` | 3 | stub: `export {};` |
| `mobile/types/transaction.ts` | 3 | stub: `export {};` |
| `mobile/types/wallet.ts` | 2 | stub |
| `backend/` | — | **does not exist as a directory** — you bootstrap the FastAPI app or coordinate with Leke who is also creating backend files |
| `backend/app/api/transfer.py` | — | **does not exist** — you create it |
| `backend/tests/test_in_network_transfer.py` | — | **does not exist** — you create it |
| `constants/personas.ts` | 119 | done — three personas with full nested `Account` shapes |
| `constants/theme.ts` | 83 | done — `Echopay` palette |
| `services/mono.ts` | 262 | done — Mono NIN + BVN mocks (Leke uses these in signup; you don't touch) |

Reference screens already in the target palette: `app/login.tsx` (376 lines), `app/register.tsx` (618 lines). Copy their patterns.

---

## 3. The theme (the law)

Import `Echopay` from `constants/theme.ts`. Never inline a hex code.

| Token | Hex | Use |
|---|---|---|
| `pageBg` | `#FBF7F0` | warm beige page background |
| `cardBg` | `#FFFFFF` | elevated surface (cards, inputs) |
| `cardSoft` | `#F5EFE6` | recessed surface (input wells, footers) |
| `accent` | `#F97316` | primary orange (CTA, brand, focus) |
| `accentSoft` | `#FFEDD5` | tinted bg (badges) |
| `accentPressed` | `#C2410C` | pressed CTA |
| `accentMuted` | `#FBC192` | disabled CTA |
| `border` | `#ECE5D7` | hairline 1px borders |
| `text` / `textMuted` / `textSubtle` | `#1A1A1A` / `#6B6B6B` / `#9A9A9A` | text stack |
| `success` / `successSoft` | `#0E8C5A` / `#E2F4EC` | verified, settled |
| `danger` / `dangerSoft` | `#DC2626` / `#FEF2F2` | error states only |

Rules: no gradients, no drop shadows, one accent. Border radii: input 14, card 16–18, pill 999. Type weights: body 400, label 600, heading 700, brand 800.

---

## 4. Mobile work

### 4.1 `mobile/services/transfer.ts` (new)

The single API surface for in-network transfer. Mocked first, real second.

```ts
import { Echopay } from '../constants/theme';
import { Persona } from '../constants/personas';

export interface LocalTransferRequest {
  fromUserId: number;
  toPersonaId: string;          // matches Persona.id from constants/personas.ts
  amountKobo: number;            // PRD §5 — always integer kobo
  pin: string;                   // verified locally against PERSONAS[].pin
  idempotencyKey: string;        // sha256(fromUserId + toPersonaId + amountKobo + minute-bucket)
}

export interface LocalTransferResult {
  txId: string;
  status: 'completed';
  settledAt: string;             // ISO timestamp
  balanceAfterKobo: number;
}

export async function localTransfer(req: LocalTransferRequest): Promise<LocalTransferResult>;
```

**Mock implementation** (today, no backend yet):
1. Sleep 350–500ms.
2. Generate `txId = crypto.randomUUID()`.
3. Resolve `toPersona` from `constants/personas.ts`.
4. Write two transaction rows to `cache.ts` (one debit for sender, one credit for receiver) — but only the sender row is visible to the sender's history; the receiver row is for completeness if you later add multi-user views on the demo phone.
5. Update sender balance via `useWallet().applyDebit(amountKobo)`.
6. Return result.

**Real implementation** (drop-in swap, no signature change): POST to `${EXPO_PUBLIC_API_BASE_URL}/transfer/in-network` with `idempotencyKey` as a header. Match the backend §4.4 below.

### 4.2 `mobile/services/cache.ts` (fill)

```ts
import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';

// On web: AsyncStorage-backed fallback (no transactional semantics, but the
// home tab only reads from cache, so eventual consistency is fine).
// On phone: expo-sqlite with WAL mode, schema matches PRD §15.7.

export interface CachedTx {
  id: string;
  user_id: number;
  type: 'in_network' | 'external_out' | 'topup' | 'qr_receive';
  direction: 'in' | 'out';
  amount_kobo: number;
  counterparty: string;        // display name
  status: 'completed' | 'pending' | 'failed';
  created_at: string;          // ISO
}

export async function writeTransaction(tx: CachedTx): Promise<void>;
export async function getRecentTx(userId: number, limit?: number): Promise<CachedTx[]>;
export async function clearCache(): Promise<void>;
```

WAL mode on init (`PRAGMA journal_mode = WAL;`). `INSERT OR IGNORE` on the `id` column for idempotency.

### 4.3 `mobile/hooks/useWallet.ts` (fill)

```ts
import { useAuth } from '../context/AuthContext';

export function useWallet(): {
  balanceKobo: number;
  balanceNaira: string;        // "₦450,000.00" — formatted via utils/format.ts
  vaNumber: string;
  applyDebit: (kobo: number) => Promise<void>;
  applyCredit: (kobo: number) => Promise<void>;
};
```

`applyDebit` / `applyCredit`:
1. Update `AuthContext.account.balance` via `setSession()` (already exists in AuthContext — re-sets with the new balance preserved).
2. Persist to AsyncStorage (AuthContext already does this).
3. Optimistic update — UI reflects immediately, server reconciles later.

### 4.4 `mobile/types/transaction.ts` and `types/wallet.ts` (fill)

```ts
// types/transaction.ts
export interface TransactionRow {
  id: string;
  type: 'in_network' | 'external_out' | 'topup' | 'qr_receive';
  direction: 'in' | 'out';
  amount_kobo: number;
  counterparty: string;
  status: 'completed' | 'pending' | 'failed';
  created_at: string;
}

// types/wallet.ts
export interface Wallet {
  user_id: number;
  squad_va_number: string;
  balance_kobo: number;
  updated_at: string;
}
```

### 4.5 `mobile/app/local-transfer.tsx` (new)

Three-stage single-file screen. Each stage swaps the content; back arrow always visible.

#### Stage 1: `pick-recipient`

```
← Back

LOCAL TRANSFER
Send money instantly

[search box: "Phone or username"]

Suggested
┌─────────────────────────────┐
│ IT  Iya Tope                 │
│     Okra trader · Mile 12     │
└─────────────────────────────┘
┌─────────────────────────────┐
│ K   Kosi                      │
│     Customer · Lagos          │
└─────────────────────────────┘
```

Suggestion list = `PERSONAS` from `constants/personas.ts` filtered to exclude the current user. Tap a card → next stage.

#### Stage 2: `enter-amount`

```
← Back

To Iya Tope                       [small persona card with avatar+name]

Amount

┌──────────────────────────────┐
│           ₦ 5,000             │   big amount input
└──────────────────────────────┘

From your balance ₦450,000.00

⚡ Instant · No fees                [accentSoft pill badge]

[Continue]                          primary CTA
```

Validate: amount > 0, amount ≤ balance, amount is integer kobo (multiply by 100 on submit). Tap "Continue" → next stage.

#### Stage 3: `confirm-pin`

```
← Back

Sending ₦5,000 to Iya Tope         [readback]

Enter your PIN

[• • • •]                          PIN input, autofocus

[Confirm]                          primary CTA
```

On submit:
1. Verify PIN locally against the current user's `Persona.pin` (this is hackathon scope — real Argon2id hash check goes in `secure-store` post-T2).
2. Call `transfer.localTransfer({...})`.
3. On success: navigate to stage 4 success card.
4. On failure: red error inline, PIN cleared.

#### Stage 4: `success`

```
       ✓ (green check)

   Sent ₦5,000 to Iya Tope

   Settled in 0.4s
   TX abc123ef

  [Done]                           returns to home
```

Auto-return after 1.5s.

### 4.6 `mobile/components/local-transfer/Pill.tsx` (new)

```tsx
import { Pressable, Text, View } from 'react-native';
import { Echopay } from '../../constants/theme';

export function LocalTransferPill({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={...}>
      {/* orange icon circle on cardSoft, dark label below */}
      <Text>Local Transfer</Text>
    </Pressable>
  );
}
```

Match the visual weight of Leke's other quick-action pills (`Send` external, `Receive`). Orange accent dot or icon to set it apart as the "instant" action.

### 4.7 The one home-tab edit

`mobile/app/(tabs)/index.tsx` — Leke leaves:

```tsx
{/* SLOT: local-transfer-pill */}
```

Inside the quick-action row. You replace it with:

```tsx
<LocalTransferPill onPress={() => router.push('/local-transfer')} />
```

This is the only edit you make to that file. Don't touch palette, layout, or other actions — that's Leke's repaint.

---

## 5. Backend work

PRD §6 has the full backend surface. You own one route and its tests. If the backend directory doesn't exist when you start, scaffold the minimum: `backend/app/main.py`, `backend/app/core/{config,db}.py`, `backend/app/models.py` (tables from PRD §5 — at minimum `wallets`, `transactions`).

### 5.1 `backend/app/models.py` (you and Leke share this file)

Tables you need (from PRD §5):

```sql
CREATE TABLE wallets (
  user_id INTEGER PRIMARY KEY,
  squad_va_number TEXT UNIQUE NOT NULL,
  balance_kobo INTEGER NOT NULL DEFAULT 0,
  locked_kobo INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  counterparty_user_id INTEGER,
  type TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount_kobo INTEGER NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
```

Coordinate with Leke if they've already added these. First writer wins; second writer reviews.

### 5.2 `backend/app/api/transfer.py` (new — your file)

```python
POST /transfer/in-network
Body: { from_user_id, to_user_id, amount_kobo, idempotency_key }
Headers: Authorization: Bearer <token>  (verified by middleware later; for now accept any non-empty token)
```

Handler (SQLite, WAL mode, `BEGIN IMMEDIATE`):

```python
def in_network_transfer(req):
    # 1. Idempotency check — return existing row if seen
    existing = db.execute(
        "SELECT * FROM transactions WHERE idempotency_key = ?",
        (req.idempotency_key,)
    ).fetchone()
    if existing:
        return existing_to_response(existing)

    with db.transaction(mode='IMMEDIATE'):
        # 2. Lock sender wallet
        sender = db.execute(
            "SELECT balance_kobo FROM wallets WHERE user_id = ?",
            (req.from_user_id,)
        ).fetchone()
        if not sender:
            raise HTTPException(404, "Sender wallet not found")

        # 3. Balance check
        if sender['balance_kobo'] < req.amount_kobo:
            raise HTTPException(400, "Insufficient balance")
        if req.amount_kobo <= 0:
            raise HTTPException(400, "Amount must be positive")
        if req.from_user_id == req.to_user_id:
            raise HTTPException(400, "Self-transfer not allowed")

        # 4. Atomic move
        tx_id = str(uuid4())
        now = int(time.time())
        db.execute("UPDATE wallets SET balance_kobo = balance_kobo - ?, version = version + 1, updated_at = ? WHERE user_id = ?",
                   (req.amount_kobo, now, req.from_user_id))
        db.execute("UPDATE wallets SET balance_kobo = balance_kobo + ?, version = version + 1, updated_at = ? WHERE user_id = ?",
                   (req.amount_kobo, now, req.to_user_id))

        # 5. Insert tx row
        db.execute("""INSERT INTO transactions
            (id, user_id, counterparty_user_id, type, direction, amount_kobo, status, idempotency_key, created_at, settled_at)
            VALUES (?, ?, ?, 'in_network', 'out', ?, 'completed', ?, ?, ?)""",
            (tx_id, req.from_user_id, req.to_user_id, req.amount_kobo, req.idempotency_key, now, now))

    return {
        "success": True,
        "data": {
            "tx_id": tx_id,
            "status": "completed",
            "settled_at": iso_from_ts(now),
            "balance_after_kobo": sender['balance_kobo'] - req.amount_kobo,
        }
    }
```

Retry the whole transaction up to 3 times on SQLite `BUSY` / `LOCKED` errors with exponential backoff (50ms, 100ms, 200ms). Beyond 3 attempts, return 503 — client should retry with the **same `idempotency_key`** so the next attempt either picks up the now-committed row or proceeds cleanly.

### 5.3 `backend/tests/test_in_network_transfer.py` (new — your file)

20+ tests. The PRD §11 Risk 3 calls reconciliation correctness "catastrophic if it fails." You write the tests that prove it doesn't.

| # | Test | Expected |
|---|---|---|
| 1 | Happy path A→B | Both balances update; tx row inserted; response OK. |
| 2 | Sender wallet doesn't exist | 404 |
| 3 | Receiver wallet doesn't exist | 404 |
| 4 | Amount = 0 | 400 |
| 5 | Amount negative | 400 |
| 6 | Amount > sender balance | 400; no state change |
| 7 | Amount == sender balance (drain) | OK; sender at 0 |
| 8 | Self-transfer (from == to) | 400 |
| 9 | Duplicate idempotency_key, identical body | returns same `tx_id`; no double-spend |
| 10 | Duplicate idempotency_key, different body | returns the original row (idempotency wins over body comparison — document this) |
| 11 | Two concurrent A→B and A→C sharing the same funds | One succeeds, one fails; total preserved |
| 12 | After successful tx: `sum(wallets.balance_kobo)` is conserved | Equal to pre-tx sum |
| 13 | `transactions` row has correct direction and counterparty | `'out'`, `counterparty_user_id == to_user_id` |
| 14 | Non-integer amount input (e.g. `100.5`) | 400 (parser rejects) |
| 15 | String "abc" in `amount_kobo` | 400 |
| 16 | Missing `idempotency_key` | 400 |
| 17 | Idempotency_key too long (>128 chars) | 400 |
| 18 | Wallet `version` increments by 1 on both rows | yes |
| 19 | `settled_at` is set on completed tx | non-null |
| 20 | High concurrency: 100 concurrent A→B (10 kobo each) | Sender drained by exactly 1000 kobo; no oversend; ledger consistent |

Run with `pytest backend/tests/test_in_network_transfer.py -v`. Target: all 20 green.

---

## 6. Files you touch

```
mobile/app/local-transfer.tsx                  NEW
mobile/components/local-transfer/Pill.tsx      NEW
mobile/services/transfer.ts                    NEW
mobile/services/cache.ts                       FILL
mobile/hooks/useWallet.ts                      FILL
mobile/hooks/useTransactions.ts                FILL (lightweight wrapper around cache.getRecentTx)
mobile/types/transaction.ts                    FILL
mobile/types/wallet.ts                         FILL
mobile/app/(tabs)/index.tsx                    1-line edit (replace SLOT comment)
backend/app/main.py                            NEW (if not yet scaffolded — coordinate w/ Leke)
backend/app/core/{config,db}.py                NEW (if not yet scaffolded)
backend/app/models.py                          NEW or shared edit
backend/app/api/transfer.py                    NEW (POST /transfer/in-network)
backend/tests/test_in_network_transfer.py      NEW
```

## 7. Acceptance criteria

- Sign in as Mama Risikat → home shows Local Transfer pill in the quick-action row.
- Tap pill → screen opens at stage 1 → suggestions list Iya Tope + Kosi.
- Send ₦5,000 to Iya Tope → success card displays tx ID + "Settled in <Xms>".
- Home balance debited by ₦5,000 immediately. Tx visible in Recent Transactions on home.
- 20+ backend tests pass. Concurrency test (#20) passes.
- `npm run typecheck` clean.
- `grep "TODO" backend/app/api/transfer.py` returns nothing.

## 8. Out of scope (Leke owns these)

- Squad client, Static VA, Dynamic VA, external Transfer.
- All non-`local-transfer` mobile screens (signup, transfer external, scan, receive, voice-signup, transactions tab, profile tab, home palette outside your slot).
- The BVN finish step in `app/register.tsx`.
- Tab bar palette.
- Admin dashboard.
- `services/storage.ts` (Leke fills for token + PIN hash).
- `services/squad-api.ts` (Leke fills).
- `hooks/useNetworkStatus.ts` (Leke fills).
- The 31 remaining `#E31937` references outside the home pill — Leke sweeps those.

## 9. Workflow

```bash
git checkout main && git pull origin main
git checkout -b feat/local-transfer
# work
git push -u origin feat/local-transfer
gh pr create --title "feat: local transfer (in-network)" --body-file <(cat <<EOF
## Summary
- New mobile screen \`app/local-transfer.tsx\` (recipient → amount → PIN → success)
- New backend endpoint POST /transfer/in-network with atomic BEGIN IMMEDIATE
- 20+ tests covering idempotency, concurrency, ledger conservation
- LocalTransferPill drops into Leke's home slot

## Test plan
1. Sign in as Mama Risikat (PIN 1234)
2. Tap Local Transfer → Iya Tope → ₦5,000 → 1234
3. Confirm: home balance ₦445,000, tx in history
4. \`pytest backend/tests/test_in_network_transfer.py\` — 20+ green

Refs: docs/PRD_FUNBI.md, EchoPay_Cash_PRD.md §4 §5 §6
EOF
)
```

No `Co-Authored-By: Claude` trailer. No "Generated with Claude Code" footer. Commits are yours.

## 10. Hour estimate

| Task | Hours |
|---|---|
| `services/transfer.ts` + `cache.ts` + `useWallet.ts` + types | 1.5 |
| `app/local-transfer.tsx` (4 stages) | 2.0 |
| `LocalTransferPill` component | 0.5 |
| Backend endpoint (handler + retry + idempotency) | 1.5 |
| 20+ tests | 1.5 |
| Slot edit + verification | 0.25 |
| **Total** | **~7h** |

Start with `services/transfer.ts` mocked → screen → integrate cache → pill → home edit. Backend can come after if mobile lands first; the mock keeps the demo working.

Ship it.

---

# Wave 2 — production hardening (post-PR #8)

PR #8 landed the foundation (mobile screen, pill, services, cache, hooks, types, backend endpoint, 20 tests). These four sections extend that work without crossing into Leke's lane.

Order by demo impact: §11 → §12 → §13 → §14.

## 11. Dual-balance offline wallet (online funds vs offline allocation)

**The model.** Every user has TWO server-tracked balances on the same `wallets` row (the schema already has both columns from PR #8):

- `balance_kobo` — full online funds. Accessed by external transfers, top-ups, and **online** in-network transfers.
- `locked_kobo` — pre-allocated offline-spending budget. The user explicitly moves funds from `balance_kobo` into `locked_kobo` ("I'll need ₦20,000 for the market today") via a new endpoint. Offline in-network transfers debit this column.

Money never leaves the wallet — it's just earmarked. The **reconciliation invariant updates**: `sum(balance_kobo + locked_kobo) ≡ Master Static VA balance` (PRD §4.5 — update there). This is the same total Squad sees; the locked column is purely an internal allocation.

**Why this beats the single-balance outbox.** A stolen phone offline can only spend up to `locked_kobo` (a user-chosen cap), not the full wallet. The user has explicit consent for offline exposure. Sum conservation still holds at every step.

**The two pipelines stay clean:**
- Online local transfer → debits `balance_kobo`, credits receiver's `balance_kobo`. Server is source of truth in real time.
- Offline local transfer → debits cached `locked_kobo` mirror on mobile, queues to outbox. On reconnect, outbox replays with `from_locked=true` flag → server debits `locked_kobo` (not `balance_kobo`), credits receiver's `balance_kobo`. Idempotency_key UNIQUE ensures replays don't double-spend.

### 11.1 Backend — lock / unlock endpoints

`backend/app/api/wallet.py` (new file):

```python
POST /wallet/lock-for-offline
Body: { user_id, amount_kobo, idempotency_key }
→ Atomically: balance_kobo -= amount, locked_kobo += amount.
  Rejects if balance_kobo < amount.

POST /wallet/unlock-from-offline
Body: { user_id, amount_kobo, idempotency_key }
→ Atomically: locked_kobo -= amount, balance_kobo += amount.
  Rejects if locked_kobo < amount.
```

Both wrap `BEGIN IMMEDIATE` and use the same idempotency_key UNIQUE pattern as `/transfer/in-network`. Add a `wallet_movements` log table (or reuse `transactions` with new types `'lock_offline'` / `'unlock_offline'`) for audit.

### 11.2 Backend — modify `/transfer/in-network`

Add optional `from_locked: bool = False` to `InNetworkTransferRequest`. In the handler:
- `from_locked=False` (online path, default): check `sender.balance_kobo >= amount`; debit `balance_kobo`.
- `from_locked=True` (offline replay): check `sender.locked_kobo >= amount`; debit `locked_kobo`.

Either way, **receiver always credits `balance_kobo`** — they receive into their online wallet. Sender's `version` bumps as before.

### 11.3 Mobile — dual-balance tracking

`types/index.ts` Account already has `balance` string. Add `locked_balance: string` (optional for back-compat). Personas seeded with both: Mama at `{balance: '400000.00', locked_balance: '50000.00'}`.

`hooks/useWallet.ts` extends:
```ts
{
  balanceKobo, balanceNaira,                  // online
  lockedBalanceKobo, lockedBalanceNaira,      // offline budget
  vaNumber,
  applyDebit(kobo),                           // debits online (used by online path)
  applyLockedDebit(kobo),                     // debits offline budget (used by offline path)
  lockForOffline(kobo),                       // calls /wallet/lock-for-offline
  unlockFromOffline(kobo),                    // calls /wallet/unlock-from-offline
}
```

`services/transfer.ts` mock-fallback enqueues to outbox with `payload.from_locked=true` AND decrements the cached `locked_balance` via `applyLockedDebit`.

`services/cache.ts` `OutboxRow.payload` adds `from_locked: boolean`.

### 11.4 Mobile — `/offline-wallet` top-up screen

`app/offline-wallet.tsx` (new):
- Title: "Offline spending budget"
- Subtitle: "Pre-load funds you can spend even when your network is down. We move money from your main wallet to your offline budget — nothing leaves your account."
- Shows: current online balance + current locked balance side-by-side.
- Input: "How much do you want available offline?" — slider or number input, capped at online balance.
- Primary CTA: "Lock ₦X for offline use" → calls `useWallet.lockForOffline(kobo)` → success screen.
- Secondary CTA: "Return offline budget to main wallet" — calls `unlockFromOffline(currentLocked)`.

Route from home tab's locked-balance card (added in §11.5 — small Leke touch).

### 11.5 Mobile — home dual-balance display

`app/(tabs)/index.tsx` shows both columns. Coordinate with Leke (PRD_LEKE §3.15 — new) — Leke writes the palette, Funbi confirms the field names. Layout:

```
┌─────────────────────────────────────────┐
│  Available balance                       │
│  ₦400,000                                │  ← balance_kobo
│  As of just now                          │
├─────────────────────────────────────────┤
│  Offline budget                ₦50,000   │  ← locked_kobo
│  Tap to top up →                         │
└─────────────────────────────────────────┘
```

When offline budget = 0, hint card reads "Set aside funds for offline use →" routing to `/offline-wallet`.

### 11.6 Local-transfer adaptation

`app/local-transfer.tsx` stage 2 (enter amount) checks which "pot" to gate against using `useNetworkStatus()` (Leke's hook from Wave 1):
- Online → max = `balanceKobo`, subtitle "From your balance ₦X"
- Offline → max = `lockedBalanceKobo`, subtitle "From your offline budget ₦X"

If offline and user tries an amount > `lockedBalanceKobo`, inline error: "That's more than your offline budget. Connect to add more to your offline budget."

### 11.7 Tests

`backend/tests/test_wallet_lock_unlock.py` (~12 tests):
- Lock happy path: `balance` decremented, `locked` incremented, total conserved
- Lock with insufficient balance: 400, no state change
- Lock with zero/negative: 422
- Idempotent lock (same key twice): single move
- Unlock happy path: inverse
- Unlock with insufficient locked: 400
- Concurrent lock + unlock on same user: serialized, conservation holds
- `from_locked=true` transfer when sufficient locked: succeeds, locked decremented, receiver's balance credited
- `from_locked=true` transfer when insufficient locked but sufficient balance: 400 `insufficient_locked_balance` (must NOT silently fall through)
- Reconciliation invariant: after any sequence of lock/unlock/transfer, `sum(balance_kobo + locked_kobo)` is conserved

### Acceptance

- Sign in as Mama → home shows `Available balance ₦400,000` + `Offline budget ₦50,000`.
- Tap "Tap to top up →" → `/offline-wallet` → drag slider to ₦70,000 → "Lock ₦70K for offline use" → success. Home updates: `₦380,000` + `₦70,000`.
- Toggle airplane mode. Local Transfer of ₦5,000 → success. Mobile cache: `₦380,000` (unchanged) + `₦65,000`.
- Toggle back online. Outbox drains. Backend DB: Mama's `balance_kobo=38_000_000`, `locked_kobo=6_500_000`. Iya Tope's `balance_kobo` up by 5,000_00.
- Try offline transfer of ₦70,000 (more than offline budget): UI rejects with "That's more than your offline budget."
- Old single-balance behavior still works when `from_locked` not provided — backwards compatible.

### Hours

~4h: backend (1.5h) + mobile cache/hook/service (1h) + offline-wallet screen (45 min) + home dual-balance (15 min) + local-transfer adaptation (15 min) + tests (45 min).

### Files

```
mobile/services/cache.ts                  EXTEND   add outbox table, writeOutbox/readOutboxBatch/ackOutbox/rejectOutbox
mobile/services/transfer.ts               MODIFY   mock fallback enqueues to outbox in addition to tx history
mobile/hooks/useOutbox.ts                 NEW      NetInfo listener; drains on reconnect with exponential backoff
mobile/context/AuthContext.tsx            MOUNT    one-line addition: useOutbox() called inside provider so it lives one level above the router and survives screen unmounts
backend/app/api/sync.py                   NEW      POST /transfer/sync-offline-batch — array of {idempotency_key, from_user_id, to_user_id, amount_kobo}, replays each through the existing in_network_transfer handler
backend/tests/test_sync_offline_batch.py  NEW      tests for ordered drain, partial success, replay of already-acked txs
```

### Schema additions to `cache.ts`

```ts
// Per-user outbox keyed by user_id. Same JSON-blob-in-AsyncStorage strategy
// as tx history; one row per pending op. status transitions monotonically:
//   queued → sent → (acked | rejected)
// rejected items never retry; they surface to the user via the home tab.
export interface OutboxRow {
  id: string;                       // UUID
  user_id: number;
  op_type: 'in_network';            // ready for future op types (M2 permits)
  payload: {
    from_user_id: number;
    to_user_id: number;
    amount_kobo: number;
  };
  idempotency_key: string;
  attempts: number;
  last_error?: string;
  created_at: string;
  next_retry_at: string;            // ISO; honored by drain loop
  status: 'queued' | 'sent' | 'acked' | 'rejected';
}

export async function writeOutbox(row: OutboxRow): Promise<void>;
export async function readOutboxQueued(userId: number, limit?: number): Promise<OutboxRow[]>;
export async function markOutbox(userId: number, id: string, patch: Partial<OutboxRow>): Promise<void>;
export async function getOutboxPendingCount(userId: number): Promise<number>;  // for badge on home
```

### Drain logic (`useOutbox.ts`)

- Listens to `useNetworkStatus()` (Leke shipped in Wave 2).
- On `isOnline` transitioning false → true: enter drain loop.
- Reads up to 20 `queued` rows where `next_retry_at <= now`, in `created_at` ASC order.
- For each: mark `sent`, POST to `/transfer/sync-offline-batch`, on 200 mark `acked`, on 4xx mark `rejected` (do not retry), on 5xx / network error increment `attempts` (max 10) and set `next_retry_at = now + min(60s, 2^attempts * 1000ms)`.
- After 10 failed attempts: mark `rejected`, surface a user banner: "1 payment couldn't sync — review history."
- Only one drain loop at a time per user (use a local mutex in the hook).

### Backend endpoint

```python
@router.post("/sync-offline-batch")
def sync_offline_batch(req: SyncBatchRequest, db: Session = Depends(get_db)):
    """Replays an array of offline-queued in-network transfers.

    Each row is independently passed through the existing in-network
    handler — idempotency_key UNIQUE ensures already-applied txs return
    the original row instead of double-spending.
    """
    results = []
    for op in req.ops:
        try:
            tx = in_network_transfer(InNetworkTransferRequest(**op.dict()), db)
            results.append({"idempotency_key": op.idempotency_key, "status": "acked", "tx_id": tx.data.tx_id})
        except HTTPException as e:
            results.append({"idempotency_key": op.idempotency_key, "status": "rejected", "error": e.detail})
    return {"success": True, "data": {"results": results}}
```

Cap batch size at 50. Reject empty batches with 400.

### Acceptance

- Offline transfer writes to outbox (visible via `getOutboxPendingCount` returning 1).
- Home tab shows a small "1 payment waiting to sync" badge when pending count > 0 (Leke's home update — coordinate in his §3.13).
- Toggle network on → outbox drains within 5s — server has the tx — local row moves `queued → acked`.
- Replay of an already-acked outbox row (manually staged in test): returns the original tx_id, no double-spend.
- 5+ new backend tests in `test_sync_offline_batch.py` pass.

### Hours

~3.5h: cache outbox helpers (45 min) + transfer.ts wiring (30 min) + useOutbox hook + drain (1h) + backend endpoint (30 min) + tests (45 min).

### Out of scope

- Multi-hop permits (M2 ed25519 work — separate PRD section to be drafted)
- Receiver-side outbox (the demo runs both flows on Mama's phone via persona-switch; production splits)
- Cross-device outbox merge (one-device-one-outbox is fine for v1)

---

## 12. Accept route-param prefill on `local-transfer.tsx`

**Goal:** when Leke wires the home voice card to route to `/local-transfer?recipientId=iya_tope&amountKobo=500000`, the screen jumps straight to the PIN stage with all earlier fields filled in. Voice → 1 tap (PIN) → done.

### Files

```
mobile/app/local-transfer.tsx     MODIFY   useLocalSearchParams; if both params present, skip to confirm-pin stage
```

### Behavior

- `useLocalSearchParams<{ recipientId?: string; amountKobo?: string }>()` on mount.
- If `recipientId` resolves to a known persona via `getPersonaById` AND `amountKobo` parses to a positive integer ≤ user balance: set `recipient`, `amountStr`, jump to `confirm-pin` stage.
- If `recipientId` is unknown: route to `pick-recipient` with the search box pre-filled with the original string so the user sees what failed.
- If only `recipientId` present: pre-select recipient, jump to `enter-amount`.
- If only `amountKobo` present: ignore (we need a recipient first).

### Acceptance

- `router.push('/local-transfer?recipientId=iya_tope&amountKobo=500000')` lands on the PIN stage with "₦5,000 to Iya Tope" readback.
- Bad `recipientId` falls back gracefully without crash.
- No regression on the manual flow (no params).

### Hours

~30 min.

---

## 13. `useLocalTransfer` hook refactor

**Goal:** `mobile/docs/ARCHITECTURE.md` says screens never call services directly — they consume hooks. `app/local-transfer.tsx` currently calls `localTransfer()` and the cache helpers directly. Pull that into a hook so the screen is presentation-only and the state machine becomes unit-testable.

### Files

```
mobile/hooks/useLocalTransfer.ts     NEW       state machine + handlers
mobile/app/local-transfer.tsx        REFACTOR  consume the hook
```

### Hook signature

```ts
export function useLocalTransfer(opts?: { prefilledRecipientId?: string; prefilledAmountKobo?: number }): {
  stage: Stage;
  recipient: Persona | null;
  amountKobo: number;
  amountStr: string;
  pin: string;
  error: string | null;
  loading: boolean;
  result: LocalTransferResult | null;
  recipients: Persona[];                          // filtered by query
  query: string;

  setQuery(q: string): void;
  selectRecipient(p: Persona): void;
  setAmount(s: string): void;
  setPin(p: string): void;
  back(): void;
  continueFromAmount(): void;
  confirmAndSend(): Promise<void>;
  reset(): void;
};
```

### Acceptance

- Screen render code is <250 lines (currently ~580). All state and handlers live in the hook.
- New unit test file `mobile/hooks/__tests__/useLocalTransfer.test.ts` covers happy path + insufficient balance + wrong PIN. (Jest isn't wired yet per `mobile/README.md`; skip the test file if `npm test` doesn't exist — leave the hook itself testable for when Jest lands.)

### Hours

~45 min — straight extraction, no logic change.

---

## 14. Hardening tests for `/transfer/in-network`

**Goal:** the 20 tests cover the spec'd cases. Add edge cases discovered during the live test that aren't in the original PRD §5.3 list.

### New tests

| # | Case | Expected |
|---|---|---|
| 21 | Sender wallet exists but has `version=0` and no prior txs (fresh wallet) | Transfer succeeds, version goes to 1 |
| 22 | Sender == receiver but submitted as integers >0 | 400 self_transfer (already covered as test 8, but extend to verify idempotency_key isn't claimed) |
| 23 | Body with extra unknown fields | 422 (Pydantic should reject by default — verify config doesn't accept extras) |
| 24 | `idempotency_key` with valid pattern but at exactly 128 chars | 200 (boundary) |
| 25 | `idempotency_key` with 129 chars | 422 (one over) |
| 26 | from_user_id = 0 | 422 (ge=1 violation) |
| 27 | Race: 2 simultaneous calls with same idempotency_key from different threads | Both return same tx_id, only one debit applied |
| 28 | After successful tx: re-issue with same key but different amount in body | Returns original tx data, ignores new amount (documented behavior) |
| 29 | Transfer with amount_kobo = INT_MAX (9223372036854775807) and matching balance | Either succeeds or 400 — must not overflow |
| 30 | Concurrent transfers from 10 different senders to 1 receiver | All succeed (no shared lock), receiver balance correctly summed |

### Hours

~45 min.

---

## Wave 2 — total estimate

| Section | Hours |
|---|---|
| 11. Outbox + sync drain | 3.5 |
| 12. Route-param prefill | 0.5 |
| 13. `useLocalTransfer` refactor | 0.75 |
| 14. Hardening tests | 0.75 |
| **Total Wave 2** | **~5.5h** |

---

## Coordination touchpoints with Leke (Wave 2)

1. **Home pending-sync badge.** Funbi exposes `getOutboxPendingCount(user_id)`; Leke calls it from home tab and renders a small chip when count > 0. Leke's §3.13.
2. **Voice → route push.** Leke's voice handler pushes `router.push('/local-transfer?recipientId=...&amountKobo=...')`. Funbi's screen consumes the params per §12.
3. **JWT auth gate.** Funbi's `/transfer/in-network` and `/transfer/sync-offline-batch` will eventually require `Depends(current_user)` from `backend/app/core/auth.py` — that module is Leke's §4.5. Until it lands, both endpoints accept any caller (documented hackathon scope). After Leke ships §4.5, Funbi adds one `Depends(current_user)` line per endpoint in a tiny follow-up PR.
