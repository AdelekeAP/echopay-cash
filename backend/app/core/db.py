"""SQLAlchemy 2.0 engine + session, tuned for SQLite WAL.

PRD §4 (in-network transfer): the handler runs inside a single
`BEGIN IMMEDIATE` transaction. We disable SQLAlchemy's implicit BEGIN
and emit `BEGIN IMMEDIATE` ourselves via the `begin` event so every
write transaction in the app grabs the SQLite reserved lock up front —
which prevents the "I read, then somebody else wrote, then I wrote" race
that BEGIN DEFERRED would otherwise allow.

PRAGMAs (applied on every new connection):
- `journal_mode=WAL`   — concurrent readers while a writer holds the lock
- `foreign_keys=ON`    — SQLite default is OFF (legacy compatibility)
- `busy_timeout=5000`  — wait 5s on a locked DB instead of raising immediately
- `synchronous=NORMAL` — WAL durability without fsync per commit
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import get_settings


class Base(DeclarativeBase):
    pass


def _build_engine(database_url: str):
    connect_args: dict = {}
    if database_url.startswith("sqlite"):
        connect_args = {"check_same_thread": False}

    engine = create_engine(
        database_url,
        connect_args=connect_args,
        # isolation_level=None disables SQLAlchemy's auto-BEGIN so the
        # `begin` listener below can emit BEGIN IMMEDIATE explicitly.
        isolation_level="AUTOCOMMIT" if database_url.startswith("sqlite") else None,
        future=True,
    )

    if database_url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _set_sqlite_pragmas(dbapi_conn, _):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA busy_timeout=5000")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.close()

        @event.listens_for(engine, "begin")
        def _begin_immediate(conn):  # noqa: ANN001
            conn.exec_driver_sql("BEGIN IMMEDIATE")

    return engine


engine = _build_engine(get_settings().database_url)
SessionLocal = sessionmaker(
    bind=engine,
    autocommit=False,
    autoflush=False,
    expire_on_commit=False,
    class_=Session,
    future=True,
)


def get_db() -> Iterator[Session]:
    """FastAPI dependency. Each request gets a fresh Session, closed on return."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def db_session() -> Iterator[Session]:
    """Imperative variant for seed scripts and tests."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
