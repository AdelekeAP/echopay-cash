"""Tests for POST /dynamic-va/create.

Mirrors test_auth_voice_signup.py: per-test SQLite DB via `client` from
conftest.py, monkeypatch `create_dynamic_va` so no live Squad calls hit
the network in CI, and an autouse fixture clears my module-level caches
between tests (settings, squad client, dva router synthetic counter).

Coverage (8 tests):
  1. Happy path with Bearer token + mocked Squad → 200, pending tx row
  2. Synthetic fallback when SQUAD_SECRET_KEY="" → 200, demo_mode=true
  3. Idempotency: same body twice within bucket → same tx_id
  4. Auth via body user_id (no Bearer) → 200
  5. Auth required: no Bearer + no user_id → 401 auth_required
  6. Invalid amount (0) → 422 (Pydantic strict gt=0)
  7. Squad failure → 503 squad_failed
  8. Wallet not found → 404 wallet_not_found
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _drop_stale_dva_modules():
    """Pop my modules BEFORE conftest's `client` fixture runs.

    Funbi's conftest pops `app.main` + `app.core.db` + `app.models` +
    `app.core.config` + `app.api.transfer` between tests, then re-imports
    `app.main`. That re-import pulls `from .api.dva import router` — but
    if `app.api.dva` is still cached from a prior test file's run, it
    keeps stale references to the old `Transaction`/`User`/`Wallet`
    classes (which are bound to a different engine + DB file).

    Result: the DVA endpoint writes to the previous test's DB, while
    the new test's helpers read from the current test's DB. `_count_qr_rows`
    sees zero, assertion fails.

    Fix: pop my modules in a fixture that DOESN'T depend on `client`, so
    pytest runs it before `client`. Conftest then re-imports `app.main`
    and `from .api.dva` triggers a fresh import bound to the new models.

    Same for the synthetic-counter reset.
    """
    import sys

    for mod_name in (
        "app.api.dva",
        "app.api.auth",
        "app.squad.dynamic_va",
        "app.squad.static_va",
        "app.squad.client",
        "app.voice.proxy",
    ):
        sys.modules.pop(mod_name, None)

    yield

    # Belt-and-braces post-cleanup so the next test starts clean
    # even if it doesn't import this fixture.
    for mod_name in (
        "app.api.dva",
        "app.api.auth",
        "app.squad.dynamic_va",
        "app.squad.static_va",
        "app.squad.client",
        "app.voice.proxy",
    ):
        sys.modules.pop(mod_name, None)


@pytest.fixture(autouse=True)
def _reset_synthetic_counter(client):  # noqa: ARG001 — order AFTER client
    """Reset the synthetic DVA round-robin so test_synthetic_fallback
    can assert the first pool entry deterministically. Runs AFTER
    `client` so app.api.dva is freshly imported by app.main."""
    try:
        from app.api import dva as dva_module
        dva_module._reset_synthetic_counter()
    except (ImportError, AttributeError):
        pass
    yield


# --------------------------------------------------------------- helpers


def _seed_persona(customer_identifier: str, va_number: str, balance_kobo: int = 0) -> int:
    """Insert a user + wallet, return user_id. Direct ORM write."""
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        with db.begin():
            u = models.User(
                customer_identifier=customer_identifier,
                first_name="Mama Risikat",
                last_name="Oluwole",
                phone="+234 801 234 5001",
                email=f"{customer_identifier}@echopay.test",
                created_at=models.now_unix(),
            )
            db.add(u)
            db.flush()
            db.add(
                models.Wallet(
                    user_id=u.id,
                    squad_va_number=va_number,
                    balance_kobo=balance_kobo,
                    updated_at=models.now_unix(),
                )
            )
            return u.id


def _seed_user_without_wallet(customer_identifier: str) -> int:
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        with db.begin():
            u = models.User(
                customer_identifier=customer_identifier,
                first_name="Orphan",
                last_name="NoWallet",
                phone="+234 801 234 5099",
                email="orphan@echopay.test",
                created_at=models.now_unix(),
            )
            db.add(u)
            db.flush()
            return u.id


def _count_qr_rows(user_id: int) -> int:
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        return (
            db.query(models.Transaction)
            .filter(
                models.Transaction.user_id == user_id,
                models.Transaction.type == "qr_receive",
            )
            .count()
        )


@pytest.fixture
def mock_squad_dva(monkeypatch):
    """Returns a setter — call mock_squad_dva(va_number=..., raise_error=...)."""

    def _install(
        va_number: str = "9988776655",
        reference: str = "ECHOPAYCASH_test_ref",
        expires_at: int = 9_999_999_999,
        raise_error: str | None = None,
    ):
        from app.api import dva as dva_module
        from app.squad import client as squad_client
        from app.squad.dynamic_va import DynamicVAResult

        async def fake_create_dynamic_va(client, **kwargs):
            if raise_error == "auth":
                raise squad_client.SquadAuthError("mocked auth error", status_code=401)
            if raise_error == "generic":
                raise squad_client.SquadError("mocked generic error")
            return DynamicVAResult(
                {
                    "va_number": va_number,
                    "reference": reference,
                    "expires_at": expires_at,
                }
            )

        monkeypatch.setattr(dva_module, "create_dynamic_va", fake_create_dynamic_va)

    return _install


@pytest.fixture
def squad_key(monkeypatch):
    """Set or clear SQUAD_SECRET_KEY for the duration of the test."""

    def _install(key: str = "sandbox_test_key"):
        monkeypatch.setenv("SQUAD_SECRET_KEY", key)
        from app.core import config as config_module
        config_module.get_settings.cache_clear()

    return _install


def _bearer(user_id: int, unix: int = 1_700_000_000) -> str:
    return f"Bearer demo_token_{user_id}_{unix}"


# --------------------------------------------------------------- tests


def test_happy_path_with_bearer_token(client, mock_squad_dva, squad_key):
    squad_key("sandbox_test_key")
    mock_squad_dva(va_number="9988776655", reference="ECHOPAYCASH_xyz")
    uid = _seed_persona("mama_001", "0123456789")

    r = client.post(
        "/dynamic-va/create",
        json={"amount_kobo": 20_000, "ttl_seconds": 300},
        headers={"Authorization": _bearer(uid)},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    data = body["data"]
    assert data["dva_number"] == "9988776655"
    assert data["amount_kobo"] == 20_000
    assert data["reference"] == "ECHOPAYCASH_xyz"
    assert data["demo_mode"] is False
    assert data["tx_id"].startswith("qr_")
    assert data["qr_payload"].startswith(f"echopay:dva:9988776655:20000:{data['tx_id']}")

    # Pending tx row landed in DB.
    assert _count_qr_rows(uid) == 1


def test_synthetic_fallback_when_no_squad_key(client, monkeypatch):
    monkeypatch.setenv("SQUAD_SECRET_KEY", "")
    from app.core import config as config_module
    config_module.get_settings.cache_clear()

    uid = _seed_persona("mama_002", "0123456789")

    r = client.post(
        "/dynamic-va/create",
        json={"amount_kobo": 50_000},
        headers={"Authorization": _bearer(uid)},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    # Synthetic pool starts at 9012345678 (counter reset by autouse fixture).
    assert data["dva_number"] == "9012345678"
    assert data["demo_mode"] is True
    assert data["amount_kobo"] == 50_000


def test_idempotent_re_issue_returns_same_tx(client, mock_squad_dva, squad_key):
    squad_key("sandbox_test_key")
    mock_squad_dva()
    uid = _seed_persona("mama_003", "0123456789")

    body = {"amount_kobo": 20_000}
    headers = {"Authorization": _bearer(uid)}

    r1 = client.post("/dynamic-va/create", json=body, headers=headers)
    assert r1.status_code == 200
    tx_id_1 = r1.json()["data"]["tx_id"]

    r2 = client.post("/dynamic-va/create", json=body, headers=headers)
    assert r2.status_code == 200
    tx_id_2 = r2.json()["data"]["tx_id"]

    assert tx_id_1 == tx_id_2
    assert _count_qr_rows(uid) == 1


def test_auth_via_body_user_id_when_no_bearer(client, mock_squad_dva, squad_key):
    squad_key("sandbox_test_key")
    mock_squad_dva(va_number="9991112222")
    uid = _seed_persona("mama_004", "0123456789")

    r = client.post(
        "/dynamic-va/create",
        json={"amount_kobo": 10_000, "user_id": uid},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["dva_number"] == "9991112222"


def test_auth_required_when_nothing_provided(client, squad_key):
    squad_key("sandbox_test_key")
    _seed_persona("mama_005", "0123456789")

    r = client.post("/dynamic-va/create", json={"amount_kobo": 10_000})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "auth_required"


def test_invalid_amount_zero_rejected(client, mock_squad_dva, squad_key):
    squad_key("sandbox_test_key")
    mock_squad_dva()
    uid = _seed_persona("mama_006", "0123456789")

    r = client.post(
        "/dynamic-va/create",
        json={"amount_kobo": 0},
        headers={"Authorization": _bearer(uid)},
    )
    # Pydantic gt=0 surfaces as 422 (validation error, not 400).
    assert r.status_code == 422


def test_squad_failure_returns_503(client, mock_squad_dva, squad_key):
    squad_key("sandbox_test_key")
    mock_squad_dva(raise_error="generic")
    uid = _seed_persona("mama_007", "0123456789")

    r = client.post(
        "/dynamic-va/create",
        json={"amount_kobo": 20_000},
        headers={"Authorization": _bearer(uid)},
    )
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "squad_failed"


def test_wallet_not_found_returns_404(client, mock_squad_dva, squad_key):
    squad_key("sandbox_test_key")
    mock_squad_dva()
    uid = _seed_user_without_wallet("no_wallet_001")

    r = client.post(
        "/dynamic-va/create",
        json={"amount_kobo": 20_000},
        headers={"Authorization": _bearer(uid)},
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "wallet_not_found"
