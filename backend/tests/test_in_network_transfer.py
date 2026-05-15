"""20+ tests for POST /transfer/in-network.

PRD §11 Risk 3 names a reconciliation bug "catastrophic if it happens."
This file exists to prove it can't. We cover idempotency, concurrency,
input validation, and ledger conservation. Each test runs against a
fresh SQLite file so cases are isolated.
"""

from __future__ import annotations

import concurrent.futures
import uuid


def _build(from_user: int, to_user: int, amount: int, key: str | None = None) -> dict:
    return {
        "from_user_id": from_user,
        "to_user_id": to_user,
        "amount_kobo": amount,
        "idempotency_key": key or f"test_{uuid.uuid4().hex[:16]}",
    }


# --------------------------------------------------------------------- 1. happy path

def test_happy_path(client, seed_wallets, wallet_reader):
    alice, bob = seed_wallets["alice"], seed_wallets["bob"]
    body = _build(alice, bob, 2_000_00)

    r = client.post("/transfer/in-network", json=body)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["status"] == "completed"
    assert data["balance_after_kobo"] == 8_000_00
    assert wallet_reader(alice)["balance_kobo"] == 8_000_00
    assert wallet_reader(bob)["balance_kobo"] == 7_000_00


# --------------------------------------------------------------------- 2. sender wallet not found

def test_sender_wallet_not_found(client, seed_wallets):
    bob = seed_wallets["bob"]
    r = client.post("/transfer/in-network", json=_build(99999, bob, 100_00))
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "sender_wallet_not_found"


# --------------------------------------------------------------------- 3. receiver wallet not found

def test_receiver_wallet_not_found(client, seed_wallets):
    alice = seed_wallets["alice"]
    r = client.post("/transfer/in-network", json=_build(alice, 99999, 100_00))
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "receiver_wallet_not_found"


# --------------------------------------------------------------------- 4. amount = 0 rejected

def test_zero_amount_rejected(client, seed_wallets):
    a, b = seed_wallets["alice"], seed_wallets["bob"]
    r = client.post("/transfer/in-network", json=_build(a, b, 0))
    assert r.status_code == 422


# --------------------------------------------------------------------- 5. amount < 0 rejected

def test_negative_amount_rejected(client, seed_wallets):
    a, b = seed_wallets["alice"], seed_wallets["bob"]
    r = client.post("/transfer/in-network", json=_build(a, b, -100_00))
    assert r.status_code == 422


# --------------------------------------------------------------------- 6. amount > balance

def test_insufficient_balance(client, seed_wallets, wallet_reader):
    a, b = seed_wallets["alice"], seed_wallets["bob"]
    r = client.post("/transfer/in-network", json=_build(a, b, 99_999_99))
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "insufficient_balance"
    # No state change
    assert wallet_reader(a)["balance_kobo"] == 10_000_00
    assert wallet_reader(b)["balance_kobo"] == 5_000_00


# --------------------------------------------------------------------- 7. drain the sender

def test_drain_sender(client, seed_wallets, wallet_reader):
    a, b = seed_wallets["alice"], seed_wallets["bob"]
    r = client.post("/transfer/in-network", json=_build(a, b, 10_000_00))
    assert r.status_code == 200
    assert wallet_reader(a)["balance_kobo"] == 0
    assert wallet_reader(b)["balance_kobo"] == 15_000_00


# --------------------------------------------------------------------- 8. self-transfer rejected

def test_self_transfer_rejected(client, seed_wallets):
    a = seed_wallets["alice"]
    r = client.post("/transfer/in-network", json=_build(a, a, 100_00))
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "self_transfer"


# --------------------------------------------------------------------- 9. idempotency: identical body

def test_idempotency_identical_body(client, seed_wallets, wallet_reader):
    a, b = seed_wallets["alice"], seed_wallets["bob"]
    body = _build(a, b, 500_00, key="dup-1")
    r1 = client.post("/transfer/in-network", json=body)
    r2 = client.post("/transfer/in-network", json=body)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["data"]["tx_id"] == r2.json()["data"]["tx_id"]
    # Only one debit happened
    assert wallet_reader(a)["balance_kobo"] == 9_500_00


# --------------------------------------------------------------------- 10. idempotency: different body, same key

def test_idempotency_different_body_returns_original(client, seed_wallets, wallet_reader):
    """Spec: the idempotency_key wins. Even if the second body differs
    we return the original row — never double-write. Document this in
    the response.
    """
    a, b, c = seed_wallets["alice"], seed_wallets["bob"], seed_wallets["carol"]
    r1 = client.post("/transfer/in-network", json=_build(a, b, 500_00, key="dup-2"))
    assert r1.status_code == 200
    tx1 = r1.json()["data"]["tx_id"]

    r2 = client.post("/transfer/in-network", json=_build(a, c, 999_00, key="dup-2"))
    assert r2.status_code == 200
    assert r2.json()["data"]["tx_id"] == tx1
    # Only the first transfer was applied
    assert wallet_reader(a)["balance_kobo"] == 9_500_00
    assert wallet_reader(b)["balance_kobo"] == 5_500_00
    assert wallet_reader(c)["balance_kobo"] == 1_000_00  # untouched


# --------------------------------------------------------------------- 11. concurrent A→B + A→C sharing funds

