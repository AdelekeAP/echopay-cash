"""POST /sync/submit — settle a fully-offline-signed transaction.

Master doc §4.2 / PRD §4. Either phone calls this with the complete
bundle (permit + tx + sender_sig + receiver_sig). The server:

1. Verifies the server's own permit signature.
2. Verifies the sender's signature over the tx.
3. Verifies the receiver's signature over {tx, sender_sig}.
4. Inserts the nonce (sender_user_id, nonce) — UNIQUE, catches replay.
5. Atomically redeems the permit:
       UPDATE permits SET status='redeemed' WHERE permit_id=:id
         AND status='outstanding' AND :now < expires_at RETURNING ...
   0 rows → double-spend or expired. 409 + fraud flag.
6. Atomically moves kobo: sender.locked_kobo -= amount,
   receiver.balance_kobo += amount. Transaction row INSERTed.

The whole thing runs inside one BEGIN IMMEDIATE so concurrent submits
of the same permit/nonce serialize and the second loses cleanly.
"""

from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core.crypto import verify_server_b64, verify_user_b64
from ..core.db import get_db
from ..models import Nonce, Permit, Transaction, User, Wallet, now_unix

router = APIRouter(prefix="/sync", tags=["sync"])

ID_PATTERN = re.compile(r"^[A-Za-z0-9_:\-\.]{1,128}$")


# ----------------------------------------------------------------- schemas

class PermitBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    permit_id: str = Field(..., min_length=1, max_length=64)
    user_id: int = Field(..., ge=1)
    device_fingerprint: Optional[str] = Field(default=None, max_length=64)
    max_amount_kobo: int = Field(..., gt=0)
    issued_at: int = Field(..., ge=0)
    expires_at: int = Field(..., ge=0)
    server_sig_b64: str = Field(..., min_length=1, max_length=128)


class TxBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    permit_id: str
    from_user: int = Field(..., ge=1)
    to_user: int = Field(..., ge=1)
    amount_kobo: int = Field(..., gt=0)
    nonce: str = Field(..., min_length=1, max_length=64)
    ts: int = Field(..., ge=0)

    @field_validator("amount_kobo", "from_user", "to_user", "ts", "issued_at", mode="before", check_fields=False)
    @classmethod
    def _strict_int(cls, v):
        if isinstance(v, bool) or not isinstance(v, int):
            raise ValueError("must be integer")
        return v


class SyncSubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    permit: PermitBundle
    tx: TxBundle
    sender_sig_b64: str = Field(..., min_length=1, max_length=128)
    receiver_sig_b64: str = Field(..., min_length=1, max_length=128)


class SyncSubmitResponse(BaseModel):
    success: bool
    data: "_SettleData"


class _SettleData(BaseModel):
    tx_id: str
    status: str
    settled_at: int


SyncSubmitResponse.model_rebuild()


# ----------------------------------------------------------------- helpers

def _permit_canonical(p: PermitBundle) -> dict:
    return {
        "device_fingerprint": p.device_fingerprint,
        "expires_at": p.expires_at,
        "issued_at": p.issued_at,
        "max_amount_kobo": p.max_amount_kobo,
        "permit_id": p.permit_id,
        "user_id": p.user_id,
    }


def _tx_canonical(t: TxBundle) -> dict:
    return {
        "amount_kobo": t.amount_kobo,
        "from_user": t.from_user,
        "nonce": t.nonce,
        "permit_id": t.permit_id,
        "to_user": t.to_user,
        "ts": t.ts,
    }


def _receipt_canonical(t: TxBundle, sender_sig_b64: str) -> dict:
    """What the receiver signs — the tx envelope + sender's signature."""
    return {
        "sender_sig": sender_sig_b64,
        "tx": _tx_canonical(t),
    }


# ----------------------------------------------------------------- handler


