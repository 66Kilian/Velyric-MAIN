# syntax=docker/dockerfile:1.19
FROM golang:1.27.1-bookworm@sha256:69a7b9788769bec032d238959b61854e9ae87f57be9029ec04e9885fabf99195 AS build

# Public upstream snapshots, verified before extraction. No MinIO registry or
# retired binary download endpoint is needed to rebuild this sandbox image.
ADD --checksum=sha256:71794c2df26aad0cc99e8421c58b7aa2dd55969f979b0e7d1e931042e9fabcd6 https://codeload.github.com/minio/minio/tar.gz/7aac2a2c5b7c882e68c1ce017d8256be2feea27f /tmp/minio.tar.gz
ADD --checksum=sha256:167415edd21bc29f5360943dac64272aa5cda0a39f3070b15cfeca671c43d975 https://codeload.github.com/minio/mc/tar.gz/77f82e18b5401a65958f1619df6ebb994634bd88 /tmp/mc.tar.gz
RUN mkdir -p /src/minio /src/mc /out \
    && tar -xzf /tmp/minio.tar.gz -C /src/minio --strip-components=1 \
    && tar -xzf /tmp/mc.tar.gz -C /src/mc --strip-components=1

ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOMAXPROCS=2
WORKDIR /src/minio
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -mod=readonly -p 2 -trimpath -buildvcs=false -ldflags="-s -w" -o /out/minio .
WORKDIR /src/mc
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -mod=readonly -p 2 -trimpath -buildvcs=false -ldflags="-s -w" -o /out/mc .

FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/minio /out/mc /usr/local/bin/
COPY --from=build /src/minio/LICENSE /src/minio/NOTICE /licenses/minio/
COPY --from=build /src/mc/LICENSE /licenses/mc/LICENSE
LABEL org.opencontainers.image.title="Velyric sandbox MinIO" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="7aac2a2c5b7c882e68c1ce017d8256be2feea27f"
ENV MINIO_UPDATE=off
EXPOSE 9000 9001
ENTRYPOINT ["minio"]
CMD ["server", "/data", "--console-address", ":9001"]
