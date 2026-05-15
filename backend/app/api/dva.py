"""POST /dynamic-va/create — per-QR Dynamic VA for the receive flow.

PRD §1 Script A 2:00 demo beat: Mama generates a ₦200 QR, customer pays
from any bank, Mama's phone receives.

Flow:
  1. Mobile sends `Authorization: Bearer demo_token_<user_id>_<unix>`
     (or `user_id` in body for non-mobile testing).
  2. Validate token / body, look up the user's wallet.
  3. Resolve a DVA — Squad sandbox call when SQUAD_SECRET_KEY is set,
     otherwise round-robin a synthetic 10-digit pool.
  4. Insert a pending `qr_receive` Transaction (idempotent on 5-min
     bucket — same amount within a DVA's active TTL collapses).
  5. Return envelope shaped for mobile rendering.

Webhook settlement is a separate PR — pending rows here will flip to
`completed` when /webhooks/squad lands.
"""

from __future__ import annotations

import re
import time
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from ..core.config import get_settings
from ..core.db import get_db
from ..models import Transaction, User, Wallet, now_unix
from ..squad.client import SquadAuthError, SquadError, get_squad_client
from ..squad.dynamic_va import DynamicVAResult, create_dynamic_va

router = APIRouter(prefix="/dynamic-va", tags=["dva"])

# Idempotency bucket = 5 minutes (DVA default TTL). Same-amount requests
# within an active DVA's window collapse to one row. After TTL expires,
# new bucket → new DVA. (Approval Adjustment A1.)
IDEMPOTENCY_BUCKET_SEC = 300

MAX_RETRIES = 3
RETRY_BACKOFF_MS = (50, 100, 200)

DEFAULT_TTL_SEC = 300
MIN_TTL_SEC = 60
MAX_TTL_SEC = 1800

_TOKEN_PATTERN = re.compile(r"^demo_token_(\d+)_\d+$")

# Synthetic DVA pool — used when SQUAD_SECRET_KEY is empty (demo-day
# insurance). 9xxx prefix is unused in NIBSS so these can never collide
# with a real account. Round-robin via a module-level counter so
# consecutive Generate taps produce different numbers.
_SYNTHETIC_DVA_POOL = ("9012345678", "9023456789", "9034567890")
_synthetic_counter = 0


def _next_synthetic_dva() -> str:
    global _synthetic_counter
    n = _SYNTHETIC_DVA_POOL[_synthetic_counter % len(_SYNTHETIC_DVA_POOL)]
    _synthetic_counter += 1
    return n


def _reset_synthetic_counter() -> None:
    """Test-only helper so tests can assert a deterministic first value."""
    global _synthetic_counter
    _synthetic_counter = 0


# ----------------------------------------------------------------- schemas


class DvaCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount_kobo: int = Field(..., gt=0, description="Positive integer kobo")
    ttl_seconds: Optional[int] = Field(default=DEFAULT_TTL_SEC)
    # Optional fallback when no Authorization header is supplied
    # (mostly for curl + web testing without a real session token).
    user_id: Optional[int] = Field(default=None, ge=1)

    @field_validator("amount_kobo", mode="before")
    @classmethod
    def _reject_non_int_amount(cls, v):
        # Pydantic v2 will coerce ints-as-strings; we want strict int.
        if isinstance(v, bool) or not isinstance(v, int):
            raise ValueError("amount_kobo must be an integer (kobo)")
        return v

    @field_validator("ttl_seconds", mode="after")
    @classmethod
    def _ttl_in_range(cls, v):
        if v is None:
            return DEFAULT_TTL_SEC
        if not isinstance(v, int) or v < MIN_TTL_SEC or v > MAX_TTL_SEC:
            raise ValueError(
                f"ttl_seconds must be int in [{MIN_TTL_SEC}, {MAX_TTL_SEC}]"
            )
        return v


class _DvaData(BaseModel):
    tx_id: str
    dva_number: str
    qr_payload: str
    amount_kobo: int
    reference: str
    expires_at: int
    merchant_business_name: str
    demo_mode: bool


class DvaCreateResponse(BaseModel):
    success: bool
    data: _DvaData


DvaCreateResponse.model_rebuild()


# ----------------------------------------------------------------- helpers


def _parse_user_id_from_token(authorization: str | None) -> int | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization[7:].strip()
    m = _TOKEN_PATTERN.fullmatch(token)
    if not m:
        return None
    try:
        return int(m.group(1))
    except (TypeError, ValueError):
        return None


def _resolve_user_id(authorization: str | None, body_user_id: int | None) -> int:
    """Token first, body fallback. 401 if neither present or token invalid."""
    if authorization and authorization.lower().startswith("bearer "):
        uid = _parse_user_id_from_token(authorization)
        if uid is None:
            raise HTTPException(
                status_code=401,
                detail={
                    "code": "invalid_token",
                    "message": "Token format not recognised. Sign in again.",
                },
            )
        return uid
    if body_user_id is not None:
        return body_user_id
    raise HTTPException(
        status_code=401,
        detail={
            "code": "auth_required",
            "message": "Authorization header or user_id in body required.",
        },
    )


