"""Tests for POST /auth/voice-signup.

Mirrors Funbi's test_in_network_transfer.py pattern: per-test SQLite DB
via the `client` fixture in conftest.py. We monkeypatch the
module-level `transcribe` function and the `create_static_va` function
so no live network calls hit Whisper or Squad in CI.

Coverage (14 tests):
  1.  Happy path matched persona (Whisper + Squad both mocked)
  2.  Re-entry returns existing user (idempotent)
  3.  VOICE_DEMO_MODE=true happy path (no Whisper call needed)
  4.  SQUAD_SECRET_KEY="" → uses seeded VA fallback
  5.  Voice service raises → 503 voice_unavailable
  6.  Transcript empty → 400 transcription_empty
  7.  Transcript "John Smith" → 404 persona_unmatched
  8.  Squad raises → 503 squad_failed
  9.  Missing audio field → 422
  10. Persona-match false-positive: "tope" alone → 404 (Adjustment 1)
  11. Persona-match false-positive: "mama" alone → 404 (Adjustment 1)
  12. Persona-match last-name: "risikat" → mama_risikat
  13. Persona-match full name w/ filler: "i am kosi" → kosi
  14. Persona-match Iya Tope full first-name
"""

from __future__ import annotations

import io
import pytest


@pytest.fixture(autouse=True)
def _reset_module_caches(client):  # noqa: ARG001 — depend on client to order after it
    """Wipe module-level caches that survive across tests.

    Funbi's conftest pops `app.main`, `app.core.config`, `app.core.db`,
    `app.models`, `app.api.transfer` between tests — but my new modules
    (`app.api.auth`, `app.voice.proxy`, `app.squad.client`) keep their
    cached settings + lazy singletons. Reset them so each test starts
    clean.
    """
    yield
    # Best-effort: invalidate caches even on failure.
    import sys
    for mod_name in (
        "app.api.auth",
        "app.voice.proxy",
        "app.voice.persona_match",
        "app.squad.client",
        "app.squad.static_va",
    ):
        sys.modules.pop(mod_name, None)
    # Clear get_settings cache for next test
    try:
        from app.core import config as config_module
        config_module.get_settings.cache_clear()
    except (ImportError, AttributeError):
        pass


# --------------------------------------------------------------- helpers


def _multipart(transcript_hint: str = "any") -> dict:
    """Build the files+data dict for httpx multipart upload.

    Bytes don't matter for the mocked path — we only need a valid
    multipart frame. `transcript_hint` is unused on the wire; it's
    just documentation at the call site.
    """
    return {
        "files": {"audio": ("audio.m4a", io.BytesIO(b"fake-audio-bytes"), "audio/m4a")},
    }


@pytest.fixture
def mock_voice(monkeypatch):
    """Returns a setter — call mock_voice(transcript="...") in each test."""

    def _install(transcript: str | None = None, raise_unavailable: bool = False,
                 raise_empty: bool = False):
        from app.voice import proxy as voice_proxy
        from app.api import auth as auth_module

        async def fake_transcribe(audio_bytes: bytes, filename: str = "audio.m4a"):
            if raise_unavailable:
                raise voice_proxy.VoiceUnavailableError("mocked unavailable")
            if raise_empty:
                raise voice_proxy.TranscriptionEmptyError("mocked empty")
            return transcript or ""

        # The endpoint imports `transcribe` directly, so monkeypatch its
        # module reference (not the source module's).
        monkeypatch.setattr(auth_module, "transcribe", fake_transcribe)

    return _install


@pytest.fixture
def mock_squad(monkeypatch):
    """Returns a setter — call mock_squad(va_number=...) per test."""

    def _install(va_number: str | None = "0999888777", raise_error: str | None = None):
        from app.api import auth as auth_module
        from app.squad import client as squad_client
        from app.squad.static_va import SquadStaticVAResult

        async def fake_create_static_va(client, **kwargs):
            if raise_error == "auth":
                raise squad_client.SquadAuthError("mocked auth error", status_code=401)
            if raise_error == "generic":
                raise squad_client.SquadError("mocked generic error")
            return SquadStaticVAResult({"va_number": va_number, "customer_id": "cust_X"})

        monkeypatch.setattr(auth_module, "create_static_va", fake_create_static_va)

    return _install


@pytest.fixture
def squad_key(monkeypatch):
    """Set or clear SQUAD_SECRET_KEY for the duration of the test."""

    def _install(key: str = "sandbox_test_key"):
        monkeypatch.setenv("SQUAD_SECRET_KEY", key)
        # Force settings cache to invalidate so the value is re-read.
        from app.core import config as config_module
        config_module.get_settings.cache_clear()

    return _install


# --------------------------------------------------------------- tests


def test_happy_path_mama_risikat(client, mock_voice, mock_squad, squad_key):
    squad_key("sandbox_test_key")
    mock_voice(transcript="mama risikat")
    mock_squad(va_number="0123456789")

    r = client.post("/auth/voice-signup", **_multipart())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    data = body["data"]
    assert data["matched_persona_id"] == "mama_risikat"
    assert data["transcript"] == "mama risikat"
    assert data["demo_mode"] is False
    assert data["user"]["first_name"] == "Mama Risikat"
    assert data["account"]["account_number"] == "0123456789"
    assert data["account"]["bank"]["name"] == "GTBank"
    assert data["token"].startswith("demo_token_")


