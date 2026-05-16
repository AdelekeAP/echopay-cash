"""Voice biometric proxy — echopay-cash backend (:8100) ↔ legacy voice service (:8000).

Architecture
------------
Mobile's `voiceBiometricsService` currently calls `:8000` DIRECTLY at
`/api/v1/voice/biometrics/*`. To insert echopay-cash backend as the
proxy (per PRD §6) WITHOUT a mobile code change, we:

  1. Mount this router at the SAME path mobile uses
     (`/api/v1/voice/biometrics`), NOT the PRD §6 canonical
     `/voice/biometric/*`. Mobile compatibility wins; PRD path migration
     is a separate PR that updates both mobile and backend together.
  2. Forward `account-number` + `company-id` headers verbatim to `:8000`
     (legacy auth pattern — mobile already sends these).
  3. Optionally cross-check Bearer token against `account-number`
     header (defense in depth — see _cross_check_account_match below).

Deployment ops: to switch mobile from calling `:8000` directly →
proxying via echopay-cash, set
  EXPO_PUBLIC_VOICE_BASE_URL=http://<echopay-cash-host>:8100
in `mobile/.env`. No code change.

Path A vs Path C
----------------
Path A — real ECAPA-TDNN proxy. Forward request to `:8000`, return
its response shape verbatim. Requires `:8000` reachability and live
audio model.

Path C — synthetic env-flag fallback. When `VOICE_BIOMETRIC_DEMO_MODE=true`,
each endpoint returns a synthetic-pass response without calling `:8000`.
Maps to PRD §11.5 risk mitigation ("Pre-record fallback"). Demo-day
operational toggle: flip the env var to `false` after `:8000` is
verified green at dress rehearsal.

Synthetic responses match the legacy `:8000` response shapes verbatim
so mobile's response-parsing code doesn't break. Deterministic
`enrollment_id` and `enrollment_date` per `account-number` so demo
replays are consistent.

Logging
-------
Per-call structured log: masked `account_number` (last 4 digits),
endpoint, `demo_mode` flag, `upstream_ms` (Path A only), status. NEVER
log audio bytes or embeddings.
"""

from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.config import get_settings
from ..core.db import get_db
from ..models import Wallet

router = APIRouter(prefix="/api/v1/voice/biometrics", tags=["voice-biometric"])
logger = logging.getLogger("echopay.voice_proxy")


# ----------------------------------------------------------------- httpx client

# Single async client reused across requests. FastAPI creates the
# event loop once per process so a module-level client is safe.
# Initialized lazily on first call so test fixtures can override the
# settings before the client is built.
_httpx_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    """Lazy singleton — built once per process, reuses connection pool."""
    global _httpx_client
    if _httpx_client is None:
        settings = get_settings()
        _httpx_client = httpx.AsyncClient(
            base_url=settings.voice_biometric_service_url,
            timeout=httpx.Timeout(settings.voice_biometric_timeout_seconds),
        )
    return _httpx_client


def reset_httpx_client() -> None:
    """Test helper — drop the cached client so a settings change is picked up."""
    global _httpx_client
    _httpx_client = None


# ----------------------------------------------------------------- helpers


def _mask_account(account_number: str) -> str:
    """Last 4 digits prefixed with ****. Safe to log."""
    if not account_number or len(account_number) < 4:
        return "****"
    return f"****{account_number[-4:]}"


def _user_id_from_token(authorization: str | None) -> int | None:
    """Parse user_id from 'Bearer demo_token_<user_id>_<unix>'. Returns None on failure.

    Mirrors voice_intent.py / transfer.py / dva.py / loans.py token parser.
    """
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


def _cross_check_account_match(
    authorization: str | None,
    account_number: str,
    db: Session,
) -> None:
    """Defense-in-depth: when a Bearer token IS present, verify that the
    token's user owns the wallet whose squad_va_number == account_number.

    No-op when Authorization header is absent (mobile-unchanged path
    still works). Raises 403 on mismatch or missing wallet.
    """
    uid = _user_id_from_token(authorization)
    if uid is None:
        return  # No token — no cross-check (mobile-unchanged path)

    wallet = db.scalar(select(Wallet).where(Wallet.user_id == uid))
    if wallet is None:
        raise HTTPException(
            status_code=403,
            detail={"error": "wallet_not_found"},
        )
    if wallet.squad_va_number != account_number:
        raise HTTPException(
            status_code=403,
            detail={"error": "account_mismatch"},
        )


def _synthetic_enrollment_id(account_number: str) -> str:
    """Deterministic UUID per account-number — demo replays look consistent."""
    return str(uuid.uuid5(uuid.NAMESPACE_OID, f"demo_{account_number}"))


