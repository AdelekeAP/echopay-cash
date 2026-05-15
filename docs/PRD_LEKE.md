# PRD — Leke · Mobile shell, Squad, palette sweep

**Owner:** Leke
**Branch:** `feat/mobile-shell-and-squad` (or split into smaller PRs if you prefer — see §9)
**Anchors:** [`EchoPay_Cash_PRD.md`](../EchoPay_Cash_PRD.md) §3 (file layout), §4 (Squad APIs), §6 (backend except in-network), §7 (mobile screens except local-transfer).

You own everything in the mobile build **except** Funbi's local-transfer vertical, plus the Squad-side backend, plus the admin dashboard. Funbi's branch is independent of yours — your branches can land in either order. The only file you both touch is `mobile/app/(tabs)/index.tsx` (home), and the contract for that is in §2.1.

---

## 1. State of the code today (your lane)

Detailed audit so you don't waste time re-discovering it.

### 1.1 Screens that exist and need work

| File | Lines | State | Your task |
|---|---|---|---|
| `mobile/app/login.tsx` | 376 | **done** — palette + persona picker + PIN sheet | nothing |
| `mobile/app/register.tsx` | 618 | **80% done** — palette + NIN flow + PIN step. **Missing the BVN JSX block** (`stage === 'enter-bvn'`); handler `handleBvnVerify` is already wired | finish §3.1 |
| `mobile/app/(tabs)/index.tsx` | 595 | **old red Zenith design**, 9 `#E31937` refs | full repaint + leave slot for Funbi (§3.2) |
| `mobile/app/(tabs)/_layout.tsx` | 135 | 1 red ref (active tint) | swap colors (§3.3) |
| `mobile/app/(tabs)/transactions.tsx` | 246 | 5 red refs, old palette | full repaint (§3.4) |
| `mobile/app/(tabs)/profile.tsx` | 363 | 4 red refs, palette, **+ RNW text rendering bug** (name/bank/account number show blank because raw strings sit outside `<Text>`) | repaint + fix text bug (§3.5) |
| `mobile/app/transfer.tsx` | 991 | 9 red refs, old multi-step flow w/ PIN+voice+face biometric tiers, points at old API | repaint + reframe as external-only (§3.6) |
| `mobile/app/voice-signup.tsx` | 3 | `return null` stub | real shell (§3.7) |
| `mobile/app/receive.tsx` | 3 | `return null` stub | real shell (§3.7) |
| `mobile/app/scan.tsx` | 3 | `return null` stub | real shell (§3.7) |
| `mobile/app/index.tsx` | 34 | 1 red ref (the splash spinner) | swap to `Echopay.accent` |
| `mobile/components/FloatingMicButton.tsx` | 294 | 2 red refs | swap to accent (or hide on web — already gated by parent) |

### 1.2 Services and hooks you own (stubs to fill)

| File | Lines | State |
|---|---|---|
| `mobile/services/squad-api.ts` | 4 | stub: `export {};` — typed wrappers around the backend's Squad-proxy endpoints |
| `mobile/services/storage.ts` | 5 | stub — secure-store helpers (PIN hash, token, ed25519 key handle) |
| `mobile/services/voiceService.ts` | 480 | **working but broken**: hardcoded `DEV_MACHINE_IP = '192.168.0.15'` (wrong for this Mac) |
| `mobile/services/api.ts` | 137 | **working but broken**: 5 `TODO(phase-1)` markers, all paths point at non-existent backend (`/auth/login/`, `/banks/`, etc.) |
| `mobile/hooks/useNetworkStatus.ts` | 3 | stub — wrap `@react-native-community/netinfo` (already installed) |
| `mobile/hooks/useTransactions.ts` | 3 | stub — **Funbi fills** for the local-transfer history slice; you read from it in the transactions tab |
| `mobile/hooks/useBiometricAuth.ts` | 137 | working — used by transfer.tsx |
| `mobile/hooks/useShakeDetection.ts` | 95 | working — web guard already added |
| `mobile/hooks/useWakeWord.ts` | 217 | working — legacy, **do not modify** (gated by CLAUDE.md, already disabled on web at caller) |
| `mobile/hooks/useVoiceRecording.ts` | 253 | working — legacy, do not modify |

