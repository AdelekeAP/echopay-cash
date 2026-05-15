# Dev split — mobile sprint to demo

**Source of truth:** [`EchoPay_Cash_PRD.md`](../EchoPay_Cash_PRD.md) at the repo root. Every endpoint, table, screen, and rule below is anchored to a section number there. If the PRD and this doc disagree, the PRD wins — update this file, not the spec.

**Sprint:** Fri May 15 → Sat May 16, 2026
**Two devs:**
- **Funbi** — owns the **entire local-transfer feature** end-to-end (mobile UI + backend endpoint + ledger + cache + tests).
- **Leke** — owns **everything else** in the mobile build (signup polish, palette sweep across the rest of the app, Squad-side screens, admin dashboard).

The split is zero-file-overlap by design with **one tiny coordination point** at the home tab (Leke leaves a slot for Funbi's pill; Funbi drops it in).

---

## 0. Theme — the law

**All new and modified screens import colors from `constants/theme.ts` `Echopay` only.** Never inline a hex code in a screen file.

```ts
import { Echopay } from '../constants/theme';
```

| Token | Hex | Use |
|---|---|---|
| `pageBg` | `#FBF7F0` | warm beige page background |
| `cardBg` | `#FFFFFF` | elevated surface (cards, inputs) on beige |
| `cardSoft` | `#F5EFE6` | recessed surface (input wells, footers, demo panels) |
| `accent` | `#F97316` | primary orange — CTAs, brand, focus |
| `accentSoft` | `#FFEDD5` | tinted bg (hero blocks, pending chips) |
| `accentPressed` | `#C2410C` | pressed state on the primary button |
| `accentMuted` | `#FBC192` | disabled button bg |
| `border` | `#ECE5D7` | hairline 1px borders |
| `borderStrong` | `#D9CFB8` | input in focus |
| `text` | `#1A1A1A` | primary text |
| `textMuted` | `#6B6B6B` | secondary text |
| `textSubtle` | `#9A9A9A` | captions, placeholders |
| `success` / `successSoft` | `#0E8C5A` / `#E2F4EC` | verified chips, settled rows |
| `danger` / `dangerSoft` | `#DC2626` / `#FEF2F2` | error states **only** |

Rules:

1. **No gradients. No drop shadows.** Borders only.
2. **No red anywhere except `danger`.** The old `#E31937` from the demo-bank fork is dead — grep and replace.
3. **One accent.** Orange does brand, focus, primary CTA, badges. Don't introduce a second hue.
4. **Border radii:** inputs/buttons `14`, cards `16–18`, pills `999`.
5. **Type weights:** body 400, label 600, heading 700, brand wordmark 800.

Canonical reference screens already in palette: `app/login.tsx`, `app/register.tsx`.

---

## 1. Funbi — Local Transfer (entire vertical)

**Branch:** `feat/local-transfer`
**Anchors:** PRD §4 (atomic SQL pattern), §5 (`wallets` + `transactions` tables), §6 (backend endpoints), §7 (mobile screens).

You own this feature end-to-end: the pill on home, the dedicated screen, the local backend endpoint, the atomic ledger move, the cache write, the tests. You commit one change to `app/(tabs)/index.tsx` to drop your pill into the slot Leke leaves for you. Everything else in home is Leke's.

### 1.1 Mobile — Local Transfer screen

`mobile/app/local-transfer.tsx` — new screen, three stages:

| Stage | What it shows | Action |
|---|---|---|
| `pick-recipient` | Search box "Phone or username" + suggestion list (Iya Tope, Kosi from `constants/personas.ts`). | Tap a persona → next. |
| `enter-amount` | Big amount input with ₦ prefix. Footer: "From your balance ₦X". Badge: "Instant. No fees." | Tap "Continue" → next. |
| `confirm-pin` | Recipient summary + 4-digit PIN entry. | Submit → call `transfer.localTransfer()` → success card → auto-return home. |

Palette per §0. The success card shows tx ID, "Sent ₦X to <name> · 0.0s", green check. Auto-pop back to home after ~1.5s.

### 1.2 Mobile — pill on home (one coordination edit)

`mobile/app/(tabs)/index.tsx` — Leke leaves a `{/* SLOT: local-transfer-pill */}` placeholder inside the quick-action row. You replace it with:

```tsx
<LocalTransferPill onPress={() => router.push('/local-transfer')} />
```

`LocalTransferPill` lives in `mobile/components/local-transfer/Pill.tsx`. Orange accent on cream card per palette.

### 1.3 Mobile — transfer service

`mobile/services/transfer.ts` — new. Owns the in-network API surface:

```ts
export interface LocalTransferRequest {
  fromUserId: number;
  toUserId: number;       // or by username if recipient resolution happens client-side
  amountKobo: number;     // PRD §5 — always integer kobo
  pin: string;
  idempotencyKey: string; // sha256(fromUserId + toUserId + amountKobo + minute-bucket)
}

export interface LocalTransferResult {
  txId: string;
  status: 'completed';
  settledAt: string;
  balanceAfterKobo: number;
}

export async function localTransfer(req: LocalTransferRequest): Promise<LocalTransferResult>;
```

Mock first: ~400ms delay, generate UUID, write to `cache.ts`, update `useWallet` balance. Real wire-up: `POST /transfer/in-network` on the new backend (§1.5 below). Idempotency key is **UNIQUE on transactions** per PRD §5 — duplicate POSTs return the existing row, not an error.

### 1.4 Mobile — cache + hook

You implement the local-transfer slice of `services/cache.ts` and `hooks/useWallet.ts`:

- `cache.ts`: `writeTransaction(tx)`, `getRecentTx(limit)` — SQLite on phone, AsyncStorage fallback on web. Schema matches PRD §15.7 + §5.
- `useWallet.ts`: returns `{ balanceKobo, applyDebit(kobo), applyCredit(kobo) }`. Wraps `AuthContext.account.balance` and writes to `cache.ts`.

### 1.5 Backend — `/transfer/in-network`

`backend/app/api/transfer.py` (M1 backend; OK to start now even before T2 lands — your endpoint becomes the first route the backend exposes):

```python
POST /transfer/in-network
Body: { from_user_id, to_user_id, amount_kobo, idempotency_key, pin_hash }
```

Per PRD §4, the handler is **one `SERIALIZABLE` transaction** (Postgres) or **`BEGIN IMMEDIATE`** (SQLite, since the PRD picked SQLite for the hackathon):

```sql
BEGIN IMMEDIATE;
SELECT balance_kobo FROM wallets WHERE user_id = :from FOR UPDATE;
-- application checks balance >= amount; else ROLLBACK
UPDATE wallets SET balance_kobo = balance_kobo - :amount WHERE user_id = :from;
UPDATE wallets SET balance_kobo = balance_kobo + :amount WHERE user_id = :to;
INSERT INTO transactions (id, type, from_id, to_id, amount_kobo, idempotency_key, status, settled_at)
  VALUES (:tx_id, 'in_network', :from, :to, :amount, :idem, 'completed', NOW());
COMMIT;
```

Retry on serialization failure with exponential backoff, max 3 attempts. Beyond 3, surface a failure with the same idempotency key so the client can safely retry.

### 1.6 Tests — 20+ per PRD §11 Risk 3

`backend/tests/test_in_network_transfer.py`. The PRD calls out reconciliation correctness as a catastrophic risk. Cover:

- Happy path: A→B, both balances update, tx row inserted.
- Insufficient balance: rejected, no state change.
- Duplicate idempotency key: returns same tx, no double-spend.
- Concurrent A→B and A→C with shared funds: one succeeds, one fails (no oversend).
- A→A self-transfer: rejected.
- Zero amount: rejected.
- Negative amount: rejected.
- Non-integer kobo (string input "100.5"): rejected.
- Wallet doesn't exist: rejected.
- After successful tx: `sum(wallets.balance_kobo)` is conserved.

### Files Funbi touches

```
mobile/app/local-transfer.tsx                  NEW
mobile/components/local-transfer/Pill.tsx      NEW
mobile/services/transfer.ts                    NEW
mobile/services/cache.ts                       FILL (tx history slice)
mobile/hooks/useWallet.ts                      FILL
mobile/app/(tabs)/index.tsx                    1-line edit (drop pill into Leke's slot)
backend/app/api/transfer.py                    NEW (just /transfer/in-network)
backend/tests/test_in_network_transfer.py      NEW
```

### Acceptance

- Sign in as Mama Risikat → home shows Local Transfer pill → tap → send ₦5,000 to Iya Tope → success card → balance debited by ₦5,000 on home, tx row visible in recent tx.
- 20+ tests pass on `backend/tests/test_in_network_transfer.py`.
- Concurrent transfer test (PRD §11 Risk 3) passes — no oversend under load.
- No console errors. Typecheck clean. ESLint clean for new files.

### Out of scope (Leke owns these)

- Squad client / Static VA / Dynamic VA / external Transfer.
- The rest of the home tab (Funbi only writes the pill component).
- Tabs (transactions, profile), transfer (external), receive, scan, voice-signup screens.
- Admin dashboard.
- BVN signup step.

---

## 2. Leke — Everything else

**Branch:** `feat/mobile-shell-and-squad`
**Anchors:** PRD §3 (file layout), §4 (Squad APIs), §6 (backend except in-network), §7 (mobile screens except local-transfer).

You own the rest of the mobile build and the Squad-side backend. Funbi's local transfer doesn't depend on any of your work — your branches can land in either order.

### 2.1 Mobile — finish signup (BVN step)

`mobile/app/register.tsx` — the file is mid-state. NIN step is done; BVN handler is wired (`handleBvnVerify` calls `services/mono.ts` `verifyBvn`); the `verifying-bvn` full-screen state renders. **Missing:** the JSX block for `stage === 'enter-bvn'`.

Mirror the NIN step:
- Eyebrow: `STEP 2 · BANK KYC`
- Title: "Confirm your BVN"
- Subtitle: "We cross-check your BVN against the NIBSS database."
- Single BVN input (11 digits, formatted 4-4-3)
- Disabled-style summary card above the input showing the NIN-verified name
- Primary button: "Verify BVN"
- Provider badge: `Powered by Mono · BVN lookup via NIBSS` (green dot)
- Test BVN pairs panel (collapsed):
  `12345678901 → 22288899900`, `22334455667 → 11122233344`, `98765432101 → 55566677788`

Update the verified card in the PIN step to show both NIN and BVN as confirmed.

### 2.2 Mobile — home tab palette + the local-transfer slot

`mobile/app/(tabs)/index.tsx`:

- Replace red Zenith-styled card with `cardBg` on `pageBg`, hairline border, no gradient.
- Header: "Good morning, {first_name}" + cream-bg avatar.
- Balance card: "Available balance" label (muted) + ₦450,000.00 in bold 32 + "As of just now" subtitle.
- Account number row: "GTBank · 0123 456 789" with a copy icon (visual only this sprint).
- **Quick action row — three pills:**
  1. 🡙 Send (external) → `app/transfer.tsx`
  2. `{/* SLOT: local-transfer-pill */}` ← **Funbi drops their `<LocalTransferPill>` here**
  3. 🔳 Receive → `app/receive.tsx`
- Recent transactions section: pull from `cache.ts` `getRecentTx()`. Empty state in palette.

**Coordination contract:** leave the JSX slot comment exactly as shown. Funbi will replace just that one line.

### 2.3 Mobile — tab bar

`mobile/app/(tabs)/_layout.tsx`:
- `tabBarActiveTintColor: Echopay.accent`
- `tabBarInactiveTintColor: Echopay.textSubtle`
- `tabBarStyle.backgroundColor: Echopay.cardBg`, `borderColor: Echopay.border`
- Drop heavy shadow; keep the floating pill geometry.

### 2.4 Mobile — transactions tab

`mobile/app/(tabs)/transactions.tsx`:
- Page bg → `Echopay.pageBg`
- Header "Transaction History" → `Echopay.text`
- Empty state: cream icon circle, muted text
- Row template: card on white, type icon left, amount right (red for out, green for in), muted timestamp
- Pulls from `cache.ts` (Funbi's `getRecentTx`)

### 2.5 Mobile — profile tab

`mobile/app/(tabs)/profile.tsx`:
- **Fix the RNW text-rendering bug** — first name, last name, bank name show blank because raw strings sit outside `<Text>`. Wrap every raw string in `<Text>`.
- Page bg → `Echopay.pageBg`
- Avatar circle on cream bg with dark initials (match login)
- Menu rows on white cards with hairline borders
- Logout button styled secondary orange

### 2.6 Mobile — transfer (external) screen

`mobile/app/transfer.tsx`:
- Reframe title from "Transfer Money" → "Send to any bank"
- Subtitle "Money lands at the recipient's bank in seconds" (Squad story)
- Drop the Zenith red gradient
- Keep the existing Picker for bank selection, styled with Echopay border + bg
- Step indicator (Recipient → Amount → Confirm → PIN → Success) with orange dots
- Success card: green check + "Sent ₦X to <name> at <bank>"
- Wire to `services/squad-api.ts` `transferExternal()` (mock with delay until backend lands)

### 2.7 Mobile — stub screens

These were `return null`. Replace each with a real shell in palette so they render, even without final functionality:

- **`app/scan.tsx`** — full-screen camera placeholder (white card on beige, "Camera view" text, "Tap to scan" CTA). On web: "Available on phone" message + manual QR entry textbox.
- **`app/receive.tsx`** — hero card with a placeholder QR (`react-native-qrcode-svg` with payload `"echopay:demo"`), amount input ("Generate ₦X QR"), countdown placeholder. Powered-by-Squad-Dynamic-VA badge.
- **`app/voice-signup.tsx`** — redirect to `/register` on web; on phone, a mic button → record → fall through to `/register?prefill=true`. Phase 1+.

### 2.8 Backend — Squad integration

PRD §6 endpoints (everything except `/transfer/in-network` which is Funbi's):

```
backend/app/squad/client.py             httpx async client, Bearer auth, retry, 424 requery
backend/app/squad/static_va.py          POST /virtual-account
backend/app/squad/dynamic_va.py         POST /virtual-account/create-dynamic + initiate
backend/app/squad/transfer.py           POST /payout/account/lookup, /payout/transfer, /payout/requery
backend/app/squad/webhook.py            HMAC-SHA512 V2 validation, raw body bytes
backend/app/api/auth.py                 POST /auth/voice-signup
backend/app/api/voice_proxy.py          forwards to :8000 voice services
backend/app/api/transfer.py             POST /transfer/voice-initiate (external) — coordinate with Funbi to share the file
backend/app/api/dva.py                  POST /dynamic-va/create
backend/app/api/webhooks.py             POST /webhooks/squad
backend/app/api/admin.py                GET /admin/state, POST /admin/reconcile
backend/seed.py                         3 personas + Static VAs
```

PRD §4.1–4.5 has the exact Squad API surface: kobo amounts, HMAC field order, 424 requery rule, the 6-pipe webhook signature.

### 2.9 Admin dashboard

`admin/index.html` + `admin/app.js` — static HTML + vanilla JS per PRD §3 / §6. 1-second polling on `/admin/state`. Reconciliation banner at top: `sum(wallets) | master VA | delta` with green/red color. New webhooks flash green for 2s. "Reconcile now" button hits `POST /admin/reconcile`.

### Files Leke touches

```
mobile/app/register.tsx                    (finish BVN step)
mobile/app/(tabs)/_layout.tsx              (tab colors)
mobile/app/(tabs)/index.tsx                (home palette + leave Funbi's slot)
mobile/app/(tabs)/transactions.tsx
mobile/app/(tabs)/profile.tsx              (palette + RNW text fix)
mobile/app/transfer.tsx                    (external — palette + reframe)
mobile/app/scan.tsx                        (real shell)
mobile/app/receive.tsx                     (real shell)
mobile/app/voice-signup.tsx                (real shell)
mobile/services/squad-api.ts               (typed wrappers)
backend/app/squad/*.py                     (entire Squad client surface)
backend/app/api/auth.py
backend/app/api/voice_proxy.py
backend/app/api/transfer.py                (only the external + voice-initiate routes — share file w/ Funbi)
backend/app/api/dva.py
backend/app/api/webhooks.py
backend/app/api/admin.py
backend/seed.py
admin/index.html
admin/app.js
```

### Acceptance

- Sign up → NIN → BVN → PIN → done. Three demo NIN/BVN pairs all work.
- Every screen reachable via the tab bar uses Echopay tokens. `grep -rn "#E31937" mobile/` returns nothing in modified files.
- Profile shows actual user name, bank name, account number (no blank text).
- Tab bar active state is orange.
- Squad sandbox roundtrip green (Static VA → webhook → Transfer → requery) per PRD §13 right-now action #1 and `spike/squad_roundtrip.py`.
- Admin dashboard polls and shows live state.
- `npm run typecheck` clean.

### Out of scope (Funbi owns these)

- `/transfer/in-network` endpoint and its tests.
- `services/transfer.ts` `localTransfer()`.
- `services/cache.ts` and `hooks/useWallet.ts` (Funbi fills these for the local-transfer flow; you can read from them in transactions tab, but don't implement them).
- The `LocalTransferPill` component (Funbi's).
- `app/local-transfer.tsx` (Funbi's).

---

## 3. The single coordination point

The home tab. One JSX slot. Workflow:

1. Leke lands `feat/mobile-shell-and-squad` first or second (either order works). Their `app/(tabs)/index.tsx` contains the placeholder comment:
   ```tsx
   {/* SLOT: local-transfer-pill */}
   ```
2. Funbi rebases `feat/local-transfer` on latest `main` after Leke merges, replaces the comment with:
   ```tsx
   <LocalTransferPill onPress={() => router.push('/local-transfer')} />
   ```
3. Funbi pushes; merges.

If Funbi lands first instead: Leke's PR will replace the comment with the actual import + JSX directly. Either way, the only file that touches both contributors is `app/(tabs)/index.tsx`, and the conflict is 1 line.

---

## 4. Workflow (per `CLAUDE.md`)

```bash
git checkout main && git pull origin main
git checkout -b feat/<your-branch>
# commit often. No "Co-Authored-By: Claude". No "🤖 Generated with Claude Code".
git push -u origin feat/<your-branch>
# open PR with: 2–3 sentence summary + test plan + link to this doc's section.
# self-merge after 30-second visual self-review.
```

Branch names lock to:
- `feat/local-transfer` (Funbi)
- `feat/mobile-shell-and-squad` (Leke) — or split into smaller PRs (`feat/mobile-shell`, `feat/backend-squad`, `feat/admin-dashboard`) if you want tighter PRs.

---

## 5. Hour estimates

| Person | Tasks | Hours |
|---|---|---|
| Funbi | local-transfer screen (2h) + pill component (0.5h) + transfer service + cache + hook (1.5h) + backend endpoint (1.5h) + 20 tests (1.5h) | **~7h** |
| Leke | BVN UI finish (0.5h) + home repaint (1h) + tab bar (0.25h) + transactions (0.75h) + profile (0.75h) + transfer external (1h) + 3 stubs (1h) + Squad client + endpoints (3h) + admin dashboard (1.5h) | **~10h** |

Leke's pile is bigger by design — Funbi's vertical is deeper but narrower. If Leke needs to peel off the Squad-backend half to a separate PR or to a teammate, do it.

---

## 6. Out of scope this sprint (do NOT touch)

- Legacy voice components (`components/EchoOrb.tsx`, `VoiceModal.tsx`, etc.) — gated by `CLAUDE.md`.
- Offline mode / outbox / SQLite cache beyond what local-transfer history needs.
- ed25519 / permits / sync endpoint (M2 per PRD §1).
- Postgres. SQLite for the hackathon.
- New dependencies beyond what's already in `package.json`.

---

## 7. Done definition for the sprint

- Sign in as Mama Risikat → Echopay-painted home → tap **Local Transfer** pill → send ₦5,000 to Iya Tope → success card → balance updates → tx visible in History tab.
- Sign up: NIN → BVN → PIN → done. New persona lands on home in palette.
- Every tab uses Echopay palette. No `#E31937` remaining.
- Squad sandbox roundtrip green (gate of PRD §13).
- One recorded clean run of both flows saved to `recordings/demo_a.mp4`.

Ship it.
