# syntax=docker/dockerfile:1.19
ARG RUST_IMAGE=rust:1.98.1-slim-bookworm
ARG RUNTIME_IMAGE=gcr.io/distroless/cc-debian12:nonroot

FROM ${RUST_IMAGE} AS build
ARG CRATE
ARG BINARY
RUN test -n "${CRATE}" && test -n "${BINARY}" || (echo "CRATE and BINARY build arguments are required" >&2 && exit 64)
WORKDIR /repo
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY services/voice-runtime/Cargo.toml ./services/voice-runtime/Cargo.toml
COPY services/voice-runtime/src ./services/voice-runtime/src
COPY services/metering-worker/Cargo.toml ./services/metering-worker/Cargo.toml
COPY services/metering-worker/src ./services/metering-worker/src
COPY tools/loadgen ./tools/loadgen
COPY fuzz ./fuzz
RUN --mount=type=cache,id=velyric-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=velyric-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=velyric-cargo-target,target=/repo/target \
    cargo build --release --locked -p "${CRATE}" --bin "${BINARY}" \
    && install -D -m 0755 "target/release/${BINARY}" /out/service

FROM ${RUNTIME_IMAGE} AS runtime
ARG CRATE
LABEL org.opencontainers.image.source="https://github.com/velyric/velyric" \
      org.opencontainers.image.vendor="Velyric" \
      org.opencontainers.image.title="${CRATE}"
COPY --from=build /out/service /usr/local/bin/service
USER nonroot:nonroot
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/service"]
