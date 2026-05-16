"""Tests for /admin/state + /admin/reconcile + credit_score.

Mirrors test_webhooks_squad.py and test_dva_create.py: per-test SQLite
DB via Funbi's `client` fixture, autouse cache reset for my new modules
(`app.api.admin`, `app.admin.credit_score`), no live network.

Coverage (7 tests):
  1. test_admin_state_returns_all_personas
  2. test_admin_state_includes_credit_score_breakdown
  3. test_admin_reconcile_invariant_holds_when_no_drift
  4. test_admin_reconcile_detects_drift
  5. test_credit_score_formula_clamps_to_300_850
  6. test_credit_score_breakdown_components_sum_correctly
  7. test_admin_reconcile_holds_after_in_network_transfer  ← demo-day land-mine guard
"""

from __future__ import annotations

import time

import pytest


# --------------------------------------------------------------- module cache reset


@pytest.fixture(autouse=True)
def _drop_stale_admin_modules():
    """Pop my modules BEFORE conftest's `client` fixture runs.

    Same pattern as test_webhooks_squad.py — conftest pops app.main +
    app.models + app.core.db + app.core.config + app.api.transfer, then
    re-imports. The re-import pulls `from .api.admin import router`,
    which holds stale references to the old Transaction/Wallet/User
    classes if not popped.
    """
    import sys

    pops = (
        "app.api.admin",
        "app.api.webhooks",
        "app.api.dva",
        "app.api.auth",
        "app.admin.credit_score",
        "app.squad.signature",
        "app.squad.dynamic_va",
        "app.squad.static_va",
        "app.squad.client",
        "app.voice.proxy",
        "seed",  # admin.py imports seed at module load — must re-import to pick up fresh PERSONAS
    )
    for mod_name in pops:
        sys.modules.pop(mod_name, None)

    yield

    for mod_name in pops:
        sys.modules.pop(mod_name, None)


# --------------------------------------------------------------- seed helpers


def _seed_three_personas() -> dict[str, int]:
    """Seed the 3 demo personas, return {persona_id: user_id}.

    Numbers match seed.py so the master_va baseline matches and the
    invariant holds on a fresh DB.
    """
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")

    specs = [
        ("mama_risikat_001", "Mama Risikat", "Oluwole", "0123456789", 40_000_000, 5_000_000),
        ("iya_tope_002", "Iya Tope", "Adeyemi", "0234567890", 11_000_000, 1_500_000),
        ("kosi_003", "Kosi", "Eze", "0345678901", 7_500_000, 500_000),
    ]
    ids: dict[str, int] = {}
    with db_mod.db_session() as db:
        for ci, fn, ln, va, bal, locked in specs:
            with db.begin():
                u = models.User(
                    customer_identifier=ci,
                    first_name=fn,
                    last_name=ln,
                    phone="+234 801 000 0000",
                    email="t@echopay.test",
                    bvn="22288899900",
                    dob="1980-01-01",
                    created_at=models.now_unix(),
                )
                db.add(u)
                db.flush()
                db.add(
                    models.Wallet(
                        user_id=u.id,
                        squad_va_number=va,
                        balance_kobo=bal,
                        locked_kobo=locked,
                        updated_at=models.now_unix(),
                    )
                )
                ids[ci.rsplit("_", 1)[0]] = u.id
    return ids


def _seed_user_with_balance(
    customer_identifier: str,
    balance_kobo: int,
    locked_kobo: int = 0,
    va_number: str = "9999999999",
    created_at_offset: int = 0,
) -> int:
    """Custom seed for credit-score tests. Returns user_id."""
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        with db.begin():
            u = models.User(
                customer_identifier=customer_identifier,
                first_name="Test",
                last_name="User",
                phone="+234 801 000 0000",
                email="t@echopay.test",
                bvn="22288899900",
                dob="1980-01-01",
                created_at=models.now_unix() + created_at_offset,
            )
            db.add(u)
            db.flush()
            db.add(
                models.Wallet(
                    user_id=u.id,
                    squad_va_number=va_number,
                    balance_kobo=balance_kobo,
                    locked_kobo=locked_kobo,
                    updated_at=models.now_unix(),
                )
            )
            return u.id


def _seed_qr_receive_tx(user_id: int, amount_kobo: int, ref: str, status: str = "completed") -> str:
    """Insert a qr_receive Transaction for the user. Mirrors PR #14's
    packed squad_ref shape."""
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    tx_id = f"qr_{ref[-12:]}"
    with db_mod.db_session() as db:
        with db.begin():
            db.add(
                models.Transaction(
                    id=tx_id,
                    user_id=user_id,
                    type="qr_receive",
                    direction="in",
                    amount_kobo=amount_kobo,
                    status=status,
                    idempotency_key=f"qr_test_{ref}",
                    squad_ref=f"9012345678|{ref}",
                    created_at=models.now_unix(),
                    settled_at=models.now_unix() if status == "completed" else None,
                )
            )
    return tx_id


