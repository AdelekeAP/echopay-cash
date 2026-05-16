"""Tests for the per-persona z-score anomaly detector.

Covers:
- Algorithm correctness (empty, insufficient_history, no flags,
  high severity ≥2.5σ, medium 1.5-2.5σ, stdev=0 edge case)
- Filtering (outbound only, completed only, window respected)
- Reason string formatting (naira + commas + 1-decimal z)
- detect_all_anomalies aggregation across canonical personas
- API endpoint shape + summary counts
"""

from __future__ import annotations

import sys

import pytest


# ----------------------------------------------------------------- fixtures


@pytest.fixture(autouse=True)
def _reset_module_caches(client):  # noqa: ARG001 — depend on client to order after it
    yield
    for mod_name in (
        "app.admin.anomaly",
        "app.api.anomalies",
    ):
        sys.modules.pop(mod_name, None)


@pytest.fixture
def make_persona(client):  # noqa: ARG001
    """Returns a factory that creates a User + Wallet at a given UID."""
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")

    def _make(
        customer_identifier: str,
        first_name: str = "Test",
        last_name: str = "User",
        va_number: str | None = None,
    ) -> int:
        if va_number is None:
            # Deterministic 10-digit VA — derive from customer_identifier
            va_number = "9" + str(abs(hash(customer_identifier)) % 1_000_000_000).zfill(9)
        with db_mod.db_session() as db:
            with db.begin():
                u = models.User(
                    customer_identifier=customer_identifier,
                    first_name=first_name,
                    last_name=last_name,
                    phone="+2348012345678",
                    email="t@test",
                    bvn="22288899900",
                    dob="1990-01-01",
                    created_at=models.now_unix(),
                )
                db.add(u)
                db.flush()
                db.add(models.Wallet(
                    user_id=u.id,
                    squad_va_number=va_number,
                    balance_kobo=100_000_000,
                    updated_at=models.now_unix(),
                ))
                return u.id

    return _make


@pytest.fixture
def add_outbound_tx(client):  # noqa: ARG001
    """Insert an outbound completed transaction. Returns tx_id."""
    import importlib
    import uuid

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")

    def _add(
        user_id: int,
        amount_kobo: int,
        offset_seconds: int = 0,
        status: str = "completed",
        direction: str = "out",
        tx_type: str = "in_network",
    ) -> str:
        now = models.now_unix()
        tx_id = f"anom_{uuid.uuid4().hex[:14]}"
        with db_mod.db_session() as db:
            with db.begin():
                db.add(models.Transaction(
                    id=tx_id,
                    user_id=user_id,
                    type=tx_type,
                    direction=direction,
                    amount_kobo=amount_kobo,
                    status=status,
                    idempotency_key=f"anom_{tx_id}",
                    created_at=now - offset_seconds,
                    settled_at=now - offset_seconds,
                ))
        return tx_id

    return _add


@pytest.fixture
def fresh_db(client):
    """Return a fresh SQLAlchemy session so tests can inspect state."""
    import importlib
    db_mod = importlib.import_module("app.core.db")
    return db_mod.db_session


# ----------------------------------------------------------------- algorithm tests


def test_detect_anomalies_returns_persona_not_found_marker_when_uid_unknown(client, fresh_db):
    from app.admin.anomaly import detect_anomalies
    with fresh_db() as db:
        result = detect_anomalies(db, "nonexistent_persona_999")
    assert len(result) == 1
    assert result[0]["kind"] == "persona_not_found"


def test_detect_anomalies_returns_insufficient_history_when_under_5(
    client, make_persona, add_outbound_tx, fresh_db
):
    uid = make_persona("mama_risikat_001", "Mama", "Risikat")
    # 3 outbound transactions — below default min_history=5
    for amount in (5_000_00, 6_000_00, 7_000_00):
        add_outbound_tx(uid, amount)

    from app.admin.anomaly import detect_anomalies
    with fresh_db() as db:
        result = detect_anomalies(db, "mama_risikat_001")
    assert len(result) == 1
    assert result[0]["kind"] == "insufficient_history"
    assert result[0]["history_count"] == 3
    assert result[0]["min_required"] == 5