@router.post("/submit", response_model=SyncSubmitResponse)
def sync_submit(req: SyncSubmitRequest, db: Session = Depends(get_db)) -> SyncSubmitResponse:
    p, t = req.permit, req.tx

    # --- 0. cheap consistency checks (no I/O) ---------------------------

    if p.permit_id != t.permit_id:
        raise HTTPException(400, {"code": "permit_tx_mismatch"})
    if p.user_id != t.from_user:
        raise HTTPException(400, {"code": "permit_user_mismatch"})
    if t.from_user == t.to_user:
        raise HTTPException(400, {"code": "self_transfer"})
    if t.amount_kobo > p.max_amount_kobo:
        raise HTTPException(400, {"code": "amount_exceeds_permit_cap"})

    # --- 1. server-sig on permit (no I/O, pure crypto) ------------------

    if not verify_server_b64(_permit_canonical(p), p.server_sig_b64):
        raise HTTPException(400, {"code": "permit_signature_invalid"})

    # --- 2-3. all DB work inside one BEGIN IMMEDIATE ---------------------

    with db.begin():
        sender_user = db.get(User, t.from_user)
        receiver_user = db.get(User, t.to_user)
        if sender_user is None or receiver_user is None:
            raise HTTPException(404, {"code": "user_not_found"})
        if not sender_user.ed25519_pub_b64:
            raise HTTPException(400, {"code": "sender_has_no_pubkey"})
        if not receiver_user.ed25519_pub_b64:
            raise HTTPException(400, {"code": "receiver_has_no_pubkey"})

        # Verify user signatures (still pure crypto, but cheap to fold
        # inside the txn so we don't have to release-then-reacquire).
        if not verify_user_b64(_tx_canonical(t), req.sender_sig_b64, sender_user.ed25519_pub_b64):
            raise HTTPException(400, {"code": "sender_signature_invalid"})
        if not verify_user_b64(
            _receipt_canonical(t, req.sender_sig_b64),
            req.receiver_sig_b64,
            receiver_user.ed25519_pub_b64,
        ):
            raise HTTPException(400, {"code": "receiver_signature_invalid"})

        # Nonce — replay protection. Insert + flush so the UNIQUE
        # constraint fires now (caught by IntegrityError below) rather
        # than at commit time, which is too late for a clean 409.
        db.add(Nonce(sender_user_id=t.from_user, nonce=t.nonce, used_at=now_unix()))
        try:
            db.flush()
        except IntegrityError as e:
            # The with-block's __exit__ will roll back on raise.
            raise HTTPException(409, {"code": "nonce_replay"}) from e

        now = now_unix()
        if now >= p.expires_at:
            raise HTTPException(409, {"code": "permit_expired"})

        # Atomic permit redemption — single UPDATE so concurrent calls
        # can't both succeed. SQLAlchemy doesn't expose portable
        # RETURNING here, so we use rowcount as the equivalent.
        result = db.execute(
            update(Permit)
            .where(Permit.permit_id == p.permit_id)
            .where(Permit.status == "outstanding")
            .where(Permit.expires_at > now)
            .values(status="redeemed", redeemed_at=now)
        )
        if result.rowcount != 1:
            raise HTTPException(
                409,
                {
                    "code": "permit_already_redeemed_or_expired",
                    "message": "Double-spend detected or permit expired.",
                },
            )

        sender_w = db.get(Wallet, t.from_user)
        receiver_w = db.get(Wallet, t.to_user)
        if sender_w is None or receiver_w is None:
            raise HTTPException(404, {"code": "wallet_not_found"})
        if sender_w.locked_kobo < t.amount_kobo:
            raise HTTPException(400, {"code": "insufficient_locked_balance"})

        sender_w.locked_kobo -= t.amount_kobo
        sender_w.version += 1
        sender_w.updated_at = now
        receiver_w.balance_kobo += t.amount_kobo
        receiver_w.version += 1
        receiver_w.updated_at = now

        tx_id = f"of_{p.permit_id[3:11]}_{t.nonce[:8]}"
        db.add(
            Transaction(
                id=tx_id,
                user_id=t.from_user,
                counterparty_user_id=t.to_user,
                type="in_network",
                direction="out",
                amount_kobo=t.amount_kobo,
                status="completed",
                idempotency_key=f"offline:{t.nonce}",
                created_at=now,
                settled_at=now,
            )
        )

        db.execute(
            update(Permit)
            .where(Permit.permit_id == p.permit_id)
            .values(redeemed_by_tx_id=tx_id)
        )

    return SyncSubmitResponse(
        success=True,
        data=_SettleData(tx_id=tx_id, status="completed", settled_at=now),
    )
