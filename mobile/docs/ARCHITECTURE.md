# Mobile architecture — echopay-cash

## The 5-layer separation

```
app/        → expo-router screens. Presentation only.
hooks/      → reusable logic, no UI.
services/   → I/O — HTTP, secure-store, SQLite. No React.
types/      → shared TypeScript shapes.
utils/      → pure functions. No side effects.
```

**Rules (enforce in review):**

- Screens (`app/*.tsx`) never call services directly — they consume hooks.
- Hooks never render JSX.
- Services never import from `react`, `react-native`, or `expo-router`.
- Types and utils are imported freely from any layer.

Why this matters: when the demo backend on `:8100` is unreliable on stage,
the only edits we make are inside `services/squad-api.ts`. Screens and hooks
don't move. Likewise when the UI needs polish, screens change without
touching the network surface.

## Why kobo at every boundary

All monetary amounts — in storage, in API payloads, in hook state, in
backend tables — are **integers in kobo** (₦1 = 100 kobo). Floating-point
naira values are forbidden because `0.1 + 0.2 !== 0.3`. Conversion to
human-readable naira happens at exactly one place: `utils/format.ts`.
Conversion the other way (user input → kobo) happens at exactly one place:
`utils/format.ts:parseNairaToKobo()`. If you find yourself writing
`amount * 100` anywhere else, stop and use the helper.

## Storage policy — secure-store vs AsyncStorage vs SQLite

| Item | Where | Why |
|---|---|---|
| ed25519 private key | `expo-secure-store` | OS keychain / hardware-backed. The only secret worth protecting at rest. |
| PIN hash (Argon2id) | `expo-secure-store` | Never leaves device. 5-strike wipe rule lives at this layer. |
| Session token (JWT) | `expo-secure-store` | Survives uninstall on iOS unless explicitly cleared. |
| Cached balance / VA number / profile | AsyncStorage | Not a secret. Plaintext is fine — server is authoritative. |
| Tx history, outbox queue | `expo-sqlite` | Relational shape; outbox needs ordered drain (PRD §15.7). |
| Voice biometric embedding | server-side only | Privacy: never leaves the user's device until signup, never re-uploaded. |

No SQLCipher. The only secret worth encrypting is the private key, and it
lives in the OS keychain. Encrypting the SQLite cache adds work for no
threat reduction (see PRD §15.3).

## Boot path (offline-tolerant)

Forward-reference to PRD §15.4. Critical rule: **no synchronous network
call during boot.** The existing source app calls `bankAPI.getBanks()` and
`accountAPI.getProfile()` on home-screen mount — those must become
non-blocking with cached fallback as part of Phase 1.

The boot sequence:

1. App launches.
2. Read `session_token` from `expo-secure-store`. Missing → show login.
3. Open SQLite cache, hydrate last-known profile + balance + tx history.
4. Render home screen with offline badge unless `NetInfo.isConnected`.
5. In background: refresh balance + tx if online. On 401, refresh token.
6. UI never blocks on a network call.

## How to add a new screen

1. Create `app/<screen-name>.tsx`. Default export a screen component. Keep
   it presentation-only.
2. If the screen needs logic that other screens might reuse, create
   `hooks/use<ScreenName>.ts` and put it there. The screen consumes the
   hook.
3. If the screen calls the backend, the call goes through
   `services/squad-api.ts`. Add a typed wrapper there, don't fetch inline.
4. If the response is a new shape, add the type to `types/api.ts` (or a
   topical file like `types/wallet.ts`).
5. If the screen formats money, use `utils/format.ts`. Never `* 100` or
   `/ 100` inline.

## What's already wired

- `services/api.ts` — legacy axios client from the source fork. Endpoint
  groups (`authAPI`, `bankAPI`, etc.) are still in place but marked TODO.
  Phase 1 migrates each call site to `services/squad-api.ts`.
- `hooks/useVoiceRecording.ts` — voice capture, drives every voice flow.
- `components/VoiceModal.tsx`, `EchoOrb.tsx`, etc. — voice UI primitives at
  `components/` root.

## Legacy voice components

The voice UI primitives (EchoOrb, VoiceModal, VoiceEnrollment, Waveform, FloatingMicButton) and the voice hooks (useVoiceRecording, useWakeWord) were inherited from EchoPay v1 and predate this repo's strict-TypeScript configuration. They function correctly at runtime and are excluded from `tsc --noEmit` until they're migrated post-hackathon. New voice components added during the hackathon belong in `components/voice/`.

## Cross-reference

- Backend API surface: `echopay-cash/EchoPay_Cash_PRD.md` §6.
- Data model: PRD §5.
- Screen list: PRD §7.
- Offline shell + security: PRD §15.
