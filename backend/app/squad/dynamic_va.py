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
import uuid
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
    # Squad sandbox requires a caller-supplied transaction_ref for DVA
    # initiate (rejects with `"transaction_ref" is required` otherwise).
    # Generate one upfront and pass it through; Squad echoes it back as
    # the reference. Prefix mirrors the synthetic-pool format in api/dva.py.
    transaction_ref = f"ECHOPAYCASH_{uuid.uuid4().hex[:12]}"

    # Squad sandbox's DVA initiate schema has shifted from the original
    # PRD §4.2. Current required set (probed via 4xx error messages):
    #   amount (string kobo), transaction_ref (caller-supplied),
    #   email (any well-formed address; sandbox doesn't validate).
    # Disallowed: merchant_business_name (was in original PRD; rejected
    # by sandbox as "not allowed"). `duration` is still accepted.
    payload: dict[str, Any] = {
        "amount": str(amount_kobo),
        "duration": duration_sec,
        "transaction_ref": transaction_ref,
        "email": "echopaycash@gmail.com",
    }
    # Keep merchant_business_name reachable via closure for future
    # restoration if Squad re-enables the field; reference it once so
    # linters don't flag the unused parameter.
    _ = merchant_business_name

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

    # Prefer the ref Squad echoes back; fall back to the one we sent if
    # sandbox omits it. Either way our local persistence + webhook
    # matching uses the same string.
    reference = _extract_reference(data) or transaction_ref
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
