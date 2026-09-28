# syntax=docker/dockerfile:1.19
ARG NODE_IMAGE=node:22.20.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
WORKDIR /repo

FROM base AS build
ARG VELYRIC_CONTROL_API_URL
RUN case "${VELYRIC_CONTROL_API_URL}" in \
      http://*|https://*) ;; \
      *) echo "VELYRIC_CONTROL_API_URL build argument must be the internal control-api origin" >&2; exit 64 ;; \
    esac
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=velyric-pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=velyric-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@velyric/web..."
RUN VELYRIC_CONTROL_API_URL="${VELYRIC_CONTROL_API_URL}" pnpm --filter "@velyric/web..." run build

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.source="https://github.com/velyric/velyric" \
      org.opencontainers.image.vendor="Velyric" \
      org.opencontainers.image.title="@velyric/web"
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "apps/web/server.js"]