def test_concurrent_split_transfers_respect_balance(client, seed_wallets, wallet_reader):
    """Alice has 10_000_00. Fire one 7_000_00 and one 6_000_00 in
    parallel. Only one should succeed. Ledger conserved.
    """
    a, b, c = seed_wallets["alice"], seed_wallets["bob"], seed_wallets["carol"]

    def fire(target: int, amount: int) -> int:
        return client.post(
            "/transfer/in-network", json=_build(a, target, amount)
        ).status_code

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        f1 = ex.submit(fire, b, 7_000_00)
        f2 = ex.submit(fire, c, 6_000_00)
        codes = sorted([f1.result(), f2.result()])

    assert codes == [200, 400], codes
    total_after = (
        wallet_reader(a)["balance_kobo"]
        + wallet_reader(b)["balance_kobo"]
        + wallet_reader(c)["balance_kobo"]
    )
    assert total_after == 10_000_00 + 5_000_00 + 1_000_00  # conserved


# --------------------------------------------------------------------- 12. sum conservation across single tx

def test_sum_conservation(client, seed_wallets, wallet_reader):
    a, b, c = seed_wallets["alice"], seed_wallets["bob"], seed_wallets["carol"]
    before = sum(wallet_reader(x)["balance_kobo"] for x in (a, b, c))
    r = client.post("/transfer/in-network", json=_build(a, b, 1_234_00))
    assert r.status_code == 200
    after = sum(wallet_reader(x)["balance_kobo"] for x in (a, b, c))
    assert before == after


# --------------------------------------------------------------------- 13. tx row direction + counterparty

def test_tx_row_shape(client, seed_wallets):
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")

    a, b = seed_wallets["alice"], seed_wallets["bob"]
    r = client.post("/transfer/in-network", json=_build(a, b, 500_00))
    tx_id = r.json()["data"]["tx_id"]

    with db_mod.db_session() as db:
        tx = db.get(models.Transaction, tx_id)
        assert tx is not None
        assert tx.direction == "out"
        assert tx.user_id == a
        assert tx.counterparty_user_id == b
        assert tx.type == "in_network"
        assert tx.status == "completed"
        assert tx.amount_kobo == 500_00
        assert tx.settled_at is not None


# --------------------------------------------------------------------- 14. non-integer amount rejected

def test_non_integer_amount_rejected(client, seed_wallets):
    a, b = seed_wallets["alice"], seed_wallets["bob"]
    r = client.post(
        "/transfer/in-network",
        json={"from_user_id": a, "to_user_id": b, "amount_kobo": 100.5, "idempotency_key": "k"},
    )
    assert r.status_code == 422


# --------------------------------------------------------------------- 15. string amount rejected

def test_string_amount_rejected(client, seed_wallets):
    a, b = seed_wallets["alice"], seed_wallets["bob"]
    r = client.post(
        "/transfer/in-network",
        json={"from_user_id": a, "to_user_id": b, "amount_kobo": "abc", "idempotency_key": "k"},
    )
    assert r.status_code == 422


# --------------------------------------------------------------------- 16. missing idempotency_key

def test_missing_idempotency_key_rejected(client, seed_wallets):
    a, b = seed_wallets["alice"], seed_wallets["bob"]
    r = client.post(
        "/transfer/in-network",
        json={"from_user_id": a, "to_user_id": b, "amount_kobo": 100_00},
    )
    assert r.status_code == 422


# --------------------------------------------------------------------- 17. idempotency_key too long

def test_idempotency_key_too_long(client, seed_wallets):
    a, b = seed_wallets["alice"], seed_wallets["bob"]
    r = client.post(
        "/transfer/in-network",
        json=_build(a, b, 100_00, key="x" * 200),
    )
    assert r.status_code == 422


# --------------------------------------------------------------------- 18. wallet version bumps

def test_wallet_version_bumps(client, seed_wallets, wallet_reader):
    a, b = seed_wallets["alice"], seed_wallets["bob"]
    va_before = wallet_reader(a)["version"]
    vb_before = wallet_reader(b)["version"]
    r = client.post("/transfer/in-network", json=_build(a, b, 100_00))
    assert r.status_code == 200
    assert wallet_reader(a)["version"] == va_before + 1
    assert wallet_reader(b)["version"] == vb_before + 1


# --------------------------------------------------------------------- 19. settled_at on completed tx

def test_settled_at_present(client, seed_wallets):
    a, b = seed_wallets["alice"], seed_wallets["bob"]
    r = client.post("/transfer/in-network", json=_build(a, b, 100_00))
    assert r.json()["data"]["settled_at"] > 0


# --------------------------------------------------------------------- 20. high concurrency drain — no oversend

def test_high_concurrency_no_oversend(client, seed_wallets, wallet_reader):
    """Sender starts at 10_000_00. Fire 100 transfers of 200_00 each
    (would total 20_000_00 if all went through). Only 50 should succeed.
    Ledger is conserved either way.
    """
    a, b = seed_wallets["alice"], seed_wallets["bob"]

    def fire(i: int) -> int:
        return client.post(
            "/transfer/in-network",
            json=_build(a, b, 200_00, key=f"hc-{i}"),
        ).status_code

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        codes = list(ex.map(fire, range(100)))

    successes = sum(1 for c in codes if c == 200)
    failures = sum(1 for c in codes if c == 400)
    # We allow some 503s under extreme contention — they're retry-safe.
    serialization_503 = sum(1 for c in codes if c == 503)

    assert successes + failures + serialization_503 == 100
    assert successes == 50, f"expected 50 successes, got {successes}; codes={sorted(set(codes))}"
    # Conservation: A drained, B got the full amount
    final_a = wallet_reader(a)["balance_kobo"]
    final_b = wallet_reader(b)["balance_kobo"]
    assert final_a + final_b == 10_000_00 + 5_000_00
    assert final_a == 0
    assert final_b == 15_000_00
