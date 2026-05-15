"""Synthetic credit-score for the admin dashboard.

Challenge 02 narrative (25% rubric weight): score creditworthiness from
real wallet behaviour, NOT from BVN credit-history pulls. Each persona
on the admin dashboard surfaces a FICO-range (300–850) number with the
formula breakdown visible so judges see the math.

Pure function — no DB, no I/O. Tests just call it with synthetic
Wallet/Transaction/User row objects (or any duck-typed equivalent).

Inputs:
    wallet: Wallet ORM row (uses .balance_kobo)
    transactions: list of Transaction ORM rows for this user (uses
        .direction, .status, .type)
    user: User ORM row (uses .created_at — unix seconds)

Returns:
    (score: int, breakdown: dict[str, int])

    breakdown keys: base, account_age_bonus, inbound_bonus,
    transfer_bonus, balance_bonus, failed_penalty, raw_total,
    clamped_score
"""

from __future__ import annotations

import time
from typing import Any


def compute_credit_score(
    wallet: Any,
    transactions: list[Any],
    user: Any,
) -> tuple[int, dict[str, int]]:
    base = 500

    now_unix = int(time.time())
    account_age_days = max(0, (now_unix - int(user.created_at)) // 86_400)
    account_age_bonus = min(account_age_days * 2, 100)

    inbound_count = sum(
        1
        for t in transactions
        if t.direction == "in" and t.status == "completed"
    )
    inbound_bonus = min(inbound_count * 15, 120)

    # Both in_network (intra-EchoPay) AND external_out (Squad payout)
    # count: both are user-initiated outbound activity, which is the
    # creditworthiness proxy. External transfers are arguably the
    # stronger signal (real-world spending capacity) — counting both.
    transfer_count = sum(
        1
        for t in transactions
        if t.type in ("in_network", "external_out") and t.status == "completed"
    )
    transfer_bonus = min(transfer_count * 8, 80)

    balance_bonus = 50 if wallet.balance_kobo > 1_000_000 else 0

    failed_count = sum(
        1 for t in transactions if t.status in ("reversed", "failed")
    )
    failed_penalty = min(failed_count * 25, 100)

    raw_total = (
        base
        + account_age_bonus
        + inbound_bonus
        + transfer_bonus
        + balance_bonus
        - failed_penalty
    )
    score = max(300, min(850, raw_total))

    breakdown = {
        "base": base,
        "account_age_bonus": account_age_bonus,
        "inbound_bonus": inbound_bonus,
        "transfer_bonus": transfer_bonus,
        "balance_bonus": balance_bonus,
        "failed_penalty": failed_penalty,
        "raw_total": raw_total,
        "clamped_score": score,
    }
    return score, breakdown
