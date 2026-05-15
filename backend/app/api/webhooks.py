"""POST /webhooks/squad — Squad inbound payment settlement.

PRD §1 Script A 2:00 demo beat (second half): customer pays the DVA
Mama generated → Squad fires this webhook → backend validates HMAC →
balance updates live on stage.

Non-negotiable invariants (PRD §4.3 + CLAUDE.md):
  1. Read raw body bytes BEFORE any json.loads — HMAC is computed over
     the wire bytes, never over a re-serialized JSON.
  2. webhook_events.transaction_ref UNIQUE — replay returns 200
     immediately (IntegrityError on INSERT → swallow + 200).
  3. Wallet update + Transaction update + WebhookEvent insert inside
     ONE SQLite BEGIN IMMEDIATE (engine emits it via the `begin`
     listener in core/db.py).
  4. ALWAYS return HTTP 200, even on signature failure. Squad retries
     on non-2xx, and a 4xx leaks validation state to an attacker. Log +
     alert internally instead.

Branch summary:
  - Invalid HMAC          → log warning, 200, NO DB writes
  - Missing required fields → log warning, 200, NO DB writes
  - Replay (UNIQUE hit)   → log info, 200, no second credit
  - Unknown squad_ref     → log warning, 200, NO DB writes
  - Mismatch amount       → WebhookEvent(mismatch=1, signature_valid=1),
                            Transaction.status='reversed', NO credit, 200
  - Happy path            → WebhookEvent(mismatch=0, signature_valid=1),
                            Transaction.status='completed',
                            Wallet.balance_kobo += settled_amount_kobo,
                            all inside one with db.begin(): block, 200
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core.config import get_settings
from ..core.db import get_db
from ..models import Transaction, Wallet, WebhookEvent, now_unix
from ..squad.signature import verify_hmac_v2

router = APIRouter(prefix="/webhooks", tags=["webhooks"])
logger = logging.getLogger("echopay.webhooks.squad")


# ----------------------------------------------------------------- helpers


def _ok(reference: str, description: str = "Success") -> JSONResponse:
    """Always-200 response shaped per Squad's expected envelope."""
    return JSONResponse(
        status_code=200,
        content={
            "response_code": "00",
            "transaction_reference": reference,
            "response_description": description,
        },
    )


def _extract_data_envelope(body: dict[str, Any]) -> dict[str, Any]:
    """Squad nests fields under `data` on some events, top-level on others."""
    data = body.get("data") if isinstance(body.get("data"), dict) else None
    return data or body


def _parse_amount_to_kobo(naira_str: str) -> Optional[int]:
    """Convert Squad's naira-string `settled_amount` ('200.00') to kobo int."""
    if not naira_str:
        return None
    try:
        return int(round(float(naira_str) * 100))
    except (TypeError, ValueError):
        return None


def _find_pending_qr_tx(
    db: Session, reference: str
) -> Optional[Transaction]:
    """Look up a pending qr_receive Transaction by Squad reference.

    Transaction.squad_ref is packed as `<dva_number>|<reference>` by
    api/dva.py (PR #14 idempotency design). The webhook payload only
    carries the reference part, so we match two shapes:
    1. squad_ref == reference (legacy unpacked rows, if any)
    2. squad_ref LIKE '%|<reference>' (current packed shape from PR #14)

    Wraps the read in its own `with db.begin():` short snapshot so it
    doesn't leave a half-open auto-begun session txn that would later
    collide with the write-path `with db.begin():` block (same pattern
    as auth.py:_snapshot_existing_user and dva.py).
    """
    with db.begin():
        row = db.scalar(
            select(Transaction).where(
                (Transaction.squad_ref == reference)
                | (Transaction.squad_ref.like(f"%|{reference}"))
            )
        )
        if row is None:
            return None
        # Materialise attrs so they survive past the session close.
        _ = (row.id, row.user_id, row.amount_kobo, row.status, row.squad_ref, row.created_at)
        return row


# ----------------------------------------------------------------- handler


