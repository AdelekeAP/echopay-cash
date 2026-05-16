"""Tests for /loans/request, /loans/repay, /loans/me.

Covers:
- Decisioning per credit score thresholds (auto-approve / manual_review /
  declined)
- Atomic disbursement (wallet credit + Transaction row)
- Atomic repayment with partial + full paths
- Single-active-loan guard
- Master VA reconciliation invariant: drift = 0 holds BEFORE, DURING,
  and AFTER the full loan lifecycle. The mid-loan assertion is the
  demo-day landmine guard per Leke's directive — the 3:00 reconcile
  beat must show drift = 0 even when judges click reconcile after the
  3:45 loan disbursement beat.
"""

from __future__ import annotations

import time

import pytest


# ----------------------------------------------------------------- helpers


def _bearer(user_id: int) -> dict[str, str]:
    """Make a Bearer header for user_id — same as conftest auth_header
    but inline since these tests build users with custom histories."""
    return {"Authorization": f"Bearer demo_token_{user_id}_{int(time.time())}"}


def _seed_user(
    client,  # noqa: ARG001 — depend on client to order app init
    *,
    customer_identifier: str,
    balance_kobo: int = 0,
    age_days: int = 0,
    va_number: str = "9999999999",
) -> int:
    """Direct DB seed of a user + wallet. Returns user_id."""
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    now = models.now_unix()
    with db_mod.db_session() as db:
        with db.begin():
            u = models.User(
                customer_identifier=customer_identifier,
                first_name="Test",
                last_name="User",
                phone="+234 801 000 0000",
                email="t@echopay.test",
                bvn="22288899900",
                dob="1990-01-01",
                created_at=now - (age_days * 86_400),
            )
            db.add(u)
            db.flush()
            db.add(models.Wallet(
                user_id=u.id,
                squad_va_number=va_number,
                balance_kobo=balance_kobo,
                updated_at=now,
            ))
            return u.id


def _add_inbound_tx(user_id: int, amount_kobo: int, days_ago: int = 0) -> str:
    """Insert a completed inbound in_network transaction. Returns tx_id."""
    import importlib
    import uuid

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    when = models.now_unix() - (days_ago * 86_400)
    tx_id = f"fake_{uuid.uuid4().hex[:16]}"
    with db_mod.db_session() as db:
        with db.begin():
            db.add(models.Transaction(
                id=tx_id,
                user_id=user_id,
                type="in_network",
                direction="in",
                amount_kobo=amount_kobo,
                status="completed",
                idempotency_key=f"test_{tx_id}",
                created_at=when,
                settled_at=when,
            ))
    return tx_id


def _high_score_user(client) -> int:
    """Seed a user with score >= 700 (auto-approve band).

    Recipe: balance > ₦10k + 30-day age (caps age_bonus at 100) +
    12 inbound txs (caps inbound_bonus at 120). Score ~770.
    """
    uid = _seed_user(
        client,
        customer_identifier="high_score_user",
        balance_kobo=24_00_000,  # ₦24,000 — above balance_bonus threshold
        age_days=30,
        va_number="1000000001",
    )
    for i in range(12):
        _add_inbound_tx(uid, 200_000, days_ago=28 - (i * 2))
    return uid


def _mid_score_user(client) -> int:
    """Seed a user with 500 <= score < 700 (manual_review band).

    Recipe: small balance + 4 inbound txs + 25-day age. Score ~610.
    """
    uid = _seed_user(
        client,
        customer_identifier="mid_score_user",
        balance_kobo=500_000,  # ₦5,000 — below balance_bonus threshold
        age_days=25,
        va_number="1000000002",
    )
    for i in range(4):
        _add_inbound_tx(uid, 100_000, days_ago=20 - (i * 4))
    return uid


def _low_score_user(client) -> int:
    """Seed a user with score < 500 (declined band).

    Recipe: zero balance, zero age, one failed tx. Score = 500 - 25 = 475.
    """
    import importlib
    import uuid

    uid = _seed_user(
        client,
        customer_identifier="low_score_user",
        balance_kobo=0,
        age_days=0,
        va_number="1000000003",
    )
    # Add a failed tx for the penalty.
    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    now = models.now_unix()
    with db_mod.db_session() as db:
        with db.begin():
            db.add(models.Transaction(
                id=f"failed_{uuid.uuid4().hex[:12]}",
                user_id=uid,
                type="in_network",
                direction="in",
                amount_kobo=100_000,
                status="failed",
                idempotency_key=f"failed_test_{uid}",
                created_at=now,
                settled_at=None,
            ))
    return uid


