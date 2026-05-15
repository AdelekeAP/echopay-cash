"""Tests for POST /webhooks/squad.

Mirrors test_auth_voice_signup.py + test_dva_create.py: per-test SQLite
DB via Funbi's `client` fixture, autouse cache reset for the new modules
(`app.api.webhooks`, `app.squad.signature`), no live network.

Coverage (8 tests):
  1. test_happy_path_credits_balance
  2. test_invalid_signature_returns_200_no_db_change
  3. test_mismatch_amount_does_not_credit
  4. test_replay_idempotent
  5. test_unknown_transaction_ref_returns_200
  6. test_missing_required_fields_returns_200
  7. test_signature_constant_time_compare
  8. test_v1_signature_accepted   ← V1 fallback proof
"""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest


# --------------------------------------------------------------- module cache reset


@pytest.fixture(autouse=True)
def _drop_stale_webhook_modules():
    """Pop my modules BEFORE conftest's `client` fixture runs.

    Same pattern as test_dva_create.py — Funbi's conftest pops
    `app.main` + `app.core.db` + `app.models` + `app.core.config` +
    `app.api.transfer`, then re-imports. The re-import pulls
    `from .api.webhooks import router`, which holds stale references to
    the old `Transaction`/`Wallet`/`WebhookEvent` classes if not popped.
    """
    import sys

    for mod_name in (
        "app.api.webhooks",
        "app.api.dva",
        "app.api.auth",
        "app.squad.signature",
        "app.squad.dynamic_va",
        "app.squad.static_va",
        "app.squad.client",
        "app.voice.proxy",
    ):
        sys.modules.pop(mod_name, None)

    yield

    for mod_name in (
        "app.api.webhooks",
        "app.api.dva",
        "app.api.auth",
        "app.squad.signature",
        "app.squad.dynamic_va",
        "app.squad.static_va",
        "app.squad.client",
        "app.voice.proxy",
    ):
        sys.modules.pop(mod_name, None)


@pytest.fixture
def secret_key(monkeypatch):
    """Set SQUAD_SECRET_KEY for the test. Returns the key so tests can sign."""

    def _install(key: str = "sandbox_test_secret"):
        monkeypatch.setenv("SQUAD_SECRET_KEY", key)
        from app.core import config as config_module
        config_module.get_settings.cache_clear()
        return key

    return _install


# --------------------------------------------------------------- helpers


def _seed_pending_qr_tx(
    user_id: int,
    amount_kobo: int,
    reference: str,
    dva_number: str = "9012345678",
) -> str:
    """Insert a pending qr_receive Transaction matching PR #14's
    packed `squad_ref` shape (`<dva_number>|<reference>`). Returns the
    tx id."""
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    tx_id = f"qr_{reference[-16:]}"
    with db_mod.db_session() as db:
        with db.begin():
            db.add(
                models.Transaction(
                    id=tx_id,
                    user_id=user_id,
                    type="qr_receive",
                    direction="in",
                    amount_kobo=amount_kobo,
                    status="pending",
                    idempotency_key=f"qr_test_{reference}",
                    squad_ref=f"{dva_number}|{reference}",
                    created_at=models.now_unix(),
                )
            )
    return tx_id


def _seed_user_and_wallet(
    customer_identifier: str = "mama_001",
    starting_kobo: int = 45_000_000,
    va_number: str = "0123456789",
) -> int:
    """Seed a user + wallet, return user_id."""
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
                email="m@echopay.test",
                created_at=models.now_unix(),
            )
            db.add(u)
            db.flush()
            db.add(
                models.Wallet(
                    user_id=u.id,
                    squad_va_number=va_number,
                    balance_kobo=starting_kobo,
                    updated_at=models.now_unix(),
                )
            )
            return u.id


def _read_wallet(user_id: int) -> tuple[int, int]:
    """Returns (balance_kobo, version) for the wallet."""
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        w = db.get(models.Wallet, user_id)
        return (w.balance_kobo, w.version) if w else (0, 0)


def _read_tx_status(tx_id: str) -> str | None:
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        t = db.get(models.Transaction, tx_id)
        return t.status if t else None


def _count_webhook_events() -> int:
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        return db.query(models.WebhookEvent).count()


def _read_webhook_event(ref: str):
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        return db.get(models.WebhookEvent, ref)