### 1.3 Component barrels (empty placeholders to fill if/when you need them)

`components/{primitives,qr,status,transactions,voice}/index.ts` — all 2–4 lines. Fill as needed; don't bulk-fill speculatively.

### 1.4 Doesn't exist yet

- `backend/` directory — you scaffold (coordinate with Funbi on `backend/app/models.py` since they need `wallets` + `transactions` tables for in-network transfer).
- `admin/` directory — you scaffold (HTML + JS, no build step per PRD §3).
- `mobile/components/local-transfer/` — Funbi owns.
- `mobile/app/local-transfer.tsx` — Funbi owns.

### 1.5 Done (don't touch)

- `mobile/constants/theme.ts` (83 lines, `Echopay` palette).
- `mobile/constants/personas.ts` (119 lines, three personas).
- `mobile/services/mono.ts` (262 lines, `verifyNin` + `verifyBvn` with fixtures).
- `mobile/context/AuthContext.tsx` (155 lines, includes `setSession`).
- `mobile/utils/format.ts` (65 lines, money formatters).
- `spike/squad_roundtrip.py` + `requirements.txt` + `.env.example` + `README.md` (waiting on Squad sandbox key — see §13).

---

## 2. The theme (the law)

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

Reference screens already in palette: `app/login.tsx`, `app/register.tsx`. Copy their patterns.

When you're done, this command must return nothing in files you modified:
```bash
grep -rn "#E31937\|#e31937" mobile/app mobile/components/FloatingMicButton.tsx
```

---

## 3. Mobile work — task by task

### 3.1 Finish BVN step in signup

`mobile/app/register.tsx` — the missing piece is the JSX block for `stage === 'enter-bvn'`. Stage type, state, and `handleBvnVerify` are wired.

Add this block, mirroring the existing NIN step pattern:

```
← Back

STEP 2 · BANK KYC
Confirm your BVN
We cross-check your BVN against the NIBSS database.

[small disabled-style card showing the NIN-verified name as context]
"Adunni Folake Bello — Mar 14, 1985"

National Identification Number?  → already verified ✓

[BVN input — 11 digits, formatted 4-4-3]
Bank Verification Number

[Verify BVN]                       primary CTA

● Powered by Mono · BVN lookup via NIBSS

Test BVN pairs (collapsed):
  NIN 12345678901  →  BVN 22288899900
  NIN 22334455667  →  BVN 11122233344
  NIN 98765432101  →  BVN 55566677788
```

The handler `handleBvnVerify` is already in the file. It calls `verifyBvn(bvn, verified?.nin)` from `services/mono.ts`. On success it advances `stage` to `'pin'`. You only need the JSX.

Also update the verified card in the PIN step to show **both** NIN and BVN as confirmed (currently only NIN).

### 3.2 Home tab repaint + Funbi's slot

`mobile/app/(tabs)/index.tsx`:

- Page bg → `Echopay.pageBg`
- Replace red Zenith-styled gradient card with `cardBg` on `pageBg`, hairline `border`, no gradient.
- Header: "Good morning, {first_name}" + cream-bg avatar with dark initials (match login).
- Balance card:
  - Label: "Available balance" (`textMuted`)
  - Number: ₦450,000.00 in bold 32, `text`
  - Subtitle: "As of just now" (`textSubtle`) — placeholder for the offline-first timestamp; actual `NetInfo`-driven logic is post-T2
  - Account number row: "GTBank · 0123 456 789" with a copy icon (visual only)
- **Quick action row — three pills:**

  ```tsx
  <View style={styles.quickActions}>
    <ActionPill icon="paper-plane-outline" label="Send" onPress={() => router.push('/transfer')} />
    {/* SLOT: local-transfer-pill */}
    <ActionPill icon="qr-code-outline" label="Receive" onPress={() => router.push('/receive')} />
  </View>
  ```

  **Leave the slot comment EXACTLY as shown.** Funbi will replace just that one line with `<LocalTransferPill onPress={...} />`. Don't add the Local Transfer pill yourself.

