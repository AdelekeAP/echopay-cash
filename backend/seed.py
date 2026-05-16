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

import uuid

from sqlalchemy import select

from app.core.db import db_session
from app.models import Transaction, User, Wallet, create_all, now_unix


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
# Total: ₦24,000. With this history + 30-day account age, Musa's
# compute_credit_score() result is 726 → auto-approve band.
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


def _seed_musa_gigs(db) -> int:
    """Seed Musa's 12 inbound gig payments from Mama / Iya Tope.

    Idempotent: each Transaction uses a deterministic idempotency_key
    (`gig_seed_<musa_uid>_<i>`) so a second run skips silently.

    Returns the count of NEW rows inserted (0 if already seeded).

    NOTE: we don't debit Mama/Iya's wallets here. These are narrative
    history rows representing past gigs whose principal is already
    baked into the seeded baseline. Touching their balances now would
    double-count.
    """
    musa = db.scalar(
        select(User).where(User.customer_identifier == "musa_offloader_001")
    )
    if musa is None:
        return 0  # Musa not seeded yet — caller bootstraps personas first

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
        counterparty_uid = counterparty.id if counterparty is not None else None
        gig_at = now - (days_ago * 86_400)
        db.add(Transaction(
            id=f"gig_{uuid.uuid4().hex[:16]}",
            user_id=musa.id,
            counterparty_user_id=counterparty_uid,
            type="in_network",
            direction="in",
            amount_kobo=amount_kobo,
            status="completed",
            idempotency_key=idempotency_key,
            created_at=gig_at,
            settled_at=gig_at,
        ))
        # Credit Musa's wallet so balance + history tell the same story
        # AND so the credit_score balance_bonus fires.
        wallet = db.get(Wallet, musa.id)
        if wallet is not None:
            wallet.balance_kobo += amount_kobo
            wallet.version += 1
            wallet.updated_at = now
        inserted += 1

    # Backfill Musa's User.created_at to 30 days ago so the account-age
    # bonus in compute_credit_score() hits the 100-point cap (max age
    # bonus = 50 days × 2 = 100). Without this, fresh-seeded Musa starts
    # with age_bonus=0 and the score lands below auto-approve.
    if inserted > 0:
        musa.created_at = now - (30 * 86_400)

    return inserted


def main() -> None:
    create_all()
    for spec in PERSONAS:
        with db_session() as db:
            existing = db.scalar(
                select(User).where(User.customer_identifier == spec["customer_identifier"])
            )
            if existing:
                print(f"skip {spec['customer_identifier']} — already seeded")
                continue
            u = User(
                customer_identifier=spec["customer_identifier"],
                first_name=spec["first_name"],
                last_name=spec["last_name"],
                phone=spec["phone"],
                email=spec["email"],
                bvn=spec["bvn"],
                dob=spec["dob"],
                created_at=now_unix(),
            )
            db.add(u)
            db.flush()
            db.add(
                Wallet(
                    user_id=u.id,
                    squad_va_number=spec["va_number"],
                    balance_kobo=spec["balance_kobo"],
                    locked_kobo=spec["locked_kobo"],
                    updated_at=now_unix(),
                )
            )
            db.commit()
            print(f"seeded {spec['customer_identifier']} → user_id={u.id}")

    # After all personas exist, backfill Musa's gig history (idempotent
    # — second run inserts nothing).
    with db_session() as db:
        n = _seed_musa_gigs(db)
        db.commit()
        if n > 0:
            print(f"seeded {n} gig transactions for Musa")
        else:
            print("skip Musa gig seed — already done")


if __name__ == "__main__":
    main()
