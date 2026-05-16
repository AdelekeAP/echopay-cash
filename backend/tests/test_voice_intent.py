"""Tests for POST /voice/intent.

Mirrors test_auth_voice_signup.py patterns: per-test SQLite via the
`client` fixture, monkeypatch to avoid live Whisper/OpenAI calls.

Coverage (6 tests):
  1. Demo mode → hardcoded transfer intent (iya_tope, ₦5,000)
  2. Balance fast-path ("what is my balance") → action=balance
  3. Transfer fast-path iya_tope ("send five thousand to iya tope") → transfer_local
  4. Transfer fast-path kosi ("send 200 naira to kosi") → transfer_local, kosi, 20_000
  5. Unknown transcript ("hello there") → HTTP 200, action=unknown
  6. Whisper unavailable → 503 voice_unavailable
"""

from __future__ import annotations

import io
import sys

import pytest


# ----------------------------------------------------------------- fixtures


@pytest.fixture(autouse=True)
def _reset_module_caches(client):  # noqa: ARG001
    """Drop module-level caches that survive between tests."""
    yield
    for mod_name in (
        "app.api.voice_intent",
        "app.services.intent_parser",
        "app.voice.proxy",
        "app.voice.persona_match",
    ):
        sys.modules.pop(mod_name, None)
    try:
        from app.core import config as config_module
        config_module.get_settings.cache_clear()
    except (ImportError, AttributeError):
        pass


@pytest.fixture
def mock_transcribe(monkeypatch):
    """Return a setter that replaces `transcribe` in the voice_intent module."""

    def _install(transcript: str | None = None, raise_unavailable: bool = False):
        from app.api import voice_intent as vi_module
        from app.voice import proxy as voice_proxy

        async def fake_transcribe(audio_bytes: bytes, filename: str = "audio.m4a"):
            if raise_unavailable:
                raise voice_proxy.VoiceUnavailableError("mocked unavailable")
            return transcript or ""

        monkeypatch.setattr(vi_module, "transcribe", fake_transcribe)

    return _install


@pytest.fixture
def mock_parse_intent(monkeypatch):
    """Replace parse_intent so the test controls the returned IntentResult."""

    def _install(intent: str, action: str, entities: dict | None = None):
        from app.api import voice_intent as vi_module
        from app.services.intent_parser import IntentResult

        async def fake_parse_intent(transcript: str) -> IntentResult:
            return IntentResult(intent=intent, action=action, entities=entities or {})

        monkeypatch.setattr(vi_module, "parse_intent", fake_parse_intent)

    return _install


@pytest.fixture
def demo_mode(monkeypatch):
    """Enable VOICE_DEMO_MODE=true for the duration of the test."""
    monkeypatch.setenv("VOICE_DEMO_MODE", "true")
    from app.core import config as config_module
    config_module.get_settings.cache_clear()


# ----------------------------------------------------------------- helpers


def _audio_payload() -> dict:
    return {
        "files": {"audio": ("audio.m4a", io.BytesIO(b"fake-audio"), "audio/m4a")},
    }


# ----------------------------------------------------------------- tests


def test_demo_mode_returns_transfer_intent(client, demo_mode):
    """VOICE_DEMO_MODE=true → hardcoded transcript resolves to iya_tope transfer."""
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "transfer"
    assert data["action"] == "transfer_local"
    assert data["entities"]["recipientId"] == "iya_tope"
    assert data["entities"]["amountKobo"] == 500_000
    assert data["transcript"] == "send five thousand to iya tope"


def test_fast_path_balance_intent(client, mock_transcribe):
    """Transcript containing 'balance' → balance intent, no LLM call."""
    mock_transcribe(transcript="what is my balance")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "balance"
    assert data["action"] == "balance"


def test_fast_path_transfer_iya_tope(client, mock_transcribe):
    """Transcript 'send five thousand to iya tope' → transfer to iya_tope, ₦5,000."""
    mock_transcribe(transcript="send five thousand to iya tope")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "transfer"
    assert data["action"] == "transfer_local"
    assert data["entities"]["recipientId"] == "iya_tope"
    assert data["entities"]["amountKobo"] == 500_000


def test_fast_path_transfer_kosi(client, mock_transcribe):
    """Transcript 'send 200 naira to kosi' → transfer to kosi, ₦200 (20,000 kobo)."""
    mock_transcribe(transcript="send 200 naira to kosi")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "transfer"
    assert data["action"] == "transfer_local"
    assert data["entities"]["recipientId"] == "kosi"
    assert data["entities"]["amountKobo"] == 20_000