def _synthetic_enrollment_date(now: Optional[datetime] = None) -> datetime:
    """Always 7 days before now() — profile looks established, not fresh."""
    return (now or datetime.now(timezone.utc)) - timedelta(days=7)


def _synthetic_verify_response() -> dict:
    return {
        "verified": True,
        "confidence": 0.92,
        "similarity": 0.92,
        "security_level": "high",
        "message": "Voice verified (demo mode)",
    }


def _synthetic_enroll_response(account_number: str) -> dict:
    return {
        "success": True,
        "enrollment_id": _synthetic_enrollment_id(account_number),
        "quality_score": 0.91,
        "samples_used": 3,
        "message": "Voice enrolled (demo mode)",
    }


def _synthetic_profile_response(account_number: str) -> dict:
    return {
        "success": True,
        "data": {
            "user_id": account_number,
            "enrollment_id": _synthetic_enrollment_id(account_number),
            "quality_score": 0.91,
            "samples_count": 3,
            "enrollment_date": _synthetic_enrollment_date().isoformat(),
            "last_verified": None,
            "verification_count": 0,
            "failed_verification_count": 0,
            "is_active": True,
            "locked_until": None,
        },
    }


def _synthetic_delete_response() -> dict:
    return {"success": True, "message": "Voice profile deleted (demo mode)"}


# ----------------------------------------------------------------- forward helpers


async def _forward_to_upstream(
    method: str,
    path: str,
    headers: dict,
    files: list | None = None,
    params: dict | None = None,
) -> httpx.Response:
    """Forward a request to the :8000 voice service. Maps network errors
    to HTTP responses suitable for the proxy contract:
      ConnectError    → 503 biometric_service_unavailable
      TimeoutException → 504 biometric_service_timeout
    """
    client = _get_client()
    try:
        resp = await client.request(
            method,
            path,
            headers=headers,
            files=files,
            params=params,
        )
        return resp
    except httpx.ConnectError as e:
        logger.warning("voice_proxy upstream_unreachable: %s", e)
        raise HTTPException(
            status_code=503,
            detail={
                "error": "biometric_service_unavailable",
                "fallback_available": True,
            },
        ) from e
    except httpx.TimeoutException as e:
        logger.warning("voice_proxy upstream_timeout: %s", e)
        raise HTTPException(
            status_code=504,
            detail={"error": "biometric_service_timeout"},
        ) from e


def _map_upstream_response(resp: httpx.Response) -> dict:
    """Map :8000 status to proxy response. 2xx + 4xx forward verbatim;
    5xx becomes 502 with upstream_status surfaced.
    """
    if 200 <= resp.status_code < 300:
        return resp.json()
    if 400 <= resp.status_code < 500:
        # Forward client errors verbatim
        try:
            detail = resp.json()
        except Exception:  # noqa: BLE001 — defensive against non-JSON upstream
            detail = {"error": "upstream_client_error", "message": resp.text[:200]}
        raise HTTPException(status_code=resp.status_code, detail=detail)
    # 5xx
    raise HTTPException(
        status_code=502,
        detail={
            "error": "biometric_service_error",
            "upstream_status": resp.status_code,
        },
    )


def _log_call(
    endpoint: str,
    account_number: str,
    demo_mode: bool,
    upstream_ms: float | None,
    status_code: int,
) -> None:
    logger.info(
        "voice_proxy endpoint=%s account=%s demo_mode=%s upstream_ms=%s status=%s",
        endpoint,
        _mask_account(account_number),
        demo_mode,
        f"{upstream_ms:.1f}" if upstream_ms is not None else "n/a",
        status_code,
    )


# ----------------------------------------------------------------- endpoints


