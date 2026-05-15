# EchoPay Cash

Voice-first Squad-powered payment wallet for Nigeria's cash economy.
Built for GTCO Squad Hackathon 3.0, May 15–16 2026.

## Team

Adeleke Oluwasanmi (Leke), Funbi Onaeko, Kosi — Team Echo.

Our team has shipped voice AI infrastructure before with EchoPay v1 (voice banking)
and EchoMind (voice healthcare assistant). This repo contains the new product we built
for the GTCO Squad Hackathon 3.0: a Squad-powered wallet with voice signup, QR-based
inbound payments via Squad Dynamic Virtual Accounts, and a closed-loop ledger
architecture for offline-resilient payments between EchoPay users.

The voice stack (Whisper, intent extraction, ECAPA-TDNN biometric) is reused as an
HTTP dependency from our existing infrastructure. All Squad integration, the
permit-based offline ledger, the wallet, the QR mechanic, and the admin
reconciliation dashboard were built specifically for this hackathon.

## What's in this repo

| Path | What it is |
|---|---|
| `mobile/` | React Native (Expo SDK 54) client. Voice signup, transfer, receive-QR, wallet, offline-tolerant boot. |
| `backend/` | FastAPI service on `:8100`. Squad integration, ledger, webhooks, reconciliation. _(scaffolded in a later phase)_ |
| `admin/` | Static HTML reconciliation dashboard. 1s polling on `/admin/state`. _(scaffolded in a later phase)_ |
| `spike/` | Throwaway Squad sandbox round-trip script. Deleted before demo. |
| `docs/` | Architecture and design docs. Start with [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). |
| `EchoPay_Cash_PRD.md` | Full implementation spec — data model, endpoints, screens, offline shell, decision tree. |

## Run locally — 10-minute clone-to-demo path

```bash
git clone https://github.com/AdelekeAP/echopay-cash
cd echopay-cash

# Backend — see backend/README.md when scaffolded by other team member
# (echopay-cash backend lives on :8100; the voice services on :8000 are
#  an external HTTP dependency, not in this repo — see docs/ARCHITECTURE.md.)

# Mobile
cd mobile
npm install
cp .env.example .env
# edit .env: set EXPO_PUBLIC_API_BASE_URL to your dev machine LAN IP
npx expo start
# scan the QR code with Expo Go on your phone
```

> **Voice services callout.** The Whisper transcription and ECAPA-TDNN voice
> biometric run on `:8000` as a separate HTTP service (reused from our prior
> EchoPay v1 work). The mobile app and the echopay-cash backend reach it
> over HTTP — there is no code dependency. See
> [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the boundary.

## Architecture

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the three-tier
diagram (mobile → backend → Squad), the four critical data flows (voice
signup, voice transfer, QR receive, reconciliation), the closed-loop ledger
invariant, and the honest offline scope.

The mobile-internal layer split lives at
[`mobile/docs/ARCHITECTURE.md`](./mobile/docs/ARCHITECTURE.md).

## License

MIT
