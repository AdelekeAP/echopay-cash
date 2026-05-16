"""Seed three demo personas + wallets.

Idempotent: re-runs are no-ops once the rows exist. Starting balances
mirror constants/personas.ts on the client so home tab values match
after a fresh sign-in:

    Mama Risikat   ₦450,000.00   →  45_000_000 kobo
    Iya Tope       ₦125,000.00   →  12_500_000 kobo
    Kosi           ₦80,000.00    →   8_000_000 kobo

The Squad VA numbers here are placeholders. When Leke wires the real
Squad client, `seed.py` should call `/virtual-account` and persist the
returned VAs instead of these stand-ins.
"""

from __future__ import annotations

import asyncio
import uuid

from sqlalchemy import select

from app.core.db import db_session
from app.models import Transaction, User, Wallet, create_all, now_unix
from app.squad.client import SquadError, get_squad_client
from app.squad.static_va import create_static_va


# NOTE: gender / address / beneficiary_account are inert in this seed
# script — it writes hardcoded VA placeholders to the local DB and does
# NOT call Squad. The fields mirror auth.py's _PERSONA_SEED_BY_ID exactly
# so the two persona-spec lists stay byte-identical (drift here was the
# root cause of the Static VA payload bug fixed in fix/seed-squad-payload).
PERSONAS = [
    {
        "customer_identifier": "mama_risikat_001",
        "first_name": "Mama Risikat",
        "last_name": "Oluwole",
        "phone": "+234 801 234 5001",
        "email": "aladenusiadeleke@gmail.com",
        "bvn": "22288899900",
        "dob": "1979-03-12",
        "gender": "2",
        "address": "12 Mile 12 Market Road, Ketu, Lagos",
        "beneficiary_account": "4920299492",
        "va_number": "0123456789",
        "balance_kobo": 40_000_000,      # ₦400,000 online
        "locked_kobo":   5_000_000,      # ₦50,000 already in offline budget
        # ed25519 pubkey, base64. Matches the private key baked into
        # mobile/constants/personas.ts for the demo. Deterministic
        # seed (sha256("echopay-demo:mama_risikat_001")).
        "ed25519_pub_b64": "999uiLtwK4u4k3NhG5SB6xzPTs9uB6MkDsPH9Z5t8yw=",
    },
    {
        "customer_identifier": "iya_tope_002",
        "first_name": "Iya Tope",
        "last_name": "Adeyemi",
        "phone": "+234 801 234 5002",
        "email": "aladenusiadeleke@gmail.com",
        "bvn": "22288899900",  # shared sandbox-validated BVN; Squad sandbox doesn't enforce BVN uniqueness
        "dob": "1985-07-04",
        "gender": "2",
        "address": "Stall 24, Mile 12 Market, Ketu, Lagos",
        "beneficiary_account": "4920299492",
        "va_number": "0234567890",
        "balance_kobo": 11_000_000,      # ₦110,000 online
        "locked_kobo":   1_500_000,      # ₦15,000 offline budget
        "ed25519_pub_b64": "o5hjpq2lYZfj4Z/XC6X2es7G2Syn+1cbtXtovEihU1o=",
    },
    {
        "customer_identifier": "kosi_003",
        "first_name": "Kosi",
        "last_name": "Eze",
        "phone": "+234 801 234 5003",
        "email": "aladenusiadeleke@gmail.com",
        "bvn": "22288899900",  # shared sandbox-validated BVN; Squad sandbox doesn't enforce BVN uniqueness
        "dob": "1996-11-21",
        "gender": "1",  # narrative silent; defaulting male — see fix/seed-squad-payload PR
        "address": "5 Adeola Odeku Street, Victoria Island, Lagos",
        "beneficiary_account": "4920299492",
        "va_number": "0345678901",
        "balance_kobo": 7_500_000,       # ₦75,000 online
        "locked_kobo":     500_000,      # ₦5,000 offline budget
        "ed25519_pub_b64": "E2tSlHCYKv56LLXSlmXbrmBK5vyXRHZKCrvGExDxG/g=",
    },
    {
        # 4th persona — informal gig worker (Mile 12 offloader). Closes
        # the Challenge 02 "informal traders AND job seekers" narrative
        # by representing the worker side of the ecosystem. Hausa name
        # represents Northern informal workers common in Lagos markets.
        # Starting balance is 0; the seed loop fills it via 12 inbound
        # gig payments from Mama/Iya so Musa's credit score lands in the
        # auto-approve band (~726).
        "customer_identifier": "musa_offloader_001",
        "first_name": "Musa",
        "last_name": "Adamu",
        "phone": "+234 813 555 4001",
        "email": "musaadamu@gmail.com",
        "bvn": "22288899900",
        "dob": "1998-06-20",      # 28 years old in 2026
        "gender": "1",
        "address": "Block C, Mile 12 Workers' Quarters, Ketu, Lagos",
        "beneficiary_account": "4920299492",
        "va_number": "0456789012",
        "balance_kobo": 0,
        "locked_kobo": 0,
    },
]