- Recent transactions section: pull from `cache.ts` `getRecentTx()` (Funbi fills the function; you import and render). Empty state styled in palette.
- Drop the "Voice Banking — Try 'Send 5000 to Ade'" panel entirely OR rephrase to a small Yoruba/Pidgin hint card if you want to keep voice front and center. Master doc persona is "Iya Tope," not "Ade."

### 3.3 Tab bar

`mobile/app/(tabs)/_layout.tsx`:

- `tabBarActiveTintColor: Echopay.accent`
- `tabBarInactiveTintColor: Echopay.textSubtle`
- `tabBarStyle.backgroundColor: Echopay.cardBg`
- `tabBarStyle.borderColor: Echopay.border`
- Drop the heavy `shadowOpacity: 0.15` / `elevation: 10` — palette rules say borders only, no shadows.
- Keep the floating-pill geometry (rounded 25, margin 20).

### 3.4 Transactions tab

`mobile/app/(tabs)/transactions.tsx`:

- Page bg → `Echopay.pageBg`
- Header "Transaction History" → `Echopay.text`, weight 700
- Empty state: cream icon circle (`cardSoft`), muted helper text
- Row template (when populated by Funbi's cache):
  - White card with `border` hairline
  - Left: type icon in colored badge (`success` for in, `danger` for out)
  - Middle: counterparty + tx type label
  - Right: amount (red for out, green for in via `success`/`danger`), `textSubtle` timestamp
- Replace 5 red refs with `Echopay.accent` (or `danger` for out indicators if that's what was intended)
- Pull from `useTransactions()` hook (Funbi-owned getter; you import)

### 3.5 Profile tab

`mobile/app/(tabs)/profile.tsx`:

**RNW text bug (visible in current build):** first name, last name, bank name show blank on web because they're raw strings outside `<Text>`. Wrap every raw string in `<Text>`.

Then repaint:

- Page bg → `Echopay.pageBg`
- Avatar circle on `cardSoft` with `text`-colored initials (match login style)
- Menu rows: white cards with `border` hairline, `chevron` style consistent with the login persona cards
- Logout button: secondary style (outlined orange), not primary

Touch the 4 red refs.

### 3.6 Transfer (external) screen

`mobile/app/transfer.tsx` is 991 lines and uses the old red palette heavily (9 refs). Approach:

- **Reframe title:** "Transfer Money" → "Send to any bank"
- **Subtitle:** "Money lands at the recipient's bank in seconds" (the Squad story)
- **Drop the red gradient confirmation card** — use the green-check success pattern from `register.tsx`
- **Replace** every `#E31937` with `Echopay.accent`, every `#f9f9f9` with `Echopay.cardSoft`, etc.
- **Step indicator** (Recipient → Amount → Confirm → PIN → Success): orange dots, gray for inactive
- **Wire to** `services/squad-api.ts` `transferExternal()` (you'll add this — mock with delay until backend lands)
- **Keep** the security tier logic (PIN ≤₦50K, +biometric ≤₦1M, multi-factor >₦1M). Per master doc, voice biometric gates fire on external transfers any amount — adjust if the master doc trumps the existing tiers.

### 3.7 Stub screens — real shells

Each was `return null`. Replace with a real screen in palette. They don't need to be functional this sprint; they must **render** so nobody hits a blank screen during the demo.

#### `mobile/app/scan.tsx`

```
← Back

Scan QR

[Camera viewport placeholder — white card on beige with dashed border]
"Camera view"
"Available on phone — not on web"

Or paste a QR payload manually:
[textarea]

[Scan]                              primary CTA
```

#### `mobile/app/receive.tsx`

```
← Back

Receive money

[Big white card centered on beige]

[QR placeholder — use react-native-qrcode-svg with payload "echopay:demo:0123456789:200"]

Mama Risikat                       below the QR
GTBank · 0123 456 789

[How much?]
[Amount input — Generate ₦X QR]

[Generate]                          primary CTA

● Powered by Squad Dynamic VA · 5-minute expiry
```

Use `react-native-qrcode-svg` (already in deps) with a static payload `"echopay:demo"` for now. Real DVA wire-up is post-T2 / Squad-backend land.

#### `mobile/app/voice-signup.tsx`

Phase 1 redirect:

```tsx
import { Redirect } from 'expo-router';
export default function VoiceSignup() {
  return <Redirect href="/register" />;
}
```

On phone (post-Phase 1), this is the mic-first flow. For this sprint, just redirect so the link doesn't dead-end.

### 3.8 Hooks to fill

`mobile/hooks/useNetworkStatus.ts`:

```ts
import { useNetInfo } from '@react-native-community/netinfo';

export function useNetworkStatus() {
  const net = useNetInfo();
  return {
    isOnline: net.isConnected === true && net.isInternetReachable !== false,
    type: net.type,
  };
}
```

Use this in the home tab to show an "Offline" badge when reachable === false.

### 3.9 Services to fill

`mobile/services/squad-api.ts` — typed wrappers for the backend Squad-proxy endpoints. One function per route:

```ts
import axios from 'axios';
import { API_BASE_URL } from '../constants/config';

const client = axios.create({ baseURL: API_BASE_URL });

export async function voiceSignup(audioB64: string, phone: string): Promise<{ user_id: number; va_number: string; balance_kobo: number }>;
export async function transferExternal(params: { from_user_id: number; bank_code: string; account_number: string; amount_kobo: number; remark: string; idempotency_key: string }): Promise<{ tx_id: string; status: string }>;
export async function createDynamicVa(amount_kobo: number, ttl_seconds: number): Promise<{ dva_number: string; qr_payload: string }>;
export async function getAdminState(): Promise<AdminState>;
```

Until backend lands: each function rejects with a `Backend not ready` error you handle in the calling screen (toast, retry button).

`mobile/services/storage.ts` — secure-store helpers:

```ts
import * as SecureStore from 'expo-secure-store';

export async function setItem(key: string, value: string): Promise<void>;
export async function getItem(key: string): Promise<string | null>;
export async function deleteItem(key: string): Promise<void>;

// Convenience wrappers
export async function setPinHash(hash: string): Promise<void>;       // key: 'pin_hash'
export async function getPinHash(): Promise<string | null>;
export async function incrementPinFailures(): Promise<number>;        // key: 'pin_failures'
export async function resetPinFailures(): Promise<void>;
export async function wipeAll(): Promise<void>;                       // 5-strike kill switch
```

PIN hashing: PBKDF2-SHA256 via `expo-crypto` with 100k iterations, per-device random salt stored alongside hash (per PRD §15.10 fallback if Argon2id is hard to wire in 30 hours).

### 3.10 Fix `voiceService.ts` IP

`mobile/services/voiceService.ts` line 10: `const DEV_MACHINE_IP = '192.168.0.15'`. Change to read from env:

```ts
const DEV_MACHINE_IP = process.env.EXPO_PUBLIC_VOICE_HOST_IP ?? '127.0.0.1';
```

Add `EXPO_PUBLIC_VOICE_HOST_IP` to `mobile/.env.example` with a note that this points at the voice stack on `:8000` (the external EchoPay v1 service, not the new backend). Set it in `mobile/.env` to your dev machine IP.

### 3.11 Decommission `services/api.ts`

5 `TODO(phase-1)` markers. The whole file is from the demo-bank fork and talks to non-existent paths. Approach: leave it for now (your other screens may still import from it — `transfer.tsx` does). As you migrate each screen to `services/squad-api.ts`, delete the matching wrapper here. By the end of your branch, `services/api.ts` should be a thin axios-instance export or deleted.

### 3.12 App-open biometric unlock gate

**Anchors:** PRD §15.5 (Unlock flow, offline-tolerant), §15.3 (key material). This is the security story that makes "offline app open" defensible in Q&A — without a lock screen, opening the app cold means anyone with the unlocked phone gets straight to a wallet with ₦450K in it.

#### Why this is in your lane

The work crosses `app/_layout.tsx` boot logic, `context/AuthContext.tsx` lock state, `services/storage.ts` (which you already own, §3.9), and an unlock screen — all auth/lifecycle, none of which Funbi's local-transfer vertical touches. The existing `hooks/useBiometricAuth.ts` (137 lines, legacy) and `expo-local-authentication` (`~17.0.8`, already installed) carry the OS-side logic. Both work fully offline — biometric matching is local to the Secure Enclave / TEE, no network involved.

#### The contract

```
App cold start
  ↓
AuthContext.loadStoredAuth()  →  reads token + user + account from AsyncStorage
  ↓
  ├── no token  →  /login (persona picker, your existing work)
  └── token  →  set isLocked=true  →  /_unlock
                                          ↓
                              biometric prompt + PIN fallback
                                          ↓
                                    ├── success  →  isLocked=false  →  /(tabs)
                                    └── 5 wrong PIN attempts  →  storage.wipeAll()  →  /login
```

Foreground after >30 seconds in background also re-locks (use `AppState` from `react-native`).

#### Files

```
mobile/app/_unlock.tsx                  NEW — biometric prompt + PIN fallback screen
mobile/context/AuthContext.tsx          ADD  isLocked: boolean, lock(), unlock(), pinFailures: number
mobile/app/_layout.tsx                  GATE  redirect to /_unlock when isAuthenticated && isLocked
mobile/services/storage.ts              FILL  (already on your list in §3.9 — these helpers feed the unlock screen)
mobile/hooks/useBiometricAuth.ts        DO NOT MODIFY  (legacy, gated by CLAUDE.md). Call it from /_unlock.
```

#### `/_unlock` screen behaviour

- On mount: read `LocalAuthentication.hasHardwareAsync()` + `isEnrolledAsync()`. If both true and the user has opted-in (a `'biometric_enabled'` key in secure-store), call `authenticateAsync({reason: 'Unlock EchoPay Cash'})` immediately.
- On biometric success: `AuthContext.unlock()` → `router.replace('/(tabs)')`.
- On biometric failure or "Use PIN instead": show a 4-digit PIN keypad. PIN is verified locally via `storage.verifyPin(input)`.
- On 5 consecutive wrong PINs: `storage.wipeAll()`, `AuthContext.logout()`, `router.replace('/login')`. Show a banner: "You've been signed out. Please sign in again to restore access."
- Style: minimal — wordmark + avatar + persona name + biometric/PIN. Re-uses `Echopay` palette.

#### `services/storage.ts` additions for this feature

You already had these on your §3.9 list — call them out explicitly:
- `setPinHash(pin: string)` — PBKDF2-SHA256 (via `expo-crypto`, 100k iterations) with per-device random salt; stores `{salt, hash}` JSON under `'pin_hash'`.
- `verifyPin(input: string)` → boolean — constant-time compare.
- `incrementPinFailures()` → number — returns the new count. Stored under `'pin_failures'`.
- `resetPinFailures()` — call on every successful unlock.
- `wipeAll()` — deletes `'pin_hash'`, `'pin_failures'`, `'biometric_enabled'`, the session token, and any cached private keys. Triggered after 5 strikes.

#### PIN setup — where it slots into signup

`register.tsx` currently ends with the PIN entry step. Add one step after PIN confirmation:
- "Use Face ID / fingerprint to unlock?" with Skip + Enable.
- On Enable: `LocalAuthentication.authenticateAsync(...)` once to confirm enrolment, then `storage.setItem('biometric_enabled', 'true')`.
- On Skip: leave `'biometric_enabled'` unset; unlock falls through to PIN.

#### Coordination note for Funbi

When this lands, the existing PIN check inside `app/local-transfer.tsx` stage 3 (which currently does `pin !== me.pin` against the persona's bundled PIN) should be refactored to call `storage.verifyPin(pin)` so PIN validation has a single source of truth. ~5-line change, do it in a follow-up.

#### Acceptance

- Cold-start an installed build offline → land on `_unlock` → biometric prompts → success unlocks → home renders.
- Tap "Use PIN instead" → 4-digit pad → wrong PIN 5 times → secure-store wiped, routed to `/login`.
- Foreground after 30s background → re-lock prompt.
- `npm run typecheck` clean.
- No network call required to unlock — verified by toggling airplane mode before app open.

#### Hour estimate

~1.5h: storage helpers (0.5h, already on your list) + `_unlock` screen (0.5h) + AuthContext lock state + _layout gate (0.5h).

---

## 4. Backend work — Squad client + endpoints

PRD §6 lists the full surface. Funbi owns `/transfer/in-network` and its tests. You own everything else.

### 4.1 Scaffold (if Funbi hasn't yet)

```
backend/
├── pyproject.toml
├── .env.example
├── app/
│   ├── main.py
│   ├── core/
│   │   ├── config.py
│   │   └── db.py
│   ├── models.py
│   ├── squad/
│   │   ├── client.py
│   │   ├── static_va.py
│   │   ├── dynamic_va.py
│   │   ├── transfer.py
│   │   └── webhook.py
│   └── api/
│       ├── auth.py
│       ├── voice_proxy.py
│       ├── transfer.py            ← shared file w/ Funbi
│       ├── dva.py
│       ├── webhooks.py
│       └── admin.py
├── seed.py
└── tests/
    ├── test_squad_client.py
    ├── test_webhook_hmac.py
    └── test_in_network_transfer.py    ← Funbi's
```

Coordinate with Funbi on `app/models.py` (you both need `wallets` + `transactions` tables).

### 4.2 Squad client (`app/squad/client.py`)

PRD §4 + the spike script (`spike/squad_roundtrip.py`) have everything. Key rules:

- Sandbox base `https://sandbox-api-d.squadco.com`, never call production.
- All amounts in kobo.
- Every call goes through `client.py` — never `httpx.post(...)` from anywhere else.
- 424 on Transfer → call `/payout/requery` every 5s up to 60s. Never retry the Transfer with the same ref.
- HMAC over **raw request body bytes**, never `json.dumps(json.loads(body))`.
- HMAC-SHA512 V2 field order: `transaction_ref | virtual_account_number | principal_amount | settled_amount | transaction_currency | customer_id`
- Always return HTTP 200 to incoming webhooks, even on signature failure.
- `webhook_events.transaction_ref` UNIQUE — idempotency check before processing.

The spike file already has working `verify_hmac_v2`, `create_va`, `simulate_payment`, `account_lookup`, `transfer`, `_requery_poll` functions. Port them into `app/squad/`.

### 4.3 Endpoints (`app/api/*.py`)

From PRD §6:

- `POST /auth/voice-signup` (`auth.py`): Whisper → name → Mono NIN+BVN (call out to your own service) → Squad B2C Static VA → write user + wallet rows
- `POST /voice/intent`, `POST /voice/biometric/verify` (`voice_proxy.py`): forward to `:8000` voice stack with a short-lived HS256 service JWT
- `POST /transfer/voice-initiate` (`transfer.py`, shared w/ Funbi): handle EXTERNAL only — Squad `/payout/account/lookup` → `/payout/transfer` → 424 requery
- `POST /dynamic-va/create` (`dva.py`): Squad `/virtual-account/initiate-dynamic-virtual-account` from a pool
- `POST /webhooks/squad` (`webhooks.py`): HMAC-SHA512 V2 validation, idempotent, dispatches by event type
- `GET /admin/state` (`admin.py`): returns `{wallets, recent_transactions, recent_webhooks, reconciliation: {squad_balance_kobo, sum_wallets_kobo, delta_kobo}}`
- `POST /admin/reconcile` (`admin.py`): Squad `/account/balance` for master VA → diff against `sum(wallets)` → return delta

### 4.4 Seed

`backend/seed.py` — idempotent script that:

1. Creates three users from `mobile/constants/personas.ts` (mama_risikat, iya_tope, kosi)
2. Calls Squad `/virtual-account` for each to get a real sandbox VA number
3. Writes `wallets` rows with starting balances (Mama ₦450K, Iya ₦125K, Kosi ₦80K — in kobo: 45_000_000 / 12_500_000 / 8_000_000)
4. On re-run: skips existing users

Run once on first boot. Required before any demo.

---

## 5. Admin dashboard

`admin/index.html` + `admin/app.js` — static, no build step (PRD §3). Open with `python -m http.server 5173` in `admin/`. Project on the second screen during stage demo.

Layout:
- **Top banner:** "Reconciliation — sum(wallets) ₦X · master VA ₦Y · delta ₦Z" — green if delta=0, red otherwise. "Reconcile now" button.
- **Wallets table:** name, VA number, balance (formatted), last updated.
- **Transactions table:** last 20, time / type / direction / amount / status / squad_ref.
- **Webhooks table:** last 20, time / source / transaction_ref / signature_valid.
- New webhooks flash green for 2 seconds.

Polls `GET /admin/state` every 1 second. No SSE in v1.

---

## 6. Files you touch

```
mobile/app/register.tsx                  (finish BVN step JSX)
mobile/app/(tabs)/index.tsx              (home repaint + leave Funbi's slot)
mobile/app/(tabs)/_layout.tsx            (tab colors)
mobile/app/(tabs)/transactions.tsx       (palette + read from useTransactions)
mobile/app/(tabs)/profile.tsx            (palette + RNW text fix)
mobile/app/transfer.tsx                  (external — palette + reframe + wire squad-api)
mobile/app/scan.tsx                      (real shell)
mobile/app/receive.tsx                   (real shell with QR placeholder)
mobile/app/voice-signup.tsx              (redirect to /register)
mobile/app/index.tsx                     (splash spinner color)
mobile/components/FloatingMicButton.tsx  (accent swap)
mobile/services/squad-api.ts             (typed wrappers)
mobile/services/storage.ts               (secure-store helpers)
mobile/services/voiceService.ts          (env-driven IP)
mobile/services/api.ts                   (decommission as you migrate)
mobile/hooks/useNetworkStatus.ts         (NetInfo wrapper)

backend/app/main.py                      (or shared w/ Funbi)
backend/app/core/{config,db}.py
backend/app/models.py                    (shared w/ Funbi)
backend/app/squad/{client,static_va,dynamic_va,transfer,webhook}.py
backend/app/api/auth.py
backend/app/api/voice_proxy.py
backend/app/api/transfer.py              (external + voice-initiate only — Funbi adds in-network)
backend/app/api/dva.py
backend/app/api/webhooks.py
backend/app/api/admin.py
backend/seed.py
backend/tests/test_squad_client.py
backend/tests/test_webhook_hmac.py

admin/index.html
admin/app.js
```

---

## 7. Acceptance criteria

### Mobile
- Sign up: NIN → BVN → PIN → done, with three demo NIN/BVN pairs all working.
- Tab bar active state is orange.
- Home tab uses Echopay palette. The local-transfer slot is present and reads `{/* SLOT: local-transfer-pill */}`.
- Transactions tab reads from `cache.getRecentTx()` and renders rows in palette.
- Profile tab shows actual first name, last name, bank name (no blank text). Menu items show labels (no icons-only).
- Transfer (external) screen is in palette and wired to `services/squad-api.ts` `transferExternal()`.
- Scan / receive / voice-signup screens render without crashing — no blank `return null` screens left.
- `grep -rn "#E31937" mobile/app mobile/components/FloatingMicButton.tsx` returns **nothing** in modified files.
- `npm run typecheck` clean.

### Backend
- Squad sandbox roundtrip is green: Static VA created → simulate payment → webhook with `signature_valid: true` → Transfer fired → either 200 or requery to terminal state.
- `seed.py` runs idempotently; `curl localhost:8100/admin/state` returns 3 wallets.
- HMAC V2 unit tests pass.

### Admin
- Open `admin/index.html`, see live wallet state polling every 1s.
- Trigger a simulated payment in the spike → webhook flashes green on the dashboard within 1.5s.
- "Reconcile now" button posts to `/admin/reconcile` and shows `delta = 0`.

---

## 8. Out of scope (Funbi owns these)

- `app/local-transfer.tsx` and `components/local-transfer/Pill.tsx`.
- `services/transfer.ts` (the in-network function).
- `services/cache.ts` and `hooks/useWallet.ts` (Funbi fills; you only **read** via `useTransactions` and the home balance display).
- `POST /transfer/in-network` backend endpoint and its 20+ tests.

If Funbi finishes their branch first and merges, you'll inherit working cache/useWallet — your transactions tab and home balance just light up.

---

## 9. Workflow

Per `CLAUDE.md`:

```bash
git checkout main && git pull origin main
git checkout -b feat/mobile-shell-and-squad        # or split into smaller PRs (recommended)
```

Recommended split into smaller PRs for faster review:

1. `feat/mobile-palette` — items 3.1 through 3.8 (UI sweep) — biggest visual win, ship first
2. `feat/mobile-services` — items 3.9 through 3.11 (services + storage + voice IP fix)
3. `feat/backend-squad` — items 4.1 through 4.4 (Squad client + endpoints)
4. `feat/admin-dashboard` — item 5

Each PR:
```bash
git push -u origin feat/<name>
gh pr create --title "..." --body-file <(cat <<EOF
## Summary
- <2-3 bullets>

## Test plan
1. ...
2. ...
3. ...

Refs: docs/PRD_LEKE.md §<numbers>, EchoPay_Cash_PRD.md §<numbers>
EOF
)
```

**No Co-Authored-By: Claude trailer. No "Generated with Claude Code" footer.** Commits are yours.

---

## 10. Hour estimate

| Bucket | Tasks | Hours |
|---|---|---|
| Mobile UI sweep | BVN finish (0.5) + home (1) + tabs (0.25) + transactions (0.75) + profile (0.75) + transfer external (1.0) + 3 stubs (1) + splash + mic (0.25) | **~5.5h** |
| Mobile services + fixes | squad-api wrappers (0.5) + storage (0.5) + voice IP (0.1) + api.ts decommission (0.25) + useNetworkStatus (0.15) | **~1.5h** |
| Backend Squad | scaffold (0.5) + client.py (1) + static_va + dynamic_va + transfer + webhook (1.5) + endpoints (1.5) + seed (0.5) + tests (1) | **~6h** |
| Admin dashboard | HTML + JS + polling + reconciliation banner | **~1.5h** |
| **Total** | | **~14.5h** |

This is the larger pile. Split into multiple PRs to land incrementally. If the backend half is too much solo, peel it off and pair-program with Funbi after their local-transfer PR lands.

---

## 11. Coordination touchpoints with Funbi

1. **Home tab slot.** You leave `{/* SLOT: local-transfer-pill */}`. Funbi replaces it. Don't add the pill yourself.
2. **`backend/app/models.py`.** First writer creates it with `wallets` + `transactions` tables matching PRD §5. Second writer reviews.
3. **`backend/app/api/transfer.py`.** You add the `/transfer/voice-initiate` (external) route. Funbi adds the `/transfer/in-network` route in the same file. Different functions, no overlap.
4. **`services/cache.ts` + `hooks/useTransactions.ts`.** Funbi fills these. You import and render — don't re-implement.

If you finish before Funbi: your branch can merge first; Funbi rebases. If Funbi finishes first: their branch merges; you rebase to pick up `cache.ts` + `useWallet.ts` for your home balance / transactions tab.

---

## 12. Done definition for your share of the sprint

- Every tab uses Echopay palette. No red anywhere except `Echopay.danger` in error states.
- Signup flow: NIN → BVN → PIN → done, three demo pairs work.
- Squad sandbox roundtrip green (spike + integrated through backend client).
- Admin dashboard projects live state.
- All stub screens replaced with real shells.
- Profile renders all text correctly on web.

---

## 13. Squad sandbox key — the gate

`spike/squad_roundtrip.py` is ready to run. It needs `SQUAD_SECRET_KEY` in `spike/.env`. Get it from https://sandbox.squadco.com → Merchant Settings → API and WEBHOOKS, paste it in, and run:

```bash
cd spike
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env, paste the sandbox secret key
python squad_roundtrip.py create-va --persona mama_risikat
# in another terminal: cloudflared tunnel --url http://localhost:9000
# in a third: python squad_roundtrip.py listen
# then: python squad_roundtrip.py simulate --va <va_number> --amount-kobo 50000
# watch the listener terminal for: signature_valid: True
```

This must pass before §4 (Squad backend integration) can be considered green.

Ship it.
