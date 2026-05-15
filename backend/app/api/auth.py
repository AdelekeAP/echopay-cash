"""POST /auth/voice-signup — the PRD §1 Script A 0:30 demo opener.

Flow:
  1. Mobile uploads recorded audio (multipart `audio` field).
  2. Voice proxy transcribes via OpenAI Whisper (or returns
     "mama risikat" if VOICE_DEMO_MODE=true).
  3. persona_match resolves the transcript to one of the three seeded
     personas; unmatched → 404 (mobile offers persona picker).
  4. If the matched persona's user doesn't exist in the DB, create
     user+wallet inside one `BEGIN IMMEDIATE` — mirroring Funbi's
     transfer endpoint discipline. Optionally calls Squad's
     /virtual-account if a sandbox key is configured.
  5. Returns user+account+token shaped to fit AuthContext.setSession.

Idempotent: re-running with the same persona returns the existing user
+ wallet. The Squad call is skipped on re-entry (we already have a VA).
"""

from __future__ import annotations

import time
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.config import get_settings
from ..core.db import get_db
from ..models import User, Wallet, now_unix
from ..squad.client import SquadAuthError, SquadError, get_squad_client
from ..squad.static_va import create_static_va
from ..voice.persona_match import PERSONAS, PersonaSpec, match_persona
from ..voice.proxy import TranscriptionEmptyError, VoiceUnavailableError, transcribe

router = APIRouter(prefix="/auth", tags=["auth"])


# Seed data mirror — kept in sync with backend/seed.py so the endpoint
# can create a user record for a matched persona even if seed.py hasn't
# been run. Defensive: if the user already exists in DB we use the DB
# row; if not, we fall back to this dict for the INSERT.
_PERSONA_SEED_BY_ID: dict[str, dict] = {
    "mama_risikat": {
        "customer_identifier": "mama_risikat_001",
        "first_name": "Mama Risikat",
        "last_name": "Oluwole",
        "phone": "+234 801 234 5001",
        # Squad rejects @echopay.com TLD + plus-aliasing — using the
        # user's real Gmail raw (sandbox doesn't enforce email uniqueness
        # across customers, so all 3 personas can share).
        "email": "aladenusiadeleke@gmail.com",
        "bvn": "22288899900",
        "dob": "1979-03-12",
        "gender": "2",  # female (honorific "Mama")
        "address": "12 Mile 12 Market Road, Ketu, Lagos",
        "beneficiary_account": "4920299492",  # Squad's docs-sample, sandbox-accepted
        "va_number_fallback": "0123456789",
        "balance_kobo_initial": 45_000_000,
    },
    "iya_tope": {
        "customer_identifier": "iya_tope_002",
        "first_name": "Iya Tope",
        "last_name": "Adeyemi",
        "phone": "+234 801 234 5002",
        "email": "aladenusiadeleke@gmail.com",
        "bvn": "22288899900",  # shared sandbox-validated BVN; Squad sandbox doesn't enforce BVN uniqueness
        "dob": "1985-07-04",
        "gender": "2",  # female (honorific "Iya")
        "address": "Stall 24, Mile 12 Market, Ketu, Lagos",
        "beneficiary_account": "4920299492",
        "va_number_fallback": "0234567890",
        "balance_kobo_initial": 12_500_000,
    },
    "kosi": {
        "customer_identifier": "kosi_003",
        "first_name": "Kosi",
        "last_name": "Eze",
        "phone": "+234 801 234 5003",
        "email": "aladenusiadeleke@gmail.com",
        "bvn": "22288899900",  # shared sandbox-validated BVN; Squad sandbox doesn't enforce BVN uniqueness
        "dob": "1996-11-21",
        # Persona narrative is silent on gender — "Kosi" is a unisex
        # Igbo name. Defaulting to male; flagged in fix/seed-squad-payload
        # PR description for review.
        "gender": "1",
        "address": "5 Adeola Odeku Street, Victoria Island, Lagos",
        "beneficiary_account": "4920299492",
        "va_number_fallback": "0345678901",
        "balance_kobo_initial": 8_000_000,
    },
}


# ----------------------------------------------------------------- response shape

class _BankPayload(BaseModel):
    id: int = 1
    name: str = "GTBank"
    code: str = "058"
    logo_url: Optional[str] = None


