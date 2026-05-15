"""Squad webhook HMAC-SHA512 signature verification.

PRD §4.3 + Squad canonical (API Summary deck slide 5 / docs.squadco.com
"Webhook Validation --version 3"). The signature is computed over 6
pipe-separated payload fields in this exact order:

    transaction_reference | virtual_account_number | currency |
    principal_amount | settled_amount | customer_identifier

V2/V3 is the canonical path. V1 (full-body hash) is kept as a defensive
fallback for sandbox variance — verified safe under constant-time compare.

This module is pure: no FastAPI, no DB, no I/O. Adapted from
`spike/squad_roundtrip.py:verify_hmac_v2` after the field-order +
field-name bugs in that file were corrected in PR feat/webhook-vertical.

Discipline:
- The caller MUST pass the raw request bytes — never re-parsed JSON.
  Re-serialization changes byte-for-byte content and breaks the hash.
- `hmac.compare_digest` is used for constant-time comparison to prevent
  timing attacks against the signature.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Literal

# What the caller gets back to surface which signature version matched.
SignatureVersion = Literal["v1", "v2"]


def verify_hmac_v2(
    raw_body: bytes,
    signature_hex: str,
    secret_key: str,
) -> tuple[bool, SignatureVersion | None, str]:
    """Verify a Squad webhook HMAC signature.

    Returns:
        (is_valid, matched_version, detail)
        - is_valid: True if either V2 or V1 hash matches in constant time
        - matched_version: 'v2' / 'v1' on match, None on no-match or no-key
        - detail: human-readable diagnostic for logs (includes computed
          hashes on failure for tunnel-debugging — never shown to the
          caller as an HTTP response)

    Args:
        raw_body: the request body bytes, EXACTLY as received off the
            wire. Must not be passed through `json.loads`/`json.dumps`.
        signature_hex: the hex-encoded HMAC from the header
            (`x-squad-encrypted-body` or `x-squad-signature`).
        secret_key: the Squad sandbox/production secret key.
    """
    if not secret_key:
        return False, None, "no_secret_key_configured"

    key = secret_key.encode("utf-8")

    # V1: hash the entire raw body
    computed_v1 = hmac.new(key, raw_body, hashlib.sha512).hexdigest()

    # V2/V3: hash 6 pipe-separated fields per Squad canonical order
    computed_v2 = ""
    try:
        payload = json.loads(raw_body)
        # Squad nests payload fields under "data" on some event types and
        # top-level on others. Try the data envelope first, fall back to
        # top-level.
        data = payload.get("data", payload) if isinstance(payload, dict) else {}
        fields = [
            str(data.get("transaction_reference", "")),
            str(data.get("virtual_account_number", "")),
            # Squad's canonical key is "currency"; legacy spike payloads
            # used "transaction_currency" — accept both, prefer canonical.
            str(data.get("currency", data.get("transaction_currency", "NGN"))),
            str(data.get("principal_amount", "")),
            str(data.get("settled_amount", "")),
            str(data.get("customer_identifier", data.get("customer_id", ""))),
        ]
        msg = "|".join(fields).encode("utf-8")
        computed_v2 = hmac.new(key, msg, hashlib.sha512).hexdigest()
    except (json.JSONDecodeError, AttributeError, TypeError) as e:
        # If the body isn't valid JSON, V2 is impossible. V1 may still
        # match (raw-body hash). Don't fail outright.
        computed_v2 = f"<v2 build failed: {type(e).__name__}>"

    sig = (signature_hex or "").lower().strip()
    if not sig:
        return False, None, "no_signature_header"

    # V2 is canonical — check it first.
    if hmac.compare_digest(sig, computed_v2):
        return True, "v2", f"V2 match ({computed_v2[:16]}…)"
    if hmac.compare_digest(sig, computed_v1):
        return True, "v1", f"V1 match ({computed_v1[:16]}…)"

    return (
        False,
        None,
        f"no_match sig={sig[:16]}… v1={computed_v1[:16]}… v2={computed_v2[:16] if not computed_v2.startswith('<') else computed_v2}",
    )