def _mutate_wallet_balance(user_id: int, delta_kobo: int) -> None:
    """Directly mutate a wallet's balance_kobo WITHOUT inserting a
    Transaction. This simulates ledger corruption — used by the
    drift-detection test."""
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        with db.begin():
            w = db.get(models.Wallet, user_id)
            w.balance_kobo += delta_kobo


# ============================================================ tests


def test_admin_state_returns_all_personas(client):
    ids = _seed_three_personas()
    assert len(ids) == 3

    r = client.get("/admin/state")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    data = body["data"]
    assert "polled_at" in data
    assert len(data["personas"]) == 3

    persona_ids = {p["persona_id"] for p in data["personas"]}
    assert persona_ids == {"mama_risikat", "iya_tope", "kosi"}

    # Each persona has the required keys.
    for p in data["personas"]:
        assert "wallet" in p
        assert "credit_score" in p
        assert "recent_transactions" in p
        assert "recent_webhook_events" in p
        assert p["wallet"]["balance_kobo"] >= 0
        assert p["wallet"]["locked_kobo"] >= 0


def test_admin_state_includes_credit_score_breakdown(client):
    _seed_three_personas()

    r = client.get("/admin/state")
    assert r.status_code == 200
    body = r.json()

    for p in body["data"]["personas"]:
        cs = p["credit_score"]
        # Score is an int in the FICO 300-850 range.
        assert isinstance(cs["score"], int)
        assert 300 <= cs["score"] <= 850
        # Breakdown has all components.
        bd = cs["breakdown"]
        for key in (
            "base",
            "account_age_bonus",
            "inbound_bonus",
            "transfer_bonus",
            "balance_bonus",
            "failed_penalty",
            "raw_total",
            "clamped_score",
        ):
            assert key in bd, f"breakdown missing {key}"
        # Algebra: components sum to raw_total.
        recomputed = (
            bd["base"]
            + bd["account_age_bonus"]
            + bd["inbound_bonus"]
            + bd["transfer_bonus"]
            + bd["balance_bonus"]
            - bd["failed_penalty"]
        )
        assert recomputed == bd["raw_total"]
        # clamped_score is raw_total clamped to [300, 850] and matches score.
        assert bd["clamped_score"] == cs["score"]


def test_admin_reconcile_invariant_holds_when_no_drift(client):
    _seed_three_personas()

    r = client.post("/admin/reconcile")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    data = body["data"]

    # Fresh seed: sum of wallet balances + locked = baseline = master_va.
    assert data["sum_balance_kobo"] == 40_000_000 + 11_000_000 + 7_500_000
    assert data["sum_locked_kobo"] == 5_000_000 + 1_500_000 + 500_000
    assert data["sum_outstanding_permits_kobo"] == 0  # M2 — always 0 in M1
    assert data["computed_total_kobo"] == 65_500_000
    assert data["master_va_balance_kobo"] == 65_500_000
    assert data["drift_kobo"] == 0
    assert data["invariant_holds"] is True


def test_admin_reconcile_detects_drift(client):
    ids = _seed_three_personas()
    # Direct DB tamper: bump mama's wallet by ₦1,000 WITHOUT a Transaction.
    # This simulates ledger corruption — no inbound webhook, no transfer.
    _mutate_wallet_balance(ids["mama_risikat"], 1_000_000)  # +₦10,000

    r = client.post("/admin/reconcile")
    assert r.status_code == 200
    data = r.json()["data"]

    # SUM grew but master_va is unchanged (no qr_receive/topup tx).
    assert data["sum_balance_kobo"] == 40_000_000 + 11_000_000 + 7_500_000 + 1_000_000
    assert data["master_va_balance_kobo"] == 65_500_000
    assert data["drift_kobo"] == 1_000_000
    assert data["invariant_holds"] is False