def test_detect_anomalies_no_flags_when_all_within_1_5_sigma(
    client, make_persona, add_outbound_tx, fresh_db
):
    """5 transactions around ₦5K-7K with one ₦7.5K — well within 1.5σ."""
    uid = make_persona("kosi_003", "Kosi", "Eze")
    for i, amt in enumerate([5_000_00, 6_000_00, 7_000_00, 5_500_00, 6_500_00]):
        add_outbound_tx(uid, amt, offset_seconds=i * 60)

    from app.admin.anomaly import detect_anomalies
    with fresh_db() as db:
        result = detect_anomalies(db, "kosi_003")
    # All within 1.5σ → empty list (NOT a marker)
    assert result == []


def test_detect_anomalies_flags_high_severity_at_2_5_sigma(
    client, make_persona, add_outbound_tx, fresh_db
):
    """Pattern: 9 transactions at ₦5K + one at ₦50K → ~3σ outlier → high."""
    uid = make_persona("mama_risikat_001", "Mama", "Risikat")
    for i in range(9):
        add_outbound_tx(uid, 5_000_00, offset_seconds=(i + 1) * 60)
    big_tx = add_outbound_tx(uid, 50_000_00, offset_seconds=0)

    from app.admin.anomaly import detect_anomalies
    with fresh_db() as db:
        result = detect_anomalies(db, "mama_risikat_001")
    high_alerts = [a for a in result if a.get("severity") == "high"]
    assert len(high_alerts) == 1
    flagged = high_alerts[0]
    assert flagged["transaction_id"] == big_tx
    assert flagged["amount_kobo"] == 50_000_00
    assert flagged["z_score"] >= 2.5


def test_detect_anomalies_flags_medium_severity_between_1_5_and_2_5(
    client, make_persona, add_outbound_tx, fresh_db
):
    """Pattern: small variance + one moderate outlier → medium."""
    uid = make_persona("iya_tope_002", "Iya", "Tope")
    # 6 small transactions at ₦5K-6K, one at ₦9K — should hit ~1.8σ
    amounts = [5_000_00, 5_100_00, 5_200_00, 5_300_00, 5_400_00, 5_500_00, 8_500_00]
    for i, amt in enumerate(amounts):
        add_outbound_tx(uid, amt, offset_seconds=i * 60)

    from app.admin.anomaly import detect_anomalies
    with fresh_db() as db:
        result = detect_anomalies(db, "iya_tope_002")
    medium = [a for a in result if a.get("severity") == "medium"]
    high = [a for a in result if a.get("severity") == "high"]
    assert len(medium) == 1
    assert len(high) == 0
    assert 1.5 <= medium[0]["z_score"] < 2.5


def test_detect_anomalies_handles_stdev_zero_edge_case(
    client, make_persona, add_outbound_tx, fresh_db
):
    """All amounts equal → stdev=0 → no flags, no division by zero."""
    uid = make_persona("kosi_003", "Kosi", "Eze")
    for i in range(6):
        add_outbound_tx(uid, 5_000_00, offset_seconds=i * 60)

    from app.admin.anomaly import detect_anomalies
    with fresh_db() as db:
        result = detect_anomalies(db, "kosi_003")
    assert result == []  # No flags, no crash


def test_detect_anomalies_only_considers_outbound(
    client, make_persona, add_outbound_tx, fresh_db
):
    """Inbound transactions must NOT contribute to the baseline or get flagged."""
    uid = make_persona("musa_offloader_001", "Musa", "Adamu")
    # 5 inbound (will be ignored) + 5 outbound consistent — should yield empty
    for i in range(5):
        add_outbound_tx(uid, 100_000_00, offset_seconds=i * 60, direction="in")
    for i in range(5):
        add_outbound_tx(uid, 5_000_00, offset_seconds=(i + 10) * 60)

    from app.admin.anomaly import detect_anomalies
    with fresh_db() as db:
        result = detect_anomalies(db, "musa_offloader_001")
    # The 5 outbound all equal → stdev=0 → no flags
    assert result == []