class _UserPayload(BaseModel):
    id: int
    username: str
    email: str
    first_name: str
    last_name: str
    phone_number: str


class _AccountPayload(BaseModel):
    id: int
    account_number: str
    balance: str  # Naira string with 2dp — matches existing mobile types/Account
    is_active: bool = True
    created_at: str
    user: _UserPayload
    bank: _BankPayload = _BankPayload()


class _SignupData(BaseModel):
    user: _UserPayload
    account: _AccountPayload
    token: str
    matched_persona_id: str
    transcript: str
    demo_mode: bool


class VoiceSignupResponse(BaseModel):
    success: bool
    data: _SignupData


VoiceSignupResponse.model_rebuild()


# ----------------------------------------------------------------- handler


@router.post("/voice-signup", response_model=VoiceSignupResponse)
async def voice_signup(
    audio: UploadFile = File(...),
    phone: Optional[str] = Form(None),  # noqa: ARG001 — accepted for forward-compat
    db: Session = Depends(get_db),
) -> VoiceSignupResponse:
    """Voice → persona match → Squad VA (or fallback) → DB upsert → session.

    Errors:
    - 400 transcription_empty  Whisper returned whitespace
    - 404 persona_unmatched    Voice didn't match a demo persona
    - 503 voice_unavailable    Whisper failed or OPENAI_API_KEY missing
    - 503 squad_failed         Squad sandbox call failed (sandbox down,
                               auth error, etc.) — endpoint still falls
                               back to seed VA when SQUAD_SECRET_KEY=""
    """
    settings = get_settings()

    # 1. Transcribe
    audio_bytes = await audio.read()
    try:
        transcript = await transcribe(audio_bytes, filename=audio.filename or "audio.m4a")
    except TranscriptionEmptyError:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "transcription_empty",
                "message": "I didn't catch that, try again.",
            },
        )
    except VoiceUnavailableError as e:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "voice_unavailable",
                "message": "Voice service unavailable. Use the picker.",
                "cause": str(e),
            },
        )

    # 2. Match persona
    matched = match_persona(transcript)
    if matched is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "persona_unmatched",
                "message": "Voice didn't match a demo persona. Use the picker.",
                "transcript": transcript,
            },
        )

    spec = _PERSONA_SEED_BY_ID[matched.persona_id]

    # 3. Snapshot any existing user inside a short read-only transaction
    #    so the implicit auto-begin doesn't hold over into the later
    #    insert (Funbi's pattern: every DB op lives inside `with db.begin()`).
    existing_snapshot = _snapshot_existing_user(db, spec["customer_identifier"])

    if existing_snapshot is not None:
        # Idempotent re-entry — DB has the user already (probably from
        # seed.py or a prior signup). Use the seeded VA.
        user_row, wallet = existing_snapshot
        used_demo_squad = True  # didn't hit Squad on re-entry
    else:
        # New user — try Squad first, fall back to seed VA on empty key.
        va_number, used_demo_squad = await _resolve_va_number(
            matched, spec, settings.squad_secret_key
        )
        user_row, wallet = _insert_user_and_wallet(
            db, spec, va_number, spec["balance_kobo_initial"]
        )

    # 4. Build response — shape matches AuthContext.setSession contract
    demo_mode = settings.voice_demo_mode or used_demo_squad
    token = _mint_demo_token(user_row.id)
    return _build_response(user_row, wallet, token, matched, transcript, demo_mode)


# ----------------------------------------------------------------- helpers


def _snapshot_existing_user(
    db: Session, customer_identifier: str
) -> Optional[tuple[User, Wallet]]:
    """Read the (User, Wallet) for a persona's customer_identifier, or None.

    Wraps the read in `with db.begin():` so SQLAlchemy doesn't leave a
    half-open auto-begun transaction sitting around when we later open
    `with db.begin():` to insert.
    """
    with db.begin():
        user = db.scalar(
            select(User).where(User.customer_identifier == customer_identifier)
        )
        if user is None:
            return None
        wallet = db.get(Wallet, user.id)
        if wallet is None:
            # Defensive — seed.py always creates both. If we ever land
            # here, something deleted the wallet row out from under us.
            return None
        # Eager-load attributes so they survive after the session
        # transaction closes.
        _ = (user.id, user.first_name, user.last_name, user.email, user.phone,
             user.customer_identifier, user.created_at)
        _ = (wallet.user_id, wallet.squad_va_number, wallet.balance_kobo,
             wallet.updated_at)
    return user, wallet


