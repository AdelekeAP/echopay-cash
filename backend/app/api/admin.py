"""GET /admin/state + POST /admin/reconcile — admin dashboard backend.

PRD §1 Script A 3:00 demo beat: presenter clicks "Run Reconcile" on the
projected dashboard → invariant math appears live →
  SUM(balance_kobo) + SUM(locked_kobo) + 0 (permits, M2) ≡ master VA

Also delivers Challenge 02 (25% rubric weight): synthetic credit score
per persona from wallet behaviour signals, NOT BVN credit history. Each
persona on the dashboard surfaces a FICO-range (300–850) score with the
formula breakdown visible.

Endpoints:
  GET  /admin/state     — full snapshot per persona (read-only)
  POST /admin/reconcile — invariant check, returns drift_kobo

Discipline:
  - Read-only on /admin/state and /admin/reconcile. No `with db.begin():`
    blocks needed (no writes).
  - `master_va_balance_kobo` is M1's gap-filler — synthesized from
    transaction history + a seeded baseline. Live Squad
    `/account/balance` query lands in a future PR.
  - Permits term is always 0 in M1 (PRD §3 + §6 mark permits as M2).
  - PRD §6 envelope: `{success, data}` on success.
"""

from __future__ import annotations

import logging
import sys
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..admin.credit_score import compute_credit_score
from ..core.db import get_db
from ..models import Transaction, User, Wallet, WebhookEvent

router = APIRouter(prefix="/admin", tags=["admin"])
logger = logging.getLogger("echopay.admin")


# ----------------------------------------------------------------- seed baseline

# Derive `initial_seed_master_va_kobo` from seed.py's PERSONAS constant.
# Avoids a system_meta table; keeps the source-of-truth in one place.
# Caveat: if you add a 4th persona later, update seed.py — admin.py
# reads it at module import. PRD §9 fixes the 3 personas for M1.
def _load_seed_master_va_kobo() -> int:
    # seed.py lives at backend/seed.py — sibling to backend/app/.
    # Add the backend root to sys.path so `import seed` resolves.
    backend_dir = Path(__file__).resolve().parents[2]
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))
    import seed  # noqa: WPS433 — late import is intentional

    return sum(
        int(p["balance_kobo"]) + int(p["locked_kobo"]) for p in seed.PERSONAS
    )


_INITIAL_SEED_MASTER_VA_KOBO = _load_seed_master_va_kobo()


# ----------------------------------------------------------------- schemas


class _Wallet(BaseModel):
    squad_va_number: str
    balance_kobo: int
    locked_kobo: int
    version: int
    updated_at: int


class _CreditScore(BaseModel):
    score: int
    breakdown: dict[str, int]


class _Transaction(BaseModel):
    id: str
    type: str
    direction: str
    amount_kobo: int
    status: str
    counterparty_user_id: Optional[int] = None
    squad_ref: Optional[str] = None
    created_at: int
    settled_at: Optional[int] = None


class _WebhookEvent(BaseModel):
    transaction_ref: str
    source: str
    signature_valid: int
    mismatch: int
    signature_version_matched: Optional[str] = None
    processed_at: int


class _Persona(BaseModel):
    persona_id: str
    user_id: int
    persona_name: str
    wallet: _Wallet
    credit_score: _CreditScore
    recent_transactions: list[_Transaction]
    recent_webhook_events: list[_WebhookEvent]


class _AdminStateData(BaseModel):
    personas: list[_Persona]
    polled_at: int


class AdminStateResponse(BaseModel):
    success: bool
    data: _AdminStateData


class _ReconcileData(BaseModel):
    sum_balance_kobo: int
    sum_locked_kobo: int
    sum_outstanding_permits_kobo: int
    computed_total_kobo: int
    master_va_balance_kobo: int
    drift_kobo: int
    invariant_holds: bool
    checked_at: int
    note: str


class ReconcileResponse(BaseModel):
    success: bool
    data: _ReconcileData


AdminStateResponse.model_rebuild()
ReconcileResponse.model_rebuild()


# ----------------------------------------------------------------- helpers


