"""SQLAlchemy models. Schema mirrors EchoPay_Cash_PRD.md §5.

Money is always integer kobo. Timestamps are unix seconds (integer) so
arithmetic is trivial and the schema doesn't depend on a TZ library.

Tables:
  - users, wallets, transactions             (Funbi — local transfer)
  - permits, nonces                          (offline ed25519 payments)
  - webhook_events                           (Leke — Squad webhook log)
"""

from __future__ import annotations

import time
from typing import Optional

from sqlalchemy import (
    BigInteger,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    CheckConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .core.db import Base


def now_unix() -> int:
    return int(time.time())


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_identifier: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    first_name: Mapped[str] = mapped_column(String(80), nullable=False)
    last_name: Mapped[str] = mapped_column(String(80), nullable=False)
    phone: Mapped[str] = mapped_column(String(32), nullable=False)
    email: Mapped[str] = mapped_column(String(160), nullable=False)
    bvn: Mapped[Optional[str]] = mapped_column(String(11), nullable=True)
    dob: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    # ed25519 public key (base64, 32 bytes raw → 44-char b64). Pinned at
    # signup, used by /sync/submit to verify the sender's tx signature
    # and the receiver's countersign on offline payments (master doc §4.2).
    ed25519_pub_b64: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_unix, nullable=False)

    wallet: Mapped[Optional["Wallet"]] = relationship(back_populates="user", uselist=False)


class Wallet(Base):
    __tablename__ = "wallets"

    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    squad_va_number: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    balance_kobo: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    locked_kobo: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, default=now_unix, nullable=False)

    user: Mapped["User"] = relationship(back_populates="wallet")

    __table_args__ = (
        CheckConstraint("balance_kobo >= 0", name="wallets_nonnegative_balance"),
        CheckConstraint("locked_kobo >= 0", name="wallets_nonnegative_locked"),
    )


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False, index=True
    )
    counterparty_user_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True
    )
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    direction: Mapped[str] = mapped_column(String(8), nullable=False)
    amount_kobo: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    squad_ref: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, default=now_unix, nullable=False)
    settled_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    __table_args__ = (
        # Idempotency: a given client request retried with the same key
        # must collapse to one row. PRD §4 / PRD_FUNBI §5.2.
        UniqueConstraint("idempotency_key", name="transactions_idempotency_key_unique"),
        CheckConstraint("amount_kobo > 0", name="transactions_positive_amount"),
        CheckConstraint("direction IN ('in', 'out')", name="transactions_direction_enum"),
        CheckConstraint(
            "status IN ('pending', 'completed', 'reversed', 'failed')",
            name="transactions_status_enum",
        ),
    )


class Permit(Base):
    """Server-issued ed25519-signed spending permit (master doc §4.2).

    Issued while the user is online. The phone caches it and can spend
    against it while offline, capped at max_amount_kobo and bounded by
    expires_at. Redeemed atomically on /sync/submit via:
        UPDATE permits SET status='redeemed' WHERE permit_id=:id
          AND status='outstanding' AND :now < expires_at
          RETURNING permit_id, max_amount_kobo;
    0 rows back → double-spend / expired → reject + flag.
    """
    __tablename__ = "permits"

    permit_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=False, index=True
    )
    device_fingerprint: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    max_amount_kobo: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="outstanding")
    issued_at: Mapped[int] = mapped_column(BigInteger, default=now_unix, nullable=False)
    expires_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    redeemed_by_tx_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    redeemed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    # Server's ed25519 signature over the canonical permit payload
    # ({permit_id, user_id, device_fingerprint, max_amount_kobo,
    #   issued_at, expires_at}) — base64.
    server_sig_b64: Mapped[str] = mapped_column(String(128), nullable=False)

    __table_args__ = (
        CheckConstraint("max_amount_kobo > 0", name="permits_positive_max"),
        CheckConstraint(
            "status IN ('outstanding', 'redeemed', 'expired')",
            name="permits_status_enum",
        ),
    )


class Nonce(Base):
    """Replay-protection for offline txs (master doc §4.2).

    Every offline transaction carries a sender-generated nonce.
    (sender_user_id, nonce) is UNIQUE forever, so the same QR can never
    be successfully sync'd twice — independent of permit redemption.
    """
    __tablename__ = "nonces"

    sender_user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id"), primary_key=True
    )
    nonce: Mapped[str] = mapped_column(String(64), primary_key=True)
    used_at: Mapped[int] = mapped_column(BigInteger, default=now_unix, nullable=False)


class WebhookEvent(Base):
    """Squad webhook event log.

    PRD §4.3 + §5 spec. The `transaction_ref` PK doubles as the
    idempotency lock — a replay of the same Squad webhook hits the
    UNIQUE constraint on INSERT, which the endpoint catches and turns
    into an immediate 200 (no second wallet credit).

    Extra fields beyond PRD §5 spec, captured in this PR for telemetry:
    - `mismatch`: True when paid amount ≠ expected amount (Squad
      auto-refunds; we log + flag, do not credit).
    - `signature_version_matched`: 'v1' / 'v2' / NULL — surfaces sandbox
      version drift for the admin dashboard.
    """

    __tablename__ = "webhook_events"

    transaction_ref: Mapped[str] = mapped_column(String(64), primary_key=True)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    raw_payload: Mapped[str] = mapped_column(String(8192), nullable=False)
    signature_valid: Mapped[int] = mapped_column(Integer, nullable=False)
    mismatch: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    signature_version_matched: Mapped[Optional[str]] = mapped_column(
        String(8), nullable=True
    )
    processed_at: Mapped[int] = mapped_column(BigInteger, default=now_unix, nullable=False)

    __table_args__ = (
        CheckConstraint(
            "source IN ('static_va', 'dynamic_va', 'transfer')",
            name="webhook_events_source_enum",
        ),
        CheckConstraint(
            "signature_valid IN (0, 1)",
            name="webhook_events_signature_valid_bool",
        ),
        CheckConstraint(
            "mismatch IN (0, 1)",
            name="webhook_events_mismatch_bool",
        ),
    )


def create_all() -> None:
    """Idempotent — create tables if they don't exist."""
    from .core.db import engine
    Base.metadata.create_all(bind=engine)