def test_unknown_intent_returns_200(client, mock_transcribe):
    """Unclassifiable transcript → HTTP 200 with action='unknown', not 4xx."""
    mock_transcribe(transcript="hello there how are you")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "unknown"
    assert data["action"] == "unknown"


def test_whisper_unavailable_503(client, mock_transcribe):
    """VoiceUnavailableError propagates as 503."""
    mock_transcribe(raise_unavailable=True)
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "VOICE_UNAVAILABLE"


# ----------------------------------------------------------------- qr_generate tests
# PRD §1 Script A 2:00 beat — "Generate ₦200 QR for okra."


def test_qr_generate_basic(client, mock_transcribe):
    """'generate 200 QR' → qr_generate intent, amountKobo=20_000."""
    mock_transcribe(transcript="generate 200 QR")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "qr_generate"
    assert data["action"] == "qr_generate"
    assert data["entities"]["amountKobo"] == 20_000


def test_qr_generate_naira_word(client, mock_transcribe):
    """'create a QR for two hundred naira' → qr_generate, 20_000 kobo."""
    mock_transcribe(transcript="create a QR for two hundred naira")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "qr_generate"
    assert data["entities"]["amountKobo"] == 20_000


def test_qr_generate_comma_amount(client, mock_transcribe):
    """'make a QR for 10,000' → qr_generate, 1_000_000 kobo."""
    mock_transcribe(transcript="make a QR for 10,000")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "qr_generate"
    assert data["entities"]["amountKobo"] == 1_000_000


def test_qr_generate_no_false_positive_on_transfer(client, mock_transcribe):
    """'send 5000 to iya tope' must STAY a transfer (no QR keyword present)."""
    mock_transcribe(transcript="send 5000 to iya tope")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "transfer"
    assert data["action"] == "transfer_local"
    assert data["entities"]["recipientId"] == "iya_tope"


def test_qr_generate_no_amount(client, mock_transcribe):
    """'generate a QR please' → qr_generate intent, NO amountKobo (mobile prompts)."""
    mock_transcribe(transcript="generate a QR please")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "qr_generate"
    assert data["action"] == "qr_generate"
    assert "amountKobo" not in data["entities"]


# ----------------------------------------------------------------- Pidgin tests
#
# PRD Challenge 02 "language" rubric dimension. Nigerian Pidgin is the
# lingua franca of informal commerce — the target persona for EchoPay
# Cash. These tests assert that Pidgin commands route to the same
# intents as their English equivalents through three layers:
# preprocessing → regex → LLM (the LLM is mocked at the unit level;
# tests here exercise the fast-path layers only).


# ---- Preprocessing (5 tests) -----------------------------------------------


def test_pidgin_preprocess_strips_abeg_prefix(client, mock_transcribe):
    """'abeg send 5000 to iya tope' → 'abeg' stripped → transfer."""
    mock_transcribe(transcript="abeg send 5000 to iya tope")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "transfer"
    assert data["entities"]["recipientId"] == "iya_tope"
    assert data["entities"]["amountKobo"] == 500_000


def test_pidgin_preprocess_k_suffix_digit(client, mock_transcribe):
    """'send 5K to iya tope' → preprocess normalizes 5K → 5000 → transfer."""
    mock_transcribe(transcript="send 5K to iya tope")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "transfer"
    assert data["entities"]["recipientId"] == "iya_tope"
    assert data["entities"]["amountKobo"] == 500_000


def test_pidgin_preprocess_k_suffix_word(client, mock_transcribe):
    """'send five K to iya tope' → spoken K resolves via _MULTIPLIERS."""
    mock_transcribe(transcript="send five K to iya tope")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "transfer"
    assert data["entities"]["amountKobo"] == 500_000


def test_pidgin_preprocess_smart_quotes_normalized(client, mock_transcribe):
    """Curly apostrophes from Whisper don't break recognition."""
    # Note: smart-quote normalization runs in preprocessing.
    mock_transcribe(transcript="abeg, send ’5000’ to iya tope")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "transfer"
    assert data["entities"]["amountKobo"] == 500_000


def test_pidgin_preprocess_period_intrusion_fixed(client, mock_transcribe):
    """'how much I.dey hold' → period intrusion fixed → balance fast-path."""
    mock_transcribe(transcript="how much I.dey hold")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "balance"
    assert data["action"] == "balance"


# ---- Transfer Pidgin (5 tests) ---------------------------------------------


