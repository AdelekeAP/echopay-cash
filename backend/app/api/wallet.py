"""Lock / unlock the offline-spending allocation on a user's wallet.

PRD_FUNBI §11.1 — money never leaves the wallet; it moves between two
columns on the same row:

    balance_kobo  ⇄  locked_kobo

Lock for offline: balance -= amount, locked += amount.
Unlock back to online: locked -= amount, balance += amount.

Both endpoints wrap a `BEGIN IMMEDIATE` transaction and enforce the
same idempotency_key UNIQUE pattern as /transfer/in-network.

Sum conservation across both columns is the reconciliation invariant
(PRD §4.5): the sum SUM(balance_kobo) + SUM(locked_kobo) must equal
the Master Static VA balance at Squad. These endpoints can never break
that — they only redistribute, never inject or remove kobo.
"""

from __future__ import annotations

import re
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from ..core.db import get_db
from ..models import Transaction, Wallet, now_unix

router = APIRouter(prefix="/wallet", tags=["wallet"])

MAX_RETRIES = 3
RETRY_BACKOFF_MS = (50, 100, 200)
IDEMPOTENCY_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_:\-\.]{1,128}$")


class LockRequest(BaseModel):
    user_id: int = Field(..., ge=1)
    amount_kobo: int = Field(..., gt=0)
    idempotency_key: str = Field(..., min_length=1, max_length=128)

    @field_validator("idempotency_key")
    @classmethod
    def _check_key(cls, v: str) -> str:
        if not IDEMPOTENCY_KEY_PATTERN.fullmatch(v):
            raise ValueError("idempotency_key must be [A-Za-z0-9_:.-]{1,128}")
        return v

    @field_validator("amount_kobo", mode="before")
    @classmethod
    def _strict_int(cls, v):
        if isinstance(v, bool) or not isinstance(v, int):
            raise ValueError("amount_kobo must be integer kobo")
        return v


class LockResponse(BaseModel):
    success: bool
    data: "_WalletState"


class _WalletState(BaseModel):
    user_id: int
    balance_kobo: int
    locked_kobo: int
    moved_kobo: int
    version: int
    movement_tx_id: str


LockResponse.model_rebuild()


# ----------------------------------------------------------------- handlers

@router.post("/lock-for-offline", response_model=LockResponse)
def lock_for_offline(req: LockRequest, db: Session = Depends(get_db)) -> LockResponse:
    """Move funds from balance_kobo → locked_kobo."""
    return _move(db, req, direction="lock")


@router.post("/unlock-from-offline", response_model=LockResponse)
def unlock_from_offline(req: LockRequest, db: Session = Depends(get_db)) -> LockResponse:
    """Move funds from locked_kobo → balance_kobo."""
    return _move(db, req, direction="unlock")


def _existing_movement(db: Session, idempotency_key: str) -> Transaction | None:
    return db.scalar(select(Transaction).where(Transaction.idempotency_key == idempotency_key))


def _state_response(tx: Transaction, wallet: Wallet, moved: int) -> LockResponse:
    return LockResponse(
        success=True,
        data=_WalletState(
            user_id=wallet.user_id,
            balance_kobo=wallet.balance_kobo,
            locked_kobo=wallet.locked_kobo,
            moved_kobo=moved,
            version=wallet.version,
            movement_tx_id=tx.id,
        ),
    )


def _move(
    db: Session, req: LockRequest, direction: str
) -> LockResponse:
    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            return _attempt_move(db, req, direction)
        except OperationalError as e:
            db.rollback()
            last_error = e
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BACKOFF_MS[attempt] / 1000)
            continue
        except IntegrityError as e:
            db.rollback()
            existing = _existing_movement(db, req.idempotency_key)
            if existing:
                w = db.get(Wallet, req.user_id)
                if w:
                    return _state_response(existing, w, existing.amount_kobo)
            raise HTTPException(status_code=409, detail=str(e)) from e

    raise HTTPException(
        status_code=503,
        detail={
            "code": "serialization_failure",
            "message": "Ledger contended — retry with the same idempotency_key.",
            "cause": str(last_error) if last_error else None,
        },
    )


def _attempt_move(
    db: Session, req: LockRequest, direction: str
) -> LockResponse:
    with db.begin():
        # Idempotent reissue?
        existing = _existing_movement(db, req.idempotency_key)
        if existing:
            w = db.get(Wallet, req.user_id)
            if w:
                return _state_response(existing, w, existing.amount_kobo)
            raise HTTPException(404, "wallet_not_found_for_existing_tx")

        wallet = db.get(Wallet, req.user_id)
        if wallet is None:
            raise HTTPException(
                status_code=404, detail={"code": "wallet_not_found"}
            )

        if direction == "lock":
            if wallet.balance_kobo < req.amount_kobo:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "insufficient_balance",
                        "balance_kobo": wallet.balance_kobo,
                        "amount_kobo": req.amount_kobo,
                    },
                )
            wallet.balance_kobo -= req.amount_kobo
            wallet.locked_kobo += req.amount_kobo
            tx_type = "lock_offline"
        elif direction == "unlock":
            if wallet.locked_kobo < req.amount_kobo:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "insufficient_locked",
                        "locked_kobo": wallet.locked_kobo,
                        "amount_kobo": req.amount_kobo,
                    },
                )
            wallet.locked_kobo -= req.amount_kobo
            wallet.balance_kobo += req.amount_kobo
            tx_type = "unlock_offline"
        else:
            raise HTTPException(500, "bad_direction")

        now = now_unix()
        wallet.version += 1
        wallet.updated_at = now

        import uuid as _uuid
        tx_id = f"lt_{_uuid.uuid4().hex[:16]}"
        movement = Transaction(
            id=tx_id,
            user_id=req.user_id,
            counterparty_user_id=None,
            type=tx_type,
            direction="out" if direction == "lock" else "in",
            amount_kobo=req.amount_kobo,
            status="completed",
            idempotency_key=req.idempotency_key,
            created_at=now,
            settled_at=now,
        )
        db.add(movement)
        db.flush()

        return _state_response(movement, wallet, req.amount_kobo)
