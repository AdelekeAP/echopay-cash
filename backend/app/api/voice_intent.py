"""POST /voice/intent — Whisper transcription + intent extraction.

PRD_LEKE.md §3.14: voice hint card on home tab calls this endpoint.
Mobile sends the raw audio; backend runs Whisper (or demo bypass),
extracts intent via fast-path regex + optional LLM, and returns a
typed action object mobile can dispatch without further parsing.

Demo-day safety:
  VOICE_DEMO_MODE=true → skip Whisper, use hardcoded transcript
  "send five thousand to iya tope", so the 1:15 Script A beat works
  even when the OpenAI key isn't loaded or the laptop is offline.

Auth (lightweight):
  Optional `Authorization: Bearer demo_token_<user_id>_<ts>`. When
  parseable, the live wallet balance_kobo is attached for `balance`
  actions. Missing or malformed token → still 200, balance omitted.

Invariants:
  - ALWAYS returns HTTP 200 (intent failure → action: "unknown").
  - 503 propagated only for Whisper unavailability.
  - 422 on missing `audio` field (FastAPI form validation).
  - No DB writes. Read-only apart from the Wallet balance lookup.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, Header, HTTPException, UploadFile
from sqlalchemy.orm import Session

from ..core.config import get_settings
from ..core.db import get_db
from ..models import Wallet
from ..services.intent_parser import parse_intent
from ..voice.proxy import TranscriptionEmptyError, VoiceUnavailableError, transcribe

router = APIRouter(prefix="/voice", tags=["voice"])
logger = logging.getLogger("echopay.voice_intent")

_DEMO_TRANSCRIPT = "send five thousand to iya tope"


def _user_id_from_token(authorization: str | None) -> int | None:
    """Parse user_id from Authorization header. Returns None on any failure."""
    if not authorization:
        return None
    token = (
        authorization.removeprefix("Bearer ").strip()
        if authorization.startswith("Bearer ")
        else authorization.strip()
    )
    # Expected: demo_token_<user_id>_<unix_ts>  →  ["demo","token","<id>","<ts>"]
    parts = token.split("_")
    if len(parts) >= 4 and parts[0] == "demo" and parts[1] == "token":
        try:
            return int(parts[2])
        except ValueError:
            return None
    return None


@router.post("/intent")
async def voice_intent(
    audio: UploadFile = File(...),
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> dict:
    """Transcribe audio then extract intent. Always HTTP 200 on intent failure."""
    settings = get_settings()
    user_id = _user_id_from_token(authorization)

    # ---- transcription --------------------------------------------------

    if settings.voice_demo_mode:
        transcript = _DEMO_TRANSCRIPT
        logger.info("voice_intent: demo mode, using hardcoded transcript")
    else:
        try:
            audio_bytes = await audio.read()
            transcript = await transcribe(audio_bytes, audio.filename or "audio.m4a")
        except VoiceUnavailableError as exc:
            raise HTTPException(
                status_code=503,
                detail={"code": "VOICE_UNAVAILABLE", "message": str(exc)},
            )
        except TranscriptionEmptyError:
            logger.info("voice_intent: empty transcript, returning unknown")
            return {
                "success": True,
                "data": {
                    "intent": "unknown",
                    "transcript": "",
                    "action": "unknown",
                    "entities": {},
                },
            }

    logger.info("voice_intent: transcript=%r user_id=%s", transcript, user_id)

    # ---- intent extraction ----------------------------------------------

    result = await parse_intent(transcript)
    entities = dict(result.entities)

    # Enrich balance response with live wallet balance when user is known
    if result.intent == "balance" and user_id is not None:
        wallet = db.get(Wallet, user_id)
        if wallet:
            entities["balance_kobo"] = wallet.balance_kobo

    return {
        "success": True,
        "data": {
            "intent": result.intent,
            "transcript": transcript,
            "action": result.action,
            "entities": entities,
        },
    }
