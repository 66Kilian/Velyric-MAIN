from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Protocol

_REFERENCE = re.compile(r"^(aws-sm|local-vault)://([A-Za-z0-9/_+=.@-]+)$")
_CACHE_SECONDS = 300.0


class SecretUnavailableError(Exception):
    pass


class SecretsManagerClient(Protocol):
    def get_secret_value(self, *, SecretId: str) -> dict[str, object]: ...  # noqa: N803


class TenantSecretReader:
    def __init__(self, client: SecretsManagerClient | None, local_vault_dir: str | None) -> None:
        self._client = client
        self._local = Path(local_vault_dir).resolve() if local_vault_dir is not None else None
        self._cache: dict[str, tuple[float, str]] = {}

    def read(self, reference: str) -> str:
        cached = self._cache.get(reference)
        if cached is not None and cached[0] > time.monotonic():
            return cached[1]
        match = _REFERENCE.match(reference)
        if match is None or ".." in match.group(2):
            msg = "secret reference is invalid"
            raise SecretUnavailableError(msg)
        scheme, name = match.group(1), match.group(2)
        value = self._read_local(name) if scheme == "local-vault" else self._read_aws(name)
        self._cache[reference] = (time.monotonic() + _CACHE_SECONDS, value)
        return value

    def _read_local(self, name: str) -> str:
        if self._local is None:
            msg = "local vault references are not enabled"
            raise SecretUnavailableError(msg)
        path = (self._local / f"{name}.secret").resolve()
        if self._local not in path.parents:
            msg = "secret reference escapes the local vault"
            raise SecretUnavailableError(msg)
        try:
            return path.read_text(encoding="utf-8")
        except OSError as error:
            msg = "local vault secret is unavailable"
            raise SecretUnavailableError(msg) from error

    def _read_aws(self, name: str) -> str:
        if self._client is None:
            msg = "AWS Secrets Manager references are not enabled"
            raise SecretUnavailableError(msg)
        try:
            response = self._client.get_secret_value(SecretId=name)
        except Exception as error:
            msg = "tenant secret could not be read"
            raise SecretUnavailableError(msg) from error
        value = response.get("SecretString")
        if not isinstance(value, str) or not value:
            msg = "tenant secret has no string value"
            raise SecretUnavailableError(msg)
        return value