# Musa's gig history — 12 inbound transactions from Mama / Iya Tope over
# the past 30 days, varied at realistic offloader rates (₦1,500-3,000).
# Total: ₦26,000. With this history + 30-day account age, Musa's
# compute_credit_score() result is 730 → auto-approve band.
#
# Tuple shape: (counterparty_customer_identifier, amount_kobo, days_ago)
MUSA_GIGS = [
    ("mama_risikat_001",     200_000, 28),  # ₦2,000
    ("iya_tope_002",         250_000, 26),
    ("mama_risikat_001",     150_000, 24),
    ("mama_risikat_001",     200_000, 21),
    ("iya_tope_002",         300_000, 19),
    ("mama_risikat_001",     200_000, 16),
    ("iya_tope_002",         250_000, 13),
    ("mama_risikat_001",     200_000, 11),
    ("iya_tope_002",         150_000,  8),
    ("mama_risikat_001",     200_000,  6),
    ("iya_tope_002",         300_000,  4),
    ("mama_risikat_001",     200_000,  1),
]


# Mama's pre-demo activity to populate the anomaly panel at the 4:00
# demo beat. Two-phase seed:
#   Phase 1: 8 inbound qr_receive payments totaling ₦640,000. Funds
#     Mama's wallet ABOVE her outbound need (₦454,150) so the next
#     phase doesn't bankrupt her. qr_receive is in the master_va
#     inbound list → both sum(wallets) and master_va go up by the
#     same delta → drift stays 0.
#   Phase 2: 10 outbound external_out transactions:
#     - 9 typical small amounts (₦200-₦800) over the past 7 days
#     - 1 anomalous ₦450,000 outbound 1 day ago
#     external_out is in the master_va outbound list → sum(wallets)
#     and master_va both go down by the same delta → drift stays 0.
#
# Z-score math for anomaly detection:
#   9 small ≈ ₦4,150 total (mean ~₦461 each in kobo land)
#   1 outlier at 45_000_000 kobo (₦450,000)
#   mean = (415_000 + 45_000_000) / 10 ≈ 4.54M kobo
#   stdev ≈ 13.5M kobo (dominated by outlier)
#   z(outlier) ≈ |45M - 4.54M| / 13.5M ≈ 3.0 → HIGH severity flag
#   z(typical) ≈ 0.3 → no flag
#
# Tuple shape: (amount_kobo, days_ago, idempotency_suffix)
MAMA_DEMO_INBOUNDS = [
    (8_000_000, 14, "qr_in_1"),  # ₦80,000
    (8_000_000, 13, "qr_in_2"),
    (8_000_000, 12, "qr_in_3"),
    (8_000_000, 11, "qr_in_4"),
    (8_000_000, 10, "qr_in_5"),
    (8_000_000,  9, "qr_in_6"),
    (8_000_000,  8, "qr_in_7"),
    (8_000_000,  8, "qr_in_8"),
]  # 8 × ₦80,000 = ₦640,000 total inbound

MAMA_DEMO_OUTBOUNDS = [
    # 9 small typical (₦200-₦800 range, in kobo)
    (   20_000, 7, "out_typical_1"),  # ₦200
    (   35_000, 7, "out_typical_2"),  # ₦350
    (   50_000, 6, "out_typical_3"),  # ₦500
    (   25_000, 6, "out_typical_4"),  # ₦250
    (   70_000, 5, "out_typical_5"),  # ₦700
    (   45_000, 4, "out_typical_6"),  # ₦450
    (   60_000, 3, "out_typical_7"),  # ₦600
    (   30_000, 2, "out_typical_8"),  # ₦300
    (   80_000, 2, "out_typical_9"),  # ₦800
    # 1 anomalous ₦450,000 (z ≈ 3.0σ → HIGH)
    (45_000_000, 1, "out_anomaly"),
]  # sum = 45_415_000 kobo = ₦454,150


