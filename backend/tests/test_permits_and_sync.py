"""Tests for /permits/issue + /sync/submit — master doc §4.2.

The permit-based offline payment is the system's biggest correctness
risk (double-spend). These tests prove the atomic redemption catches
replay attempts, that signatures are actually verified, and that
ledger conservation holds across legit and malicious sync attempts.
"""

from __future__ import annotations

import base64
import hashlib
import json

import pytest
from nacl.signing import SigningKey


# ---------- helpers --------------------------------------------------------

def _signing_key_for(slug: str) -> SigningKey:
    seed = hashlib.sha256(f"echopay-demo:{slug}".encode()).digest()
    return SigningKey(seed)


def _canonical(payload: dict) -> bytes:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _b64sign(sk: SigningKey, payload: dict) -> str:
    return base64.b64encode(sk.sign(_canonical(payload)).signature).decode("ascii")


# Test-only seed: gives users 1/2/3 deterministic pubkeys matching the
# demo personas. We attach the pubkey AFTER seed_wallets has created
# the users so the conftest fixture doesn't need to know about ed25519.

PERSONA_SLUGS = {
    "alice": "mama_risikat_001",
    "bob": "iya_tope_002",
    "carol": "kosi_003",
}


def _attach_pubkeys(client, seed_wallets):
    """Patch the test users with the persona public keys so /sync/submit
    has something to verify against. Also fund alice's locked_kobo so
    permits have budget."""
    import importlib
    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        for name, slug in PERSONA_SLUGS.items():
            user = db.get(models.User, seed_wallets[name])
            sk = _signing_key_for(slug)
            pub = base64.b64encode(sk.verify_key.encode()).decode("ascii")
            user.ed25519_pub_b64 = pub
        # alice (sender): seed locked_kobo so permits have budget
        w = db.get(models.Wallet, seed_wallets["alice"])
        w.locked_kobo = 5_000_00
        db.commit()


def _issue_permit(client, user_id: int, max_amount_kobo: int):
    r = client.post("/permits/issue", json={
        "user_id": user_id,
        "max_amount_kobo": max_amount_kobo,
        "ttl_seconds": 3600,
    })
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _build_signed_submit(permit, sender_id, receiver_id, amount, nonce):
    sender_sk = _signing_key_for(PERSONA_SLUGS["alice"])
    receiver_sk = _signing_key_for(PERSONA_SLUGS["bob"])
    tx = {
        "amount_kobo": amount,
        "from_user": sender_id,
        "nonce": nonce,
        "permit_id": permit["permit_id"],
        "to_user": receiver_id,
        "ts": 1700000000,
    }
    sender_sig = _b64sign(sender_sk, tx)
    receipt = {"sender_sig": sender_sig, "tx": tx}
    receiver_sig = _b64sign(receiver_sk, receipt)
    return {
        "permit": permit,
        "tx": tx,
        "sender_sig_b64": sender_sig,
        "receiver_sig_b64": receiver_sig,
    }


# ---------- permit issuance ------------------------------------------------

def test_permit_issue_happy(client, seed_wallets):
    _attach_pubkeys(client, seed_wallets)
    r = client.post("/permits/issue", json={
        "user_id": seed_wallets["alice"],
        "max_amount_kobo": 1_000_00,
        "ttl_seconds": 3600,
    })
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["permit_id"].startswith("pm_")
    assert data["max_amount_kobo"] == 1_000_00
    assert data["expires_at"] > data["issued_at"]
    assert len(data["server_sig_b64"]) > 40   # base64 of 64-byte sig


def test_permit_issue_exceeds_locked_budget(client, seed_wallets):
    _attach_pubkeys(client, seed_wallets)
    r = client.post("/permits/issue", json={
        "user_id": seed_wallets["alice"],
        "max_amount_kobo": 99_999_99,   # way more than alice's 5K locked
        "ttl_seconds": 3600,
    })
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "insufficient_locked_for_permit"


def test_permit_issue_ttl_capped(client, seed_wallets):
    _attach_pubkeys(client, seed_wallets)
    r = client.post("/permits/issue", json={
        "user_id": seed_wallets["alice"],
        "max_amount_kobo": 100_00,
        "ttl_seconds": 999_999_999,
    })
    assert r.status_code == 422   # exceeds PERMIT_TTL_SECONDS_MAX


# ---------- sync submit happy path ----------------------------------------

def test_sync_submit_happy(client, seed_wallets, wallet_reader):
    _attach_pubkeys(client, seed_wallets)
    alice = seed_wallets["alice"]
    bob = seed_wallets["bob"]
    permit = _issue_permit(client, alice, 1_000_00)

    body = _build_signed_submit(permit, alice, bob, 500_00, "n-happy-1")
    r = client.post("/sync/submit", json=body)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["status"] == "completed"

    # Ledger: sender.locked_kobo -= 500_00, receiver.balance_kobo += 500_00
    a = wallet_reader(alice)
    b = wallet_reader(bob)
    assert a["balance_kobo"] == 10_000_00          # untouched online pot
    # locked started at 5_000_00 (set in _attach_pubkeys), minus 500_00
    # The full read via wallet_reader returns only what's in the fixture;
    # we re-fetch directly to assert locked_kobo.
    import importlib
    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        sender = db.get(models.Wallet, alice)
        assert sender.locked_kobo == 5_000_00 - 500_00
    assert b["balance_kobo"] == 5_000_00 + 500_00


