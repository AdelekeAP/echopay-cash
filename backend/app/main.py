"""FastAPI app entrypoint.

Boots on :8100 (see backend/README.md for the run command). Tables are
created on startup; in production a real migration tool would replace
create_all() — for hackathon scope, idempotent SQLite is enough.

Leke's PRs add routers for /auth, /voice, /transfer/voice-initiate,
/dynamic-va, /webhooks/squad, /admin/* — all wire into this same app.
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
from .api.dva import router as dva_router
from .api.webhooks import router as webhooks_router

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
app.include_router(dva_router)
app.include_router(webhooks_router)
