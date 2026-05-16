"""Loans — working-capital credit against the synthetic credit score.

PR #19 added the score; this turns it into a service. Endpoint behavior:

  POST /loans/request   — score-driven decisioning + atomic disbursement
  POST /loans/repay     — atomic debit + full-repayment marking
  GET  /loans/me        — token user's loan history

Decisioning:
  score >= 700   → status='disbursed' (auto-approve + auto-disburse)
  500 <= s < 700 → status='manual_review' (no disbursement)
  score < 500    → status='declined' (no disbursement)

Auth model (PR #22 pattern):
  Authorization: Bearer demo_token_<user_id>_<unix>. The token's user_id
  IS the borrower (single-party endpoint; no need for body to repeat it).

Master VA reconciliation:
  loan_disbursement counts as OUTBOUND from master VA in admin.py's
  formula (real cash leaves the pool to fund the loan). loan_repayment
  counts as INBOUND (cash returns). Net result: drift = 0 holds across
  the full lifecycle including mid-loan.

Atomicity:
  All ledger-touching operations wrapped in `with db.begin():`. The
  paired Transaction row uses a deterministic idempotency_key
  (`loan_disburse_<loan_id>` / `loan_repay_<loan_id>_<n>`) so retries
  are safe.
"""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..admin.credit_score import compute_credit_score
from ..core.db import get_db
from ..models import Loan, Transaction, User, Wallet, now_unix

router = APIRouter(prefix="/loans", tags=["loans"])

# Decisioning thresholds — PR description references these in the
# "Trader-worker ecosystem" Q&A talking points.
AUTO_APPROVE_THRESHOLD = 700
MANUAL_REVIEW_THRESHOLD = 500

# Amount caps per the user's brief: ₦10 minimum, ₦500,000 maximum.
MIN_AMOUNT_KOBO = 1_000        # ₦10
MAX_AMOUNT_KOBO = 50_000_000   # ₦500,000

# Statuses that block a new loan request (single active loan per user).
_ACTIVE_LOAN_STATUSES = ("pending", "approved", "disbursed")


# ----------------------------------------------------------------- auth helper


def _user_id_from_token(authorization: str | None) -> int | None:
    """Mirror of voice_intent.py / transfer.py / dva.py token parser."""
    if not authorization:
        return None
    token = (
        authorization.removeprefix("Bearer ").strip()
        if authorization.startswith("Bearer ")
        else authorization.strip()
    )
    parts = token.split("_")
    if len(parts) >= 4 and parts[0] == "demo" and parts[1] == "token":
        try:
            return int(parts[2])
        except ValueError:
            return None
    return None


def _require_user_id(authorization: str | None) -> int:
    uid = _user_id_from_token(authorization)
    if uid is None:
        raise HTTPException(
            status_code=401,
            detail={
                "code": "auth_required",
                "message": "Authorization: Bearer <token> required.",
            },
        )
    return uid


# ----------------------------------------------------------------- schemas


class LoanRequest(BaseModel):
    amount_kobo: int = Field(
        ..., ge=MIN_AMOUNT_KOBO, le=MAX_AMOUNT_KOBO, description="Integer kobo"
    )


class LoanRepayRequest(BaseModel):
    loan_id: str = Field(..., min_length=1, max_length=40)
    amount_kobo: int = Field(..., ge=1, description="Integer kobo")


# ----------------------------------------------------------------- helpers


def _serialize_loan(loan: Loan) -> dict:
    return {
        "loan_id": loan.id,
        "status": loan.status,
        "amount_kobo": loan.amount_kobo,
        "repaid_kobo": loan.repaid_kobo,
        "outstanding_kobo": loan.amount_kobo - loan.repaid_kobo,
        "credit_score_at_request": loan.credit_score_at_request,
        "decision_reason": loan.decision_reason,
        "created_at": loan.created_at,
        "approved_at": loan.approved_at,
        "disbursed_at": loan.disbursed_at,
        "repaid_at": loan.repaid_at,
    }


def _disburse_loan(loan: Loan, wallet: Wallet, db: Session) -> None:
    """Credit borrower's wallet + insert loan_disbursement Transaction.

    Caller MUST already be inside a `with db.begin():` block. The
    idempotency_key on the Transaction is deterministic
    (`loan_disburse_<loan_id>`) so accidental double-call surfaces as
    an IntegrityError instead of silently double-crediting.
    """
    now = now_unix()
    wallet.balance_kobo += loan.amount_kobo
    wallet.version += 1
    wallet.updated_at = now

    db.add(Transaction(
        id=f"ld_{uuid.uuid4().hex[:16]}",
        user_id=loan.user_id,
        type="loan_disbursement",
        direction="in",
        amount_kobo=loan.amount_kobo,
        status="completed",
        idempotency_key=f"loan_disburse_{loan.id}",
        created_at=now,
        settled_at=now,
    ))

    loan.status = "disbursed"
    loan.approved_at = now
    loan.disbursed_at = now


# ----------------------------------------------------------------- endpoints


