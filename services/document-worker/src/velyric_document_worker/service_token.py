from __future__ import annotations

import base64
import json
import time
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import load_pem_private_key

SERVICE_NAME = "document-worker"
TOKEN_LIFETIME_SECONDS = 120


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


class ServiceTokenSigner:
    def __init__(self, pem: str, key_id: str) -> None:
        key = load_pem_private_key(pem.encode("utf-8"), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            msg = "service signing key must be an Ed25519 private key"
            raise TypeError(msg)
        self._key = key
        self._key_id = key_id

    def sign(
        self,
        *,
        audience: str,
        scopes: tuple[str, ...],
        tenant_id: str | None,
        now: float | None = None,
    ) -> str:
        issued = int(now if now is not None else time.time())
        header = {"alg": "EdDSA", "typ": "JWT", "kid": self._key_id}
        claims: dict[str, str | int] = {
            "iss": SERVICE_NAME,
            "sub": SERVICE_NAME,
            "aud": audience,
            "iat": issued,
            "nbf": issued,
            "exp": issued + TOKEN_LIFETIME_SECONDS,
            "jti": str(uuid.uuid4()),
            "scope": " ".join(sorted(set(scopes))),
        }
        if tenant_id is not None:
            claims["tenant_id"] = tenant_id
        encoded_header = _b64url(json.dumps(header, separators=(",", ":")).encode())
        encoded_claims = _b64url(json.dumps(claims, separators=(",", ":")).encode())
        signing_input = f"{encoded_header}.{encoded_claims}"
        signature = self._key.sign(signing_input.encode("ascii"))
        return f"{signing_input}.{_b64url(signature)}"