@router.post("/enroll")
async def enroll_voice(
    sample_1: UploadFile = File(...),
    sample_2: UploadFile = File(...),
    sample_3: UploadFile = File(...),
    sample_4: Optional[UploadFile] = File(None),
    sample_5: Optional[UploadFile] = File(None),
    account_number: str = Header(..., alias="account-number"),
    company_id: Optional[str] = Header(None, alias="company-id"),
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> dict:
    """Enroll a user's voice. Proxies to :8000/api/v1/voice/biometrics/enroll.

    Path C (demo mode): returns synthetic enrollment without calling :8000.
    Path A (real): forwards 3-5 multipart samples + account-number header.
    """
    settings = get_settings()
    _cross_check_account_match(authorization, account_number, db)

    if settings.voice_biometric_demo_mode:
        _log_call("enroll", account_number, demo_mode=True, upstream_ms=None, status_code=200)
        return _synthetic_enroll_response(account_number)

    # Path A: forward to :8000
    samples = [
        ("sample_1", sample_1),
        ("sample_2", sample_2),
        ("sample_3", sample_3),
    ]
    if sample_4 is not None:
        samples.append(("sample_4", sample_4))
    if sample_5 is not None:
        samples.append(("sample_5", sample_5))

    files = []
    for field_name, upload in samples:
        content = await upload.read()
        files.append(
            (field_name, (upload.filename or f"{field_name}.m4a", content, upload.content_type or "audio/m4a"))
        )

    headers = {"account-number": account_number}
    if company_id is not None:
        headers["company-id"] = company_id

    started = time.monotonic()
    resp = await _forward_to_upstream(
        "POST", "/api/v1/voice/biometrics/enroll", headers=headers, files=files
    )
    elapsed_ms = (time.monotonic() - started) * 1000
    _log_call("enroll", account_number, demo_mode=False, upstream_ms=elapsed_ms, status_code=resp.status_code)
    return _map_upstream_response(resp)


@router.post("/verify")
async def verify_voice(
    audio: UploadFile = File(...),
    account_number: str = Header(..., alias="account-number"),
    company_id: Optional[str] = Header(None, alias="company-id"),
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> dict:
    """Verify a live voice sample against stored profile. Proxies to
    :8000/api/v1/voice/biometrics/verify.
    """
    settings = get_settings()
    _cross_check_account_match(authorization, account_number, db)

    if settings.voice_biometric_demo_mode:
        _log_call("verify", account_number, demo_mode=True, upstream_ms=None, status_code=200)
        return _synthetic_verify_response()

    content = await audio.read()
    files = [
        (
            "audio",
            (audio.filename or "audio.m4a", content, audio.content_type or "audio/m4a"),
        )
    ]
    headers = {"account-number": account_number}
    if company_id is not None:
        headers["company-id"] = company_id

    started = time.monotonic()
    resp = await _forward_to_upstream(
        "POST", "/api/v1/voice/biometrics/verify", headers=headers, files=files
    )
    elapsed_ms = (time.monotonic() - started) * 1000
    _log_call("verify", account_number, demo_mode=False, upstream_ms=elapsed_ms, status_code=resp.status_code)
    return _map_upstream_response(resp)


@router.get("/profile/{user_id}")
async def get_voice_profile(
    user_id: str,
    company_id: Optional[str] = None,
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> dict:
    """Get voice profile metadata (no embedding data). Proxies to
    :8000/api/v1/voice/biometrics/profile/{user_id}.

    Note: `user_id` URL param is the account_number string (10-digit
    Squad VA) in legacy practice — not the integer User.id.
    """
    settings = get_settings()
    # Treat the path param as the account_number for cross-check parity
    # with enroll/verify (defense-in-depth only fires when Bearer present).
    _cross_check_account_match(authorization, user_id, db)

    if settings.voice_biometric_demo_mode:
        _log_call("profile_get", user_id, demo_mode=True, upstream_ms=None, status_code=200)
        return _synthetic_profile_response(user_id)

    params = {"company_id": company_id} if company_id is not None else None
    started = time.monotonic()
    resp = await _forward_to_upstream(
        "GET", f"/api/v1/voice/biometrics/profile/{user_id}", headers={}, params=params
    )
    elapsed_ms = (time.monotonic() - started) * 1000
    _log_call("profile_get", user_id, demo_mode=False, upstream_ms=elapsed_ms, status_code=resp.status_code)
    return _map_upstream_response(resp)


@router.delete("/profile/{user_id}")
async def delete_voice_profile(
    user_id: str,
    company_id: Optional[str] = None,
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> dict:
    """Soft-delete a user's voice profile. Proxies to
    :8000/api/v1/voice/biometrics/profile/{user_id}.
    """
    settings = get_settings()
    _cross_check_account_match(authorization, user_id, db)

    if settings.voice_biometric_demo_mode:
        _log_call("profile_delete", user_id, demo_mode=True, upstream_ms=None, status_code=200)
        return _synthetic_delete_response()

    params = {"company_id": company_id} if company_id is not None else None
    started = time.monotonic()
    resp = await _forward_to_upstream(
        "DELETE", f"/api/v1/voice/biometrics/profile/{user_id}", headers={}, params=params
    )
    elapsed_ms = (time.monotonic() - started) * 1000
    _log_call("profile_delete", user_id, demo_mode=False, upstream_ms=elapsed_ms, status_code=resp.status_code)
    return _map_upstream_response(resp)
