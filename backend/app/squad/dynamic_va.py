"""Squad Dynamic VA — per-QR initiate.

PRD §4.2:
  POST /virtual-account/initiate-dynamic-virtual-account
  Body: { amount, duration, merchant_business_name }

A Dynamic VA is single-use: one expected payment of a specific amount
within a time window. After it expires (or is paid), the underlying VA
returns to Squad's pool. For the hackathon scope we call `initiate`
directly per QR; Squad sandbox handles the pool internally. If sandbox
demands explicit pool-creation (POST /virtual-account/create-dynamic-
virtual-account), we add that on top in a follow-up.

Returns a `DynamicVAResult` dict with at least `va_number`. The endpoint
layer wraps errors into HTTP 503 squad_failed.
"""

from __future__ import annotations

import time
from typing import Any

from .client import SquadClient, SquadError


class DynamicVAResult(dict):
    """Marker dict subclass for clarity at call sites."""

    @property
    def va_number(self) -> str:
        return self["va_number"]

    @property
    def reference(self) -> str | None:
        return self.get("reference")

    @property
    def expires_at(self) -> int | None:
        return self.get("expires_at")


async def create_dynamic_va(
    client: SquadClient,
    amount_kobo: int,
    duration_sec: int,
    merchant_business_name: str,
) -> DynamicVAResult:
    """Initiate a per-QR Dynamic VA.

    Args:
        amount_kobo: positive integer kobo
        duration_sec: TTL in seconds; Squad expects this as the lifetime
            of the DVA before it auto-expires.
        merchant_business_name: display name shown to payer in their
            bank app. We pass the persona's display name.

    Raises:
        SquadError on transport / 4xx / 5xx failure (handled at endpoint).
    """
    payload: dict[str, Any] = {
        # PRD §4.2 says `amount` (kobo string) for transfer endpoints;
        # for DVA initiate the body fields are amount/duration/business
        # name. Pass amount as a string since other Squad endpoints
        # standardize on string-kobo — defensive against type coercion.
        "amount": str(amount_kobo),
        "duration": duration_sec,
        "merchant_business_name": merchant_business_name,
    }

    body = await client.post(
        "/virtual-account/initiate-dynamic-virtual-account",
        json=payload,
    )

    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        raise SquadError(
            "Squad response missing data envelope",
            status_code=200,
            body=body,
        )

    va_number = _extract_va_number(data)
    if not va_number:
        raise SquadError(
            "Squad DVA response missing account number",
            status_code=200,
            body=body,
        )

    reference = _extract_reference(data)
    expires_at = _extract_expires_at(data, duration_sec)

    return DynamicVAResult(
        {
            "va_number": va_number,
            "reference": reference,
            "expires_at": expires_at,
        }
    )


def _extract_va_number(data: dict[str, Any]) -> str | None:
    # Squad has used several key names for the VA number across its
    # historical sandbox builds. Try the documented one first, then
    # fall back. Mirrors static_va.py's defensive parse.
    for key in (
        "virtual_account_number",
        "account_number",
        "va_number",
        "dva_number",
    ):
        v = data.get(key)
        if isinstance(v, str) and v:
            return v
    return None


def _extract_reference(data: dict[str, Any]) -> str | None:
    for key in ("merchant_business_reference", "reference", "transaction_ref"):
        v = data.get(key)
        if isinstance(v, str) and v:
            return v
    return None


def _extract_expires_at(data: dict[str, Any], duration_sec: int) -> int:
    """Returns unix expiry. Falls back to `now + duration` if Squad
    doesn't return an explicit field — sandbox often omits it."""
    for key in ("expires_at_unix", "expires_at"):
        v = data.get(key)
        if isinstance(v, int):
            return v
        if isinstance(v, str):
            try:
                return int(v)
            except ValueError:
                continue
    return int(time.time()) + max(0, duration_sec)