# Sign with Squad's canonical V2/V3 order:
# transaction_reference | virtual_account_number | currency |
# principal_amount | settled_amount | customer_identifier
def _sign_v2(body_bytes: bytes, secret: str) -> str:
    data = json.loads(body_bytes)
    inner = data.get("data", data)
    fields = [
        str(inner.get("transaction_reference", "")),
        str(inner.get("virtual_account_number", "")),
        str(inner.get("currency", "NGN")),
        str(inner.get("principal_amount", "")),
        str(inner.get("settled_amount", "")),
        str(inner.get("customer_identifier", inner.get("customer_id", ""))),
    ]
    msg = "|".join(fields).encode("utf-8")
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha512).hexdigest()


def _sign_v1(body_bytes: bytes, secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), body_bytes, hashlib.sha512).hexdigest()


def _build_payload(
    reference: str,
    va_number: str = "9012345678",
    amount_naira: str = "200.00",
    customer_identifier: str = "mama_risikat_001",
    currency: str = "NGN",
) -> bytes:
    payload = {
        "Event": "successful_transaction",
        "data": {
            "transaction_reference": reference,
            "virtual_account_number": va_number,
            "currency": currency,
            "principal_amount": amount_naira,
            "settled_amount": amount_naira,
            "customer_identifier": customer_identifier,
        },
    }
    # Serialize once — the wire body is THE byte sequence the signature
    # is computed against. Tests must POST these exact bytes.
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


# --------------------------------------------------------------- tests


def test_happy_path_credits_balance(client, secret_key):
    secret = secret_key()
    user_id = _seed_user_and_wallet(starting_kobo=45_000_000)
    reference = "ECHOPAYCASH_test_happy"
    tx_id = _seed_pending_qr_tx(user_id, amount_kobo=20_000, reference=reference)

    body = _build_payload(reference, amount_naira="200.00")
    sig = _sign_v2(body, secret)

    r = client.post(
        "/webhooks/squad",
        content=body,
        headers={"content-type": "application/json", "x-squad-encrypted-body": sig},
    )

    assert r.status_code == 200, r.text
    j = r.json()
    assert j["response_code"] == "00"
    assert j["transaction_reference"] == reference
    assert j["response_description"] == "Success"

    balance, version = _read_wallet(user_id)
    assert balance == 45_000_000 + 20_000
    assert version == 1
    assert _read_tx_status(tx_id) == "completed"

    we = _read_webhook_event(reference)
    assert we is not None
    assert we.signature_valid == 1
    assert we.mismatch == 0
    assert we.signature_version_matched == "v2"
    assert we.source == "static_va"


def test_invalid_signature_returns_200_no_db_change(client, secret_key):
    secret_key()
    user_id = _seed_user_and_wallet(starting_kobo=45_000_000)
    reference = "ECHOPAYCASH_test_invalid"
    tx_id = _seed_pending_qr_tx(user_id, amount_kobo=20_000, reference=reference)
    starting_balance, _ = _read_wallet(user_id)

    body = _build_payload(reference)
    bad_sig = "deadbeef" * 16  # 128 hex chars but wrong content

    r = client.post(
        "/webhooks/squad",
        content=body,
        headers={"content-type": "application/json", "x-squad-encrypted-body": bad_sig},
    )

    assert r.status_code == 200, r.text
    j = r.json()
    assert j["response_description"] == "Invalid signature"

    # NO DB writes — wallet untouched, tx still pending, no WebhookEvent.
    balance, _ = _read_wallet(user_id)
    assert balance == starting_balance
    assert _read_tx_status(tx_id) == "pending"
    assert _count_webhook_events() == 0


def test_mismatch_amount_does_not_credit(client, secret_key):
    secret = secret_key()
    user_id = _seed_user_and_wallet(starting_kobo=45_000_000)
    reference = "ECHOPAYCASH_test_mismatch"
    tx_id = _seed_pending_qr_tx(user_id, amount_kobo=20_000, reference=reference)
    starting_balance, _ = _read_wallet(user_id)

    # Customer paid ₦500 instead of expected ₦200.
    body = _build_payload(reference, amount_naira="500.00")
    sig = _sign_v2(body, secret)

    r = client.post(
        "/webhooks/squad",
        content=body,
        headers={"content-type": "application/json", "x-squad-encrypted-body": sig},
    )

    assert r.status_code == 200, r.text
    j = r.json()
    assert j["response_description"].startswith("Mismatch")

    # Balance NOT credited (Squad auto-refunds per PRD §4.3).
    balance, _ = _read_wallet(user_id)
    assert balance == starting_balance
    # Transaction marked 'reversed' (status enum has no 'mismatched').
    assert _read_tx_status(tx_id) == "reversed"
    # WebhookEvent persisted with mismatch=1, signature_valid=1.
    we = _read_webhook_event(reference)
    assert we is not None
    assert we.mismatch == 1
    assert we.signature_valid == 1