def _seed_musa_gigs(db) -> int:
    """Seed Musa's 12 inbound gig payments from Mama / Iya Tope.

    Idempotent: each Transaction uses a deterministic idempotency_key
    (`gig_seed_<musa_uid>_<i>`) so a second run skips silently.

    Returns the count of NEW rows inserted (0 if already seeded).

    Conservation: each gig DEBITS the counterparty (mama or iya) and
    CREDITS Musa. The total system balance is unchanged — gigs are real
    intra-EchoPay transfers, not fresh money. Without these debits the
    reconcile invariant breaks at baseline (drift = +gig_total).
    """
    musa = db.scalar(
        select(User).where(User.customer_identifier == "musa_offloader_001")
    )
    if musa is None:
        return 0  # Musa not seeded yet — caller bootstraps personas first

    musa_wallet = db.get(Wallet, musa.id)

    inserted = 0
    now = now_unix()
    for i, (counterparty_id, amount_kobo, days_ago) in enumerate(MUSA_GIGS):
        idempotency_key = f"gig_seed_{musa.id}_{i}"
        existing = db.scalar(
            select(Transaction).where(Transaction.idempotency_key == idempotency_key)
        )
        if existing is not None:
            continue
        counterparty = db.scalar(
            select(User).where(User.customer_identifier == counterparty_id)
        )
        if counterparty is None:
            # If a counterparty isn't seeded (shouldn't happen post-main()
            # but defensive), skip this gig rather than corrupt history.
            continue
        counterparty_wallet = db.get(Wallet, counterparty.id)
        if counterparty_wallet is None:
            continue

        gig_at = now - (days_ago * 86_400)
        db.add(Transaction(
            id=f"gig_{uuid.uuid4().hex[:16]}",
            user_id=musa.id,
            counterparty_user_id=counterparty.id,
            type="in_network",
            direction="in",
            amount_kobo=amount_kobo,
            status="completed",
            idempotency_key=idempotency_key,
            created_at=gig_at,
            settled_at=gig_at,
        ))
        # Conservation: debit the counterparty, credit Musa.
        counterparty_wallet.balance_kobo -= amount_kobo
        counterparty_wallet.version += 1
        counterparty_wallet.updated_at = now
        if musa_wallet is not None:
            musa_wallet.balance_kobo += amount_kobo
            musa_wallet.version += 1
            musa_wallet.updated_at = now
        inserted += 1

    # Backfill Musa's User.created_at to 30 days ago so the account-age
    # bonus in compute_credit_score() rises to 60 (30 days × 2). Combined
    # with 12 inbound (bonus 120) + balance > ₦10k (bonus 50), the score
    # lands around 730 — auto-approve band.
    if inserted > 0:
        musa.created_at = now - (30 * 86_400)

    return inserted


def _seed_mama_demo_activity(db) -> int:
    """Seed Mama's pre-demo inbound + outbound history.

    Two-phase, conservation-preserving:
      1. 8 qr_receive inbounds totaling ₦640,000 (credits Mama's wallet,
         increments master_va via the inbound list — drift unchanged)
      2. 10 external_out outbounds totaling ₦454,150 (debits Mama's
         wallet, decrements master_va via the outbound list — drift
         unchanged). 9 typical + 1 anomalous (₦450K) so that
         /admin/anomalies returns a HIGH-severity flag at demo open.

    Idempotent: each transaction's idempotency_key is derived from a
    deterministic suffix ("mama_demo_<phase>_<suffix>"). Re-running
    seed.main() inserts zero new rows after the first run.

    Returns the count of NEW rows inserted (0 if already seeded).
    """
    mama = db.scalar(
        select(User).where(User.customer_identifier == "mama_risikat_001")
    )
    if mama is None:
        return 0

    mama_wallet = db.get(Wallet, mama.id)
    if mama_wallet is None:
        return 0

    inserted = 0
    now = now_unix()

    # Phase 1: qr_receive inbounds. Spread across days 8-14 ago so they
    # precede the outbound activity chronologically.
    for amount_kobo, days_ago, suffix in MAMA_DEMO_INBOUNDS:
        idempotency_key = f"mama_demo_in_{suffix}"
        existing = db.scalar(
            select(Transaction).where(Transaction.idempotency_key == idempotency_key)
        )
        if existing is not None:
            continue
        when = now - (days_ago * 86_400)
        db.add(Transaction(
            id=f"mqi_{uuid.uuid4().hex[:16]}",
            user_id=mama.id,
            type="qr_receive",
            direction="in",
            amount_kobo=amount_kobo,
            status="completed",
            idempotency_key=idempotency_key,
            created_at=when,
            settled_at=when,
        ))
        mama_wallet.balance_kobo += amount_kobo
        mama_wallet.version += 1
        mama_wallet.updated_at = now
        inserted += 1

    # Phase 2: external_out outbounds. Days 1-7 ago. 9 typical + 1
    # anomaly. external_out is the master_va outbound list entry,
    # so conservation holds.
    for amount_kobo, days_ago, suffix in MAMA_DEMO_OUTBOUNDS:
        idempotency_key = f"mama_demo_out_{suffix}"
        existing = db.scalar(
            select(Transaction).where(Transaction.idempotency_key == idempotency_key)
        )
        if existing is not None:
            continue
        when = now - (days_ago * 86_400)
        db.add(Transaction(
            id=f"mqo_{uuid.uuid4().hex[:16]}",
            user_id=mama.id,
            type="external_out",
            direction="out",
            amount_kobo=amount_kobo,
            status="completed",
            idempotency_key=idempotency_key,
            created_at=when,
            settled_at=when,
        ))
        mama_wallet.balance_kobo -= amount_kobo
        mama_wallet.version += 1
        mama_wallet.updated_at = now
        inserted += 1

    return inserted


