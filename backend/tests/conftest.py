"""Pytest fixtures for the in-network transfer tests.

Each test gets a fresh SQLite DB in a tempdir so cases are isolated and
parallel runs don't stomp on each other. The TestClient hits the real
app, so we exercise the FastAPI router, the dependency, and the SQLite
write path end-to-end.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator

import pytest

# Configure the DB URL BEFORE importing the app, so the engine binds to
# the per-test file. `get_settings` is lru_cached, so we also clear it.


@pytest.fixture
def db_path() -> Iterator[str]:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        yield path
    finally:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


@pytest.fixture
def client(db_path: str, monkeypatch: pytest.MonkeyPatch):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_path}")

    # Rebuild the module graph so the engine binds to the temp DB
    import importlib
    import sys

    # Drop any cached app modules so config + engine re-evaluate.
    # Any module that imports `app.core.db` directly or transitively
    # must appear here, or it will keep a reference to the previous
    # test's engine and write to the wrong SQLite file.
    for mod in [
        "app.api.transfer",
        "app.api.wallet",
        "app.api.sync",
        "app.api.permits",
        "app.api.offline_sync",
        "app.api.voice_intent",
        "app.api.voice_proxy",
        "app.api.anomalies",
        "app.api.loans",
        "app.api.admin",
        "app.api.auth",
        "app.voice.proxy",
        "app.services.intent_parser",
        "app.main",
        "app.models",
        "app.core.db",
        "app.core.config",
        "app.core.crypto",
        "seed",
    ]:
        sys.modules.pop(mod, None)

    from app.core.config import get_settings  # noqa: WPS433 — late import is intentional

    get_settings.cache_clear()  # type: ignore[attr-defined]

    main = importlib.import_module("app.main")
    main.create_all()

    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def seed_wallets(client):
    """Seed three users + wallets directly via the model layer.

    Returns a dict of user_id → starting balance_kobo for easy assertions.
    """
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")

    spec = [
        ("alice@test", "Alice", "A", "+2348011111111", "0111111111", 10_000_00),  # ₦10,000
        ("bob@test", "Bob", "B", "+2348022222222", "0222222222", 5_000_00),         # ₦5,000
        ("carol@test", "Carol", "C", "+2348033333333", "0333333333", 1_000_00),     # ₦1,000
    ]

    ids: dict[str, int] = {}
    with db_mod.db_session() as db:
        for ident, fn, ln, phone, va, bal in spec:
            with db.begin():
                u = models.User(
                    customer_identifier=ident,
                    first_name=fn,
                    last_name=ln,
                    phone=phone,
                    email=f"{ident}",
                    created_at=models.now_unix(),
                )
                db.add(u)
                db.flush()
                db.add(
                    models.Wallet(
                        user_id=u.id,
                        squad_va_number=va,
                        balance_kobo=bal,
                        updated_at=models.now_unix(),
                    )
                )
                ids[fn.lower()] = u.id
    return ids


@pytest.fixture
def auth_header():
    """Bearer-token header builder for endpoints that derive user_id
    from the token (transfer/in-network, dva/create, voice/intent).

    Usage in tests:
        client.post(url, json=body, headers=auth_header(user_id))
    """
    import time

    def _make(user_id: int) -> dict[str, str]:
        return {"Authorization": f"Bearer demo_token_{user_id}_{int(time.time())}"}

    return _make


@pytest.fixture
def wallet_reader(client):
    """Helper to read a wallet's current balance from the test DB."""
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")

    def _read(user_id: int) -> dict | None:
        with db_mod.db_session() as db:
            w = db.get(models.Wallet, user_id)
            if not w:
                return None
            return {
                "user_id": w.user_id,
                "balance_kobo": w.balance_kobo,
                "version": w.version,
            }

    return _read
