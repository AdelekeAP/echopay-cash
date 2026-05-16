"""GET /admin/anomalies — per-persona z-score anomaly summary.

Read-only sibling of /admin/state and /admin/reconcile. No auth
header (matches existing admin endpoints — the admin dashboard is
deployment-local, not internet-exposed).

Response envelope (PRD §6 `{success, data}` shape NOT used here for
consistency with the dashboard's existing top-level access patterns;
see admin.py for the same pattern).
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..admin.anomaly import detect_all_anomalies
from ..core.db import get_db


router = APIRouter(prefix="/admin", tags=["admin"])


def _summarize(anomalies_by_persona: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Compute summary counts. Markers (insufficient_history,
    persona_not_found) do NOT count as alerts — only `kind=anomaly`."""
    personas_scanned = len(anomalies_by_persona)
    personas_with_anomalies = 0
    severity_counts = {"high": 0, "medium": 0}
    total_alerts = 0

    for alerts in anomalies_by_persona.values():
        has_real_alert = False
        for alert in alerts:
            if alert.get("kind") == "anomaly":
                total_alerts += 1
                severity = alert.get("severity")
                if severity in severity_counts:
                    severity_counts[severity] += 1
                has_real_alert = True
        if has_real_alert:
            personas_with_anomalies += 1

    return {
        "personas_scanned": personas_scanned,
        "personas_with_anomalies": personas_with_anomalies,
        "total_alerts": total_alerts,
        "alerts_by_severity": severity_counts,
    }


@router.get("/anomalies")
def get_anomalies(db: Session = Depends(get_db)) -> dict[str, Any]:
    """Scan all canonical personas; return alerts grouped by persona."""
    anomalies = detect_all_anomalies(db)
    summary = _summarize(anomalies)
    return {
        "scanned_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        **summary,
        "anomalies": anomalies,
    }