@router.post("/squad")
async def squad_webhook(
    request: Request,
    db: Session = Depends(get_db),
    x_squad_encrypted_body: Optional[str] = Header(default=None, alias="x-squad-encrypted-body"),
    x_squad_signature: Optional[str] = Header(default=None, alias="x-squad-signature"),
) -> JSONResponse:
    settings = get_settings()
    secret_key = settings.squad_secret_key

    # 1. Raw bytes BEFORE any json.loads — required for HMAC integrity.
    raw_body = await request.body()

    # 2. Validate HMAC. Accept either Squad header variant. Constant-time
    #    compare inside verify_hmac_v2.
    signature_hex = x_squad_encrypted_body or x_squad_signature or ""
    is_valid, matched_version, detail = verify_hmac_v2(
        raw_body, signature_hex, secret_key
    )

    if not is_valid:
        # Per PRD §4.3 rule 4 + CLAUDE.md invariant: NEVER 4xx. Log,
        # alert (logger.warning bubbles to anything that's tailing).
        # Do NOT persist a WebhookEvent — we don't want the UNIQUE PK
        # taken by an attacker's spoofed reference, which would prevent
        # legitimate retries from being processed.
        logger.warning("squad_webhook invalid_signature %s", detail)
        return _ok("", description="Invalid signature")

    # 3. Parse JSON. We've already validated the bytes — any parse error
    #    past this point is a logic bug or Squad sending malformed JSON.
    try:
        body = json.loads(raw_body)
    except json.JSONDecodeError as e:
        logger.warning("squad_webhook json_decode_failed %s", e)
        return _ok("", description="Malformed JSON")

    if not isinstance(body, dict):
        logger.warning("squad_webhook non_object_payload type=%s", type(body).__name__)
        return _ok("", description="Malformed payload")

    data = _extract_data_envelope(body)

    transaction_reference = str(data.get("transaction_reference", "")).strip()
    settled_amount_str = str(data.get("settled_amount", "")).strip()
    if not transaction_reference or not settled_amount_str:
        logger.warning(
            "squad_webhook missing_required_fields ref=%r amt=%r",
            transaction_reference,
            settled_amount_str,
        )
        return _ok(transaction_reference, description="Missing required fields")

    settled_amount_kobo = _parse_amount_to_kobo(settled_amount_str)
    if settled_amount_kobo is None or settled_amount_kobo <= 0:
        logger.warning(
            "squad_webhook invalid_amount ref=%s amt=%r",
            transaction_reference,
            settled_amount_str,
        )
        return _ok(transaction_reference, description="Invalid amount")

    raw_payload_str = raw_body.decode("utf-8", errors="replace")[:8000]

    # 4. Lookup pending Transaction (outside the txn — pure read).
    pending_tx = _find_pending_qr_tx(db, transaction_reference)

    if pending_tx is None:
        # Unknown reference. Don't persist a WebhookEvent (same
        # reasoning as invalid_signature path — PK squat risk).
        logger.warning("squad_webhook unknown_ref %s", transaction_reference)
        return _ok(transaction_reference, description="Unknown reference")

    expected_kobo = pending_tx.amount_kobo
    is_mismatch = settled_amount_kobo != expected_kobo

    # 5. Atomic write: WebhookEvent insert + (if happy path) wallet
    #    credit + tx status update, all inside one with db.begin().
    try:
        with db.begin():
            db.add(
                WebhookEvent(
                    transaction_ref=transaction_reference,
                    source="static_va",
                    raw_payload=raw_payload_str,
                    signature_valid=1,
                    mismatch=1 if is_mismatch else 0,
                    signature_version_matched=matched_version,
                    processed_at=now_unix(),
                )
            )
            db.flush()  # surface IntegrityError now, inside the txn

            # Re-fetch tx with row lock semantics (SQLite reserved
            # lock + BEGIN IMMEDIATE — already held by the engine begin
            # event listener). Reading inside the txn ensures we see
            # any concurrent webhook's commit.
            tx = db.get(Transaction, pending_tx.id)
            if tx is None:
                logger.warning(
                    "squad_webhook race_lost ref=%s tx_disappeared",
                    transaction_reference,
                )
                # WebhookEvent will still commit so we don't lose the
                # signal. Return 200.
                return _ok(transaction_reference, description="Tx disappeared")

            if is_mismatch:
                # Mismatch policy per PRD §4.3 Dynamic VA:
                # "wrong amount → Squad auto-refunds, log only".
                # We mark 'reversed' since the status enum doesn't
                # have 'mismatched' and the money effectively flows
                # back to the payer.
                tx.status = "reversed"
                tx.settled_at = now_unix()
                # No wallet credit.
            else:
                # Happy path — atomic credit.
                wallet = db.get(Wallet, tx.user_id)
                if wallet is None:
                    logger.error(
                        "squad_webhook wallet_missing user_id=%s tx=%s",
                        tx.user_id,
                        tx.id,
                    )
                    return _ok(transaction_reference, description="Wallet missing")
                wallet.balance_kobo += settled_amount_kobo
                wallet.version += 1
                wallet.updated_at = now_unix()
                tx.status = "completed"
                tx.settled_at = now_unix()
    except IntegrityError:
        # UNIQUE collision on WebhookEvent.transaction_ref — this is
        # a replay. PRD §4.3 rule 2: return 200 immediately, no second
        # credit. The original processing already settled (or
        # mismatched) the tx.
        db.rollback()
        logger.info("squad_webhook replay_idempotent ref=%s", transaction_reference)
        return _ok(transaction_reference, description="Replay (already processed)")

    description = "Mismatch (amount differs from expected)" if is_mismatch else "Success"
    logger.info(
        "squad_webhook ok ref=%s version=%s mismatch=%s amount_kobo=%s",
        transaction_reference,
        matched_version,
        is_mismatch,
        settled_amount_kobo,
    )
    return _ok(transaction_reference, description=description)
