"""ed25519 helpers for the offline-permit mechanic (master doc §4.2).

Server holds one keypair. The private key signs every issued permit so
the receiver's phone can verify it offline without contacting the
server. The public key is pinned in the mobile bundle (set
EXPO_PUBLIC_SERVER_ED25519_PUB to the value get_server_pubkey_b64()
prints on first boot).

We use pynacl's SigningKey/VerifyKey. Signatures are 64 bytes, keys
are 32 bytes raw. We serialize to base64 for all wire + storage
formats (JSON-friendly, fits in our String columns).

Canonical payload format: JSON with keys sorted, no whitespace. Both
sides agree on the same string-bytes-to-sign so cross-language
(Python ↔ JS via tweetnacl) round-trips cleanly.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any

from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

# Stored alongside the SQLite db; gitignored. In production this would
# be an HSM / KMS-managed key. Hackathon: just persist it next to the
# db so restarts don't break previously-issued permits.
#
# Override via ECHOPAY_SERVER_KEY_PATH — used by the Docker container
# to mount the key on a persistent volume (/data/server_ed25519.key)
# so permits survive container restarts.
_KEY_PATH = Path(
    os.environ.get(
        "ECHOPAY_SERVER_KEY_PATH",
        str(Path(__file__).resolve().parents[2] / "server_ed25519.key"),
    )
)


def _load_or_create_keypair() -> SigningKey:
    if _KEY_PATH.exists():
        return SigningKey(bytes.fromhex(_KEY_PATH.read_text().strip()))
    sk = SigningKey.generate()
    _KEY_PATH.write_text(sk.encode().hex())
    _KEY_PATH.chmod(0o600)
    return sk


_SERVER_SK = _load_or_create_keypair()
_SERVER_VK = _SERVER_SK.verify_key


def get_server_pubkey_b64() -> str:
    return base64.b64encode(_SERVER_VK.encode()).decode("ascii")


# ----------------------------------------------------- canonical encoding


def canonical_bytes(payload: dict[str, Any]) -> bytes:
    """JSON, sorted keys, no whitespace, UTF-8.

    Mobile (tweetnacl) must match exactly. Use
    `JSON.stringify(payload, Object.keys(payload).sort())` over there,
    or build the string by hand in key-sorted order.
    """
    return json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")


# ----------------------------------------------------- signing + verify


def sign_b64(payload: dict[str, Any]) -> str:
    msg = canonical_bytes(payload)
    sig = _SERVER_SK.sign(msg).signature
    return base64.b64encode(sig).decode("ascii")


def verify_server_b64(payload: dict[str, Any], sig_b64: str) -> bool:
    try:
        sig = base64.b64decode(sig_b64)
    except Exception:
        return False
    try:
        _SERVER_VK.verify(canonical_bytes(payload), sig)
        return True
    except BadSignatureError:
        return False


def verify_user_b64(payload: dict[str, Any], sig_b64: str, user_pub_b64: str) -> bool:
    try:
        sig = base64.b64decode(sig_b64)
        pub = base64.b64decode(user_pub_b64)
    except Exception:
        return False
    try:
        VerifyKey(pub).verify(canonical_bytes(payload), sig)
        return True
    except BadSignatureError:
        return False
    except Exception:
        return False