def _require_user_with_wallet(db: Session, user_id: int) -> tuple[User, Wallet]:
    """Short read txn — mirrors auth.py's snapshot pattern."""
    with db.begin():
        user = db.get(User, user_id)
        if user is None:
            raise HTTPException(
                status_code=404,
                detail={"code": "user_not_found", "message": "User not found."},
            )
        wallet = db.get(Wallet, user_id)
        if wallet is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "code": "wallet_not_found",
                    "message": "User has no wallet. Sign up first.",
                },
            )
        # Eager-load attributes so they survive past the session close.
        _ = (user.id, user.first_name, user.last_name)
        _ = (wallet.user_id, wallet.squad_va_number)
    return user, wallet


def _existing_qr_tx(db: Session, idempotency_key: str) -> Transaction | None:
    return db.scalar(
        select(Transaction).where(Transaction.idempotency_key == idempotency_key)
    )


async def _resolve_dva(
    amount_kobo: int,
    ttl_seconds: int,
    merchant_business_name: str,
    squad_secret_key: str,
) -> tuple[DynamicVAResult, bool]:
    """Returns (DVA result, used_demo_fallback).

    Demo bypass: empty SQUAD_SECRET_KEY → use synthetic pool. Otherwise
    call Squad sandbox.
    """
    if not squad_secret_key:
        va_number = _next_synthetic_dva()
        reference = f"ECHOPAYCASH_demo_{uuid.uuid4().hex[:8]}"
        return (
            DynamicVAResult(
                {
                    "va_number": va_number,
                    "reference": reference,
                    "expires_at": int(time.time()) + ttl_seconds,
                }
            ),
            True,
        )

    client = get_squad_client()
    try:
        result = await create_dynamic_va(
            client,
            amount_kobo=amount_kobo,
            duration_sec=ttl_seconds,
            merchant_business_name=merchant_business_name,
        )
    except SquadAuthError as e:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "squad_failed",
                "message": "Couldn't create QR account. Try again.",
                "cause": f"squad_auth: {e}",
            },
        )
    except SquadError as e:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "squad_failed",
                "message": "Couldn't create QR account. Try again.",
                "cause": str(e),
            },
        )
    return result, False


def _build_qr_payload(dva_number: str, amount_kobo: int, tx_id: str) -> str:
    # EchoPay-aware scanners can parse this structured URI. The mobile
    # screen renders the bare dva_number in the QR (so judges with any
    # bank app see a manual-transfer-ready account number) — qr_payload
    # is here for forward-compat with the in-network EchoPay scanner.
    return f"echopay:dva:{dva_number}:{amount_kobo}:{tx_id}"


def _row_to_response(
    tx: Transaction,
    dva_number: str,
    reference: str,
    expires_at: int,
    merchant_business_name: str,
    demo_mode: bool,
) -> DvaCreateResponse:
    return DvaCreateResponse(
        success=True,
        data=_DvaData(
            tx_id=tx.id,
            dva_number=dva_number,
            qr_payload=_build_qr_payload(dva_number, tx.amount_kobo, tx.id),
            amount_kobo=tx.amount_kobo,
            reference=reference,
            expires_at=expires_at,
            merchant_business_name=merchant_business_name,
            demo_mode=demo_mode,
        ),
    )


# `squad_ref` packs `<dva_number>|<reference>` so an idempotent re-issue
# returns the same DVA number as the original Squad call. Separator is
# `|` — Squad refs use `[A-Za-z0-9_-]` so this is collision-free.
_SQUAD_REF_SEP = "|"


def _pack_squad_ref(dva_number: str, reference: str) -> str:
    return f"{dva_number}{_SQUAD_REF_SEP}{reference}"


def _unpack_squad_ref(packed: str) -> tuple[str, str]:
    """Returns (dva_number, reference). Tolerant of legacy unpacked refs
    (no separator) — older rows return ("", packed) so the response still
    has the reference even if dva_number is unavailable."""
    if _SQUAD_REF_SEP not in packed:
        return ("", packed)
    dva_number, _, reference = packed.partition(_SQUAD_REF_SEP)
    return (dva_number, reference)


# ----------------------------------------------------------------- handler


