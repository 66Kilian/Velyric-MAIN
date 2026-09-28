# syntax=docker/dockerfile:1.19
ARG NODE_IMAGE=node:22.20.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
WORKDIR /repo

FROM base AS build
ARG PACKAGE
RUN test -n "${PACKAGE}" || (echo "PACKAGE build argument is required" >&2 && exit 64)
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=velyric-pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=velyric-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "${PACKAGE}..."
RUN pnpm --filter "${PACKAGE}..." run build
RUN --mount=type=cache,id=velyric-pnpm-store,target=/pnpm/store \
    pnpm --filter "${PACKAGE}" deploy --legacy --prod /out

FROM ${NODE_IMAGE} AS runtime
ARG PACKAGE
ARG SERVICE_PORT=8080
LABEL org.opencontainers.image.source="https://github.com/velyric/velyric" \
      org.opencontainers.image.vendor="Velyric" \
      org.opencontainers.image.title="${PACKAGE}"
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE ${SERVICE_PORT}
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]
