"""Tests for GET /dynamic-va/resolve — phone-book lookup for scan-to-pay.

PRD §1 Script A 2:00 beat: Phone B scans Mama's DVA QR (bare 10-digit
number); needs to resolve VA → recipient identity before paying.

Coverage:
  1. Happy path: known seeded VA returns lean persona payload.
  2. 404 when VA isn't registered.
  3. 400 on too-short VA.
  4. 400 on non-digit characters.
  5. SECURITY: response keys are EXACTLY the lean set — no sensitive
     fields (phone, email, bvn, dob, address, balances) leak.
"""

from __future__ import annotations

import sys

import pytest


@pytest.fixture(autouse=True)
def _reset_module_caches(client):  # noqa: ARG001 — depend on client to order after it
    """Drop module-level caches that survive between tests."""
    yield
    for mod_name in (
        "app.api.dva",
        "app.api.admin",
    ):
        sys.modules.pop(mod_name, None)
    try:
        from app.core import config as config_module
        config_module.get_settings.cache_clear()
    except (ImportError, AttributeError):
        pass


def _seed_persona(client, va_number: str, first: str, last: str) -> int:
    """Direct DB seed of a user + wallet with a known VA. Returns user_id."""
    import importlib

    models = importlib.import_module("app.models")
    db_mod = importlib.import_module("app.core.db")

    with db_mod.db_session() as db:
        with db.begin():
            user = models.User(
                customer_identifier=f"{first.lower()}_{last.lower()}_001",
                first_name=first,
                last_name=last,
                phone="+2348012345678",
                email=f"{first.lower()}@test",
                bvn="22288899900",
                dob="1990-01-01",
                created_at=models.now_unix(),
            )
            db.add(user)
            db.flush()
            db.add(models.Wallet(
                user_id=user.id,
                squad_va_number=va_number,
                balance_kobo=10_000_00,
                updated_at=models.now_unix(),
            ))
            return user.id


def test_resolve_happy_path(client):
    """Known VA → lean persona payload."""
    user_id = _seed_persona(client, "0123456789", "Mama", "Risikat")
    r = client.get("/dynamic-va/resolve", params={"va_number": "0123456789"})
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["recipient_user_id"] == user_id
    assert data["recipient_display_name"] == "Mama Risikat"
    assert data["persona_id"] == "mama_risikat"


def test_resolve_not_found(client):
    """Unknown VA → 404 VA_NOT_FOUND."""
    r = client.get("/dynamic-va/resolve", params={"va_number": "9999999999"})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "VA_NOT_FOUND"


def test_resolve_invalid_format_short(client):
    """VA shorter than 10 digits → 400 INVALID_VA."""
    r = client.get("/dynamic-va/resolve", params={"va_number": "12345"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "INVALID_VA"


def test_resolve_invalid_format_non_digit(client):
    """VA with non-digit characters → 400 INVALID_VA."""
    r = client.get("/dynamic-va/resolve", params={"va_number": "0123ABCDEF"})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "INVALID_VA"


def test_resolve_no_sensitive_leak(client):
    """SECURITY: response keys EXACTLY match the lean phone-book set.

    Any new field on User (phone, email, bvn, dob, address) must NOT
    appear in the response. If a future PR adds one, this test will
    catch the leak.
    """
    _seed_persona(client, "0234567890", "Iya", "Tope")
    r = client.get("/dynamic-va/resolve", params={"va_number": "0234567890"})
    assert r.status_code == 200
    body = r.json()
    # Top-level envelope
    assert set(body.keys()) == {"success", "data"}
    # Lean inner payload — no leaks
    assert set(body["data"].keys()) == {
        "recipient_user_id",
        "recipient_display_name",
        "persona_id",
    }
    # Explicit anti-leak assertions
    serialized = str(body)
    for sensitive in ("phone", "email", "bvn", "dob", "balance", "locked"):
        assert sensitive not in serialized.lower(), (
            f"sensitive field '{sensitive}' leaked into resolve response"
        )