# ---------- double-spend rejection ----------------------------------------

def test_sync_submit_double_spend_same_permit(client, seed_wallets, wallet_reader):
    """Same permit submitted twice with DIFFERENT nonces → second one
    is rejected because the permit is already redeemed. This is the
    master-doc §4.2 'permit_already_redeemed_or_expired' branch.
    """
    _attach_pubkeys(client, seed_wallets)
    alice = seed_wallets["alice"]
    bob = seed_wallets["bob"]
    permit = _issue_permit(client, alice, 1_000_00)

    body1 = _build_signed_submit(permit, alice, bob, 300_00, "n-1")
    body2 = _build_signed_submit(permit, alice, bob, 300_00, "n-2")

    r1 = client.post("/sync/submit", json=body1)
    r2 = client.post("/sync/submit", json=body2)

    assert r1.status_code == 200
    assert r2.status_code == 409
    assert r2.json()["detail"]["code"] == "permit_already_redeemed_or_expired"

    # Only the first debit applied
    import importlib
    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        a = db.get(models.Wallet, alice)
        b = db.get(models.Wallet, bob)
        assert a.locked_kobo == 5_000_00 - 300_00
        assert b.balance_kobo == 5_000_00 + 300_00


def test_sync_submit_replay_same_nonce(client, seed_wallets):
    """Exact same submit body twice → second one fails on nonce UNIQUE
    even before reaching the permit-redemption stage. This catches
    blind replays of a captured QR.
    """
    _attach_pubkeys(client, seed_wallets)
    alice = seed_wallets["alice"]
    bob = seed_wallets["bob"]
    permit = _issue_permit(client, alice, 1_000_00)
    body = _build_signed_submit(permit, alice, bob, 200_00, "n-replay")

    r1 = client.post("/sync/submit", json=body)
    r2 = client.post("/sync/submit", json=body)

    assert r1.status_code == 200
    assert r2.status_code == 409
    # Either nonce_replay or permit_already_redeemed — which one fires
    # first depends on FK ordering, both are correct rejections.
    code = r2.json()["detail"]["code"]
    assert code in ("nonce_replay", "permit_already_redeemed_or_expired")


# ---------- signature verification ----------------------------------------

def test_sync_submit_tampered_amount_fails(client, seed_wallets):
    """Sender signed amount=200_00, but the bundle says amount=300_00.
    Both values are within the permit cap so the cap check passes —
    the rejection MUST come from the sender signature no longer
    matching the canonical tx. This isolates the signature check from
    the cap check.
    """
    _attach_pubkeys(client, seed_wallets)
    alice = seed_wallets["alice"]
    bob = seed_wallets["bob"]
    permit = _issue_permit(client, alice, 1_000_00)
    body = _build_signed_submit(permit, alice, bob, 200_00, "n-tamper")
    body["tx"]["amount_kobo"] = 300_00   # tampered, still under cap

    r = client.post("/sync/submit", json=body)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "sender_signature_invalid"


def test_sync_submit_forged_server_sig_fails(client, seed_wallets):
    _attach_pubkeys(client, seed_wallets)
    alice = seed_wallets["alice"]
    bob = seed_wallets["bob"]
    permit = _issue_permit(client, alice, 1_000_00)
    body = _build_signed_submit(permit, alice, bob, 100_00, "n-forge")
    # Replace server_sig with garbage
    body["permit"]["server_sig_b64"] = base64.b64encode(b"\x00" * 64).decode("ascii")

    r = client.post("/sync/submit", json=body)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "permit_signature_invalid"


# ---------- amount over cap -----------------------------------------------

def test_sync_submit_amount_over_permit_cap(client, seed_wallets):
    _attach_pubkeys(client, seed_wallets)
    alice = seed_wallets["alice"]
    bob = seed_wallets["bob"]
    permit = _issue_permit(client, alice, 100_00)   # ₦100 cap
    body = _build_signed_submit(permit, alice, bob, 500_00, "n-over")

    r = client.post("/sync/submit", json=body)
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "amount_exceeds_permit_cap"


# ---------- conservation invariant ----------------------------------------

def test_sync_submit_conservation(client, seed_wallets):
    """sum(balance + locked) is preserved across the offline settlement."""
    _attach_pubkeys(client, seed_wallets)
    alice = seed_wallets["alice"]
    bob = seed_wallets["bob"]
    carol = seed_wallets["carol"]

    import importlib
    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")

    def total():
        with db_mod.db_session() as db:
            return sum(
                w.balance_kobo + w.locked_kobo
                for w in db.scalars(__import__("sqlalchemy").select(models.Wallet)).all()
            )

    before = total()
    permit = _issue_permit(client, alice, 1_000_00)
    body = _build_signed_submit(permit, alice, bob, 250_00, "n-conserve")
    r = client.post("/sync/submit", json=body)
    assert r.status_code == 200
    after = total()
    assert before == after, f"conservation broken: {before} → {after}"