def test_credit_score_formula_clamps_to_300_850(client):
    """Force extreme inputs and assert the clamp holds on both ends."""
    # Re-import the function inside this test since modules get reset.
    import importlib

    models = importlib.import_module("app.models")
    cs_module = importlib.import_module("app.admin.credit_score")

    # Floor case: brand new user, no transactions, ₦0 balance, no
    # failures. Score should land at exactly base=500 (no bonuses, no
    # penalty). Well above 300 floor — clamping never triggers.
    class _FakeWallet:
        balance_kobo = 0

    class _FakeUser:
        created_at = int(time.time())  # 0 days old

    score, bd = cs_module.compute_credit_score(_FakeWallet(), [], _FakeUser())
    assert score == 500
    assert 300 <= score <= 850

    # Ceiling case: ancient user with massive inbound + transfer count.
    # Should clamp at 850.
    class _OldUser:
        created_at = int(time.time()) - 86_400 * 5_000  # 5000 days old

    class _RichWallet:
        balance_kobo = 999_999_999_999

    huge_tx_list = []
    for i in range(1000):  # way more than the bonus caps allow

        class _Tx:
            pass

        t = _Tx()
        t.direction = "in"
        t.status = "completed"
        t.type = "in_network"
        huge_tx_list.append(t)

    score, bd = cs_module.compute_credit_score(_RichWallet(), huge_tx_list, _OldUser())
    # Max possible raw_total given current caps:
    #   500 + 100 (age max) + 120 (inbound max) + 80 (transfer max)
    #   + 50 (balance) - 0 (no failures) = 850 exactly.
    # The clamp to 850 is mathematically defensive — it can't be
    # exceeded with the current formula. Score lands at exactly 850.
    assert score == 850
    assert bd["raw_total"] == 850
    assert bd["clamped_score"] == 850
    # Verify bonuses are capped (not just below ceiling by coincidence).
    assert bd["inbound_bonus"] == 120
    assert bd["transfer_bonus"] == 80
    assert bd["account_age_bonus"] == 100

    # Floor stress: many failures, very new user, nothing else.
    class _NewUser:
        created_at = int(time.time())

    class _BrokeWallet:
        balance_kobo = 0

    fail_tx_list = []
    for _ in range(10):

        class _Tx:
            pass

        t = _Tx()
        t.direction = "out"
        t.status = "reversed"
        t.type = "in_network"
        fail_tx_list.append(t)

    score, bd = cs_module.compute_credit_score(_BrokeWallet(), fail_tx_list, _NewUser())
    # 500 base - 100 penalty (capped) = 400 — well above 300 floor,
    # no clamp.
    assert score == 400
    assert 300 <= score <= 850


def test_credit_score_breakdown_components_sum_correctly(client):
    """Hand-compute a known input → known output."""
    import importlib

    cs_module = importlib.import_module("app.admin.credit_score")

    # Construct exact inputs for a deterministic score.
    class _W:
        balance_kobo = 2_000_000  # > 1M threshold → +50

    class _U:
        # 100 days old → +200 capped to +100
        created_at = int(time.time()) - 86_400 * 100

    class _Tx:
        pass

    tx_list = []
    # 3 inbound completed → +45
    for _ in range(3):
        t = _Tx()
        t.direction, t.status, t.type = "in", "completed", "qr_receive"
        tx_list.append(t)
    # 2 in_network completed (outbound activity) → +16
    for _ in range(2):
        t = _Tx()
        t.direction, t.status, t.type = "out", "completed", "in_network"
        tx_list.append(t)
    # 1 failed → -25
    t = _Tx()
    t.direction, t.status, t.type = "out", "failed", "in_network"
    tx_list.append(t)

    score, bd = cs_module.compute_credit_score(_W(), tx_list, _U())

    assert bd["base"] == 500
    assert bd["account_age_bonus"] == 100  # 100 days × 2 = 200, capped to 100
    assert bd["inbound_bonus"] == 3 * 15  # 45
    assert bd["transfer_bonus"] == 2 * 8  # 16
    assert bd["balance_bonus"] == 50
    assert bd["failed_penalty"] == 25
    assert bd["raw_total"] == 500 + 100 + 45 + 16 + 50 - 25
    assert bd["raw_total"] == 686
    assert bd["clamped_score"] == 686
    assert score == 686


def test_admin_reconcile_holds_after_in_network_transfer(client):
    """Demo-day land-mine guard.

    PRD §1 Script A 1:15 beat: Mama → Iya Tope ₦5,000 in-network.
    Funbi's transfer.py creates ONE Transaction row with
    direction='out', type='in_network'. Mama's wallet drops 5K, Iya's
    rises 5K. SUM(wallets.balance) is unchanged.

    Refined master_va formula EXCLUDES in_network (Squad-side no-op),
    so master_va is also unchanged. Drift stays 0. Without this fix,
    the 3:00 reconcile beat would FAIL on stage.
    """
    ids = _seed_three_personas()

    # Use Funbi's real /transfer/in-network endpoint to make sure the
    # tx row + wallet mutation match the real demo flow.
    import time as _t
    body = {
        "from_user_id": ids["mama_risikat"],
        "to_user_id": ids["iya_tope"],
        "amount_kobo": 5_000_00,  # ₦5,000
        "idempotency_key": "test_demo_1_15_beat",
    }
    headers = {"Authorization": f"Bearer demo_token_{ids['mama_risikat']}_{int(_t.time())}"}
    r = client.post("/transfer/in-network", json=body, headers=headers)
    assert r.status_code == 200, r.text

    # Now reconcile.
    r = client.post("/admin/reconcile")
    assert r.status_code == 200, r.text
    data = r.json()["data"]

    # SUM is unchanged (intra-EchoPay): mama 40M-500K, iya 11M+500K,
    # kosi 7.5M → 58.5M still.
    assert data["sum_balance_kobo"] == 40_000_000 + 11_000_000 + 7_500_000
    # master_va is also unchanged (no qr_receive/topup/external_out).
    assert data["master_va_balance_kobo"] == 65_500_000
    # Critical: drift is 0.
    assert data["drift_kobo"] == 0
    assert data["invariant_holds"] is True