async def _try_mint_real_squad_va(spec: dict) -> str | None:
    """Mint a real Squad sandbox Static VA for this persona.

    Returns the 10-digit VA on success, None on any failure (sandbox
    rejection, network error, key missing). Caller falls back to the
    placeholder so the seed never crashes — partial real VAs are
    better than no seed at all when demo is imminent.
    """
    client = get_squad_client()
    if not client.configured:
        return None
    try:
        result = await create_static_va(
            client,
            customer_identifier=spec["customer_identifier"],
            first_name=spec["first_name"],
            last_name=spec["last_name"],
            phone=spec["phone"],
            email=spec["email"],
            bvn=spec["bvn"],
            dob=spec["dob"],
            address=spec["address"],
            gender=spec["gender"],
            beneficiary_account=spec["beneficiary_account"],
        )
        return result.va_number
    except SquadError as e:
        print(
            f"  ! Squad mint failed for {spec['customer_identifier']}: {e} — "
            "falling back to placeholder VA"
        )
        return None
    except Exception as e:
        print(
            f"  ! Unexpected error minting VA for {spec['customer_identifier']}: "
            f"{type(e).__name__}: {e} — falling back to placeholder"
        )
        return None


def main() -> None:
    create_all()
    for spec in PERSONAS:
        with db_session() as db:
            existing = db.scalar(
                select(User).where(User.customer_identifier == spec["customer_identifier"])
            )
            if existing:
                # Existing row — if its VA is still the placeholder, try
                # to remint a real Squad VA in place. Keeps anomaly
                # history and balances intact. Idempotent: re-runs against
                # a real VA do nothing.
                wallet = db.get(Wallet, existing.id)
                if wallet and wallet.squad_va_number == spec["va_number"]:
                    new_va = asyncio.run(_try_mint_real_squad_va(spec))
                    if new_va:
                        old_va = wallet.squad_va_number
                        wallet.squad_va_number = new_va
                        wallet.version += 1
                        wallet.updated_at = now_unix()
                        db.commit()
                        print(
                            f"reminted {spec['customer_identifier']}: "
                            f"{old_va} → {new_va} (REAL squad)"
                        )
                    else:
                        print(
                            f"skip {spec['customer_identifier']} — Squad "
                            "mint failed, kept placeholder"
                        )
                else:
                    print(
                        f"skip {spec['customer_identifier']} — already has "
                        f"real VA ({wallet.squad_va_number if wallet else 'n/a'})"
                    )
                continue
            # Attempt to mint a real Squad sandbox VA for this persona; on
            # any failure (sandbox down, schema reject, key missing), the
            # helper returns None and we use the placeholder VA so the
            # seed completes regardless. Real VAs become visible in the
            # Squad sandbox dashboard for the demo Q&A "show me the
            # integration" moment.
            real_va = asyncio.run(_try_mint_real_squad_va(spec))
            va_to_use = real_va if real_va else spec["va_number"]
            va_marker = "REAL squad" if real_va else "PLACEHOLDER"

            u = User(
                customer_identifier=spec["customer_identifier"],
                first_name=spec["first_name"],
                last_name=spec["last_name"],
                phone=spec["phone"],
                email=spec["email"],
                bvn=spec["bvn"],
                dob=spec["dob"],
                ed25519_pub_b64=spec.get("ed25519_pub_b64"),
                created_at=now_unix(),
            )
            db.add(u)
            db.flush()
            db.add(
                Wallet(
                    user_id=u.id,
                    squad_va_number=va_to_use,
                    balance_kobo=spec["balance_kobo"],
                    locked_kobo=spec["locked_kobo"],
                    updated_at=now_unix(),
                )
            )
            db.commit()
            print(
                f"seeded {spec['customer_identifier']} → user_id={u.id}, "
                f"VA={va_to_use} ({va_marker})"
            )

    # After all personas exist, backfill Musa's gig history (idempotent
    # — second run inserts nothing).
    with db_session() as db:
        n = _seed_musa_gigs(db)
        db.commit()
        if n > 0:
            print(f"seeded {n} gig transactions for Musa")
        else:
            print("skip Musa gig seed — already done")

    # Mama's demo activity to populate the anomaly panel at 4:00 beat.
    with db_session() as db:
        n = _seed_mama_demo_activity(db)
        db.commit()
        if n > 0:
            print(f"seeded {n} demo transactions for Mama (anomaly panel)")
        else:
            print("skip Mama demo seed — already done")


if __name__ == "__main__":
    main()