async def _resolve_va_number(
    matched: PersonaSpec,
    spec: dict,
    squad_secret_key: str,
) -> tuple[str, bool]:
    """Returns (va_number, used_demo_fallback)."""
    if not squad_secret_key:
        # Demo-day insurance: no Squad key → use the seeded VA, mark
        # demo_mode in response so the client can flag this.
        return spec["va_number_fallback"], True

    client = get_squad_client()
    try:
        result = await create_static_va(
            client,
            customer_identifier=spec["customer_identifier"],
            first_name=spec["first_name"],
            last_name=spec["last_name"],
            phone=spec["phone"],
            email=spec["email"],
            bvn=spec["bvn"],
            dob=spec["dob"],
            gender=spec["gender"],
            address=spec["address"],
            beneficiary_account=spec["beneficiary_account"],
        )
    except SquadAuthError as e:
        # Bad sandbox key — config error, log loudly via the cause.
        raise HTTPException(
            status_code=503,
            detail={
                "code": "squad_failed",
                "message": "Couldn't create your account. Try again.",
                "cause": f"squad_auth: {e}",
            },
        )
    except SquadError as e:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "squad_failed",
                "message": "Couldn't create your account. Try again.",
                "cause": str(e),
            },
        )
    return result.va_number, False


def _insert_user_and_wallet(
    db: Session,
    spec: dict,
    va_number: str,
    balance_kobo: int,
) -> tuple[User, Wallet]:
    """One atomic INSERT pair, mirroring Funbi's BEGIN IMMEDIATE pattern."""
    with db.begin():
        # Double-check inside the transaction in case a concurrent
        # signup beat us to it (same persona, two devices).
        existing = db.scalar(
            select(User).where(User.customer_identifier == spec["customer_identifier"])
        )
        if existing:
            wallet = db.get(Wallet, existing.id)
            if wallet is None:
                raise HTTPException(status_code=500, detail={"code": "wallet_missing"})
            return existing, wallet

        now = now_unix()
        user = User(
            customer_identifier=spec["customer_identifier"],
            first_name=spec["first_name"],
            last_name=spec["last_name"],
            phone=spec["phone"],
            email=spec["email"],
            bvn=spec["bvn"],
            dob=spec["dob"],
            created_at=now,
        )
        db.add(user)
        db.flush()  # populates user.id

        wallet = Wallet(
            user_id=user.id,
            squad_va_number=va_number,
            balance_kobo=balance_kobo,
            updated_at=now,
        )
        db.add(wallet)
        db.flush()

    return user, wallet


def _mint_demo_token(user_id: int) -> str:
    # DEMO TOKEN FORMAT — placeholder until §3.12 auth-gate PR adds real JWT.
    # Mobile AuthContext treats this as opaque; any non-empty string is accepted.
    # Format: demo_token_<user_id>_<unix_timestamp>
    # DO NOT use this as a real auth token for any sensitive endpoint.
    return f"demo_token_{user_id}_{int(time.time())}"


def _build_response(
    user: User,
    wallet: Wallet,
    token: str,
    matched: PersonaSpec,
    transcript: str,
    demo_mode: bool,
) -> VoiceSignupResponse:
    username = (
        user.customer_identifier.rsplit("_", 1)[0]
        if "_" in user.customer_identifier
        else user.customer_identifier
    )
    user_payload = _UserPayload(
        id=user.id,
        username=username,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        phone_number=user.phone,
    )
    balance_naira = f"{wallet.balance_kobo / 100:.2f}"
    account_payload = _AccountPayload(
        id=user.id,
        account_number=wallet.squad_va_number,
        balance=balance_naira,
        is_active=True,
        created_at=_iso_from_unix(user.created_at),
        user=user_payload,
    )
    return VoiceSignupResponse(
        success=True,
        data=_SignupData(
            user=user_payload,
            account=account_payload,
            token=token,
            matched_persona_id=matched.persona_id,
            transcript=transcript,
            demo_mode=demo_mode,
        ),
    )


def _iso_from_unix(unix: int) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(unix, tz=timezone.utc).isoformat()
