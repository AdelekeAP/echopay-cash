"""Squad sandbox HTTP client.

Single entry point for every Squad API call per EchoPay_Cash_PRD.md §4.
No `httpx.post(...)` outside this module — that's the discipline that
keeps the auth header, base URL, retry policy, and (eventually) HMAC
verification in one place.

This PR only needs the Static VA creation path (`/virtual-account`).
Dynamic VA, transfer, requery, and webhook flows land in later PRs and
will plug into the same client class.
"""

from __future__ import annotations

from typing import Any

import httpx

from ..core.config import get_settings


class SquadError(Exception):
    """Raised when a Squad call fails for any reason.

    The endpoint layer maps this to HTTP 503 with code `squad_failed`.
    """

    def __init__(self, message: str, status_code: int | None = None, body: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


class SquadAuthError(SquadError):
    """Raised on 401/403 from Squad. Indicates a bad sandbox key.

    Surfaced separately so the endpoint can log it loudly — this is a
    configuration error, not a transient failure.
    """


class SquadClient:
    """Thin async wrapper around Squad sandbox.

    Construct once at module level via `get_squad_client()`. Each call
    opens a fresh httpx.AsyncClient (no shared connection pool across
    requests for hackathon scope — keeps the surface small).
    """

    def __init__(self, base_url: str, secret_key: str, timeout: float = 10.0):
        self._base_url = base_url.rstrip("/")
        self._secret_key = secret_key
        self._timeout = timeout

    @property
    def configured(self) -> bool:
        """True iff a non-empty secret key was provided."""
        return bool(self._secret_key)

    async def post(self, path: str, json: dict[str, Any]) -> dict[str, Any]:
        if not self.configured:
            raise SquadError("Squad secret key not configured")

        url = f"{self._base_url}{path}"
        headers = {
            "Authorization": f"Bearer {self._secret_key}",
            "Content-Type": "application/json",
        }

        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(url, json=json, headers=headers)
        except httpx.HTTPError as e:
            raise SquadError(f"Squad request failed: {type(e).__name__}") from e

        if resp.status_code in (401, 403):
            raise SquadAuthError(
                f"Squad auth rejected ({resp.status_code})",
                status_code=resp.status_code,
                body=_safe_json(resp),
            )

        if resp.status_code >= 500:
            raise SquadError(
                f"Squad server error {resp.status_code}",
                status_code=resp.status_code,
                body=_safe_json(resp),
            )

        body = _safe_json(resp)
        # Squad sandbox uses `success` boolean in the envelope; surface
        # the message on failure so the endpoint can include it.
        if resp.status_code >= 400 or body.get("success") is False:
            raise SquadError(
                body.get("message") or f"Squad rejected request ({resp.status_code})",
                status_code=resp.status_code,
                body=body,
            )

        return body


def _safe_json(resp: httpx.Response) -> dict[str, Any]:
    try:
        data = resp.json()
        return data if isinstance(data, dict) else {"_raw": data}
    except Exception:
        return {"_raw_text": resp.text}


# Module-level singleton — built lazily from settings.
_client_cache: SquadClient | None = None


def get_squad_client() -> SquadClient:
    global _client_cache
    if _client_cache is None:
        s = get_settings()
        _client_cache = SquadClient(
            base_url=s.squad_base_url,
            secret_key=s.squad_secret_key,
        )
    return _client_cache


def reset_squad_client() -> None:
    """Test-only — clears the cached client so settings reloads pick up env changes."""
    global _client_cache
    _client_cache = None