@router.post("/create", response_model=DvaCreateResponse)
async def create_dva(
    req: DvaCreateRequest,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> DvaCreateResponse:
    """Mint a per-QR Dynamic VA. Idempotent on 5-min bucket.

    Errors:
    - 400 invalid_amount / invalid_ttl  (also surfaces as 422 from Pydantic)
    - 401 auth_required / invalid_token
    - 404 user_not_found / wallet_not_found
    - 503 squad_failed
    """
    settings = get_settings()

    # 1. Auth
    user_id = _resolve_user_id(authorization, req.user_id)

    # 2. Wallet snapshot
    user, wallet = _require_user_with_wallet(db, user_id)
    merchant_name = user.first_name

    ttl_seconds = req.ttl_seconds or DEFAULT_TTL_SEC

    # 3. Idempotency check — 5-min bucket. Re-issue within window returns
    #    the existing row WITHOUT another Squad call.
    bucket = int(time.time() // IDEMPOTENCY_BUCKET_SEC)
    idem = f"qr:{user_id}:{req.amount_kobo}:{bucket}"

    existing = _existing_qr_tx_in_short_txn(db, idem)
    if existing is not None:
        # Idempotent re-issue: same dva_number/reference as the original,
        # unpacked from the persisted squad_ref. No fresh Squad call.
        dva_number, reference = _unpack_squad_ref(existing.squad_ref or "")
        return _row_to_response(
            existing,
            dva_number=dva_number,
            reference=reference,
            expires_at=existing.created_at + ttl_seconds,
            merchant_business_name=merchant_name,
            demo_mode=not settings.squad_secret_key,
        )

    # 4. Async Squad call OUTSIDE any txn — don't hold BEGIN IMMEDIATE
    #    while awaiting network.
    dva_result, used_demo = await _resolve_dva(
        amount_kobo=req.amount_kobo,
        ttl_seconds=ttl_seconds,
        merchant_business_name=merchant_name,
        squad_secret_key=settings.squad_secret_key,
    )

    # 5. Insert tx (with retry on database is locked + idempotency race).
    #    Pack BOTH dva_number AND reference into squad_ref so an
    #    idempotent re-issue can return the same DVA number without a
    #    fresh Squad call. Format: "<dva_number>|<reference>". A future
    #    PR can split this into its own column (PRD §5 schema doesn't
    #    list dva_number yet — squad_ref is opaque storage here).
    packed_ref = _pack_squad_ref(dva_result.va_number, dva_result.reference or "")
    tx = _insert_qr_tx_with_retry(
        db,
        user_id=user_id,
        amount_kobo=req.amount_kobo,
        idempotency_key=idem,
        squad_ref=packed_ref,
    )

    # Whichever code path inserted (or race-won) the row, the source of
    # truth for dva_number is now the persisted row. Unpack so an
    # idempotent re-issue gets the SAME number.
    persisted_dva, persisted_ref = _unpack_squad_ref(tx.squad_ref or packed_ref)
    return _row_to_response(
        tx,
        dva_number=persisted_dva or dva_result.va_number,
        reference=persisted_ref or dva_result.reference or "",
        expires_at=dva_result.expires_at or (now_unix() + ttl_seconds),
        merchant_business_name=merchant_name,
        demo_mode=used_demo,
    )


def _existing_qr_tx_in_short_txn(db: Session, idem: str) -> Transaction | None:
    """Wrap the existing-tx read in its own short txn so it doesn't
    leave an auto-begun transaction open across the async Squad call."""
    with db.begin():
        row = _existing_qr_tx(db, idem)
        if row is None:
            return None
        # Materialise attrs for use after session closes.
        _ = (row.id, row.user_id, row.amount_kobo, row.squad_ref, row.created_at)
        return row


def _insert_qr_tx_with_retry(
    db: Session,
    user_id: int,
    amount_kobo: int,
    idempotency_key: str,
    squad_ref: str,
) -> Transaction:
    """Insert with retry on database-locked + IntegrityError race."""
    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            return _insert_qr_tx(
                db,
                user_id=user_id,
                amount_kobo=amount_kobo,
                idempotency_key=idempotency_key,
                squad_ref=squad_ref,
            )
        except OperationalError as e:
            db.rollback()
            last_error = e
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_BACKOFF_MS[attempt] / 1000)
            continue
        except IntegrityError:
            db.rollback()
            existing = _existing_qr_tx(db, idempotency_key)
            if existing is not None:
                return existing
            raise

    raise HTTPException(
        status_code=503,
        detail={
            "code": "serialization_failure",
            "message": "Ledger contention. Retry with the same idempotency key.",
            "cause": str(last_error) if last_error else None,
        },
    )


def _insert_qr_tx(
    db: Session,
    user_id: int,
    amount_kobo: int,
    idempotency_key: str,
    squad_ref: str,
) -> Transaction:
    with db.begin():
        # Re-check inside the txn — another writer may have committed
        # while we were on the network with Squad.
        existing = _existing_qr_tx(db, idempotency_key)
        if existing is not None:
            _ = (existing.id, existing.user_id, existing.amount_kobo)
            return existing

        now = now_unix()
        tx = Transaction(
            id=f"qr_{uuid.uuid4().hex[:16]}",
            user_id=user_id,
            type="qr_receive",
            direction="in",
            amount_kobo=amount_kobo,
            status="pending",
            idempotency_key=idempotency_key,
            squad_ref=squad_ref or None,
            created_at=now,
        )
        db.add(tx)
        db.flush()
        _ = (tx.id, tx.created_at)  # materialise
        return tx