def _wallet_balance(user_id: int) -> int:
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        w = db.get(models.Wallet, user_id)
        return w.balance_kobo if w else 0


# ----------------------------------------------------------------- decisioning


def test_request_loan_auto_approve_when_score_high(client):
    uid = _high_score_user(client)
    before = _wallet_balance(uid)
    r = client.post(
        "/loans/request",
        json={"amount_kobo": 20_000_00},  # ₦20,000
        headers=_bearer(uid),
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["status"] == "disbursed"
    assert data["credit_score"] >= 700
    assert data["amount_kobo"] == 20_000_00
    # Atomic disbursement bumped the wallet.
    assert _wallet_balance(uid) == before + 20_000_00


def test_request_loan_manual_review_when_score_mid(client):
    uid = _mid_score_user(client)
    before = _wallet_balance(uid)
    r = client.post(
        "/loans/request",
        json={"amount_kobo": 5_000_00},
        headers=_bearer(uid),
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["status"] == "manual_review"
    assert 500 <= data["credit_score"] < 700
    assert data["decision_reason"] == "manual_review_required"
    # No disbursement — wallet unchanged.
    assert _wallet_balance(uid) == before


def test_request_loan_declined_when_score_low(client):
    uid = _low_score_user(client)
    before = _wallet_balance(uid)
    r = client.post(
        "/loans/request",
        json={"amount_kobo": 1_000_00},
        headers=_bearer(uid),
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["status"] == "declined"
    assert data["credit_score"] < 500
    assert data["decision_reason"] == "credit_score_below_threshold"
    assert _wallet_balance(uid) == before


# ----------------------------------------------------------------- guards


def test_request_loan_rejects_when_active_loan_exists(client):
    uid = _high_score_user(client)
    r1 = client.post(
        "/loans/request",
        json={"amount_kobo": 5_000_00},
        headers=_bearer(uid),
    )
    assert r1.status_code == 200 and r1.json()["data"]["status"] == "disbursed"
    # Second request should be blocked.
    r2 = client.post(
        "/loans/request",
        json={"amount_kobo": 1_000_00},
        headers=_bearer(uid),
    )
    assert r2.status_code == 409
    assert r2.json()["detail"]["code"] == "active_loan_exists"


def test_request_loan_rejects_invalid_amount_too_small(client):
    uid = _high_score_user(client)
    r = client.post(
        "/loans/request",
        json={"amount_kobo": 999},  # below ₦10 floor
        headers=_bearer(uid),
    )
    assert r.status_code == 422


def test_request_loan_rejects_invalid_amount_too_large(client):
    uid = _high_score_user(client)
    r = client.post(
        "/loans/request",
        json={"amount_kobo": 60_000_000},  # above ₦500K ceiling
        headers=_bearer(uid),
    )
    assert r.status_code == 422


def test_request_loan_auth_required(client):
    r = client.post("/loans/request", json={"amount_kobo": 5_000_00})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "auth_required"


# ----------------------------------------------------------------- disbursement


def test_disbursement_creates_transaction_row(client):
    import importlib

    uid = _high_score_user(client)
    r = client.post(
        "/loans/request",
        json={"amount_kobo": 10_000_00},
        headers=_bearer(uid),
    )
    assert r.status_code == 200
    loan_id = r.json()["data"]["loan_id"]

    # Verify the Transaction row exists with the correct type + direction.
    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    from sqlalchemy import select

    with db_mod.db_session() as db:
        tx = db.scalar(
            select(models.Transaction).where(
                models.Transaction.idempotency_key == f"loan_disburse_{loan_id}"
            )
        )
        assert tx is not None
        assert tx.type == "loan_disbursement"
        assert tx.direction == "in"
        assert tx.amount_kobo == 10_000_00
        assert tx.status == "completed"


# ----------------------------------------------------------------- repayment


def test_repay_loan_partial_decrements_outstanding(client):
    uid = _high_score_user(client)
    r1 = client.post(
        "/loans/request",
        json={"amount_kobo": 20_000_00},
        headers=_bearer(uid),
    )
    loan_id = r1.json()["data"]["loan_id"]
    balance_after_disburse = _wallet_balance(uid)

    r2 = client.post(
        "/loans/repay",
        json={"loan_id": loan_id, "amount_kobo": 8_000_00},
        headers=_bearer(uid),
    )
    assert r2.status_code == 200, r2.text
    data = r2.json()["data"]
    assert data["status"] == "disbursed"  # still active
    assert data["repaid_kobo"] == 8_000_00
    assert data["outstanding_kobo"] == 12_000_00
    assert _wallet_balance(uid) == balance_after_disburse - 8_000_00


def test_repay_loan_full_marks_repaid(client):
    uid = _high_score_user(client)
    r1 = client.post(
        "/loans/request",
        json={"amount_kobo": 15_000_00},
        headers=_bearer(uid),
    )
    loan_id = r1.json()["data"]["loan_id"]
    balance_after_disburse = _wallet_balance(uid)

    r2 = client.post(
        "/loans/repay",
        json={"loan_id": loan_id, "amount_kobo": 15_000_00},
        headers=_bearer(uid),
    )
    assert r2.status_code == 200
    data = r2.json()["data"]
    assert data["status"] == "repaid"
    assert data["outstanding_kobo"] == 0
    assert data["repaid_at"] is not None
    assert _wallet_balance(uid) == balance_after_disburse - 15_000_00


def test_repay_loan_rejects_amount_exceeds_outstanding(client):
    uid = _high_score_user(client)
    r1 = client.post(
        "/loans/request",
        json={"amount_kobo": 5_000_00},
        headers=_bearer(uid),
    )
    loan_id = r1.json()["data"]["loan_id"]
    r2 = client.post(
        "/loans/repay",
        json={"loan_id": loan_id, "amount_kobo": 10_000_00},  # over
        headers=_bearer(uid),
    )
    assert r2.status_code == 400
    assert r2.json()["detail"]["code"] == "amount_exceeds_outstanding"


def test_repay_loan_rejects_other_users_loan(client):
    """Anti-leak: if loan belongs to another user, return 404 (not 403) to
    avoid revealing the loan's existence."""
    other = _high_score_user(client)
    r1 = client.post(
        "/loans/request",
        json={"amount_kobo": 5_000_00},
        headers=_bearer(other),
    )
    loan_id = r1.json()["data"]["loan_id"]

    intruder = _seed_user(client, customer_identifier="intruder", va_number="9999999998")
    r2 = client.post(
        "/loans/repay",
        json={"loan_id": loan_id, "amount_kobo": 1_000_00},
        headers=_bearer(intruder),
    )
    assert r2.status_code == 404
    assert r2.json()["detail"]["code"] == "loan_not_found"


# ----------------------------------------------------------------- /loans/me


def test_get_my_loans_returns_user_loans(client):
    uid = _high_score_user(client)
    r1 = client.post(
        "/loans/request",
        json={"amount_kobo": 5_000_00},
        headers=_bearer(uid),
    )
    assert r1.status_code == 200

    r2 = client.get("/loans/me", headers=_bearer(uid))
    assert r2.status_code == 200
    loans = r2.json()["data"]["loans"]
    assert len(loans) == 1
    assert loans[0]["status"] == "disbursed"


# ----------------------------------------------------------------- master VA invariant


def _seed_canonical_and_get_musa_id(client) -> int:
    """Run seed.main() against the test DB and return Musa's user_id.

    Establishes a drift=0 baseline (4 personas + 12 conservation-preserving
    gigs) needed for the reconcile invariant tests.
    """
    import importlib
    from sqlalchemy import select

    seed_module = importlib.import_module("seed")
    seed_module.main()

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        musa = db.scalar(
            select(models.User).where(
                models.User.customer_identifier == "musa_offloader_001"
            )
        )
        assert musa is not None
        return musa.id


def test_master_va_invariant_holds_after_loan_lifecycle(client):
    """Three-point invariant assertion per Leke directive:
    1. Before any loan activity:    drift = 0
    2. After disbursement (active): drift = 0
    3. After full repayment:        drift = 0

    Uses Musa (seed.py 4th persona, auto-approve band) as the borrower.
    """
    musa_uid = _seed_canonical_and_get_musa_id(client)

    # Point 1: baseline
    r = client.post("/admin/reconcile")
    assert r.status_code == 200
    assert r.json()["data"]["drift_kobo"] == 0
    assert r.json()["data"]["invariant_holds"] is True

    # Disburse
    r1 = client.post(
        "/loans/request",
        json={"amount_kobo": 20_000_00},
        headers=_bearer(musa_uid),
    )
    assert r1.status_code == 200, r1.text
    assert r1.json()["data"]["status"] == "disbursed"
    loan_id = r1.json()["data"]["loan_id"]

    # Point 2: mid-loan (active outstanding)
    r = client.post("/admin/reconcile")
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["drift_kobo"] == 0, (
        f"MID-LOAN drift broke! sum_balance={data['sum_balance_kobo']} "
        f"master_va={data['master_va_balance_kobo']} drift={data['drift_kobo']}"
    )
    assert data["invariant_holds"] is True

    # Repay in full
    r2 = client.post(
        "/loans/repay",
        json={"loan_id": loan_id, "amount_kobo": 20_000_00},
        headers=_bearer(musa_uid),
    )
    assert r2.json()["data"]["status"] == "repaid"

    # Point 3: post-lifecycle
    r = client.post("/admin/reconcile")
    assert r.json()["data"]["drift_kobo"] == 0
    assert r.json()["data"]["invariant_holds"] is True


def test_master_va_invariant_holds_during_outstanding_loan(client):
    """Explicit demo-day landmine guard.

    The 3:00 admin reconcile demo beat may fire AFTER the 3:45 loan
    disbursement beat. If drift ≠ 0 in this state, the "invariant
    holds" finale collapses on stage. This test pins that exact state
    and asserts drift = 0.
    """
    musa_uid = _seed_canonical_and_get_musa_id(client)
    r1 = client.post(
        "/loans/request",
        json={"amount_kobo": 18_500_00},  # arbitrary non-round amount
        headers=_bearer(musa_uid),
    )
    assert r1.status_code == 200, r1.text
    assert r1.json()["data"]["status"] == "disbursed"

    # DO NOT repay. Loan is outstanding.
    r = client.post("/admin/reconcile")
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["drift_kobo"] == 0
    assert data["invariant_holds"] is True


# ----------------------------------------------------------------- Musa seed


def test_musa_persona_seeded_with_qualifying_score(client):
    """Verify seed.py's Musa setup produces an auto-approve credit score.

    Runs seed.main() against the test DB and verifies:
    - Musa exists with the right customer_identifier
    - Musa has 12 inbound transactions
    - Musa's wallet balance is ~₦24,000
    - compute_credit_score returns >= 700 (auto-approve band)
    """
    import importlib
    from sqlalchemy import select

    seed_module = importlib.import_module("seed")
    seed_module.main()

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    cs_module = importlib.import_module("app.admin.credit_score")

    with db_mod.db_session() as db:
        musa = db.scalar(
            select(models.User).where(
                models.User.customer_identifier == "musa_offloader_001"
            )
        )
        assert musa is not None, "Musa not seeded"

        wallet = db.get(models.Wallet, musa.id)
        assert wallet is not None

        # 12 inbound gigs totaling ₦26,000 (sum of MUSA_GIGS amounts).
        txs = list(db.scalars(
            select(models.Transaction).where(models.Transaction.user_id == musa.id)
        ).all())
        assert len(txs) == 12, f"expected 12 gigs, got {len(txs)}"
        assert all(t.direction == "in" and t.status == "completed" for t in txs)
        assert sum(t.amount_kobo for t in txs) == 2_600_000
        assert wallet.balance_kobo == 2_600_000

        # Score in auto-approve band.
        score, breakdown = cs_module.compute_credit_score(wallet, txs, musa)
        assert score >= 700, f"Musa's score {score} below auto-approve threshold; breakdown={breakdown}"
