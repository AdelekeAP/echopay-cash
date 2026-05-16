"""Per-persona transaction-amount anomaly detection (z-score).

Algorithm
---------
For each persona's last N=30 OUTBOUND completed transactions
(direction='out', status='completed'), compute mean + population
stdev of amount_kobo. For each transaction:

    z = |amount - mean| / stdev

    z >= 2.5          → severity='high'   (review recommended)
    1.5 <= z < 2.5    → severity='medium' (monitoring flagged)
    z <  1.5          → not flagged

abs(z) is used so unusually SMALL amounts also flag (e.g. a wallet
that normally sends ₦5K suddenly sending ₦50 looks like funny business
too — could be a probe before a larger drain).

Edge cases:
  - <5 outbound history rows → no scoring; return marker
    `insufficient_history` so the API can surface "not enough data"
    rather than silently returning empty
  - stdev = 0 (all amounts equal) → all z values undefined; no flags
  - empty wallet history → empty result

Production path:
  This is the rules-based MVP. Production replaces the per-persona
  z-score with a trained model that uses:
    - merchant category embeddings
    - time-of-day + day-of-week features
    - counterparty graph features
    - feedback loop from operator-reviewed flags
  The interface (function signature) stays the same so the model
  drop-in is internal-only.

Bias note:
  Per-persona baselines mean each user is judged against their own
  pattern, not a population norm. A trader with consistently large
  transactions has a higher baseline, so large amounts aren't
  reflexively flagged. Bias surface = cold-start (< min_history rows);
  mitigated by the insufficient_history marker which surfaces the
  uncertainty rather than guessing.
"""

from __future__ import annotations

import statistics
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Transaction, User


DEFAULT_WINDOW_SIZE = 30
DEFAULT_MIN_HISTORY = 5
HIGH_THRESHOLD = 2.5
MEDIUM_THRESHOLD = 1.5


@dataclass
class _PersonaStats:
    persona_uid: str
    persona_display: str
    user_id: int
    transactions: list[Transaction]  # ordered newest-first


def _format_naira(amount_kobo: int | float) -> str:
    """₦12,500 — comma-thousands, no decimals."""
    naira = int(round(amount_kobo / 100))
    return f"₦{naira:,}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _reason_high(amount_kobo: int, z: float, mean_kobo: float, stdev_kobo: float,
                 persona_display: str) -> str:
    return (
        f"Transaction amount {_format_naira(amount_kobo)} is {z:.1f}σ above "
        f"{persona_display}'s typical pattern "
        f"(avg {_format_naira(mean_kobo)}, stdev {_format_naira(stdev_kobo)}). "
        "Review recommended."
    )


def _reason_medium(amount_kobo: int, z: float, persona_display: str) -> str:
    return (
        f"Transaction amount {_format_naira(amount_kobo)} is {z:.1f}σ above "
        f"{persona_display}'s typical pattern. Monitoring flagged."
    )


def _load_persona_stats(
    db: Session,
    customer_identifier: str,
    window_size: int,
) -> _PersonaStats | None:
    """Find the user by customer_identifier and load their last
    window_size outbound completed transactions. Returns None if
    user not found (orphan persona_uid — caller's responsibility)."""
    user = db.scalar(
        select(User).where(User.customer_identifier == customer_identifier)
    )
    if user is None:
        return None

    txs = list(
        db.scalars(
            select(Transaction)
            .where(
                Transaction.user_id == user.id,
                Transaction.direction == "out",
                Transaction.status == "completed",
            )
            .order_by(Transaction.created_at.desc())
            .limit(window_size)
        ).all()
    )

    persona_display = f"{user.first_name} {user.last_name}".strip()
    return _PersonaStats(
        persona_uid=customer_identifier,
        persona_display=persona_display,
        user_id=user.id,
        transactions=txs,
    )


def detect_anomalies(
    db: Session,
    persona_uid: str,
    window_size: int = DEFAULT_WINDOW_SIZE,
    min_history: int = DEFAULT_MIN_HISTORY,
) -> list[dict[str, Any]]:
    """Scan one persona's recent outbound transactions for z-score outliers.

    Returns a list of alert dicts (may be empty). Special case: if the
    persona has < min_history outbound completed transactions, returns
    a single-element list containing a `{kind: "insufficient_history"}`
    marker rather than an empty list — callers can distinguish "scanned
    and found nothing" from "couldn't scan."
    """
    stats = _load_persona_stats(db, persona_uid, window_size)
    if stats is None:
        return [{
            "kind": "persona_not_found",
            "persona_uid": persona_uid,
            "detected_at": _now_iso(),
        }]

    if len(stats.transactions) < min_history:
        return [{
            "kind": "insufficient_history",
            "persona_uid": persona_uid,
            "history_count": len(stats.transactions),
            "min_required": min_history,
            "detected_at": _now_iso(),
        }]

    amounts = [tx.amount_kobo for tx in stats.transactions]
    mean_val = statistics.mean(amounts)
    stdev_val = statistics.pstdev(amounts)  # population stdev

    # All amounts equal → no variance to score against.
    if stdev_val == 0:
        return []

    alerts: list[dict[str, Any]] = []
    now_iso = _now_iso()

    for tx in stats.transactions:
        z = abs(tx.amount_kobo - mean_val) / stdev_val
        if z >= HIGH_THRESHOLD:
            severity = "high"
            reason = _reason_high(
                tx.amount_kobo, z, mean_val, stdev_val, stats.persona_display
            )
        elif z >= MEDIUM_THRESHOLD:
            severity = "medium"
            reason = _reason_medium(tx.amount_kobo, z, stats.persona_display)
        else:
            continue

        alerts.append({
            "kind": "anomaly",
            "transaction_id": tx.id,
            "persona_uid": persona_uid,
            "persona_display": stats.persona_display,
            "amount_kobo": tx.amount_kobo,
            "z_score": round(z, 2),
            "severity": severity,
            "mean_amount_kobo": int(round(mean_val)),
            "stdev_amount_kobo": int(round(stdev_val)),
            "reason": reason,
            "transaction_created_at": tx.created_at,
            "detected_at": now_iso,
        })

    return alerts


# Canonical 4 personas from seed.py. Listed here rather than imported
# to keep anomaly.py free of the seed module's import-time side effects.
_CANONICAL_PERSONA_UIDS = (
    "mama_risikat_001",
    "iya_tope_002",
    "kosi_003",
    "musa_offloader_001",
)


def detect_all_anomalies(
    db: Session,
    window_size: int = DEFAULT_WINDOW_SIZE,
    min_history: int = DEFAULT_MIN_HISTORY,
) -> dict[str, list[dict[str, Any]]]:
    """Run detect_anomalies for each canonical persona.

    Returns:
        {persona_uid: [alerts...], ...}

    Missing personas return [{kind: "persona_not_found", ...}].
    Personas with insufficient history return their marker. Personas
    with no flagged transactions return [].
    """
    out: dict[str, list[dict[str, Any]]] = {}
    for uid in _CANONICAL_PERSONA_UIDS:
        out[uid] = detect_anomalies(
            db, uid, window_size=window_size, min_history=min_history
        )
    return out
