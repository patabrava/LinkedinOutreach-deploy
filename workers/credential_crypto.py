from __future__ import annotations

import base64
import os
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SCHEME = "aes-256-gcm-v1"
KEY_BYTES = 32


def _decode_key(raw_key: str) -> Optional[bytes]:
    token = (raw_key or "").strip()
    if not token:
        return None
    try:
        if len(token) == KEY_BYTES * 2 and all(c in "0123456789abcdefABCDEF" for c in token):
            key = bytes.fromhex(token)
        else:
            key = base64.b64decode(token, validate=True)
    except Exception:
        return None
    return key if len(key) == KEY_BYTES else None


def _get_key() -> Optional[bytes]:
    return _decode_key(os.getenv("LINKEDIN_CREDENTIALS_KEY", ""))


def decrypt_password(value: dict) -> Optional[str]:
    if not isinstance(value, dict):
        return None

    encrypted = value.get("password_encrypted")
    scheme = value.get("password_scheme")
    if not encrypted:
        # Legacy fallback
        password = value.get("password")
        return password if isinstance(password, str) and password else None

    if scheme and scheme != SCHEME:
        return None

    key = _get_key()
    if not key:
        return None

    try:
        nonce_b64, ciphertext_b64, tag_b64 = encrypted.split(":", 2)
        nonce = base64.b64decode(nonce_b64)
        ciphertext = base64.b64decode(ciphertext_b64)
        tag = base64.b64decode(tag_b64)
        plain = AESGCM(key).decrypt(nonce, ciphertext + tag, None)
        return plain.decode("utf-8")
    except Exception:
        return None
