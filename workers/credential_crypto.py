from __future__ import annotations

import base64
import os
from pathlib import Path
from secrets import token_bytes
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SCHEME = "aes-256-gcm-v1"
KEY_BYTES = 32
KEY_FILE_ENV = "LINKEDIN_CREDENTIALS_KEY_FILE"
DEFAULT_KEY_FILE = Path(__file__).resolve().parents[1] / ".linkedin_credentials_key"


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


def _key_file_path() -> Path:
    raw_path = (os.getenv(KEY_FILE_ENV) or "").strip()
    return Path(raw_path) if raw_path else DEFAULT_KEY_FILE


def _read_key_file(path: Path) -> Optional[bytes]:
    if not path.exists():
        return None
    try:
        return _decode_key(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _persist_key_file(path: Path, key: bytes) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("x", encoding="utf-8") as handle:
            handle.write(base64.b64encode(key).decode("ascii") + "\n")
        try:
            os.chmod(path, 0o600)
        except Exception:
            pass
        return True
    except FileExistsError:
        return False


def _get_key() -> Optional[bytes]:
    env_key = _decode_key(os.getenv("LINKEDIN_CREDENTIALS_KEY", ""))
    if env_key:
        return env_key

    path = _key_file_path()
    file_key = _read_key_file(path)
    if file_key:
        return file_key
    if path.exists():
        return None

    generated = token_bytes(KEY_BYTES)
    try:
        _persist_key_file(path, generated)
    except Exception:
        return None
    return _read_key_file(path) or generated


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
