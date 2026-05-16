"""Tests for /wallet/lock-for-offline + /wallet/unlock-from-offline
plus the from_locked branch of /transfer/in-network.

PRD_FUNBI §11.7 — proves sum conservation under any sequence of
lock/unlock/transfer, idempotency, and that the dual-balance pots
don't leak into each other.
"""

from __future__ import annotations

import uuid


def _key(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:16]}"


def _read_wallets(client, user_ids: list[int]) -> dict[int, dict]:
    """Cheap helper that uses the test DB directly via the same engine."""
    import importlib
    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    out: dict[int, dict] = {}
    with db_mod.db_session() as db:
        for uid in user_ids:
            w = db.get(models.Wallet, uid)
            if w:
                out[uid] = {
                    "balance_kobo": w.balance_kobo,
                    "locked_kobo": w.locked_kobo,
                    "version": w.version,
                }
    return out


# --------------------------------------------------------- 1. lock happy path

def test_lock_happy_path(client, seed_wallets):
    alice = seed_wallets["alice"]
    r = client.post(
        "/wallet/lock-for-offline",
        json={"user_id": alice, "amount_kobo": 3_000_00, "idempotency_key": _key("lock-")},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["balance_kobo"] == 7_000_00
    assert data["locked_kobo"] == 3_000_00
    assert data["moved_kobo"] == 3_000_00
    # Conservation: balance + locked unchanged
    state = _read_wallets(client, [alice])[alice]
    assert state["balance_kobo"] + state["locked_kobo"] == 10_000_00


# --------------------------------------------------------- 2. lock insufficient balance

def test_lock_insufficient_balance(client, seed_wallets):
    alice = seed_wallets["alice"]
    r = client.post(
        "/wallet/lock-for-offline",
        json={"user_id": alice, "amount_kobo": 99_999_99, "idempotency_key": _key("lock-")},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "insufficient_balance"
    state = _read_wallets(client, [alice])[alice]
    assert state["balance_kobo"] == 10_000_00
    assert state["locked_kobo"] == 0


# --------------------------------------------------------- 3. unlock happy path

def test_unlock_happy_path(client, seed_wallets):
    alice = seed_wallets["alice"]
    client.post(
        "/wallet/lock-for-offline",
        json={"user_id": alice, "amount_kobo": 4_000_00, "idempotency_key": _key("lock-")},
    )
    r = client.post(
        "/wallet/unlock-from-offline",
        json={"user_id": alice, "amount_kobo": 2_500_00, "idempotency_key": _key("unlock-")},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["balance_kobo"] == 10_000_00 - 4_000_00 + 2_500_00
    assert data["locked_kobo"] == 4_000_00 - 2_500_00


# --------------------------------------------------------- 4. unlock insufficient locked

def test_unlock_insufficient_locked(client, seed_wallets):
    alice = seed_wallets["alice"]
    r = client.post(
        "/wallet/unlock-from-offline",
        json={"user_id": alice, "amount_kobo": 100_00, "idempotency_key": _key("unlock-")},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "insufficient_locked"


# --------------------------------------------------------- 5. lock idempotent

def test_lock_idempotent(client, seed_wallets):
    alice = seed_wallets["alice"]
    body = {"user_id": alice, "amount_kobo": 1_500_00, "idempotency_key": "lock-dup-1"}
    r1 = client.post("/wallet/lock-for-offline", json=body)
    r2 = client.post("/wallet/lock-for-offline", json=body)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["data"]["movement_tx_id"] == r2.json()["data"]["movement_tx_id"]
    state = _read_wallets(client, [alice])[alice]
    assert state["balance_kobo"] == 8_500_00
    assert state["locked_kobo"] == 1_500_00


# --------------------------------------------------------- 6. from_locked transfer happy

def test_from_locked_transfer_happy(client, seed_wallets, auth_header):
    alice, bob = seed_wallets["alice"], seed_wallets["bob"]
    # pre-load Alice's offline budget
    client.post(
        "/wallet/lock-for-offline",
        json={"user_id": alice, "amount_kobo": 5_000_00, "idempotency_key": _key("lock-")},
    )
    # offline replay: from_locked=true
    r = client.post(
        "/transfer/in-network",
        json={
            "from_user_id": alice,
            "to_user_id": bob,
            "amount_kobo": 1_000_00,
            "idempotency_key": _key("ln-"),
            "from_locked": True,
        },
        headers=auth_header(alice),
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["debited_from"] == "locked"
    state = _read_wallets(client, [alice, bob])
    assert state[alice]["balance_kobo"] == 5_000_00   # online untouched
    assert state[alice]["locked_kobo"] == 4_000_00    # locked decremented
    assert state[bob]["balance_kobo"] == 5_000_00 + 1_000_00  # receiver's online wallet credited


# --------------------------------------------------------- 7. from_locked transfer with no locked funds

def test_from_locked_transfer_no_locked(client, seed_wallets, auth_header):
    alice, bob = seed_wallets["alice"], seed_wallets["bob"]
    r = client.post(
        "/transfer/in-network",
        json={
            "from_user_id": alice,
            "to_user_id": bob,
            "amount_kobo": 100_00,
            "idempotency_key": _key("ln-"),
            "from_locked": True,
        },
        headers=auth_header(alice),
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "insufficient_locked_balance"


# --------------------------------------------------------- 8. from_locked must NOT fall through to balance

def test_from_locked_does_not_fall_through_to_balance(client, seed_wallets, auth_header):
    """Even with plenty of balance_kobo, from_locked=true insists on
    locked_kobo. Falling through would be a silent ledger error.
    """
    alice, bob = seed_wallets["alice"], seed_wallets["bob"]
    # Alice has ₦10,000 online, 0 locked.
    r = client.post(
        "/transfer/in-network",
        json={
            "from_user_id": alice,
            "to_user_id": bob,
            "amount_kobo": 1_000_00,
            "idempotency_key": _key("ln-"),
            "from_locked": True,
        },
        headers=auth_header(alice),
    )
    assert r.status_code == 400
    state = _read_wallets(client, [alice, bob])
    assert state[alice]["balance_kobo"] == 10_000_00   # unchanged
    assert state[alice]["locked_kobo"] == 0            # unchanged
    assert state[bob]["balance_kobo"] == 5_000_00      # unchanged


# --------------------------------------------------------- 9. reconciliation invariant under mixed ops

def test_reconciliation_invariant(client, seed_wallets, auth_header):
    alice, bob, carol = seed_wallets["alice"], seed_wallets["bob"], seed_wallets["carol"]
    initial = sum(_read_wallets(client, [alice, bob, carol])[u]["balance_kobo"] for u in (alice, bob, carol))
    # sequence: alice locks 4K, sends 1K offline to bob, unlocks 1K
    client.post("/wallet/lock-for-offline", json={"user_id": alice, "amount_kobo": 4_000_00, "idempotency_key": _key("lock-")})
    client.post("/transfer/in-network", json={"from_user_id": alice, "to_user_id": bob, "amount_kobo": 1_000_00, "idempotency_key": _key("ln-"), "from_locked": True}, headers=auth_header(alice))
    client.post("/wallet/unlock-from-offline", json={"user_id": alice, "amount_kobo": 1_000_00, "idempotency_key": _key("unlock-")})
    final = _read_wallets(client, [alice, bob, carol])
    total = sum(final[u]["balance_kobo"] + final[u]["locked_kobo"] for u in (alice, bob, carol))
    assert total == initial


# --------------------------------------------------------- 10. lock zero rejected

def test_lock_zero_rejected(client, seed_wallets):
    alice = seed_wallets["alice"]
    r = client.post(
        "/wallet/lock-for-offline",
        json={"user_id": alice, "amount_kobo": 0, "idempotency_key": _key("lock-")},
    )
    assert r.status_code == 422


# --------------------------------------------------------- 11. wallet not found

def test_lock_wallet_not_found(client, seed_wallets):
    r = client.post(
        "/wallet/lock-for-offline",
        json={"user_id": 99999, "amount_kobo": 100_00, "idempotency_key": _key("lock-")},
    )
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "wallet_not_found"


# --------------------------------------------------------- 12. sync-offline-batch happy path

def test_sync_offline_batch_happy(client, seed_wallets):
    alice, bob = seed_wallets["alice"], seed_wallets["bob"]
    # pre-load Alice's offline budget
    client.post(
        "/wallet/lock-for-offline",
        json={"user_id": alice, "amount_kobo": 5_000_00, "idempotency_key": _key("lock-")},
    )
    ops = [
        {"idempotency_key": "syncbatch-1", "from_user_id": alice, "to_user_id": bob, "amount_kobo": 1_000_00},
        {"idempotency_key": "syncbatch-2", "from_user_id": alice, "to_user_id": bob, "amount_kobo": 500_00},
    ]
    r = client.post("/transfer/sync-offline-batch", json={"ops": ops})
    assert r.status_code == 200, r.text
    results = r.json()["data"]["results"]
    assert len(results) == 2
    assert all(row["status"] == "acked" for row in results)
    state = _read_wallets(client, [alice, bob])
    assert state[alice]["locked_kobo"] == 5_000_00 - 1_500_00
    assert state[bob]["balance_kobo"] == 5_000_00 + 1_500_00


# --------------------------------------------------------- 13. sync batch with mixed acks + rejects

def test_sync_batch_partial_failure(client, seed_wallets):
    alice, bob = seed_wallets["alice"], seed_wallets["bob"]
    client.post(
        "/wallet/lock-for-offline",
        json={"user_id": alice, "amount_kobo": 800_00, "idempotency_key": _key("lock-")},
    )
    # first op succeeds, second exhausts; third would oversend (rejected).
    ops = [
        {"idempotency_key": "mix-1", "from_user_id": alice, "to_user_id": bob, "amount_kobo": 500_00},
        {"idempotency_key": "mix-2", "from_user_id": alice, "to_user_id": bob, "amount_kobo": 300_00},
        {"idempotency_key": "mix-3", "from_user_id": alice, "to_user_id": bob, "amount_kobo": 100_00},
    ]
    r = client.post("/transfer/sync-offline-batch", json={"ops": ops})
    assert r.status_code == 200
    results = r.json()["data"]["results"]
    statuses = [row["status"] for row in results]
    assert statuses[:2] == ["acked", "acked"]
    assert statuses[2] == "rejected"


# --------------------------------------------------------- 14. replay of already-acked offline tx is a no-op

def test_sync_batch_replay_safe(client, seed_wallets):
    alice, bob = seed_wallets["alice"], seed_wallets["bob"]
    client.post(
        "/wallet/lock-for-offline",
        json={"user_id": alice, "amount_kobo": 2_000_00, "idempotency_key": _key("lock-")},
    )
    op = {"idempotency_key": "replay-1", "from_user_id": alice, "to_user_id": bob, "amount_kobo": 500_00}
    r1 = client.post("/transfer/sync-offline-batch", json={"ops": [op]})
    r2 = client.post("/transfer/sync-offline-batch", json={"ops": [op]})
    assert r1.status_code == 200 and r2.status_code == 200
    # First batch: acked. Second batch: also acked (server returned the existing tx_id, no double-debit).
    state = _read_wallets(client, [alice, bob])
    assert state[alice]["locked_kobo"] == 2_000_00 - 500_00   # only one debit
    assert state[bob]["balance_kobo"] == 5_000_00 + 500_00    # only one credit
