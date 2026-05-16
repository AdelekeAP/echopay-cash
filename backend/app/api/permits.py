"""POST /permits/issue — server issues a signed offline-spending permit.

Master doc §4.2. Caller is online; they ask the server for permission
to spend up to N kobo over the next T hours from their wallet. The
server signs a payload that the phone caches; offline txs carry the
signed permit so the receiver's phone can verify "the server says this
person is allowed to spend up to N from their locked offline budget."

The amount IS NOT debited at issue time — only at /sync/submit, when
the permit is redeemed. Up until redemption the funds sit in
`wallets.locked_kobo`. Multiple outstanding permits per user are
allowed; total outstanding ≤ locked_kobo is enforced.
"""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.crypto import sign_b64
from ..core.db import get_db
from ..models import Permit, User, Wallet, now_unix

router = APIRouter(prefix="/permits", tags=["permits"])

PERMIT_TTL_SECONDS_MAX = 12 * 60 * 60          # master doc: 12h cap
PERMIT_TTL_SECONDS_DEFAULT = 12 * 60 * 60
DEVICE_FP_PATTERN = re.compile(r"^[A-Za-z0-9_\-:.]{1,64}$")


class IssuePermitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: int = Field(..., ge=1)
    max_amount_kobo: int = Field(..., gt=0)
    ttl_seconds: int = Field(default=PERMIT_TTL_SECONDS_DEFAULT, gt=0, le=PERMIT_TTL_SECONDS_MAX)
    device_fingerprint: str | None = Field(default=None, max_length=64)

    @field_validator("max_amount_kobo", mode="before")
    @classmethod
    def _strict_int(cls, v):
        if isinstance(v, bool) or not isinstance(v, int):
            raise ValueError("max_amount_kobo must be integer kobo")
        return v

    @field_validator("device_fingerprint")
    @classmethod
    def _check_fp(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not DEVICE_FP_PATTERN.fullmatch(v):
            raise ValueError("device_fingerprint format")
        return v


class IssuePermitResponse(BaseModel):
    success: bool
    data: "_PermitPayload"


class _PermitPayload(BaseModel):
    permit_id: str
    user_id: int
    device_fingerprint: str | None
    max_amount_kobo: int
    issued_at: int
    expires_at: int
    server_sig_b64: str


IssuePermitResponse.model_rebuild()


@router.post("/issue", response_model=IssuePermitResponse)
def issue_permit(req: IssuePermitRequest, db: Session = Depends(get_db)) -> IssuePermitResponse:
    with db.begin():
        user = db.get(User, req.user_id)
        if user is None:
            raise HTTPException(404, {"code": "user_not_found"})

        wallet = db.get(Wallet, req.user_id)
        if wallet is None:
            raise HTTPException(404, {"code": "wallet_not_found"})

        # Permit cap budget: total of outstanding permits + this new
        # one must not exceed the user's locked_kobo. Stops a user
        # over-committing their offline budget across many permits.
        outstanding_total = (
            db.scalar(
                select(func.coalesce(func.sum(Permit.max_amount_kobo), 0))
                .where(Permit.user_id == req.user_id)
                .where(Permit.status == "outstanding")
            )
            or 0
        )
        if outstanding_total + req.max_amount_kobo > wallet.locked_kobo:
            raise HTTPException(
                400,
                {
                    "code": "insufficient_locked_for_permit",
                    "outstanding_total_kobo": outstanding_total,
                    "locked_kobo": wallet.locked_kobo,
                    "requested_kobo": req.max_amount_kobo,
                    "message": (
                        "Permit would exceed your offline budget. Lock more "
                        "funds for offline first."
                    ),
                },
            )

        now = now_unix()
        permit_id = f"pm_{uuid.uuid4().hex[:24]}"
        expires_at = now + req.ttl_seconds

        # Canonical payload — the SAME shape the mobile signs/verifies
        # against. Keys sorted alphabetically by canonical_bytes().
        payload = {
            "device_fingerprint": req.device_fingerprint,
            "expires_at": expires_at,
            "issued_at": now,
            "max_amount_kobo": req.max_amount_kobo,
            "permit_id": permit_id,
            "user_id": req.user_id,
        }
        sig_b64 = sign_b64(payload)

        db.add(
            Permit(
                permit_id=permit_id,
                user_id=req.user_id,
                device_fingerprint=req.device_fingerprint,
                max_amount_kobo=req.max_amount_kobo,
                status="outstanding",
                issued_at=now,
                expires_at=expires_at,
                server_sig_b64=sig_b64,
            )
        )

    return IssuePermitResponse(
        success=True,
        data=_PermitPayload(
            permit_id=permit_id,
            user_id=req.user_id,
            device_fingerprint=req.device_fingerprint,
            max_amount_kobo=req.max_amount_kobo,
            issued_at=now,
            expires_at=expires_at,
            server_sig_b64=sig_b64,
        ),
    )
