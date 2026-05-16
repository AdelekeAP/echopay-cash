"""Squad payout API wrappers.

Three operations: account lookup, fund transfer, requery.
All amounts in kobo. Callers supply 3-digit bank codes (e.g. "058" for
GTBank); this module converts them to 6-digit NIP codes before sending
to Squad, which is what the sandbox actually validates.
"""

from __future__ import annotations

from .client import SquadClient, SquadError

# 3-digit CBN code → 6-digit NIBSS NIP code
# Covers ~25 banks that appear in real Nigerian transfers.
NIP_CODES: dict[str, str] = {
    "058": "000013",  # GTBank
    "044": "000014",  # Access Bank
    "011": "000016",  # First Bank
    "033": "000004",  # UBA
    "057": "000015",  # Zenith Bank
    "035": "000017",  # Wema Bank / ALAT
    "214": "000003",  # FCMB
    "232": "000001",  # Sterling Bank
    "032": "000018",  # Union Bank
    "221": "000012",  # Stanbic IBTC
    "070": "000007",  # Fidelity Bank
    "050": "000010",  # Ecobank
    "076": "000008",  # Polaris Bank
    "082": "000002",  # Keystone Bank
    "030": "000020",  # Heritage Bank
    "101": "000023",  # Providus Bank
    "302": "000026",  # TAJBank
    "301": "090267",  # Kuda Microfinance Bank
    "100": "100004",  # OPay
    "999": "100033",  # PalmPay
    "000": "000006",  # Jaiz Bank
    "090": "000005",  # Diamond Bank (now Access)
    "068": "000009",  # Standard Chartered
    "215": "000011",  # Unity Bank
    "317": "090110",  # VFD Microfinance
}

NIGERIAN_BANKS: list[dict] = [
    {"id": 1,  "name": "GTBank",           "code": "058", "logo_url": None},
    {"id": 2,  "name": "Access Bank",      "code": "044", "logo_url": None},
    {"id": 3,  "name": "First Bank",       "code": "011", "logo_url": None},
    {"id": 4,  "name": "UBA",              "code": "033", "logo_url": None},
    {"id": 5,  "name": "Zenith Bank",      "code": "057", "logo_url": None},
    {"id": 6,  "name": "Wema / ALAT",      "code": "035", "logo_url": None},
    {"id": 7,  "name": "FCMB",             "code": "214", "logo_url": None},
    {"id": 8,  "name": "Sterling Bank",    "code": "232", "logo_url": None},
    {"id": 9,  "name": "Union Bank",       "code": "032", "logo_url": None},
    {"id": 10, "name": "Stanbic IBTC",     "code": "221", "logo_url": None},
    {"id": 11, "name": "Fidelity Bank",    "code": "070", "logo_url": None},
    {"id": 12, "name": "Ecobank",          "code": "050", "logo_url": None},
    {"id": 13, "name": "Polaris Bank",     "code": "076", "logo_url": None},
    {"id": 14, "name": "Keystone Bank",    "code": "082", "logo_url": None},
    {"id": 15, "name": "Providus Bank",    "code": "101", "logo_url": None},
    {"id": 16, "name": "TAJBank",          "code": "302", "logo_url": None},
    {"id": 17, "name": "Kuda Bank",        "code": "301", "logo_url": None},
    {"id": 18, "name": "OPay",             "code": "100", "logo_url": None},
    {"id": 19, "name": "PalmPay",          "code": "999", "logo_url": None},
    {"id": 20, "name": "Jaiz Bank",        "code": "000", "logo_url": None},
]


def _nip(bank_code: str) -> str:
    nip = NIP_CODES.get(bank_code)
    if not nip:
        raise SquadError(f"Unknown bank code: {bank_code!r}. Add it to payout.NIP_CODES.")
    return nip


async def lookup_account(
    client: SquadClient,
    bank_code: str,
    account_number: str,
) -> str:
    """Verify a NUBAN account and return the account holder's name.

    Args:
        bank_code: 3-digit CBN code (e.g. "058").
        account_number: 10-digit NUBAN.

    Returns:
        Account holder name string.

    Raises:
        SquadError: If Squad rejects the lookup or account not found.
    """
    nip = _nip(bank_code)
    body = await client.post(
        "/payout/account/lookup",
        json={"bank_code": nip, "account_number": account_number},
    )
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        raise SquadError("Squad lookup returned no data", body=body)
    name = data.get("account_name") or data.get("accountName")
    if not name:
        raise SquadError("Squad lookup returned no account_name", body=body)
    return str(name)


async def initiate_transfer(
    client: SquadClient,
    merchant_id: str,
    reference: str,
    amount_kobo: int,
    bank_code: str,
    account_number: str,
    account_name: str,
    remark: str = "EchoPay transfer",
) -> dict:
    """Send funds from the Squad ledger to an external NUBAN.

    Args:
        reference: Unique reference — must be prefixed with merchant_id.
        amount_kobo: Amount in kobo (integer).
        bank_code: 3-digit CBN code (e.g. "058").

    Returns:
        Raw Squad data dict from the response body.

    Raises:
        SquadError: On failure (400 bad params, 412 reversed, 424 timeout).
    """
    nip = _nip(bank_code)
    transaction_reference = f"{merchant_id}_{reference}"
    body = await client.post(
        "/payout/transfer",
        json={
            "transaction_reference": transaction_reference,
            "amount": str(amount_kobo),
            "bank_code": nip,
            "account_number": account_number,
            "account_name": account_name,
            "currency_id": "NGN",
            "remark": remark,
        },
    )
    return body.get("data") if isinstance(body, dict) else {}


async def requery_transfer(
    client: SquadClient,
    merchant_id: str,
    reference: str,
) -> dict:
    """Check the outcome of a previously initiated transfer.

    Call this when a transfer returns 424 (timeout) — never retry the
    original transfer call. The reference must include the merchant prefix
    exactly as passed to initiate_transfer.
    """
    transaction_reference = f"{merchant_id}_{reference}"
    body = await client.post(
        "/payout/requery",
        json={"transaction_reference": transaction_reference},
    )
    return body.get("data") if isinstance(body, dict) else {}
