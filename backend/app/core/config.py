"""Centralized config. Pydantic-settings reads from .env on import.

If a value is missing in the env, the field default applies. Required
fields without defaults raise on import — fail fast.
"""

from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    database_url: str = "sqlite:///./echopay.db"
    cors_origins: str = (
        "http://localhost:8081,http://localhost:5173,http://localhost:19006,"
        "http://127.0.0.1:5173,http://127.0.0.1:8081"
    )

    voice_base_url: str = "http://localhost:8000"
    shared_internal_secret: str = "change-me"

    # Squad — Leke fills via feat/backend-squad. Keep here so the import
    # graph is stable and seed.py can detect "sandbox available" vs not.
    squad_base_url: str = "https://sandbox-api-d.squadco.com"
    squad_secret_key: str = ""
    squad_merchant_id: str = "ECHOPAYCASH"

    mono_secret_key: str = ""

    # OpenAI Whisper — used by app.voice.proxy for /auth/voice-signup
    # transcription. Empty key → endpoint returns 503 voice_unavailable.
    openai_api_key: str = ""

    # Demo-day insurance — when true, app.voice.proxy.transcribe skips
    # the Whisper call entirely and returns "mama risikat". Pair with
    # squad_secret_key="" to fully bypass external services and run the
    # signup flow off seed.py data alone.
    voice_demo_mode: bool = False

    # Path C demo-mode for voice biometric proxy (app/api/voice_proxy.py).
    # When true, /api/v1/voice/biometrics/* endpoints return synthetic
    # success responses without calling the :8000 voice service. Maps to
    # PRD §11.5 "pre-record fallback" risk mitigation. Default True for
    # demo-day safety; flip to False after :8000 reachability is verified
    # at dress rehearsal.
    voice_biometric_demo_mode: bool = True
    voice_biometric_service_url: str = "http://localhost:8000"
    voice_biometric_timeout_seconds: int = 10

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
