# syntax=docker/dockerfile:1.19
ARG NODE_IMAGE=node:22.20.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=velyric-pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=velyric-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@velyric/db..."
RUN pnpm --filter "@velyric/db..." run build
RUN --mount=type=cache,id=velyric-pnpm-store,target=/pnpm/store \
    pnpm --filter "@velyric/db" deploy --legacy --prod /out

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.source="https://github.com/velyric/velyric" \
      org.opencontainers.image.vendor="Velyric" \
      org.opencontainers.image.title="@velyric/db-migrate"
ENV NODE_ENV=production \
    VELYRIC_MIGRATIONS_DIR=/app/migrations \
    VELYRIC_MIGRATION_ACTOR=velyric-migrate-task
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /repo/db/migrations ./migrations
USER node
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["migrate"]
