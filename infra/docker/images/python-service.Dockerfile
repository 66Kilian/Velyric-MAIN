# syntax=docker/dockerfile:1.19
ARG PYTHON_IMAGE=python:3.11-slim-bookworm
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.0

FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE} AS build
ARG PACKAGE
RUN test -n "${PACKAGE}" || (echo "PACKAGE build argument is required" >&2 && exit 64)
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /repo
COPY pyproject.toml uv.lock .python-version ./
COPY services/document-worker/pyproject.toml ./services/document-worker/pyproject.toml
COPY services/eval-runner/pyproject.toml ./services/eval-runner/pyproject.toml
RUN --mount=type=cache,id=velyric-uv-cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-workspace --package "${PACKAGE}"
COPY services/document-worker ./services/document-worker
COPY services/eval-runner ./services/eval-runner
RUN --mount=type=cache,id=velyric-uv-cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable --package "${PACKAGE}"

FROM ${PYTHON_IMAGE} AS runtime-base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/app/.venv/bin:$PATH
RUN groupadd --system --gid 10001 velyric \
    && useradd --system --uid 10001 --gid velyric --home-dir /app --shell /usr/sbin/nologin velyric
WORKDIR /app

FROM runtime-base AS document-worker
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-hun tesseract-ocr-deu tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=velyric:velyric /app/.venv /app/.venv
LABEL org.opencontainers.image.source="https://github.com/velyric/velyric" \
      org.opencontainers.image.vendor="Velyric" \
      org.opencontainers.image.title="velyric-document-worker"
USER velyric
EXPOSE 7400
STOPSIGNAL SIGTERM
CMD ["velyric-document-worker"]

FROM runtime-base AS eval-runner
COPY --from=build --chown=velyric:velyric /app/.venv /app/.venv
LABEL org.opencontainers.image.source="https://github.com/velyric/velyric" \
      org.opencontainers.image.vendor="Velyric" \
      org.opencontainers.image.title="velyric-eval-runner"
USER velyric
EXPOSE 7500
STOPSIGNAL SIGTERM
CMD ["velyric-eval-runner"]
