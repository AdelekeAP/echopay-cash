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

import re
from datetime import datetime
from typing import Any

from .client import SquadClient, SquadError


def _normalize_phone_for_squad(phone: str) -> str:
    """Strip non-digits and normalize to 11-digit Nigerian local format.

    Squad's `mobile_num` validator requires exactly 11 or 13 digits. We
    normalize to 11-digit local (proven working via diagnostic curl —
    13-digit international is theoretically valid per the rule but
    untested, so we collapse to the proven path).

    Examples:
      "+234 801 234 5001" → "08012345001"
      "08012345001"       → "08012345001" (pass-through)
      "2348012345001"     → "08012345001" (strip 234 country code,
                                            add leading 0)
    """
    digits = re.sub(r"\D", "", phone)
    if len(digits) == 13 and digits.startswith("234"):
        digits = "0" + digits[3:]
    if len(digits) != 11:
        raise SquadError(
            f"Invalid phone format: {phone!r} normalized to {digits!r} "
            f"({len(digits)} digits, Squad needs 11 local)",
        )
    return digits


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
    gender: str = "1",  # "1" male, "2" female
    beneficiary_account: str = "4920299492",  # Squad sandbox-required despite docs saying optional
) -> SquadStaticVAResult:
    """Create (or return existing) Static VA for a customer.

    Returns a dict with at least `va_number`. The caller is responsible
    for wrapping errors into an HTTP envelope.

    Args:
        dob: ISO date string (yyyy-mm-dd). Squad's API requires mm/dd/yyyy;
            conversion happens here at the API boundary so callers keep the
            saner ISO format internally.
        beneficiary_account: 10-digit account. Squad's public docs claim
            this is optional for B2C, but sandbox enforces it. Default is
            "4920299492" — Squad's own canonical sample value from
            docs.squadco.com, accepted by sandbox without validating
            against a real GTBank registry.
    """
    # Translate ISO dob (yyyy-mm-dd) → Squad's required mm/dd/yyyy format.
    # Fail loudly with a SquadError on parse failure rather than send
    # garbage to Squad (which would return an opaque 4xx).
    try:
        dob_squad = datetime.strptime(dob, "%Y-%m-%d").strftime("%m/%d/%Y")
    except (ValueError, TypeError) as e:
        raise SquadError(
            f"Invalid dob format: expected yyyy-mm-dd, got {dob!r}: {e}",
        ) from e

    payload: dict[str, Any] = {
        "customer_identifier": customer_identifier,
        "first_name": first_name,
        "last_name": last_name,
        "mobile_num": _normalize_phone_for_squad(phone),
        "email": email,
        "bvn": bvn,
        "dob": dob_squad,
        "address": address,
        "gender": gender,
        "beneficiary_account": beneficiary_account,
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
