"""
Squad sandbox roundtrip spike.

Single file. Throwaway after Fri 19:00 once we have proof.

Subcommands:
  python squad_roundtrip.py listen              # webhook listener on :9000
  python squad_roundtrip.py create-va           # create a B2C Static VA for mama_risikat
  python squad_roundtrip.py simulate --va N --amount-kobo K
  python squad_roundtrip.py lookup --account N --bank-code C
  python squad_roundtrip.py transfer --to N --bank-code C --amount-kobo K
  python squad_roundtrip.py requery --ref REF

Reads env from .env in the same directory:
  SQUAD_BASE_URL=https://sandbox-api-d.squadco.com
  SQUAD_SECRET_KEY=...
  SQUAD_MERCHANT_ID=...        (used as transaction_reference prefix)

Note: HMAC verification reads the raw request body bytes — never re-parse.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

SQUAD_BASE_URL = os.environ.get("SQUAD_BASE_URL", "https://sandbox-api-d.squadco.com").rstrip("/")
SQUAD_SECRET_KEY = os.environ.get("SQUAD_SECRET_KEY", "")
SQUAD_MERCHANT_ID = os.environ.get("SQUAD_MERCHANT_ID", "ECHOPAYCASH")
PROOF_DIR = ROOT / "proof"
PROOF_DIR.mkdir(exist_ok=True)


def _log(label: str, payload):
    ts = datetime.now(timezone.utc).isoformat()
    if isinstance(payload, (dict, list)):
        body = json.dumps(payload, indent=2, default=str)
    else:
        body = str(payload)
    print(f"\n[{ts}] {label}\n{body}\n", flush=True)


def _headers() -> dict:
    if not SQUAD_SECRET_KEY:
        print("ERROR: SQUAD_SECRET_KEY not set in .env", file=sys.stderr)
        sys.exit(2)
    return {
        "Authorization": f"Bearer {SQUAD_SECRET_KEY}",
        "Content-Type": "application/json",
    }


# ----------------------------------------------------------------------------
# Webhook listener
# ----------------------------------------------------------------------------

app = FastAPI()


def verify_hmac_v2(raw_body: bytes, signature_hex: str) -> tuple[bool, str]:
    """
    Squad Static VA webhook HMAC-SHA512 V2/V3.
    Hash over the 6 pipe-separated fields in this exact order:
        transaction_reference | virtual_account_number | currency |
        principal_amount | settled_amount | customer_identifier
    Returns (is_valid, computed_hex). The 6-field V2/V3 path is the
    canonical Squad spec (see Squad API Summary deck slide 5 + public
    docs Webhook Validation --version 3); V1 (whole-body hash) is kept
    as a defensive fallback for sandbox variance.

    NOTE: prior versions of this spike had positions 3-5 mis-ordered
    (amounts at 3-4, currency at 5) and used key "transaction_currency"
    instead of "currency". Bug never bit because no real Squad webhook
    hit this spike. Fixed in PR feat/webhook-vertical alongside the
    matching PRD §4.3 + signature.py fixes.
    """
    if not SQUAD_SECRET_KEY:
        return False, ""
    key = SQUAD_SECRET_KEY.encode("utf-8")

    # V1: hash entire body
    computed_v1 = hmac.new(key, raw_body, hashlib.sha512).hexdigest()

    # V2/V3: hash 6 pipe-separated fields per Squad canonical order
    try:
        payload = json.loads(raw_body)
        # Squad nests fields under various keys depending on event type.
        # Static VA inbound carries them at the top level or under "data".
        data = payload.get("data", payload)
        fields = [
            str(data.get("transaction_reference", "")),
            str(data.get("virtual_account_number", "")),
            # Squad's canonical payload key is "currency"; fall back to
            # "transaction_currency" only for backwards compatibility
            # with the pre-fix spike payloads still in old recordings.
            str(data.get("currency", data.get("transaction_currency", "NGN"))),
            str(data.get("principal_amount", "")),
            str(data.get("settled_amount", "")),
            str(data.get("customer_identifier", data.get("customer_id", ""))),
        ]
        msg = "|".join(fields).encode("utf-8")
        computed_v2 = hmac.new(key, msg, hashlib.sha512).hexdigest()
    except Exception as e:
        computed_v2 = f"<v2 build failed: {e}>"

    sig = (signature_hex or "").lower().strip()
    if sig and hmac.compare_digest(sig, computed_v2):
        return True, f"V2 match ({computed_v2})"
    if sig and hmac.compare_digest(sig, computed_v1):
        return True, f"V1 match ({computed_v1})"
    return False, f"NO MATCH. sig={sig!r} computed_v1={computed_v1} computed_v2={computed_v2}"


@app.post("/webhook")
async def webhook(
    request: Request,
    x_squad_encrypted_body: str | None = Header(default=None, alias="x-squad-encrypted-body"),
    x_squad_signature: str | None = Header(default=None, alias="x-squad-signature"),
):
    raw = await request.body()
    # Squad has used different header names historically — accept either.
    signature = x_squad_encrypted_body or x_squad_signature or ""
    is_valid, detail = verify_hmac_v2(raw, signature)

    try:
        body = json.loads(raw)
    except Exception:
        body = {"_raw": raw.decode("utf-8", errors="replace")}

    _log("INBOUND WEBHOOK", {
        "signature_header": signature,
        "signature_valid": is_valid,
        "signature_detail": detail,
        "headers": dict(request.headers),
        "body": body,
    })
    # ALWAYS return 200 per Squad spec.
    return JSONResponse({"received": True, "signature_valid": is_valid})


@app.get("/health")
async def health():
    return {"ok": True}


# ----------------------------------------------------------------------------
# Squad API calls
# ----------------------------------------------------------------------------

DEMO_PERSONAS = {
    "mama_risikat": {
        "customer_identifier": "mama_risikat_001",
        "first_name": "Risikat",
        "last_name": "Oluwole",
        "mobile_num": "08012345001",
        "email": "mama.risikat@example.com",
        "bvn": os.environ.get("SQUAD_TEST_BVN", "22222222222"),
        "dob": "1979-03-12",
        "address": "Mile 12 Market, Lagos",
        "gender": "Female",
    },
    "iya_tope": {
        "customer_identifier": "iya_tope_002",
        "first_name": "Tope",
        "last_name": "Adeyemi",
        "mobile_num": "08012345002",
        "email": "iya.tope@example.com",
        "bvn": os.environ.get("SQUAD_TEST_BVN", "22222222222"),
        "dob": "1985-07-04",
        "address": "Mile 12 Market, Lagos",
        "gender": "Female",
    },
    "kosi": {
        "customer_identifier": "kosi_003",
        "first_name": "Kosi",
        "last_name": "Eze",
        "mobile_num": "08012345003",
        "email": "kosi@example.com",
        "bvn": os.environ.get("SQUAD_TEST_BVN", "22222222222"),
        "dob": "1996-11-21",
        "address": "Mile 12 Market, Lagos",
        "gender": "Male",
    },
}


async def create_va(persona_key: str) -> dict:
    persona = DEMO_PERSONAS.get(persona_key)
    if not persona:
        raise SystemExit(f"unknown persona: {persona_key}. Options: {list(DEMO_PERSONAS)}")
    url = f"{SQUAD_BASE_URL}/virtual-account"
    _log("REQUEST POST /virtual-account", persona)
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(url, headers=_headers(), json=persona)
    _log(f"RESPONSE {r.status_code}", r.text)
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else {"raw": r.text}


async def simulate_payment(va_number: str, amount_kobo: int) -> dict:
    url = f"{SQUAD_BASE_URL}/virtual-account/simulate/payment"
    body = {"virtual_account_number": va_number, "amount": amount_kobo, "currency": "NGN"}
    _log("REQUEST POST /virtual-account/simulate/payment", body)
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(url, headers=_headers(), json=body)
    _log(f"RESPONSE {r.status_code}", r.text)
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else {"raw": r.text}


async def account_lookup(account_number: str, bank_code: str) -> dict:
    url = f"{SQUAD_BASE_URL}/payout/account/lookup"
    body = {"bank_code": bank_code, "account_number": account_number}
    _log("REQUEST POST /payout/account/lookup", body)
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(url, headers=_headers(), json=body)
    _log(f"RESPONSE {r.status_code}", r.text)
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else {"raw": r.text}


async def transfer(account_number: str, bank_code: str, account_name: str, amount_kobo: int, remark: str = "EchoPay") -> dict:
    """Fires transfer, handles 424 with requery poll."""
    ref = f"{SQUAD_MERCHANT_ID}_{uuid.uuid4().hex[:16]}"
    url = f"{SQUAD_BASE_URL}/payout/transfer"
    body = {
        "transaction_reference": ref,
        "amount": str(amount_kobo),
        "bank_code": bank_code,
        "account_number": account_number,
        "account_name": account_name,
        "currency_id": "NGN",
        "remark": remark,
    }
    _log("REQUEST POST /payout/transfer", body)
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(url, headers=_headers(), json=body)
    _log(f"RESPONSE {r.status_code}", r.text)

    if r.status_code == 424:
        print(">>> 424 received — outcome unknown. Polling requery...", flush=True)
        return await _requery_poll(ref)
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else {"raw": r.text}


async def _requery_poll(reference: str, max_seconds: int = 60, interval: int = 5) -> dict:
    url = f"{SQUAD_BASE_URL}/payout/requery"
    body = {"transaction_reference": reference}
    start = asyncio.get_event_loop().time()
    last = None
    while asyncio.get_event_loop().time() - start < max_seconds:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(url, headers=_headers(), json=body)
        _log(f"REQUERY RESPONSE {r.status_code}", r.text)
        try:
            last = r.json()
        except Exception:
            last = {"raw": r.text}
        # Terminal states — adjust based on actual Squad responses
        status = (last.get("data", {}) if isinstance(last, dict) else {}).get("status") or (last.get("status") if isinstance(last, dict) else None)
        if str(status).lower() in {"success", "completed", "failed", "reversed"}:
            return last
        await asyncio.sleep(interval)
    return last or {"error": "requery_timeout"}


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Squad sandbox roundtrip spike")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("listen", help="run the webhook listener on :9000")

    cva = sub.add_parser("create-va", help="create a Static VA for a persona")
    cva.add_argument("--persona", default="mama_risikat", help="one of: " + ", ".join(DEMO_PERSONAS))

    sim = sub.add_parser("simulate", help="simulate a payment to a VA")
    sim.add_argument("--va", required=True)
    sim.add_argument("--amount-kobo", type=int, required=True)

    lup = sub.add_parser("lookup", help="account lookup before transfer")
    lup.add_argument("--account", required=True)
    lup.add_argument("--bank-code", required=True)

    tr = sub.add_parser("transfer", help="initiate transfer; handles 424")
    tr.add_argument("--to", required=True, dest="account")
    tr.add_argument("--bank-code", required=True)
    tr.add_argument("--account-name", default="Test Recipient")
    tr.add_argument("--amount-kobo", type=int, required=True)
    tr.add_argument("--remark", default="EchoPay test")

    rq = sub.add_parser("requery", help="requery a transfer")
    rq.add_argument("--ref", required=True)

    args = parser.parse_args()

    if args.cmd == "listen":
        import uvicorn
        print(f"Webhook listener on http://localhost:9000/webhook  (SQUAD_BASE_URL={SQUAD_BASE_URL})")
        uvicorn.run("squad_roundtrip:app", host="0.0.0.0", port=9000, reload=False)
    elif args.cmd == "create-va":
        result = asyncio.run(create_va(args.persona))
        (PROOF_DIR / f"create_va_{args.persona}.json").write_text(json.dumps(result, indent=2, default=str))
    elif args.cmd == "simulate":
        asyncio.run(simulate_payment(args.va, args.amount_kobo))
    elif args.cmd == "lookup":
        asyncio.run(account_lookup(args.account, args.bank_code))
    elif args.cmd == "transfer":
        result = asyncio.run(transfer(args.account, args.bank_code, args.account_name, args.amount_kobo, args.remark))
        (PROOF_DIR / f"transfer_{uuid.uuid4().hex[:8]}.json").write_text(json.dumps(result, indent=2, default=str))
    elif args.cmd == "requery":
        result = asyncio.run(_requery_poll(args.ref))
        print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