@router.post("/request")
def request_loan(
    req: LoanRequest,
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> dict:
    """Score-driven loan request + atomic auto-disbursement on approval."""
    uid = _require_user_id(authorization)

    # Pre-flight reads (snapshot before opening the write transaction).
    with db.begin():
        user = db.get(User, uid)
        if user is None:
            raise HTTPException(
                status_code=404,
                detail={"code": "user_not_found", "message": "User not found."},
            )
        wallet = db.get(Wallet, uid)
        if wallet is None:
            raise HTTPException(
                status_code=404,
                detail={"code": "wallet_not_found", "message": "Wallet not found."},
            )

        # Single-active-loan guard
        active = db.scalar(
            select(Loan).where(
                Loan.user_id == uid,
                Loan.status.in_(_ACTIVE_LOAN_STATUSES),
            )
        )
        if active is not None:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "active_loan_exists",
                    "message": "You already have an active loan.",
                    "active_loan_id": active.id,
                },
            )

        # Compute score from the user's full transaction history.
        all_txs = list(
            db.scalars(select(Transaction).where(Transaction.user_id == uid)).all()
        )
        score, breakdown = compute_credit_score(wallet, all_txs, user)

        # Decisioning
        if score >= AUTO_APPROVE_THRESHOLD:
            status_val = "disbursed"  # will land via _disburse_loan below
            reason = None
        elif score >= MANUAL_REVIEW_THRESHOLD:
            status_val = "manual_review"
            reason = "manual_review_required"
        else:
            status_val = "declined"
            reason = "credit_score_below_threshold"

        # Create the Loan row in its target status (we'll bump to
        # 'disbursed' inside _disburse_loan via mutation of the same
        # object — no second flush needed).
        now = now_unix()
        loan = Loan(
            id=f"ln_{uuid.uuid4().hex[:16]}",
            user_id=uid,
            amount_kobo=req.amount_kobo,
            repaid_kobo=0,
            status="approved" if status_val == "disbursed" else status_val,
            credit_score_at_request=score,
            decision_reason=reason,
            created_at=now,
        )
        db.add(loan)
        db.flush()  # surface any IntegrityError early; gets loan.id assigned

        if status_val == "disbursed":
            _disburse_loan(loan, wallet, db)

    return {
        "success": True,
        "data": {
            **_serialize_loan(loan),
            "credit_score": score,
            "credit_breakdown": breakdown,
        },
    }


@router.post("/repay")
def repay_loan(
    req: LoanRepayRequest,
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> dict:
    """Debit borrower's wallet + insert loan_repayment Transaction."""
    uid = _require_user_id(authorization)

    with db.begin():
        loan = db.get(Loan, req.loan_id)
        if loan is None:
            raise HTTPException(
                status_code=404,
                detail={"code": "loan_not_found", "message": "Loan not found."},
            )
        if loan.user_id != uid:
            # Don't leak loan existence — same status as 404.
            raise HTTPException(
                status_code=404,
                detail={"code": "loan_not_found", "message": "Loan not found."},
            )
        if loan.status != "disbursed":
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "loan_not_repayable",
                    "message": f"Cannot repay a loan in status '{loan.status}'.",
                },
            )

        outstanding = loan.amount_kobo - loan.repaid_kobo
        if req.amount_kobo > outstanding:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "amount_exceeds_outstanding",
                    "message": "Repayment amount exceeds outstanding balance.",
                    "outstanding_kobo": outstanding,
                },
            )

        wallet = db.get(Wallet, uid)
        if wallet is None:
            raise HTTPException(
                status_code=404,
                detail={"code": "wallet_not_found"},
            )
        if wallet.balance_kobo < req.amount_kobo:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "insufficient_balance",
                    "message": "Insufficient balance to make this repayment.",
                    "balance_kobo": wallet.balance_kobo,
                },
            )

        now = now_unix()
        wallet.balance_kobo -= req.amount_kobo
        wallet.version += 1
        wallet.updated_at = now

        # Idempotency key includes the current repaid_kobo so multiple
        # partial repayments don't collide.
        db.add(Transaction(
            id=f"lr_{uuid.uuid4().hex[:16]}",
            user_id=uid,
            type="loan_repayment",
            direction="out",
            amount_kobo=req.amount_kobo,
            status="completed",
            idempotency_key=f"loan_repay_{loan.id}_{loan.repaid_kobo}",
            created_at=now,
            settled_at=now,
        ))

        loan.repaid_kobo += req.amount_kobo
        if loan.repaid_kobo == loan.amount_kobo:
            loan.status = "repaid"
            loan.repaid_at = now

    return {
        "success": True,
        "data": _serialize_loan(loan),
    }


@router.get("/me")
def my_loans(
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> dict:
    """List the token user's loans, newest first."""
    uid = _require_user_id(authorization)
    rows = list(
        db.scalars(
            select(Loan)
            .where(Loan.user_id == uid)
            .order_by(Loan.created_at.desc())
        ).all()
    )
    return {
        "success": True,
        "data": {"loans": [_serialize_loan(l) for l in rows]},
    }