def test_detect_anomalies_only_considers_completed(
    client, make_persona, add_outbound_tx, fresh_db
):
    """pending/failed transactions don't contribute even if huge."""
    uid = make_persona("kosi_003", "Kosi", "Eze")
    for i in range(5):
        add_outbound_tx(uid, 5_000_00, offset_seconds=i * 60)
    # A huge "failed" outbound — should be excluded
    add_outbound_tx(uid, 500_000_00, offset_seconds=300, status="failed")
    # Another "pending" one
    add_outbound_tx(uid, 500_000_00, offset_seconds=400, status="pending")

    from app.admin.anomaly import detect_anomalies
    with fresh_db() as db:
        result = detect_anomalies(db, "kosi_003")
    # Only the 5 completed (all equal) count → stdev=0 → no flags
    assert result == []


def test_detect_anomalies_window_size_respected(
    client, make_persona, add_outbound_tx, fresh_db
):
    """If window_size=5, only the most recent 5 outbounds contribute."""
    uid = make_persona("mama_risikat_001", "Mama", "Risikat")
    # 5 older small transactions
    for i in range(5):
        add_outbound_tx(uid, 50_000_00, offset_seconds=10_000 + i * 60)
    # 5 recent uniform transactions
    for i in range(5):
        add_outbound_tx(uid, 5_000_00, offset_seconds=i * 60)

    from app.admin.anomaly import detect_anomalies
    with fresh_db() as db:
        # Window=5 → only the 5 recent uniform → stdev=0 → no flags
        result = detect_anomalies(db, "mama_risikat_001", window_size=5)
    assert result == []

    with fresh_db() as db:
        # Window=10 → 10 transactions, half at 5K half at 50K → big stdev
        result = detect_anomalies(db, "mama_risikat_001", window_size=10)
    # All within ~1σ of mean (27_500_00) because variance is large
    # — confirm no high-severity flags
    high = [a for a in result if a.get("severity") == "high"]
    assert len(high) == 0


# ----------------------------------------------------------------- reason string


def test_reason_string_format_high_severity(
    client, make_persona, add_outbound_tx, fresh_db
):
    uid = make_persona("mama_risikat_001", "Mama", "Risikat")
    for i in range(9):
        add_outbound_tx(uid, 5_000_00, offset_seconds=(i + 1) * 60)
    add_outbound_tx(uid, 100_000_00, offset_seconds=0)

    from app.admin.anomaly import detect_anomalies
    with fresh_db() as db:
        result = detect_anomalies(db, "mama_risikat_001")
    high = [a for a in result if a.get("severity") == "high"][0]
    reason = high["reason"]
    # Expected form: "Transaction amount ₦X is Y.Yσ above ... typical pattern
    # (avg ₦Z, stdev ₦W). Review recommended."
    assert "Review recommended" in reason
    assert "avg ₦" in reason
    assert "stdev ₦" in reason
    assert "Mama Risikat" in reason
    assert "σ above" in reason


def test_reason_string_format_medium_severity(
    client, make_persona, add_outbound_tx, fresh_db
):
    uid = make_persona("iya_tope_002", "Iya", "Tope")
    amounts = [5_000_00, 5_100_00, 5_200_00, 5_300_00, 5_400_00, 5_500_00, 8_500_00]
    for i, amt in enumerate(amounts):
        add_outbound_tx(uid, amt, offset_seconds=i * 60)

    from app.admin.anomaly import detect_anomalies
    with fresh_db() as db:
        result = detect_anomalies(db, "iya_tope_002")
    medium = [a for a in result if a.get("severity") == "medium"][0]
    reason = medium["reason"]
    assert "Monitoring flagged" in reason
    # Medium reason has NO mean/stdev parenthetical
    assert "(avg" not in reason
    assert "Iya Tope" in reason