def _persona_id_from_customer_identifier(customer_identifier: str) -> str:
    # seed.py uses `<persona_id>_NNN` shape (e.g. mama_risikat_001).
    # Strip the trailing _NNN to recover the persona_id.
    parts = customer_identifier.rsplit("_", 1)
    if len(parts) == 2 and parts[1].isdigit():
        return parts[0]
    return customer_identifier


def _serialize_transaction(tx: Transaction) -> _Transaction:
    return _Transaction(
        id=tx.id,
        type=tx.type,
        direction=tx.direction,
        amount_kobo=tx.amount_kobo,
        status=tx.status,
        counterparty_user_id=tx.counterparty_user_id,
        squad_ref=tx.squad_ref,
        created_at=tx.created_at,
        settled_at=tx.settled_at,
    )


def _serialize_webhook(ev: WebhookEvent) -> _WebhookEvent:
    return _WebhookEvent(
        transaction_ref=ev.transaction_ref,
        source=ev.source,
        signature_valid=ev.signature_valid,
        mismatch=ev.mismatch,
        signature_version_matched=ev.signature_version_matched,
        processed_at=ev.processed_at,
    )


def _master_va_balance_kobo(db: Session) -> int:
    """M1 gap-filler.

    master_va = initial_seed_baseline
              + SUM(amount WHERE type IN ('qr_receive', 'topup', 'loan_disbursement'))
              - SUM(amount WHERE type IN ('external_out', 'loan_repayment'))

    Type classification by ledger semantics — what each type does to the
    NETWORK TOTAL (the master_va number):

      `in_network`         → intra-EchoPay; both sides inside the pool.
                              EXCLUDED — counting would false-positive
                              drift after every 1:15-beat in-network
                              transfer.
      `qr_receive`         → inbound from external bank via Squad webhook.
                              EXTERNAL cash enters → master_va += amount.
      `topup`              → inbound from Static VA (future).
      `external_out`       → outbound via Squad payout.
                              EXTERNAL cash leaves → master_va -= amount.
      `loan_disbursement`  → bank-style credit creation. Borrower's wallet
                              is credited, so to keep the invariant
                              `computed_total == master_va` we MUST mark
                              master_va += amount when the loan goes out.
                              Conceptually: the pool expands to cover the
                              new credit (real banks create money when
                              they lend).
      `loan_repayment`     → credit destruction. Borrower's wallet is
                              debited, so master_va -= amount keeps
                              `computed_total == master_va` aligned.

    Sign-direction caveat: the surface intuition is "loan disburse means
    cash leaves the pool" which would put loan_disbursement on the
    outbound side. But that breaks the invariant because the wallet
    debit/credit and the master_va change must go SAME direction (both
    up or both down) for drift to stay 0. We model loans as
    credit-creation events (Leke directive 2026-05-16): drift = 0 always,
    including mid-loan and during partial repayments. The 3:00 demo
    reconcile beat survives even when judges click reconcile after the
    3:45 loan disbursement beat.
    """
    inbound = (
        db.query(Transaction)
        .where(
            Transaction.status == "completed",
            Transaction.type.in_(("qr_receive", "topup", "loan_disbursement")),
        )
        .with_entities(Transaction.amount_kobo)
        .all()
    )
    outbound = (
        db.query(Transaction)
        .where(
            Transaction.status == "completed",
            Transaction.type.in_(("external_out", "loan_repayment")),
        )
        .with_entities(Transaction.amount_kobo)
        .all()
    )
    inbound_total = sum(row[0] for row in inbound)
    outbound_total = sum(row[0] for row in outbound)
    return _INITIAL_SEED_MASTER_VA_KOBO + inbound_total - outbound_total


# ----------------------------------------------------------------- handlers