def test_replay_idempotent(client, secret_key):
    secret = secret_key()
    user_id = _seed_user_and_wallet(starting_kobo=45_000_000)
    reference = "ECHOPAYCASH_test_replay"
    _seed_pending_qr_tx(user_id, amount_kobo=20_000, reference=reference)

    body = _build_payload(reference)
    sig = _sign_v2(body, secret)
    headers = {"content-type": "application/json", "x-squad-encrypted-body": sig}

    r1 = client.post("/webhooks/squad", content=body, headers=headers)
    assert r1.status_code == 200
    assert r1.json()["response_description"] == "Success"
    balance_after_first, _ = _read_wallet(user_id)

    r2 = client.post("/webhooks/squad", content=body, headers=headers)
    assert r2.status_code == 200
    assert "Replay" in r2.json()["response_description"]

    # Balance credited exactly once.
    balance_after_second, _ = _read_wallet(user_id)
    assert balance_after_first == balance_after_second == 45_000_000 + 20_000
    # Single WebhookEvent row (UNIQUE PK enforces this).
    assert _count_webhook_events() == 1


def test_unknown_transaction_ref_returns_200(client, secret_key):
    secret = secret_key()
    user_id = _seed_user_and_wallet(starting_kobo=45_000_000)
    # Note: no _seed_pending_qr_tx call — the reference won't match anything.

    body = _build_payload("ECHOPAYCASH_no_match")
    sig = _sign_v2(body, secret)

    r = client.post(
        "/webhooks/squad",
        content=body,
        headers={"content-type": "application/json", "x-squad-encrypted-body": sig},
    )

    assert r.status_code == 200, r.text
    assert r.json()["response_description"] == "Unknown reference"

    # No DB writes.
    balance, _ = _read_wallet(user_id)
    assert balance == 45_000_000
    assert _count_webhook_events() == 0


def test_missing_required_fields_returns_200(client, secret_key):
    secret = secret_key()

    # Build a payload with empty transaction_reference — required.
    body = _build_payload("")
    sig = _sign_v2(body, secret)

    r = client.post(
        "/webhooks/squad",
        content=body,
        headers={"content-type": "application/json", "x-squad-encrypted-body": sig},
    )

    assert r.status_code == 200, r.text
    assert r.json()["response_description"] == "Missing required fields"
    assert _count_webhook_events() == 0


def test_signature_constant_time_compare(client, secret_key):
    """Sanity: two signatures differing in a single hex character must
    NOT accidentally match (hmac.compare_digest is constant-time AND
    correct)."""
    secret = secret_key()
    user_id = _seed_user_and_wallet(starting_kobo=45_000_000)
    reference = "ECHOPAYCASH_test_compare"
    _seed_pending_qr_tx(user_id, amount_kobo=20_000, reference=reference)

    body = _build_payload(reference)
    good_sig = _sign_v2(body, secret)
    # Flip the last hex character — exactly one bit difference in the
    # final nibble. compare_digest must reject this.
    bad_sig = good_sig[:-1] + ("0" if good_sig[-1] != "0" else "1")
    assert good_sig != bad_sig

    r = client.post(
        "/webhooks/squad",
        content=body,
        headers={"content-type": "application/json", "x-squad-encrypted-body": bad_sig},
    )
    assert r.status_code == 200
    assert r.json()["response_description"] == "Invalid signature"
    assert _count_webhook_events() == 0


def test_v1_signature_accepted(client, secret_key):
    """V1 fallback (full-body hash, no field concat) is still accepted —
    sandbox-variance insurance. WebhookEvent.signature_version_matched
    captures which path matched so admin dashboards can surface drift."""
    secret = secret_key()
    user_id = _seed_user_and_wallet(starting_kobo=45_000_000)
    reference = "ECHOPAYCASH_test_v1"
    tx_id = _seed_pending_qr_tx(user_id, amount_kobo=20_000, reference=reference)

    body = _build_payload(reference)
    sig_v1 = _sign_v1(body, secret)  # V1: HMAC over the entire raw body

    r = client.post(
        "/webhooks/squad",
        content=body,
        headers={"content-type": "application/json", "x-squad-encrypted-body": sig_v1},
    )

    assert r.status_code == 200, r.text
    assert r.json()["response_description"] == "Success"
    balance, _ = _read_wallet(user_id)
    assert balance == 45_000_000 + 20_000
    assert _read_tx_status(tx_id) == "completed"

    we = _read_webhook_event(reference)
    assert we is not None
    assert we.signature_valid == 1
    assert we.signature_version_matched == "v1"  # V1 path matched
    assert we.mismatch == 0
