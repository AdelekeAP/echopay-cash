# EchoPay Cash backend

FastAPI + SQLAlchemy + SQLite on `:8100`. PRD §3 / §6.

## Run

```bash
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env

python seed.py                                # 3 demo personas + wallets
uvicorn app.main:app --reload --port 8100

curl http://localhost:8100/health
```

## Test

```bash
pytest -v
```

20+ tests on `POST /transfer/in-network` covering idempotency, concurrency,
input validation, and ledger conservation. PRD §11 Risk 3.

## What's here vs what's next

This branch ships the in-network transfer vertical only — PRD_FUNBI.md.
Leke's follow-up branches add `/auth`, `/voice-proxy`, `/transfer/voice-initiate`
(external), `/dynamic-va/create`, `/webhooks/squad`, `/admin/*`, and the
Squad client per `docs/PRD_LEKE.md` §4.