def test_pidgin_transfer_give_preposition(client, mock_transcribe):
    """'send five thousand give iya tope' — classic Pidgin give-prep."""
    mock_transcribe(transcript="send five thousand give iya tope")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "transfer"
    assert data["action"] == "transfer_local"
    assert data["entities"]["recipientId"] == "iya_tope"
    assert data["entities"]["amountKobo"] == 500_000


def test_pidgin_transfer_make_i(client, mock_transcribe):
    """'make I send five thousand to iya tope' — make-I intent marker."""
    mock_transcribe(transcript="make I send five thousand to iya tope")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "transfer"
    assert data["entities"]["recipientId"] == "iya_tope"
    assert data["entities"]["amountKobo"] == 500_000


def test_pidgin_transfer_abeg_prefix(client, mock_transcribe):
    """'abeg pay iya tope ten thousand' — politeness + pay-verb variant."""
    mock_transcribe(transcript="abeg pay iya tope ten thousand")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "transfer"
    assert data["entities"]["recipientId"] == "iya_tope"
    assert data["entities"]["amountKobo"] == 1_000_000


def test_pidgin_transfer_k_suffix(client, mock_transcribe):
    """'send 5K give iya tope' — full Pidgin: K-suffix + give-prep."""
    mock_transcribe(transcript="send 5K give iya tope")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "transfer"
    assert data["entities"]["recipientId"] == "iya_tope"
    assert data["entities"]["amountKobo"] == 500_000


def test_pidgin_transfer_inverted_order(client, mock_transcribe):
    """'send iya tope five thousand naira' — recipient before amount."""
    mock_transcribe(transcript="send iya tope five thousand naira")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "transfer"
    assert data["entities"]["recipientId"] == "iya_tope"
    assert data["entities"]["amountKobo"] == 500_000


# ---- QR generate Pidgin (3 tests) ------------------------------------------


def test_pidgin_qr_make_imperative(client, mock_transcribe):
    """'make 200 qr' — make-imperative (existing regex hits this)."""
    mock_transcribe(transcript="make 200 qr")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "qr_generate"
    assert data["entities"]["amountKobo"] == 20_000


def test_pidgin_qr_set_verb(client, mock_transcribe):
    """'set 500 qr' — set as alternate Pidgin verb (added in Chunk 3)."""
    mock_transcribe(transcript="set 500 qr")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "qr_generate"
    assert data["entities"]["amountKobo"] == 50_000


def test_pidgin_qr_postpositional(client, mock_transcribe):
    """'qr for two hundred naira' — QR-first postpositional construction."""
    mock_transcribe(transcript="qr for two hundred naira")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "qr_generate"
    assert data["entities"]["amountKobo"] == 20_000


# ---- Balance Pidgin (3 tests) ----------------------------------------------


def test_pidgin_balance_how_much_i_get(client, mock_transcribe):
    """'how much I get' — most common Pidgin balance form."""
    mock_transcribe(transcript="how much I get")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "balance"
    assert data["action"] == "balance"


def test_pidgin_balance_dey_construction(client, mock_transcribe):
    """'how much dey my account' — dey-construction."""
    mock_transcribe(transcript="how much dey my account")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "balance"


def test_pidgin_balance_wetin_remain(client, mock_transcribe):
    """'wetin remain for my account' — wetin-construction."""
    mock_transcribe(transcript="wetin remain for my account")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "balance"


# ---- Cancel Pidgin (2 tests) -----------------------------------------------


def test_pidgin_cancel_no_mind(client, mock_transcribe):
    """'no mind' — most common Pidgin cancel."""
    mock_transcribe(transcript="no mind")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "cancel"
    assert data["action"] == "cancel"


def test_pidgin_cancel_leave_am(client, mock_transcribe):
    """'leave am' — am-pronoun cancel variant."""
    mock_transcribe(transcript="leave am")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "cancel"


# ---- Regression guard (1 test) ---------------------------------------------


def test_pidgin_no_false_positive_on_pure_english(client, mock_transcribe):
    """REGRESSION: pure English transfer must still classify cleanly.

    Pidgin preprocessing/regex must not corrupt the English path. This
    test re-runs the canonical transfer phrasing AFTER all Pidgin
    additions to verify no priority-ordering regression.
    """
    mock_transcribe(transcript="send 5000 to iya tope")
    resp = client.post("/voice/intent", **_audio_payload())
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["intent"] == "transfer"
    assert data["action"] == "transfer_local"
    assert data["entities"]["recipientId"] == "iya_tope"
    assert data["entities"]["amountKobo"] == 500_000
