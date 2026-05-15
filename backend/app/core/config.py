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
        "http://localhost:8081,http://localhost:5173,http://localhost:19006"
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

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