@router.get("/state", response_model=AdminStateResponse)
def admin_state(db: Session = Depends(get_db)) -> AdminStateResponse:
    """Full per-persona snapshot. Polled every 2s by the dashboard."""
    users = db.scalars(select(User).order_by(User.id)).all()

    personas_out: list[_Persona] = []
    for u in users:
        wallet = db.get(Wallet, u.id)
        if wallet is None:
            # Skip orphan users (shouldn't happen post-seed, but
            # defensive).
            continue

        # 5 most recent transactions for this user
        user_txs = (
            db.scalars(
                select(Transaction)
                .where(Transaction.user_id == u.id)
                .order_by(Transaction.created_at.desc())
                .limit(5)
            ).all()
        )

        # 5 most recent webhook events touching this user (matched
        # by counterpart Transaction's user_id via squad_ref).
        # Cheap approach: fetch the user's recent qr_receive txs and
        # look up their webhook events. Costs at most one extra
        # query per persona. Acceptable for admin polling.
        user_qr_refs = [
            t.squad_ref.split("|", 1)[-1] if t.squad_ref and "|" in t.squad_ref
            else (t.squad_ref or "")
            for t in user_txs
            if t.type == "qr_receive" and t.squad_ref
        ]
        recent_events_out: list[_WebhookEvent] = []
        if user_qr_refs:
            events = (
                db.scalars(
                    select(WebhookEvent)
                    .where(WebhookEvent.transaction_ref.in_(user_qr_refs))
                    .order_by(WebhookEvent.processed_at.desc())
                    .limit(5)
                ).all()
            )
            recent_events_out = [_serialize_webhook(ev) for ev in events]

        # Compute credit score from all transactions for this user
        # (not just the recent 5 — formula reads the full history).
        all_txs = (
            db.scalars(
                select(Transaction).where(Transaction.user_id == u.id)
            ).all()
        )
        score, breakdown = compute_credit_score(wallet, list(all_txs), u)

        personas_out.append(
            _Persona(
                persona_id=_persona_id_from_customer_identifier(u.customer_identifier),
                user_id=u.id,
                persona_name=f"{u.first_name} {u.last_name}",
                wallet=_Wallet(
                    squad_va_number=wallet.squad_va_number,
                    balance_kobo=wallet.balance_kobo,
                    locked_kobo=wallet.locked_kobo,
                    version=wallet.version,
                    updated_at=wallet.updated_at,
                ),
                credit_score=_CreditScore(score=score, breakdown=breakdown),
                recent_transactions=[_serialize_transaction(t) for t in user_txs],
                recent_webhook_events=recent_events_out,
            )
        )

    return AdminStateResponse(
        success=True,
        data=_AdminStateData(
            personas=personas_out,
            polled_at=int(time.time()),
        ),
    )


@router.post("/reconcile", response_model=ReconcileResponse)
def admin_reconcile(db: Session = Depends(get_db)) -> ReconcileResponse:
    """PRD §4.5 invariant check.

    Comparison side: SUM(wallets.balance_kobo + locked_kobo) over all
    wallets. The OTHER side: master_va_balance_kobo (M1 gap-filler;
    see _master_va_balance_kobo docstring).

    drift = computed_total - master_va. invariant_holds = drift == 0.
    """
    wallets = db.scalars(select(Wallet)).all()
    sum_balance = sum(w.balance_kobo for w in wallets)
    sum_locked = sum(w.locked_kobo for w in wallets)
    # M2: permits.max_amount_kobo WHERE status='outstanding'.
    # M1: permits table doesn't exist; always 0.
    sum_outstanding_permits = 0

    computed_total = sum_balance + sum_locked + sum_outstanding_permits
    master_va = _master_va_balance_kobo(db)
    drift = computed_total - master_va

    note = (
        "master_va_balance_kobo is M1 gap-filler: synthesized from "
        "initial_seed_master_va_kobo + qr_receive/topup credits - "
        "external_out debits. In-network transfers excluded (Squad-side "
        "no-op). Live Squad /account/balance query lands in a future PR."
    )

    return ReconcileResponse(
        success=True,
        data=_ReconcileData(
            sum_balance_kobo=sum_balance,
            sum_locked_kobo=sum_locked,
            sum_outstanding_permits_kobo=sum_outstanding_permits,
            computed_total_kobo=computed_total,
            master_va_balance_kobo=master_va,
            drift_kobo=drift,
            invariant_holds=(drift == 0),
            checked_at=int(time.time()),
            note=note,
        ),
    )
