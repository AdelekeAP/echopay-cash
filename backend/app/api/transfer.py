"""POST /transfer/in-network — atomic in-network ledger move.

EchoPay_Cash_PRD.md §4 spec. Two EchoPay-Cash wallets settle a payment
without a Squad call — money was already pooled in the Master Static VA,
so only the per-user rows in `wallets` change.

Discipline:
- Money is integer kobo. Float inputs are rejected.
- Idempotency: `(idempotency_key)` is UNIQUE. Re-issuing a request with
  the same key returns the original row, never a duplicate write.
- Atomicity: one `BEGIN IMMEDIATE` transaction wraps the balance read,
  both UPDATEs, and the INSERT. SQLite serializes writers via the
  reserved lock, which is the same property the PRD's Postgres
  SERIALIZABLE pattern provides.
- Retries: on `database is locked` we retry up to MAX_RETRIES with
  exponential backoff. The handler is idempotent so retries are safe.
- Self-transfer, zero, negative, and over-balance are all rejected.

This file shares the `transactions` table with Leke's external-transfer
work (`POST /transfer/voice-initiate`) but the two endpoints are
otherwise independent.
"""

from __future__ import annotations

import re
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from ..core.db import get_db
from ..models import Transaction, Wallet, now_unix

router = APIRouter(prefix="/transfer", tags=["transfer"])

MAX_RETRIES = 3
RETRY_BACKOFF_MS = (50, 100, 200)
IDEMPOTENCY_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_:\-\.]{1,128}$")


# ----------------------------------------------------------------- schemas

class InNetworkTransferRequest(BaseModel):
    from_user_id: int = Field(..., ge=1)
    to_user_id: int = Field(..., ge=1)
    amount_kobo: int = Field(..., gt=0, description="Positive integer kobo")
    idempotency_key: str = Field(..., min_length=1, max_length=128)
    # PRD_FUNBI §11.2 — when true, debit sender.locked_kobo (offline
    # budget) instead of sender.balance_kobo. Receiver always credits
    # their balance_kobo regardless. Set true by the outbox replay
    # path for txs that were created while the sender was offline.
    from_locked: bool = False

    @field_validator("idempotency_key")
    @classmethod
    def _check_idempotency_key(cls, v: str) -> str:
        if not IDEMPOTENCY_KEY_PATTERN.fullmatch(v):
            raise ValueError("idempotency_key must be [A-Za-z0-9_:.-]{1,128}")
        return v

    @field_validator("amount_kobo", mode="before")
    @classmethod
    def _reject_floats_and_strings(cls, v):
        # Pydantic v2 will coerce ints-as-strings; we want strict int.
        if isinstance(v, bool) or not isinstance(v, int):
            raise ValueError("amount_kobo must be an integer (kobo)")
        return v


class InNetworkTransferResponse(BaseModel):
    success: bool
    data: "_TxData"


class _TxData(BaseModel):
    tx_id: str
    status: str
    settled_at: int
    balance_after_kobo: int
    locked_after_kobo: int = 0
    debited_from: str = "balance"            # 'balance' | 'locked'


InNetworkTransferResponse.model_rebuild()


# ----------------------------------------------------------------- helpers

def _existing_row(db: Session, idempotency_key: str) -> Transaction | None:
    return db.scalar(
        select(Transaction).where(Transaction.idempotency_key == idempotency_key)
    )


def _row_to_response(
    row: Transaction,
    balance_after_kobo: int,
    locked_after_kobo: int = 0,
    debited_from: str = "balance",
) -> InNetworkTransferResponse:
    return InNetworkTransferResponse(
        success=True,
        data=_TxData(
            tx_id=row.id,
            status=row.status,
            settled_at=row.settled_at or row.created_at,
            balance_after_kobo=balance_after_kobo,
            locked_after_kobo=locked_after_kobo,
            debited_from=debited_from,
        ),
    )


# ----------------------------------------------------------------- handler

