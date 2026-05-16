"""Voice transcription — OpenAI Whisper, called inline (no :8000 hop).

Decision: the original PRD §3 ARCHITECTURE diagram pictured an external
voice service on :8000 (legacy EchoPay v1 stack: Whisper + Gemini intent
+ biometrics). For voice-signup specifically we only need speech-to-text.
Calling Whisper directly removes an out-of-scope dependency chain
(Gemini imports, biometrics service) and is one less network hop on
demo day.

Demo-day controls:
- VOICE_DEMO_MODE=true → skip Whisper entirely, return "mama risikat".
  Use when the laptop is offline or the OpenAI key isn't loaded.
- OPENAI_API_KEY="" → raise VoiceUnavailableError. The endpoint maps
  this to 503 `voice_unavailable` so the mobile UI can offer the
  persona picker fallback.

Mocking in tests: monkeypatch `transcribe` at module level (see
test_auth_voice_signup.py). We do NOT mock the OpenAI SDK itself —
that's brittle across SDK versions.
"""

from __future__ import annotations

from openai import AsyncOpenAI

from ..core.config import get_settings


class VoiceUnavailableError(Exception):
    """Raised when Whisper can't be reached. Endpoint maps to 503."""


class TranscriptionEmptyError(Exception):
    """Raised when Whisper returns an empty transcript. Endpoint maps to 400."""


# Module-level lazy singleton so we build the client once per process,
# not once per request. Reset via `reset_openai_client()` in tests.
_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        key = get_settings().openai_api_key
        if not key:
            raise VoiceUnavailableError("OPENAI_API_KEY not configured")
        _client = AsyncOpenAI(api_key=key)
    return _client


def reset_openai_client() -> None:
    """Test-only — drop the cached client so a settings change picks up."""
    global _client
    _client = None


async def transcribe(audio_bytes: bytes, filename: str = "audio.m4a") -> str:
    """Transcribe an audio blob via OpenAI Whisper.

    Raises VoiceUnavailableError if the key is missing or the API call
    fails for any reason. Raises TranscriptionEmptyError if Whisper
    returns whitespace-only text.

    `language="en"` because our persona names romanize cleanly AND
    forced English mode handles Nigerian Pidgin more reliably than
    auto-detect (which sometimes mis-classifies Pidgin as Yoruba or
    Igbo and produces garbled romanisation).

    `prompt` biases the decoder toward two domains: (1) the three
    persona names — keeps voice-signup match rate high; (2) Nigerian
    Pidgin payment vocabulary — materially improves transcription of
    "abeg", "comot", "wetin", "dey", and the K-suffix amount form
    ("5K") which standard Whisper sometimes hears as "five kay" or
    drops the K entirely. Token budget is well under Whisper's 224.
    """
    settings = get_settings()

    # Demo-day bypass — useful when the laptop is offline or the OpenAI
    # key isn't loaded. Always returns the most common persona so the
    # demo never dead-ends.
    if settings.voice_demo_mode:
        return "mama risikat"

    if not audio_bytes:
        raise TranscriptionEmptyError("No audio bytes received")

    try:
        client = _get_client()
        response = await client.audio.transcriptions.create(
            file=(filename, audio_bytes, "audio/m4a"),
            model="whisper-1",
            language="en",
            temperature=0,
            prompt=(
                "Nigerian Pidgin English to a payment app. Personas: "
                "Mama Risikat, Iya Tope, Kosi. Common words: abeg, "
                "wetin, dey, sabi, comot, make I, give, send, transfer, "
                "pay, balance, naira, kobo, QR, K, account, money."
            ),
            response_format="json",
        )
    except VoiceUnavailableError:
        raise  # propagate missing-key
    except Exception as e:  # noqa: BLE001 — Whisper SDK exceptions vary across versions
        # Don't leak OpenAI SDK exception types or stack traces in the
        # HTTP response.
        raise VoiceUnavailableError(f"Whisper call failed: {type(e).__name__}")

    text = getattr(response, "text", None) or ""
    transcript = text.strip()
    if not transcript:
        raise TranscriptionEmptyError("Whisper returned empty transcript")

    return transcript
