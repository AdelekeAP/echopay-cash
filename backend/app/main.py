"""FastAPI app entrypoint.

Boots on :8100 (see backend/README.md for the run command). Tables are
created on startup; in production a real migration tool would replace
create_all() — for hackathon scope, idempotent SQLite is enough.

Routers wired:
  - /transfer/in-network        (Funbi)
  - /wallet/lock|unlock         (Funbi)
  - /sync                       (Funbi)
  - /auth                       (Leke)
  - /permits + /sync/submit     (offline ed25519 payments — master doc §4.2)
  - /crypto/server-pubkey       (mobile pins this at boot)
  - /dynamic-va                 (Leke — per-QR Squad VA)
  - /webhooks/squad             (Leke — inbound credit settlement)
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .core.config import get_settings
from .models import create_all
from .api.transfer import router as transfer_router
from .api.wallet import router as wallet_router
from .api.sync import router as sync_router
from .api.auth import router as auth_router
from .api.permits import router as permits_router
from .api.offline_sync import router as offline_sync_router
from .api.dva import router as dva_router
from .api.webhooks import router as webhooks_router
from .api.admin import router as admin_router
from .api.voice_intent import router as voice_intent_router
from .api.loans import router as loans_router
from .api.voice_proxy import router as voice_proxy_router
from .core.crypto import get_server_pubkey_b64

settings = get_settings()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    create_all()
    yield


app = FastAPI(
    title="EchoPay Cash backend",
    version="0.1.0",
    description="In-network transfer + Squad-proxy backend for the GTCO Squad Hackathon 3.0.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["meta"])
def health() -> dict:
    return {"success": True, "data": {"status": "ok"}}


app.include_router(transfer_router)
app.include_router(wallet_router)
app.include_router(sync_router)
app.include_router(auth_router)
app.include_router(permits_router)
app.include_router(offline_sync_router)
app.include_router(dva_router)
app.include_router(webhooks_router)
app.include_router(admin_router)
app.include_router(voice_intent_router)
app.include_router(loans_router)
app.include_router(voice_proxy_router)


@app.get("/crypto/server-pubkey", tags=["meta"])
def server_pubkey() -> dict:
    """Mobile pins this once at boot. Used to verify permit signatures
    fully offline (master doc §4.2). Rotate => mobile re-pin.
    """
    return {"success": True, "data": {"ed25519_pub_b64": get_server_pubkey_b64()}}