@router.post("/in-network", response_model=InNetworkTransferResponse)
def in_network_transfer(
    req: InNetworkTransferRequest,
    db: Session = Depends(get_db),
) -> InNetworkTransferResponse:
    """Move kobo from from_user_id → to_user_id atomically.

    Errors:
    - 400 invalid amount / self-transfer / insufficient_balance / non-integer
    - 404 wallet not found
    - 409 idempotency_key collision with a different body (rare)
    - 503 after MAX_RETRIES serialization failures
    """
    if req.from_user_id == req.to_user_id:
        raise HTTPException(
            status_code=400,
            detail={"code": "self_transfer", "message": "Self-transfer not allowed."},
        )

    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            return _attempt_transfer(db, req)
        except OperationalError as e:
            # SQLite raises this on `database is locked`. Roll back the
            # session's failed transaction state and retry.
            db.rollback()
            last_error = e
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BACKOFF_MS[attempt] / 1000)
            continue
        except IntegrityError as e:
            db.rollback()
            # UNIQUE on idempotency_key triggered between SELECT and INSERT
            # (interleaved with another retry). Re-fetch and return.
            existing = _existing_row(db, req.idempotency_key)
            if existing:
                wallet = db.get(Wallet, req.from_user_id)
                return _row_to_response(
                    existing,
                    wallet.balance_kobo if wallet else 0,
                    wallet.locked_kobo if wallet else 0,
                    "locked" if req.from_locked else "balance",
                )
            raise HTTPException(status_code=409, detail=str(e)) from e

    raise HTTPException(
        status_code=503,
        detail={
            "code": "serialization_failure",
            "message": "Transfer ledger contended — retry with the same idempotency_key.",
            "cause": str(last_error) if last_error else None,
        },
    )


def _attempt_transfer(
    db: Session, req: InNetworkTransferRequest
) -> InNetworkTransferResponse:
    # Idempotency check happens inside the transaction so a concurrent
    # request with the same key blocks on the reserved lock and observes
    # the committed row on its next attempt.
    with db.begin():
        # 1. Idempotent reissue?
        existing = _existing_row(db, req.idempotency_key)
        if existing:
            wallet = db.get(Wallet, existing.user_id)
            return _row_to_response(
                existing,
                wallet.balance_kobo if wallet else 0,
                wallet.locked_kobo if wallet else 0,
                "locked" if req.from_locked else "balance",
            )

        # 2. Lock + load both wallets
        sender = db.get(Wallet, req.from_user_id)
        if sender is None:
            raise HTTPException(
                status_code=404,
                detail={"code": "sender_wallet_not_found"},
            )
        receiver = db.get(Wallet, req.to_user_id)
        if receiver is None:
            raise HTTPException(
                status_code=404,
                detail={"code": "receiver_wallet_not_found"},
            )

        # 3. Balance check — different pot depending on from_locked
        if req.from_locked:
            if sender.locked_kobo < req.amount_kobo:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "insufficient_locked_balance",
                        "message": "Insufficient offline budget.",
                        "locked_kobo": sender.locked_kobo,
                        "amount_kobo": req.amount_kobo,
                    },
                )
        else:
            if sender.balance_kobo < req.amount_kobo:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "insufficient_balance",
                        "message": "Insufficient balance.",
                        "balance_kobo": sender.balance_kobo,
                        "amount_kobo": req.amount_kobo,
                    },
                )

        # 4. Atomic move — sender debits the chosen pot,
        #    receiver always credits balance_kobo (online wallet).
        now = now_unix()
        if req.from_locked:
            sender.locked_kobo -= req.amount_kobo
        else:
            sender.balance_kobo -= req.amount_kobo
        sender.version += 1
        sender.updated_at = now
        receiver.balance_kobo += req.amount_kobo
        receiver.version += 1
        receiver.updated_at = now

        # 5. Insert tx (sender's view; receiver's row is the backend's
        #    responsibility once a multi-row history is rendered server-side).
        tx_id = f"lt_{uuid.uuid4().hex[:16]}"
        tx = Transaction(
            id=tx_id,
            user_id=req.from_user_id,
            counterparty_user_id=req.to_user_id,
            type="in_network",
            direction="out",
            amount_kobo=req.amount_kobo,
            status="completed",
            idempotency_key=req.idempotency_key,
            created_at=now,
            settled_at=now,
        )
        db.add(tx)
        db.flush()  # raise IntegrityError now (caught by handler) if race

        balance_after = sender.balance_kobo
        locked_after = sender.locked_kobo

    return InNetworkTransferResponse(
        success=True,
        data=_TxData(
            tx_id=tx_id,
            status="completed",
            settled_at=now,
            balance_after_kobo=balance_after,
            locked_after_kobo=locked_after,
            debited_from="locked" if req.from_locked else "balance",
        ),
    )
