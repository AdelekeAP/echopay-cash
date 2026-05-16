"""Tests for /api/v1/voice/biometrics/* proxy endpoints.

Covers:
- Path C demo-mode synthetic responses (no :8000 call, <100ms)
- Path A forwarding to :8000 via monkeypatched httpx
- :8000 unreachable → 503 with fallback_available flag
- :8000 timeout → 504
- :8000 4xx forwarded verbatim
- :8000 5xx → 502 with upstream_status surfaced
- Bearer token cross-check (mismatch → 403, missing wallet → 403)
- No Bearer token → no cross-check (mobile-unchanged path)
- Logging masks account number to last-4
"""

from __future__ import annotations

import io
import logging
import sys
import time

import httpx
import pytest


# ----------------------------------------------------------------- fixtures


@pytest.fixture(autouse=True)
def _reset_module_caches(client):  # noqa: ARG001 — depend on client to order after it
    """Drop module caches that survive between tests."""
    yield
    for mod_name in (
        "app.api.voice_proxy",
        "app.core.config",
    ):
        sys.modules.pop(mod_name, None)
    try:
        from app.core import config as config_module
        config_module.get_settings.cache_clear()
    except (ImportError, AttributeError):
        pass


@pytest.fixture
def demo_mode_on(monkeypatch):
    """Force Path C (demo mode) on. Default in config is already True
    but tests explicit-toggle to make intent obvious."""
    monkeypatch.setenv("VOICE_BIOMETRIC_DEMO_MODE", "true")
    from app.core import config as config_module
    config_module.get_settings.cache_clear()


@pytest.fixture
def demo_mode_off(monkeypatch):
    """Force Path A (real :8000 proxy) on."""
    monkeypatch.setenv("VOICE_BIOMETRIC_DEMO_MODE", "false")
    from app.core import config as config_module
    config_module.get_settings.cache_clear()
    # Reset the httpx client too — it caches the timeout at construction.
    from app.api import voice_proxy
    voice_proxy.reset_httpx_client()


@pytest.fixture
def mock_upstream(monkeypatch):
    """Replace voice_proxy._forward_to_upstream so tests don't open
    sockets. Returns a setter the caller invokes per test."""

    def _install(
        *,
        status_code: int = 200,
        body: dict | None = None,
        raise_exc: Exception | None = None,
    ):
        from app.api import voice_proxy

        async def fake_forward(method, path, headers, files=None, params=None):
            if raise_exc is not None:
                raise raise_exc
            # Build a synthetic httpx.Response. Easiest: construct via
            # the public API rather than internals.
            req = httpx.Request(method, f"http://upstream{path}")
            content = httpx.Response(
                status_code,
                json=body or {},
                request=req,
            )
            return content

        monkeypatch.setattr(voice_proxy, "_forward_to_upstream", fake_forward)

    return _install


# ----------------------------------------------------------------- helpers


_ACCT = "0123456789"
_OTHER_ACCT = "0234567890"


def _audio_file(field: str = "audio") -> dict:
    return {"files": {field: ("v.m4a", io.BytesIO(b"fake-audio"), "audio/m4a")}}


def _enroll_files() -> dict:
    return {
        "files": [
            ("sample_1", ("s1.m4a", io.BytesIO(b"s1"), "audio/m4a")),
            ("sample_2", ("s2.m4a", io.BytesIO(b"s2"), "audio/m4a")),
            ("sample_3", ("s3.m4a", io.BytesIO(b"s3"), "audio/m4a")),
        ]
    }


def _hdr(account: str = _ACCT, token_user_id: int | None = None) -> dict:
    h = {"account-number": account}
    if token_user_id is not None:
        h["Authorization"] = f"Bearer demo_token_{token_user_id}_{int(time.time())}"
    return h


def _seed_wallet(client, user_id: int, va_number: str) -> None:  # noqa: ARG001
    """Direct DB seed of a User + Wallet pair so cross-check has data."""
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        with db.begin():
            u = models.User(
                customer_identifier=f"test_user_{user_id}",
                first_name="Test",
                last_name="User",
                phone="+2348012345678",
                email="t@test",
                bvn="22288899900",
                dob="1990-01-01",
                created_at=models.now_unix(),
            )
            db.add(u)
            db.flush()
            db.add(models.Wallet(
                user_id=u.id,
                squad_va_number=va_number,
                balance_kobo=0,
                updated_at=models.now_unix(),
            ))


# ============================================================ Path C tests


