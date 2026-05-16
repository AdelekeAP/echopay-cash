# EchoPay Cash

Voice-first Squad-powered payment wallet for Nigeria's cash economy.
Built for GTCO Squad Hackathon 3.0, May 15–16 2026.

## Live deployments

| | URL |
|---|---|
| **API** (HTTPS, Let's Encrypt via Caddy) | https://funbi.online |
| **API docs** (Swagger UI) | https://funbi.online/docs |
| **Health check** | https://funbi.online/health |
| **Web app** (Vercel static deploy of the Expo web bundle) | https://mobile-1ojx79rzh-funbis-projects-e6f7ddff.vercel.app |

Architecture in production: DigitalOcean droplet (London) runs the
FastAPI container exposed on :8100, fronted by Caddy on :80/:443 for
TLS termination + HTTP→HTTPS redirect. Vercel serves the Expo web
bundle as static assets and the app calls the API at
`https://funbi.online`. The DNS for `funbi.online` is at Hostinger
(A → 144.126.231.148, www CNAME → funbi.online).

## Team

Adeleke Aladenusi (Leke), Funbi Onaeko, Kosi — Team BB.

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
| `backend/` | FastAPI service on `:8100`. Squad integration, ledger, webhooks, reconciliation, voice-intent proxy, voice-biometric proxy (Path A + Path C), loans, anomaly detection. |
| `admin/` | Static HTML reconciliation dashboard. 2s polling on `/admin/state`. 4-persona grid + reconcile invariant + anomaly alerts panel. |
| `spike/` | Throwaway Squad sandbox round-trip script. Deleted before demo. |
| `docs/` | Architecture and design docs. Start with [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). |
| `EchoPay_Cash_PRD.md` | Full implementation spec — data model, endpoints, screens, offline shell, decision tree. |

## Run locally — 2-minute Docker path (recommended)

```bash
git clone https://github.com/AdelekeAP/echopay-cash
cd echopay-cash
cp backend/.env.example backend/.env
# edit backend/.env: fill in SQUAD_SECRET_KEY, SQUAD_PUBLIC_KEY, SQUAD_MERCHANT_ID
docker compose up -d --build
# verify:
curl http://localhost:8100/health
# → {"success":true,"data":{"status":"ok"}}
```

The container persists SQLite + the ed25519 server signing key on a named
volume (`echopay-data`), so permits and balances survive `docker compose
restart`. To start over: `docker compose down -v`. The same `docker
compose up -d --build` is what we run on the production droplet.

Mobile dev server (separate, runs on your host):

```bash
cd mobile && npm install && cp .env.example .env
# edit .env: EXPO_PUBLIC_API_BASE_URL=http://<dev-machine-or-droplet-IP>:8100
npx expo start
# scan the QR with Expo Go
```

## Run locally — manual venv path (if you'd rather not use Docker)

```bash
git clone https://github.com/AdelekeAP/echopay-cash
cd echopay-cash

# Backend (FastAPI on :8100)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env: set OPENAI_API_KEY, SQUAD_SECRET_KEY (or leave empty for synthetic mode)
python -m seed         # populates 4 personas + Musa's gig history + Mama's anomaly seed
uvicorn app.main:app --reload --host 0.0.0.0 --port 8100
# Voice services (Whisper + ECAPA-TDNN biometric) run on :8000 as an
# external HTTP dependency — see docs/ARCHITECTURE.md. The proxy layer
# in backend/app/api/voice_proxy.py has a Path C demo-mode bypass
# (VOICE_BIOMETRIC_DEMO_MODE=true) for offline demo safety.

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