def test_reason_string_naira_formatting_with_commas(
    client, make_persona, add_outbound_tx, fresh_db
):
    """Amounts >₦1,000 must show comma-thousands separator."""
    uid = make_persona("mama_risikat_001", "Mama", "Risikat")
    for i in range(9):
        add_outbound_tx(uid, 5_000_00, offset_seconds=(i + 1) * 60)
    add_outbound_tx(uid, 500_000_00, offset_seconds=0)  # ₦500,000

    from app.admin.anomaly import detect_anomalies
    with fresh_db() as db:
        result = detect_anomalies(db, "mama_risikat_001")
    high = [a for a in result if a.get("severity") == "high"][0]
    # ₦500,000 with comma
    assert "₦500,000" in high["reason"]


# ----------------------------------------------------------------- aggregator


def test_detect_all_anomalies_covers_all_personas(
    client, make_persona, add_outbound_tx, fresh_db
):
    """All 4 canonical personas appear in the response, even if empty."""
    # Only seed one persona → others return persona_not_found markers
    uid = make_persona("mama_risikat_001", "Mama", "Risikat")
    for i in range(5):
        add_outbound_tx(uid, 5_000_00, offset_seconds=i * 60)

    from app.admin.anomaly import detect_all_anomalies
    with fresh_db() as db:
        result = detect_all_anomalies(db)
    assert set(result.keys()) == {
        "mama_risikat_001",
        "iya_tope_002",
        "kosi_003",
        "musa_offloader_001",
    }
    # mama has stdev=0 → empty list, no markers
    assert result["mama_risikat_001"] == []
    # Others not seeded → persona_not_found marker
    for uid in ("iya_tope_002", "kosi_003", "musa_offloader_001"):
        assert len(result[uid]) == 1
        assert result[uid][0]["kind"] == "persona_not_found"


# ----------------------------------------------------------------- API endpoint


def test_api_endpoint_returns_correct_shape(client):
    """Endpoint responds 200 with the documented envelope."""
    r = client.get("/admin/anomalies")
    assert r.status_code == 200, r.text
    data = r.json()
    assert "scanned_at" in data
    assert "personas_scanned" in data
    assert "personas_with_anomalies" in data
    assert "total_alerts" in data
    assert "alerts_by_severity" in data
    assert set(data["alerts_by_severity"].keys()) == {"high", "medium"}
    assert "anomalies" in data
    # 4 canonical personas always present
    assert set(data["anomalies"].keys()) == {
        "mama_risikat_001",
        "iya_tope_002",
        "kosi_003",
        "musa_offloader_001",
    }


def test_api_endpoint_summary_counts_correct(
    client, make_persona, add_outbound_tx
):
    """Summary counts reflect actual alerts, ignoring markers."""
    # Mama: 1 high-severity flag
    uid_mama = make_persona("mama_risikat_001", "Mama", "Risikat")
    for i in range(9):
        add_outbound_tx(uid_mama, 5_000_00, offset_seconds=(i + 1) * 60)
    add_outbound_tx(uid_mama, 100_000_00, offset_seconds=0)

    # Iya: 1 medium-severity flag
    uid_iya = make_persona("iya_tope_002", "Iya", "Tope")
    amounts = [5_000_00, 5_100_00, 5_200_00, 5_300_00, 5_400_00, 5_500_00, 8_500_00]
    for i, amt in enumerate(amounts):
        add_outbound_tx(uid_iya, amt, offset_seconds=i * 60)

    # Kosi + Musa not seeded → persona_not_found markers (don't count)

    r = client.get("/admin/anomalies")
    data = r.json()
    assert data["personas_scanned"] == 4
    assert data["personas_with_anomalies"] == 2
    assert data["total_alerts"] == 2
    assert data["alerts_by_severity"]["high"] == 1
    assert data["alerts_by_severity"]["medium"] == 1