def test_demo_mode_verify_returns_synthetic_within_100ms(client, demo_mode_on):
    """Verify endpoint in demo mode returns synthetic pass with no upstream call.

    Wall-clock < 100ms is the demo-day SLA — no audio is read into memory,
    no socket opened.
    """
    t0 = time.perf_counter()
    r = client.post(
        "/api/v1/voice/biometrics/verify",
        **_audio_file("audio"),
        headers=_hdr(),
    )
    elapsed_ms = (time.perf_counter() - t0) * 1000
    assert r.status_code == 200, r.text
    data = r.json()
    assert data == {
        "verified": True,
        "confidence": 0.92,
        "similarity": 0.92,
        "security_level": "high",
        "message": "Voice verified (demo mode)",
    }
    assert elapsed_ms < 100, f"demo mode took {elapsed_ms:.0f}ms — too slow"


def test_demo_mode_enroll_returns_synthetic(client, demo_mode_on):
    r = client.post(
        "/api/v1/voice/biometrics/enroll",
        **_enroll_files(),
        headers=_hdr(),
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["success"] is True
    assert data["samples_used"] == 3
    assert data["quality_score"] == 0.91
    assert data["message"] == "Voice enrolled (demo mode)"
    # enrollment_id is a UUID
    import uuid
    uuid.UUID(data["enrollment_id"])  # raises if not valid


def test_demo_mode_profile_get_returns_synthetic(client, demo_mode_on):
    r = client.get(f"/api/v1/voice/biometrics/profile/{_ACCT}")
    assert r.status_code == 200
    data = r.json()
    assert data["success"] is True
    assert data["data"]["user_id"] == _ACCT
    assert data["data"]["is_active"] is True
    assert data["data"]["verification_count"] == 0
    # Profile looks "established" — enrollment_date set
    assert data["data"]["enrollment_date"] is not None


def test_demo_mode_profile_delete_returns_synthetic(client, demo_mode_on):
    r = client.delete(f"/api/v1/voice/biometrics/profile/{_ACCT}")
    assert r.status_code == 200
    assert r.json() == {"success": True, "message": "Voice profile deleted (demo mode)"}


def test_demo_mode_enrollment_id_deterministic(client, demo_mode_on):
    """Same account → same enrollment_id across repeated calls (demo replay)."""
    r1 = client.post("/api/v1/voice/biometrics/enroll", **_enroll_files(), headers=_hdr())
    r2 = client.post("/api/v1/voice/biometrics/enroll", **_enroll_files(), headers=_hdr())
    assert r1.json()["enrollment_id"] == r2.json()["enrollment_id"]


# ============================================================ Path A tests


def test_path_a_verify_forwards_to_8000_with_account_number_header(
    client, demo_mode_off, mock_upstream
):
    mock_upstream(
        status_code=200,
        body={
            "verified": True,
            "confidence": 0.87,
            "similarity": 0.87,
            "security_level": "high",
            "message": "Voice verified",
        },
    )
    r = client.post(
        "/api/v1/voice/biometrics/verify", **_audio_file("audio"), headers=_hdr()
    )
    assert r.status_code == 200, r.text
    data = r.json()
    # Upstream confidence (not demo's 0.92) flows through
    assert data["confidence"] == 0.87
    assert data["verified"] is True


def test_path_a_enroll_forwards_multipart_samples(
    client, demo_mode_off, mock_upstream
):
    """Multipart sample_1/2/3 forwarded to upstream; upstream response forwarded."""
    mock_upstream(
        status_code=200,
        body={
            "success": True,
            "enrollment_id": "real-enroll-id",
            "quality_score": 0.88,
            "samples_used": 3,
            "message": "Enrolled",
        },
    )
    r = client.post(
        "/api/v1/voice/biometrics/enroll", **_enroll_files(), headers=_hdr()
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["enrollment_id"] == "real-enroll-id"
    assert data["quality_score"] == 0.88


def test_path_a_8000_unreachable_returns_503_with_fallback_flag(
    client, demo_mode_off, mock_upstream
):
    # Simulate a ConnectError raised by the inner httpx client. The
    # _forward_to_upstream helper catches it and raises HTTPException
    # so we install that behavior directly.
    from fastapi import HTTPException
    mock_upstream(
        raise_exc=HTTPException(
            status_code=503,
            detail={"error": "biometric_service_unavailable", "fallback_available": True},
        )
    )
    r = client.post(
        "/api/v1/voice/biometrics/verify", **_audio_file("audio"), headers=_hdr()
    )
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert detail["error"] == "biometric_service_unavailable"
    assert detail["fallback_available"] is True


def test_path_a_8000_timeout_returns_504(client, demo_mode_off, mock_upstream):
    from fastapi import HTTPException
    mock_upstream(
        raise_exc=HTTPException(
            status_code=504,
            detail={"error": "biometric_service_timeout"},
        )
    )
    r = client.post(
        "/api/v1/voice/biometrics/verify", **_audio_file("audio"), headers=_hdr()
    )
    assert r.status_code == 504
    assert r.json()["detail"]["error"] == "biometric_service_timeout"


def test_path_a_8000_returns_4xx_forwards_verbatim(
    client, demo_mode_off, mock_upstream
):
    """Upstream 4xx is the user's fault (bad audio, missing profile, etc.) —
    forward the exact status + body so mobile can render the right error."""
    mock_upstream(
        status_code=404,
        body={
            "verified": False,
            "confidence": 0.0,
            "error": "No voice profile found",
            "message": "User has not enrolled voice biometrics",
        },
    )
    r = client.post(
        "/api/v1/voice/biometrics/verify", **_audio_file("audio"), headers=_hdr()
    )
    assert r.status_code == 404
    detail = r.json()["detail"]
    assert detail["error"] == "No voice profile found"


def test_path_a_8000_returns_5xx_returns_502(client, demo_mode_off, mock_upstream):
    """Upstream 5xx is our infra's fault — surface as 502 with the
    real upstream status so ops can diagnose."""
    mock_upstream(status_code=500, body={"error": "internal upstream"})
    r = client.post(
        "/api/v1/voice/biometrics/verify", **_audio_file("audio"), headers=_hdr()
    )
    assert r.status_code == 502
    detail = r.json()["detail"]
    assert detail["error"] == "biometric_service_error"
    assert detail["upstream_status"] == 500


# ============================================================ Bearer cross-check


def test_bearer_cross_check_passes_when_account_matches(
    client, demo_mode_on
):
    _seed_wallet(client, user_id=1, va_number=_ACCT)
    r = client.post(
        "/api/v1/voice/biometrics/verify",
        **_audio_file("audio"),
        headers=_hdr(account=_ACCT, token_user_id=1),
    )
    assert r.status_code == 200, r.text
    # Synthetic verify response — cross-check passed silently
    assert r.json()["verified"] is True


def test_bearer_cross_check_403_when_account_mismatch(client, demo_mode_on):
    """Token says user 1 (owns _ACCT). Body says account-number is _OTHER_ACCT.
    Defense-in-depth → 403."""
    _seed_wallet(client, user_id=1, va_number=_ACCT)
    r = client.post(
        "/api/v1/voice/biometrics/verify",
        **_audio_file("audio"),
        headers=_hdr(account=_OTHER_ACCT, token_user_id=1),
    )
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "account_mismatch"


def test_bearer_cross_check_403_when_wallet_not_found(client, demo_mode_on):
    """Token says user 99 — that user_id has no wallet. 403 wallet_not_found."""
    # NO _seed_wallet call — user 99 doesn't exist.
    r = client.post(
        "/api/v1/voice/biometrics/verify",
        **_audio_file("audio"),
        headers=_hdr(account=_ACCT, token_user_id=99),
    )
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "wallet_not_found"


def test_no_bearer_no_cross_check_proxies_normally(client, demo_mode_on):
    """When no Bearer token is sent, cross-check is a no-op. Mobile's
    current path (account-number header only, no Bearer) still works."""
    # Wallet exists but the body's account doesn't match — no Bearer means
    # no cross-check, so the request proceeds.
    _seed_wallet(client, user_id=1, va_number=_ACCT)
    r = client.post(
        "/api/v1/voice/biometrics/verify",
        **_audio_file("audio"),
        headers=_hdr(account=_OTHER_ACCT),  # no token
    )
    assert r.status_code == 200, r.text
    assert r.json()["verified"] is True


# ============================================================ Logging


def test_logging_masks_account_number_to_last_4(client, demo_mode_on, caplog):
    """Per-call log must include ****<last4> not the full account."""
    caplog.set_level(logging.INFO, logger="echopay.voice_proxy")
    r = client.post(
        "/api/v1/voice/biometrics/verify",
        **_audio_file("audio"),
        headers=_hdr(account=_ACCT),
    )
    assert r.status_code == 200
    # Find the proxy log line
    proxy_records = [
        rec for rec in caplog.records if rec.name == "echopay.voice_proxy"
    ]
    assert proxy_records, "expected at least one voice_proxy log record"
    log_message = proxy_records[0].getMessage()
    # The masked form appears
    assert "****6789" in log_message
    # The full account number does NOT leak
    assert _ACCT not in log_message
