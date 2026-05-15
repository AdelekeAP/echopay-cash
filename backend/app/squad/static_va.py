"""Squad B2C Static VA creation.

POST /virtual-account — opens a permanent virtual account for a customer.
The response payload contains the GTBank account number we show the user.

Per PRD §9 we operate against the three hardcoded sandbox personas, not
arbitrary BVNs. If Squad has already minted a VA for a given
`customer_identifier`, the API returns a 4xx with "already exists" — we
treat that as success and accept the VA from the error body if available.
This is what makes voice-signup idempotent: re-running with the same
persona returns the same VA.
"""

from __future__ import annotations

from typing import Any

from .client import SquadClient, SquadError


class SquadStaticVAResult(dict):
    """Just a marker dict subclass for clarity at call sites."""

    @property
    def va_number(self) -> str:
        return self["va_number"]

    @property
    def customer_id(self) -> str | None:
        return self.get("customer_id")


async def create_static_va(
    client: SquadClient,
    customer_identifier: str,
    first_name: str,
    last_name: str,
    phone: str,
    email: str,
    bvn: str,
    dob: str,
    address: str = "Lagos, Nigeria",
    gender: str = "1",  # Squad encodes male=1, female=2
) -> SquadStaticVAResult:
    """Create (or return existing) Static VA for a customer.

    Returns a dict with at least `va_number`. The caller is responsible
    for wrapping errors into an HTTP envelope.
    """
    payload: dict[str, Any] = {
        "customer_identifier": customer_identifier,
        "first_name": first_name,
        "last_name": last_name,
        "mobile_num": phone,
        "email": email,
        "bvn": bvn,
        "dob": dob,
        "address": address,
        "gender": gender,
    }

    try:
        body = await client.post("/virtual-account", json=payload)
    except SquadError as e:
        # "Already exists" tolerance — Squad returns 4xx with a hint in
        # the message. We try to extract the existing VA number from the
        # error body. If we can't, surface the original error.
        existing = _try_extract_va_from_error(e)
        if existing:
            return SquadStaticVAResult({"va_number": existing, "customer_id": None})
        raise

    data = body.get("data") if isinstance(body, dict) else None
    va_number = _extract_va_number(data) if isinstance(data, dict) else None
    if not va_number:
        raise SquadError(
            "Squad response missing account number",
            status_code=200,
            body=body,
        )

    return SquadStaticVAResult(
        {
            "va_number": va_number,
            "customer_id": (data.get("customer_id") if isinstance(data, dict) else None),
        }
    )


def _extract_va_number(data: dict[str, Any]) -> str | None:
    # Squad has used several keys historically. Pick the first that's
    # present. PRD §4.2 references `virtual_account_number`.
    for key in ("virtual_account_number", "account_number", "va_number"):
        v = data.get(key)
        if isinstance(v, str) and v:
            return v
    return None


def _try_extract_va_from_error(e: SquadError) -> str | None:
    """When Squad says "already exists" some sandbox builds include the
    existing VA in the error body. Defensive parse."""
    body = e.body if isinstance(e.body, dict) else None
    if not body:
        return None
    data = body.get("data")
    if isinstance(data, dict):
        return _extract_va_number(data)
    return None
