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

from sqlalchemy import select

from app.core.db import db_session
from app.models import User, Wallet, create_all, now_unix


PERSONAS = [
    {
        "customer_identifier": "mama_risikat_001",
        "first_name": "Mama Risikat",
        "last_name": "Oluwole",
        "phone": "+234 801 234 5001",
        "email": "mama.risikat@echopay.test",
        "bvn": "22288899900",
        "dob": "1979-03-12",
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
        "email": "iya.tope@echopay.test",
        "bvn": "11122233344",
        "dob": "1985-07-04",
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
        "email": "kosi@echopay.test",
        "bvn": "55566677788",
        "dob": "1996-11-21",
        "va_number": "0345678901",
        "balance_kobo": 7_500_000,       # ₦75,000 online
        "locked_kobo":     500_000,      # ₦5,000 offline budget
        "ed25519_pub_b64": "E2tSlHCYKv56LLXSlmXbrmBK5vyXRHZKCrvGExDxG/g=",
    },
]


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
                ed25519_pub_b64=spec.get("ed25519_pub_b64"),
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


if __name__ == "__main__":
    main()