def test_re_entry_returns_existing_user(client, mock_voice, mock_squad, squad_key):
    squad_key("sandbox_test_key")
    mock_voice(transcript="mama risikat")
    mock_squad(va_number="0123456789")

    r1 = client.post("/auth/voice-signup", **_multipart())
    assert r1.status_code == 200
    user_id_1 = r1.json()["data"]["user"]["id"]

    # Second call — should fetch the same user, not create a duplicate.
    r2 = client.post("/auth/voice-signup", **_multipart())
    assert r2.status_code == 200
    user_id_2 = r2.json()["data"]["user"]["id"]
    assert user_id_1 == user_id_2

    # And only one row in DB.
    import importlib
    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")
    with db_mod.db_session() as db:
        mamas = db.query(models.User).filter(
            models.User.customer_identifier == "mama_risikat_001"
        ).all()
        assert len(mamas) == 1


def test_voice_demo_mode_bypasses_whisper(client, mock_squad, monkeypatch, squad_key):
    """VOICE_DEMO_MODE=true should mint mama_risikat without a Whisper call."""
    squad_key("sandbox_test_key")
    monkeypatch.setenv("VOICE_DEMO_MODE", "true")
    from app.core import config as config_module
    config_module.get_settings.cache_clear()
    # Also reset the proxy client cache so the demo path is re-checked
    from app.voice import proxy as voice_proxy
    voice_proxy.reset_openai_client()
    mock_squad(va_number="0123456789")

    r = client.post("/auth/voice-signup", **_multipart())
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["matched_persona_id"] == "mama_risikat"
    assert data["transcript"] == "mama risikat"


def test_squad_key_empty_falls_back_to_seed_va(client, mock_voice, monkeypatch):
    """With no Squad key, use the seeded VA and flag demo_mode=true."""
    monkeypatch.setenv("SQUAD_SECRET_KEY", "")
    from app.core import config as config_module
    config_module.get_settings.cache_clear()

    mock_voice(transcript="mama risikat")

    r = client.post("/auth/voice-signup", **_multipart())
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["account"]["account_number"] == "0123456789"  # seed fallback
    assert data["demo_mode"] is True


def test_voice_unavailable_returns_503(client, mock_voice, squad_key):
    squad_key("sandbox_test_key")
    mock_voice(raise_unavailable=True)

    r = client.post("/auth/voice-signup", **_multipart())
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert detail["code"] == "voice_unavailable"


def test_transcription_empty_returns_400(client, mock_voice, squad_key):
    squad_key("sandbox_test_key")
    mock_voice(raise_empty=True)

    r = client.post("/auth/voice-signup", **_multipart())
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert detail["code"] == "transcription_empty"


def test_persona_unmatched_returns_404(client, mock_voice, squad_key):
    squad_key("sandbox_test_key")
    mock_voice(transcript="john smith jones")

    r = client.post("/auth/voice-signup", **_multipart())
    assert r.status_code == 404
    detail = r.json()["detail"]
    assert detail["code"] == "persona_unmatched"
    assert detail["transcript"] == "john smith jones"


def test_squad_failure_returns_503(client, mock_voice, mock_squad, squad_key):
    squad_key("sandbox_test_key")
    mock_voice(transcript="mama risikat")
    mock_squad(raise_error="generic")

    r = client.post("/auth/voice-signup", **_multipart())
    assert r.status_code == 503
    detail = r.json()["detail"]
    assert detail["code"] == "squad_failed"


def test_missing_audio_field_returns_422(client):
    r = client.post("/auth/voice-signup", data={})
    assert r.status_code == 422


# ----- Persona-match strictness (Adjustment 1) ----------------------------------


def test_partial_first_name_tope_unmatched(client, mock_voice, squad_key):
    squad_key("sandbox_test_key")
    mock_voice(transcript="tope")

    r = client.post("/auth/voice-signup", **_multipart())
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "persona_unmatched"


def test_honorific_mama_alone_unmatched(client, mock_voice, squad_key):
    squad_key("sandbox_test_key")
    mock_voice(transcript="mama")

    r = client.post("/auth/voice-signup", **_multipart())
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "persona_unmatched"


def test_last_name_risikat_matches_mama(client, mock_voice, mock_squad, squad_key):
    squad_key("sandbox_test_key")
    mock_voice(transcript="risikat")
    mock_squad(va_number="0123456789")

    r = client.post("/auth/voice-signup", **_multipart())
    assert r.status_code == 200, r.text
    assert r.json()["data"]["matched_persona_id"] == "mama_risikat"


def test_full_name_with_filler_kosi(client, mock_voice, mock_squad, squad_key):
    squad_key("sandbox_test_key")
    mock_voice(transcript="i am kosi from lagos")
    mock_squad(va_number="0345678901")

    r = client.post("/auth/voice-signup", **_multipart())
    assert r.status_code == 200, r.text
    assert r.json()["data"]["matched_persona_id"] == "kosi"


def test_full_first_name_iya_tope(client, mock_voice, mock_squad, squad_key):
    squad_key("sandbox_test_key")
    mock_voice(transcript="my name is iya tope")
    mock_squad(va_number="0234567890")

    r = client.post("/auth/voice-signup", **_multipart())
    assert r.status_code == 200, r.text
    assert r.json()["data"]["matched_persona_id"] == "iya_tope"
