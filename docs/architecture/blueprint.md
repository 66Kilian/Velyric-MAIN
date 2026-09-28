# Velyric Blueprint

Canonical coordination contract for every agent and engineer working in this monorepo. Owner: module `blueprint`. Status date: 2026-09-13.

Authority order: `docs/spec/implementation-master-spec.md` (technical) > `docs/spec/product-spec-v6.md` (business) > reference images > this blueprint > provider documentation. This blueprint turns the two specifications into exact names, values and conventions. Where the blueprint and the code in `packages/contracts` disagree, the code is a bug and must be fixed to match this document in the same change.

Rules that apply to every section:

- Only create or modify files inside paths you own (section 1.3). A needed change in a foreign path is requested from its owner; decisions not covered here are recorded in `docs/architecture/modules/<module-key>.md`.
- Shared lock/state files are mutated only through `node scripts/locked.mjs <lock> -- <command>` with lock names `pnpm` (any `pnpm install`/`pnpm add`/catalog edit), `cargo-manifest` (root `Cargo.toml` or `Cargo.lock` changes), `uv` (`uv lock`, `uv sync`, root `pyproject.toml` edits).
- No TODO/FIXME/placeholder, no fake success, no hardcoded demo data, no stubbed provider responses in production code. Simulators exist only in `packages/testkit` and refuse to start unless `VELYRIC_ENV=local` or `VELYRIC_ENV=ci`.
- No explanatory code comments. Only tool-required directives are allowed.
- TypeScript strict (`tsconfig.base.json`), Rust `unsafe_code = "forbid"` + clippy `-D warnings`, Python ruff + mypy strict + pydantic v2.

## 1. Directory layout, package names and ownership

### 1.1 Layout

```
velyric/
  apps/
    web/                         @velyric/web                 Next.js marketing + dashboard + support console
    control-api/                 @velyric/control-api         Fastify public + internal API
  services/
    voice-runtime/               velyric-voice-runtime        Rust realtime session/data plane
    metering-worker/             velyric-metering-worker      Rust usage/cost ingestion
    workflow-worker/             @velyric/workflow-worker     Temporal TypeScript workers
    connector-worker/            @velyric/connector-worker    OAuth/API/SMTP/custom tool egress
    document-worker/             velyric-document-worker      Python ingestion/OCR (module velyric_document_worker)
    eval-runner/                 velyric-eval-runner          Python scoring (module velyric_eval_runner)
                                 @velyric/eval-runner         TS scenario driver in services/eval-runner/ts/
  packages/
    domain/                      @velyric/domain              domain model, policies, state machines
    contracts/                   @velyric/contracts           enums, API/event/JSON Schema contracts, generated artifacts
      state-machines/            (owned by domain)            JSON transition tables
    ui/                          @velyric/ui                  bespoke React design system + Storybook
    i18n/                        @velyric/i18n                HU/DE/EN messages + formatting
    connectors/                  @velyric/connectors          provider adapters
    config/                      @velyric/config              env schemas, flag evaluation, shared config
    testkit/                     @velyric/testkit             fixtures, factories, provider simulators
    db/                          @velyric/db                  Kysely types, migration runner, tx/RLS helpers, test harness
    security/                    @velyric/security            crypto, service JWT, SSRF guard, webhook verify, redaction
    observability/               @velyric/observability       OpenTelemetry + pino + Sentry bootstrap
    notifications/               @velyric/notifications       notification catalog, templates, delivery policies
  crates/
    call-protocol/               velyric-call-protocol        prost types from proto/ + event envelope
    runtime-policy/              velyric-runtime-policy       admission, budgets, call-local safety primitives
    common-observability/        velyric-common-observability tracing/OTel/metrics helpers
  tools/
    loadgen/                     velyric-loadgen              Rust load generator (bin velyric-loadgen)
  fuzz/                          velyric-fuzz                 cargo-fuzz targets in fuzz/fuzz_targets/, feature libfuzzer
  db/
    migrations/                  SQL migrations + manifest.json
    policies/                    RLS policy SQL included by migrations
    seeds/                       local/ci synthetic seeds only
  proto/
    call_events.proto
    metering.proto
  evals/
    scenarios/  rubrics/  datasets/
  infra/
    tofu/  docker/  runbooks/  dashboards/  observability/
  tests/
    e2e/        @velyric/e2e
    visual/     @velyric/visual-tests
    a11y/       @velyric/a11y-tests
    load/       @velyric/load-tests
    chaos/      @velyric/chaos-tests
    dr/         @velyric/dr-tests
    security/   @velyric/security-tests
  docs/
    spec/ (read-only)  architecture/  api/  operations/  security/
  scripts/                       root tooling (bootstrap, dev, locked)
  .github/workflows/
```

Workspace membership: `pnpm-workspace.yaml` globs `apps/*`, `packages/*`, `services/*`, `tools/*`, `tests/*`. Cargo workspace members are listed explicitly in root `Cargo.toml` (`crates/call-protocol`, `crates/runtime-policy`, `crates/common-observability`, `services/voice-runtime`, `services/metering-worker`, `tools/loadgen`, `fuzz`). uv workspace members: `services/document-worker`, `services/eval-runner`. A directory may be both a pnpm and a uv member (`services/eval-runner`).

Boundary rules (master 6): business logic lives in `packages/domain` or a control-api module service, never in React components or route handlers; Rust and Python services never read control-plane tables directly (only `metering-worker` owns its own usage tables through the migration chain, see 9.8); contracts are defined once in `packages/contracts` + `proto/`; shared utilities contain only cross-cutting primitives.

### 1.2 Generated artifact locations

| Artifact                           | Source                                                     | Output                                                                                                                          | Owner                                            |
| ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Enum registry JSON                 | `packages/contracts/src/enums.ts`, `topology.ts`           | `packages/contracts/generated/enums.json`                                                                                       | contracts                                        |
| State machine tables               | `packages/domain/src/state-machines/*.ts`                  | `packages/contracts/state-machines/<machine>.json`                                                                              | domain                                           |
| JSON Schema of API/event contracts | `packages/contracts/src/api/**`, `src/events/**` (TypeBox) | `packages/contracts/generated/json-schema/**`                                                                                   | contracts                                        |
| OpenAPI 3.1                        | control-api route registry                                 | `docs/api/openapi.public.json`, `docs/api/openapi.internal.json`                                                                | contracts (generator), control-api-core (routes) |
| Protobuf TS                        | `proto/*.proto` via `@bufbuild/protoc-gen-es`              | `packages/contracts/src/generated/proto/`                                                                                       | contracts                                        |
| Protobuf Rust                      | `proto/*.proto` via `protox` + `prost-build` in `build.rs` | `OUT_DIR` of `velyric-call-protocol`                                                                                            | contracts                                        |
| Rust enum mirror                   | `generated/enums.json`                                     | `crates/call-protocol/src/generated/enums.rs` (checked in, regenerated by `cargo run -p velyric-call-protocol --bin gen-enums`) | contracts                                        |
| Python enum mirror                 | `generated/enums.json`                                     | `services/<svc>/src/<module>/generated/enums.py`                                                                                | document-worker, eval-runner                     |

Every generator supports `--check` and runs in `pnpm verify`; stale output fails CI.

### 1.3 Ownership map

Globs are relative to the repo root. Every module additionally owns `docs/architecture/modules/<module-key>.md`. The more specific glob wins.

| Module key                    | Owned globs                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| blueprint                     | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `prettier.config.js`, `.prettierignore`, `.editorconfig`, `.gitattributes`, `.gitignore`, `.nvmrc`, `.python-version`, `Cargo.toml`, `rust-toolchain.toml`, `deny.toml`, `clippy.toml`, `rustfmt.toml`, `pyproject.toml`, `scripts/**`, `docs/architecture/blueprint.md` |
| db                            | `db/**`, `packages/db/**`, `docs/architecture/erd.md`                                                                                                                                                                                                                                                                                                     |
| contracts                     | `packages/contracts/**` except `packages/contracts/state-machines/**`; `proto/**`; `crates/call-protocol/**`; `docs/api/**`                                                                                                                                                                                                                               |
| domain                        | `packages/domain/**`, `packages/contracts/state-machines/**`                                                                                                                                                                                                                                                                                              |
| platform-config               | `packages/config/**`, `packages/observability/**`, `packages/testkit/**`, `.env.example`                                                                                                                                                                                                                                                                  |
| security-primitives           | `packages/security/**`                                                                                                                                                                                                                                                                                                                                    |
| ui                            | `packages/ui/**`                                                                                                                                                                                                                                                                                                                                          |
| i18n                          | `packages/i18n/**` except namespaces listed for web-marketing                                                                                                                                                                                                                                                                                             |
| control-api-core              | `apps/control-api/**` except the module directories below                                                                                                                                                                                                                                                                                                 |
| control-api-agents-calls      | `apps/control-api/src/modules/{agents,agent-versions,calls,contacts,analytics,quality,tool-gateway,runtime-snapshots}/**`                                                                                                                                                                                                                                 |
| control-api-commerce          | `apps/control-api/src/modules/{billing,checkout,webhooks,phone-numbers,provisioning,notifications,fraud}/**`                                                                                                                                                                                                                                              |
| control-api-knowledge-booking | `apps/control-api/src/modules/{knowledge,integrations,custom-tools,bookings,waitlist,locations,simulations,privacy,support}/**`                                                                                                                                                                                                                           |
| connectors-commerce           | `packages/connectors/package.json`, `packages/connectors/tsconfig*.json`, `packages/connectors/vitest.config.ts`, `packages/connectors/src/index.ts`, `packages/connectors/src/shared/**`, `packages/connectors/src/{stripe,billingo}/**`                                                                                                                 |
| connectors-telephony-ai       | `packages/connectors/src/{telnyx,twilio,openai}/**`                                                                                                                                                                                                                                                                                                       |
| connectors-productivity       | `packages/connectors/src/{google,microsoft,ses,smtp,custom-api}/**`                                                                                                                                                                                                                                                                                       |
| workflow-worker               | `services/workflow-worker/**`, `packages/notifications/**`                                                                                                                                                                                                                                                                                                |
| connector-worker              | `services/connector-worker/**`                                                                                                                                                                                                                                                                                                                            |
| voice-runtime                 | `services/voice-runtime/**`, `crates/runtime-policy/**`, `crates/common-observability/**`                                                                                                                                                                                                                                                                 |
| metering-worker               | `services/metering-worker/**`, `tools/loadgen/**`, `fuzz/**`                                                                                                                                                                                                                                                                                              |
| document-worker               | `services/document-worker/**`                                                                                                                                                                                                                                                                                                                             |
| eval-runner                   | `services/eval-runner/**`, `evals/**`                                                                                                                                                                                                                                                                                                                     |
| web-foundation                | `apps/web/**` except the route groups and component directories below                                                                                                                                                                                                                                                                                     |
| web-marketing                 | `apps/web/src/app/[locale]/(marketing)/**`, `apps/web/src/app/legal/**`, `apps/web/src/app/status/**`, `apps/web/src/components/marketing/**`, `packages/i18n/messages/*/marketing*.json`, `packages/i18n/messages/*/legal*.json`                                                                                                                         |
| web-dashboard-core            | `apps/web/src/app/app/[workspace]/(core)/{dashboard,calls,agents}/**`, `apps/web/src/components/dashboard/core/**`                                                                                                                                                                                                                                        |
| web-dashboard-ops             | `apps/web/src/app/app/[workspace]/(ops)/{knowledge,contacts,bookings,integrations,analytics,phone-numbers,locations,simulation}/**`, `apps/web/src/components/dashboard/ops/**`                                                                                                                                                                           |
| web-dashboard-admin           | `apps/web/src/app/app/[workspace]/(admin)/{billing,settings,security}/**`, `apps/web/src/app/[locale]/(auth)/**`, `apps/web/src/app/[locale]/(commerce)/**`, `apps/web/src/app/app/onboarding/**`, `apps/web/src/components/dashboard/admin/**`                                                                                                           |
| web-support-console           | `apps/web/src/app/internal/support/**`, `apps/web/src/components/support/**`                                                                                                                                                                                                                                                                              |
| infra                         | `infra/tofu/**`                                                                                                                                                                                                                                                                                                                                           |
| runtime-ops                   | `infra/docker/**`, `infra/observability/**`, `infra/dashboards/**`                                                                                                                                                                                                                                                                                        |
| ci-security                   | `.github/**`, `.gitleaks.toml`, `.semgrep/**`, `osv-scanner.toml`, `.trivyignore`, `renovate.json`                                                                                                                                                                                                                                                        |
| docs                          | `README.md`, `docs/**` except `docs/spec/**`, `docs/api/**`, `docs/architecture/blueprint.md`, `docs/architecture/modules/**`, `docs/architecture/erd.md`; `infra/runbooks/**`                                                                                                                                                                            |
| e2e-quality                   | `tests/e2e/**`, `tests/visual/**`, `tests/a11y/**`                                                                                                                                                                                                                                                                                                        |
| resilience                    | `tests/load/**`, `tests/chaos/**`, `tests/dr/**`, `tests/security/**`                                                                                                                                                                                                                                                                                     |

i18n namespace files owned by feature modules are listed in 10.6; the `packages/i18n` owner owns loaders, formatting and all other namespaces.

## 2. Pinned toolchains and libraries

Checked against npm, the crates.io sparse index and PyPI on 2026-09-13: 206 of 210 pins are the latest stable release. The four deliberate exceptions are listed in 2.5. All pins are exact. npm pins live only in the `catalog:` of `pnpm-workspace.yaml`; package manifests reference them as `"catalog:"`. Rust pins live only in `[workspace.dependencies]`; member crates use `dep.workspace = true`. Python pins are exact `==` in the member `pyproject.toml` files and the root `dev` dependency group. `minimumReleaseAge: 1440` (one day) quarantines brand-new npm releases.

### 2.1 Toolchains

| Tool       | Pin                                                                                      | Where                                      |
| ---------- | ---------------------------------------------------------------------------------------- | ------------------------------------------ |
| Node.js    | 22.20.0 (engines `>=22.20.0 <23`)                                                        | `.nvmrc`, `package.json#engines`           |
| pnpm       | 11.24.0                                                                                  | `package.json#packageManager`              |
| Rust       | 1.98.1, edition 2024, resolver 3, components clippy + rustfmt                            | `rust-toolchain.toml`, `Cargo.toml`        |
| Python     | 3.11 (`requires-python >=3.11,<3.12`)                                                    | `.python-version`, member `pyproject.toml` |
| uv         | `>=0.12.0,<0.13`                                                                         | `pyproject.toml#tool.uv.required-version`  |
| TypeScript | 6.0.3                                                                                    | catalog                                    |
| Go         | any, only for `go install` of local test servers (nats-server, temporal CLI) into GOPATH | optional                                   |

`node scripts/bootstrap.mjs --check` verifies these.

### 2.2 TypeScript libraries (catalog)

| Area            | Package                                                                                                                         | Version                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Web framework   | next / react / react-dom                                                                                                        | 16.3.5 / 19.3.0 / 19.3.0                 |
|                 | @types/react / @types/react-dom                                                                                                 | 19.3.0 / 19.3.0                          |
|                 | babel-plugin-react-compiler / server-only                                                                                       | 1.0.0 / 0.0.1                            |
| Styling         | tailwindcss / @tailwindcss/postcss / postcss                                                                                    | 4.3.3 / 4.3.3 / 8.5.28                   |
| Primitives      | radix-ui (unified package)                                                                                                      | 1.6.7                                    |
| Motion          | motion                                                                                                                          | 13.2.0                                   |
| Charts          | @visx/axis, curve, gradient, group, responsive, scale, shape, tooltip                                                           | 4.0.0                                    |
| Data            | @tanstack/react-query / @tanstack/react-virtual                                                                                 | 5.102.8 / 3.14.12                        |
| Forms           | react-hook-form / @hookform/resolvers                                                                                           | 7.88.0 / 5.9.1                           |
| Schemas         | zod / typebox / ajv / ajv-formats                                                                                               | 4.6.2 / 1.3.30 / 8.20.0 / 3.0.1          |
| i18n            | next-intl                                                                                                                       | 4.14.4                                   |
| Fonts / icons   | geist / lucide-react                                                                                                            | 1.7.2 / 1.45.0                           |
| Auth            | in-house email/password (scrypt + signed session tokens, @velyric/security)                                                     | —                                         |
| Email templates | @react-email/components / react-email                                                                                           | 1.0.12 / 6.9.5                           |
| API server      | fastify / fastify-plugin                                                                                                        | 5.12.4 / 6.0.0                           |
|                 | @fastify/cookie, cors, etag, helmet, multipart                                                                                  | 11.1.2, 11.3.0, 6.2.0, 13.1.1, 10.1.1    |
|                 | @fastify/otel, rate-limit, sensible, swagger, swagger-ui                                                                        | 0.21.0, 11.2.0, 6.0.5, 9.8.1, 6.1.1      |
|                 | @fastify/type-provider-typebox / @fastify/under-pressure                                                                        | 6.1.0 / 9.1.0                            |
| SQL             | kysely / pg / @types/pg                                                                                                         | 0.29.5 / 8.23.0 / 8.23.1                 |
| Workflows       | @temporalio/activity, client, common, testing, worker, workflow                                                                 | 1.23.0                                   |
| Messaging       | @nats-io/transport-node / jetstream / kv                                                                                        | 3.4.0                                    |
| Cache           | ioredis                                                                                                                         | 6.0.0                                    |
| Crypto/JWT      | jose                                                                                                                            | 6.2.12                                   |
| Ids / HTTP      | uuid / undici                                                                                                                   | 14.0.2 / 8.10.2                          |
| Phone numbers   | libphonenumber-js                                                                                                               | 1.13.13                                  |
| Protobuf        | @bufbuild/protobuf / protoc-gen-es / buf                                                                                        | 2.15.0 / 2.15.0 / 1.73.0                 |
| OpenAPI         | openapi-typescript                                                                                                              | 7.13.0                                   |
| Telemetry       | @opentelemetry/api                                                                                                              | 1.9.1                                    |
|                 | @opentelemetry/sdk-node, exporter-trace-otlp-http, exporter-metrics-otlp-http, exporter-logs-otlp-http, sdk-logs                | 0.222.0                                  |
|                 | @opentelemetry/sdk-metrics, resources                                                                                           | 2.11.0                                   |
|                 | @opentelemetry/semantic-conventions / auto-instrumentations-node                                                                | 1.43.0 / 0.80.0                          |
|                 | @opentelemetry/instrumentation-pino / instrumentation-undici                                                                    | 0.68.0 / 0.32.0                          |
| Logging         | pino / pino-pretty (local only)                                                                                                 | 10.3.1 / 13.1.3                          |
| Errors          | @sentry/node / @sentry/nextjs                                                                                                   | 10.74.0                                  |
| Providers       | stripe                                                                                                                          | 22.6.2                                   |
|                 | openai                                                                                                                          | 7.15.0                                   |
|                 | telnyx / twilio                                                                                                                 | 7.21.0 / 6.1.1                           |
|                 | @googleapis/calendar / google-auth-library                                                                                      | 19.0.0 / 11.0.2                          |
|                 | @microsoft/microsoft-graph-client / @azure/msal-node                                                                            | 3.0.7 / 6.0.0                            |
|                 | @aws-sdk/client-sesv2, client-kms, client-secrets-manager, client-s3, s3-request-presigner                                      | 3.1131.0                                 |
|                 | nodemailer / @types/nodemailer                                                                                                  | 10.0.9 / 8.0.1                           |
| Tests           | vitest / @vitest/coverage-v8 / vite                                                                                             | 5.0.0 / 5.0.0 / 8.3.0                    |
|                 | @vitejs/plugin-react / jsdom / @testing-library/react                                                                           | 6.1.1 / 30.0.1 / 16.3.3                  |
|                 | fast-check / @fast-check/vitest / msw                                                                                           | 4.10.0 / 0.5.0 / 2.15.0                  |
|                 | @playwright/test / @axe-core/playwright                                                                                         | 1.63.0 / 4.13.0                          |
|                 | storybook, @storybook/nextjs-vite, @storybook/react-vite, @storybook/addon-a11y, @storybook/addon-vitest                        | 10.6.0                                   |
|                 | embedded-postgres / @electric-sql/pglite / get-port                                                                             | 18.4.0-beta.17 / 0.5.8 / 7.2.0           |
| Tooling         | eslint / @eslint/js / typescript-eslint                                                                                         | 10.10.0 / 10.0.1 / 8.70.0                |
|                 | eslint-plugin-security / eslint-config-prettier / eslint-plugin-react-hooks / eslint-plugin-jsx-a11y / @next/eslint-plugin-next | 4.0.1 / 10.1.8 / 7.1.1 / 6.10.2 / 16.3.5 |
|                 | globals / prettier / tsx / @types/node                                                                                          | 17.12.0 / 3.9.6 / 4.23.13 / 22.20.2      |

Library choices that the spec left open:

- **next-intl** over alternatives: native App Router + `proxy.ts` integration, ICU messages, typed keys, server-component APIs.
- **Kysely** over Drizzle: SQL-first builder, raw SQL migrations stay the source of truth, explicit `db.transaction().execute()` gives the connection on which `SET LOCAL` runs (9.3).
- **TypeBox 1.x (`typebox`)** is the only wire-contract language (HTTP bodies, events, config files exchanged across processes); it produces JSON Schema natively for OpenAPI, Rust and Python.
- **Zod 4** is used for user-input schemas shared by web forms and the control-api command layer (`packages/domain/src/inputs/**`), connected to React Hook Form through `@hookform/resolvers/standard-schema` (the `@hookform/resolvers/typebox` resolver targets the legacy `@sinclair/typebox` 0.x line and must not be used). Each API body that accepts a form has a paired Zod input; `packages/contracts` runs a contract test comparing `z.toJSONSchema(input)` with the TypeBox body schema so the two never drift.
- **radix-ui** unified package only as unstyled accessibility primitives; no shadcn styles.
- **jose** for all JWT/JWS in TypeScript (service JWTs, widget tokens); **jsonwebtoken + ed25519-dalek** in Rust.

### 2.3 Rust crates (`[workspace.dependencies]`)

| Area           | Crate                                                                                                | Version / features                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Async          | tokio                                                                                                | 1.53.1 (rt-multi-thread, macros, net, time, sync, signal, io-util)                                  |
|                | tokio-util / tokio-stream / futures-util / bytes / dashmap                                           | 0.7.19 (rt) / 0.1.19 / 0.3.34 / 1.12.1 / 6.2.1                                                      |
| HTTP server    | axum                                                                                                 | 0.8.9 (default-features off; http1, http2, json, matched-path, original-uri, query, tokio, tracing) |
|                | tower / tower-http / http / url                                                                      | 0.5.3 / 0.7.1 / 1.5.0 / 2.5.8                                                                       |
| TLS            | rustls                                                                                               | 0.23.44 (ring provider only; aws-lc-sys, openssl-sys, native-tls banned in `deny.toml`)             |
| HTTP client    | reqwest                                                                                              | 0.13.5 (rustls-no-provider, http2, json, charset, stream)                                           |
| WebSocket      | tokio-tungstenite                                                                                    | 0.30.0 (connect, handshake, rustls-tls-webpki-roots)                                                |
| NATS           | async-nats                                                                                           | 0.50.0 (ring, jetstream, nkeys, nuid, server_2_10..2_14)                                            |
| Redis          | redis                                                                                                | 1.7.0 (aio, tokio-rustls-comp, tls-rustls-webpki-roots, connection-manager, script, acl)            |
| SQL            | sqlx                                                                                                 | 0.9.0 (runtime-tokio, tls-rustls-ring-webpki, postgres, macros, uuid, time, json, derive)           |
| Serialization  | serde / serde_json                                                                                   | 1.0.229 / 1.0.151                                                                                   |
| Protobuf       | prost / prost-types / prost-build / protox                                                           | 0.14.4 / 0.14.4 / 0.14.4 / 0.9.1                                                                    |
| Types          | uuid (v7, serde) / time                                                                              | 1.26.1 / 0.3.55                                                                                     |
| Errors         | thiserror / anyhow                                                                                   | 2.0.20 / 1.0.104                                                                                    |
| Secrets/crypto | secrecy / jsonwebtoken (rust_crypto, use_pem) / ed25519-dalek / sha2 / hex / base64 / rand / zeroize | 0.10.3 / 11.0.0 / 2.2.0 / 0.11.0 / 0.4.3 / 0.23.1 / 0.10.2 / 1.9.0                                  |
| CLI            | clap                                                                                                 | 4.6.6                                                                                               |
| Metrics        | hdrhistogram                                                                                         | 7.6.0                                                                                               |
| Telemetry      | tracing / tracing-subscriber / tracing-opentelemetry                                                 | 0.1.44 / 0.3.23 / 0.33.0                                                                            |
|                | opentelemetry / opentelemetry_sdk / opentelemetry-otlp / opentelemetry-semantic-conventions          | 0.32.0 / 0.32.1 / 0.32.0 (http-proto, reqwest-client) / 0.32.1                                      |
| Tests          | proptest / arbitrary / libfuzzer-sys / pretty_assertions / wiremock / tokio-test / insta             | 1.11.0 / 1.4.2 / 0.4.13 / 1.4.1 / 0.6.5 / 0.4.5 / 1.48.0                                            |

### 2.4 Python packages

| Package                                                                    | Version                                           | Used by         |
| -------------------------------------------------------------------------- | ------------------------------------------------- | --------------- |
| pydantic / pydantic-settings                                               | 2.13.5 / 2.15.0                                   | both services   |
| pypdf / pdfplumber / python-docx / markdown-it-py / filetype / pytesseract | 6.18.1 / 0.11.10 / 1.2.0 / 4.2.0 / 1.2.0 / 0.3.13 | document-worker |
| polars                                                                     | 1.44.2                                            | eval-runner     |
| openai                                                                     | 3.13.0                                            | both            |
| nats-py / boto3 / httpx / structlog / uuid-utils                           | 2.15.0 / 1.43.93 / 0.28.1 / 26.1.0 / 1.0.0        | both            |
| opentelemetry-api / sdk / exporter-otlp-proto-http                         | 1.44.0                                            | both            |
| ruff / mypy / pytest / pytest-asyncio / pytest-cov / hypothesis            | 0.16.7 / 2.3.1 / 9.1.1 / 1.4.0 / 7.1.1 / 6.168.0  | root dev group  |
| moto[s3,server] / boto3-stubs[s3]                                          | 5.2.3 / 1.43.93                                   | root dev group  |

### 2.5 Deliberate non-latest pins

| Pin                 | Latest | Reason                                                                                    |
| ------------------- | ------ | ----------------------------------------------------------------------------------------- |
| typescript 6.0.3    | 7.0.2  | typescript-eslint 8.70.0 peer range is `>=4.8.4 <6.1.0`.                                  |
| @types/node 22.20.2 | 26.x   | Must match the Node 22 runtime.                                                           |
| zod 4.6.2           | 4.6.4  | 4.6.3 and 4.6.4 were published less than 24 h ago and are blocked by `minimumReleaseAge`. |
| ed25519-dalek 2.2.0 | 3.0.0  | jsonwebtoken 11.0.0 depends on 2.2; a second major would duplicate the Ed25519 stack.     |

Upgrades are made by the blueprint owner under the `pnpm` / `cargo-manifest` / `uv` locks.

### 2.6 Container images for local dev and CI

Tags below are the current releases; `infra/docker/compose.dev.yml` and CI service definitions pin them by `@sha256` digest.

| Service             | Image                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Postgres + pgvector | `pgvector/pgvector:0.8.6-pg18`                                                                         |
| Redis               | `redis:8.10.1`                                                                                         |
| NATS JetStream      | `nats:2.14.6-alpine` (the unsuffixed tag ships no shell/wget, which the compose healthcheck needs)    |
| Temporal dev server | `temporalio/temporal:1.8.3` (Temporal CLI, `server start-dev`)                                         |
| Object storage      | `velyric-minio:source-7aac2a2-77f82e1` (sandbox image built from checksum-pinned upstream sources) |
| Mail capture        | `axllent/mailpit:v1.31.1`                                                                              |
| Malware scan        | `clamav/clamav:1.5.4-debian`                                                                           |
| OTel collector      | `otel/opentelemetry-collector-contrib:0.160.0`                                                         |
| Grafana             | `grafana/grafana:13.2.1`                                                                               |

## 3. Canonical enumerations

All enumerations are implemented in `packages/contracts/src/enums.ts` (plus topology names in `src/topology.ts`) and exported from `@velyric/contracts`. Each is a frozen `as const` object with a same-named union type, plus `enumValues`, `isEnumValue` and `parseEnumValue` helpers. `packages/contracts/generated/enums.json` (`{ "schema_version": 1, "enums": { ... } }`) is the language-neutral copy consumed by SQL enum checks, Rust and Python.

Casing rules: status/state/code enums use UPPER_SNAKE values equal to the key. Lowercase values are used where the value is an external identifier: environments, locales, service names, provider ids, model ids, permission strings (`resource:action`, platform permissions `platform.resource:action`), feature keys (`snake_case`), flag keys (`feature.<area>.<name>`), kill switch keys (`kill.<name>`), usage metrics, event types (`<aggregate>.<past_tense_event>`), queue and bucket names. Values are append-only: renaming or removing a value requires an expand/contract migration and a new contract version.

### 3.1 Reconciliation decisions

- **Tenant lifecycle (`TenantStatus`)** merges master 24 with v6 32.11-32.12. Payment path: `ACTIVE -> PAYMENT_AT_RISK` (Stripe `invoice.payment_failed` before the renewal day) `-> GRACE_PERIOD` (day 0 renewal failure) `-> RESTRICTED` (optional policy step during grace: outbound and premium routing off, inbound human-forward/informational mode on) `-> SUSPENDED_BILLING` (end of day +2). Dispute path: any active state `-> SUSPENDED_DISPUTE`. Fraud/abuse: `SUSPENDED_RISK`; staff action: `SUSPENDED_ADMIN`. Cancellation: `CANCELED_GRACE -> SUSPENDED_BILLING -> DATA_RETENTION -> DELETION -> DELETED` (v6 `SUSPENDED` maps to `SUSPENDED_BILLING`). `PROVISIONING` is the state between tenant row creation and go-live. Reactivation (`invoice.paid`) returns any `PAYMENT_AT_RISK`, `GRACE_PERIOD`, `RESTRICTED`, `SUSPENDED_BILLING` or `CANCELED_GRACE` tenant to `ACTIVE`; `DATA_RETENTION` and later are not reactivatable without a new order. No state change deletes configuration, knowledge, OAuth config, analytics or the tenant.
- **Provisioning (`ProvisioningState`)** is the union of master 22 and v6 32.6. v6 `LIVE` is represented as `ACTIVE`; master `PHONE_SEARCH/RESERVE` splits into `PHONE_RESERVING` and `PHONE_ORDERING`; `KYC_REQUIRED?` is `PHONE_KYC_REQUIRED`; the wait is `WAITING_FOR_CUSTOMER` / `PHONE_UNDER_REVIEW` / `WAITING_FOR_PROVIDER`; `KNOWLEDGE/DEFAULT_AGENT_READY` is `AGENT_READY`; `TEST_CALL_READY` and `GO_LIVE_ELIGIBLE` follow. Failure handling: `MANUAL_REVIEW_REQUIRED` (retries exhausted or irreversible error; Internal Support Console queue), `COMPENSATING -> COMPENSATED` (refund/cleanup workflow, v6 32.13), `CANCELED`. Financial invariant: `PAYMENT_CONFIRMED -> BILLING_DOCUMENT_CREATED -> ` provisioning-eligible; a paid order whose invoice is still pending is visible as `BILLING_PENDING` and alerts. Per-step detail lives in `ProvisioningStep` x `ProvisioningStepStatus`.
- **Phone/KYC** follows v6 32.4 exactly in `PhoneOrderStatus` (`NUMBER_SELECTED, KYC_REQUIRED, UNDER_REVIEW, APPROVED, DECLINED, NO_INVENTORY` plus operational `RESERVED, ORDER_SUBMITTED, FAILED, CANCELED`); requirement documents use `KycRequirementStatus`; the owned number uses `PhoneNumberStatus` (with `RETENTION_HOLD` for the paid/included quarantine).
- **Conversation (`ConversationState`)** is the union of master 15.1 and v6 8: `GREETING, DISCOVERY, IDENTITY, ACTION_PREVIEW, CONFIRMATION_GATE, TOOL_EXECUTION, RESULT_CONFIRMATION, FOLLOW_UP, HANDOFF, SAFE_FAILURE, CLOSING, END`. v6 `CONFIRMATION` is `RESULT_CONFIRMATION`. `CONFIRMATION_GATE` can never be skipped for a `WRITE`, `HIGH_RISK_WRITE` or `EXTERNAL_COMMUNICATION` tool.
- **Transfer (`TransferState`)** is v6 31.4: `PREPARING -> DIALING_AGENT -> AGENT_ANSWERED -> WHISPER -> BRIDGING -> COMPLETED`, with `FAILED -> RETURNED_TO_AI` and `CANCELED`. Cold transfer skips `DIALING_AGENT..WHISPER`.
- **Roles** follow master 11 plus v6 31.12 read-only: `OWNER, ADMIN, OPERATOR, ANALYST, DEVELOPER, BILLING, VIEWER`. Support-internal is a staff-side `PlatformRole` with JIT `SupportGrantStatus`, never a tenant membership.
- **Usage** is seconds-based (v6 24): `connected_voice_seconds` is measured, `billable_voice_seconds` is derived and reduces included allowance second by second.

### 3.2 Money and usage rules

- Money columns and fields are `bigint` minor units + `char(3)` ISO currency; never floats. Provider costs use `USD_MICROS` (1 USD = 1 000 000).
- Period overage charge in minor units = `ceil(max(0, billable_voice_seconds - included_voice_seconds) * overage_per_minute_net_minor / 60)`, computed once per billing period on the aggregate, not per call.
- Price selection uses `BillingMarket` from the billing profile country (`HU` for Hungary, `INTERNATIONAL` otherwise), never the UI locale and never runtime FX. The `INTERNATIONAL` EUR price book is a human policy input (section 13); until provided, `PRICE_BOOK_UNAVAILABLE` is returned for that market.
- Concurrency limit for a tenant = plan `concurrentCalls` + `CONCURRENCY_BOOST` units x 5, or the enterprise contract value; the trust ramp (`TrustTier.NEW`) may lower it further.

### 3.3 Where these values are consumed

- PostgreSQL stores enums as `text` with `CHECK (col IN (...))` constraints generated from `enums.json` (section 9.6).
- Rust uses `crates/call-protocol/src/generated/enums.rs` (serde `rename` to the exact string).
- Python uses pydantic `StrEnum` classes generated per service.
- i18n labels use the key pattern `enums.<EnumName>.<VALUE>`.

### 3.4 Enumeration catalog

Generated from `packages/contracts/generated/enums.json`. The TypeScript constant name equals the enum name; keys are UPPER_SNAKE; the value column is the exact persisted/wire string.

#### Environment, locale and money

**VelyricEnvironment**: `LOCAL`=`local`, `CI`=`ci`, `STAGING`=`staging`, `PRODUCTION`=`production`

**ProviderMode**: `SIMULATOR`=`simulator`, `SANDBOX`=`sandbox`, `LIVE`=`live`

**Locale**: `HU`=`hu`, `DE`=`de`, `EN`=`en`

**ThemePreference**: `LIGHT`=`light`, `DARK`=`dark`, `SYSTEM`=`system`

**Currency** (value = key): `HUF`, `EUR`, `USD`

**BillingMarket** (value = key): `HU`, `INTERNATIONAL`

**ServiceName**: `WEB`=`web`, `CONTROL_API`=`control-api`, `VOICE_RUNTIME`=`voice-runtime`, `WORKFLOW_WORKER`=`workflow-worker`, `CONNECTOR_WORKER`=`connector-worker`, `METERING_WORKER`=`metering-worker`, `DOCUMENT_WORKER`=`document-worker`, `EVAL_RUNNER`=`eval-runner`, `PROVIDER_SIMULATOR`=`provider-simulator`

#### Tenant lifecycle and billing

**TenantStatus** (value = key): `PROVISIONING`, `ACTIVE`, `PAYMENT_AT_RISK`, `GRACE_PERIOD`, `RESTRICTED`, `SUSPENDED_BILLING`, `SUSPENDED_DISPUTE`, `SUSPENDED_RISK`, `SUSPENDED_ADMIN`, `CANCELED_GRACE`, `DATA_RETENTION`, `DELETION`, `DELETED`

**SubscriptionStatus** (value = key): `INCOMPLETE`, `INCOMPLETE_EXPIRED`, `TRIALING`, `ACTIVE`, `PAST_DUE`, `UNPAID`, `PAUSED`, `CANCELED`

**CheckoutOrderStatus** (value = key): `DRAFT`, `AWAITING_PAYMENT`, `PAID`, `PAYMENT_FAILED`, `EXPIRED`, `CANCELED`, `PARTIALLY_REFUNDED`, `REFUNDED`

**BillingDocumentType** (value = key): `INVOICE`, `MODIFICATION_INVOICE`, `CANCELLATION_INVOICE`

**BillingDocumentStatus** (value = key): `PENDING`, `CREATED`, `SENT`, `SEND_FAILED`, `FAILED`, `CORRECTED`, `CANCELED`

**FeatureRetentionState** (value = key): `ENABLED`, `DISABLED_RETAINED`, `PURGE_SCHEDULED`, `PURGED`

**PlanCode** (value = key): `START`, `BUSINESS`, `PRO`, `ENTERPRISE`

**BurstPolicy** (value = key): `NONE`, `PAID_BURST`, `CONFIGURABLE`, `CONTRACTUAL`

**AddOnCode** (value = key): `EXTRA_PHONE_NUMBER`, `EXTRA_LOCATION`, `OUTBOUND_CALLING`, `PREMIUM_REASONING`, `CUSTOM_INTEGRATION_SETUP`, `PRIVATE_CONNECTOR`, `LARGE_KNOWLEDGE_STORAGE`, `CALL_RECORDING`, `EXTENDED_RETENTION`, `PHONE_NUMBER_RETENTION`, `DEDICATED_SLA_SUPPORT`, `WHITE_LABEL_DOMAIN`, `SIMULATION_CREDITS`, `PCI_PAYMENTS`, `SSO_SCIM`, `SIEM_EXPORT`, `BYOK`, `DEDICATED_REDUNDANCY`, `CONCURRENCY_BOOST`

**AddOnBillingType** (value = key): `RECURRING_MONTHLY`, `ONE_TIME`, `USAGE_BASED`

**FeatureKey**: `KNOWLEDGE_BASE`=`knowledge_base`, `HUMAN_HANDOFF`=`human_handoff`, `DTMF_ROUTING`=`dtmf_routing`, `BUSINESS_HOURS_ROUTING`=`business_hours_routing`, `CALLER_MEMORY`=`caller_memory`, `TRANSACTIONAL_EMAIL`=`transactional_email`, `QUALITY_MONITORING`=`quality_monitoring`, `WEB_VOICE_TEST_CALL`=`web_voice_test_call`, `GOOGLE_CALENDAR`=`google_calendar`, `MICROSOFT_365`=`microsoft_365`, `CUSTOM_SMTP`=`custom_smtp`, `CUSTOM_API_TOOLS`=`custom_api_tools`, `OUTBOUND_WEBHOOKS`=`outbound_webhooks`, `PUBLIC_API`=`public_api`, `BOOKING_ENGINE`=`booking_engine`, `WAITLIST`=`waitlist`, `WARM_TRANSFER`=`warm_transfer`, `KNOWLEDGE_INTELLIGENCE`=`knowledge_intelligence`, `WEB_VOICE_WIDGET`=`web_voice_widget`, `ROI_ANALYTICS`=`roi_analytics`, `MULTI_WORKFLOW`=`multi_workflow`, `ADVANCED_CALL_ROUTING`=`advanced_call_routing`, `MULTI_LOCATION`=`multi_location`, `SIMULATION_LAB`=`simulation_lab`, `PRIORITY_SUPPORT`=`priority_support`, `PREMIUM_REASONING`=`premium_reasoning`, `OUTBOUND_CALLING`=`outbound_calling`, `CALL_RECORDING`=`call_recording`, `SSO_SCIM`=`sso_scim`, `SIEM_EXPORT`=`siem_export`, `BYOK`=`byok`, `PCI_PAYMENTS`=`pci_payments`, `DEDICATED_REDUNDANCY`=`dedicated_redundancy`, `CONTRACTUAL_SLA`=`contractual_sla`, `WHITE_LABEL`=`white_label`

**UsageMetric**: `CONNECTED_VOICE_SECONDS`=`connected_voice_seconds`, `BILLABLE_VOICE_SECONDS`=`billable_voice_seconds`, `LIVE_VOICE_COST`=`live_voice_cost`, `BACKEND_INPUT_TOKENS`=`backend_input_tokens`, `BACKEND_OUTPUT_TOKENS`=`backend_output_tokens`, `CARRIER_SECONDS`=`carrier_seconds`, `RECORDING_SECONDS`=`recording_seconds`, `EMAIL_COUNT`=`email_count`, `TOOL_EXTERNAL_COST`=`tool_external_cost`, `SIMULATION_SECONDS`=`simulation_seconds`

**UsageUnit** (value = key): `SECONDS`, `TOKENS`, `COUNT`, `USD_MICROS`

**TrustTier** (value = key): `NEW`, `ESTABLISHED`, `TRUSTED`, `RESTRICTED`

**FraudSignalType** (value = key): `VELOCITY_IP`, `VELOCITY_ACCOUNT`, `VELOCITY_CARD`, `VELOCITY_DEVICE`, `VELOCITY_PHONE`, `RADAR_ELEVATED_RISK`, `THREE_DS_FAILED`, `BUSINESS_VERIFICATION_FAILED`, `PREMIUM_DESTINATION`, `TRANSFER_LOOP`, `COST_ANOMALY`

**FraudReviewStatus** (value = key): `CLEAR`, `REVIEW_REQUIRED`, `BLOCKED`

**DisputeStatus** (value = key): `WARNING_NEEDS_RESPONSE`, `WARNING_UNDER_REVIEW`, `WARNING_CLOSED`, `NEEDS_RESPONSE`, `UNDER_REVIEW`, `WON`, `LOST`, `PREVENTED`

#### Identity, roles and access

**Role** (value = key): `OWNER`, `ADMIN`, `OPERATOR`, `ANALYST`, `DEVELOPER`, `BILLING`, `VIEWER`

**PlatformRole** (value = key): `SUPPORT_AGENT`, `SUPPORT_LEAD`, `PLATFORM_OPS`, `FINANCE_OPS`, `PLATFORM_ADMIN`

**Permission**: `WORKSPACE_READ`=`workspace:read`, `WORKSPACE_UPDATE`=`workspace:update`, `WORKSPACE_CANCEL`=`workspace:cancel`, `MEMBERS_READ`=`members:read`, `MEMBERS_MANAGE`=`members:manage`, `ROLES_MANAGE`=`roles:manage`, `LOCATIONS_READ`=`locations:read`, `LOCATIONS_MANAGE`=`locations:manage`, `AGENTS_READ`=`agents:read`, `AGENTS_WRITE`=`agents:write`, `AGENT_VERSIONS_PUBLISH`=`agent_versions:publish`, `AGENT_VERSIONS_ROLLBACK`=`agent_versions:rollback`, `CALLS_READ`=`calls:read`, `CALLS_READ_TRANSCRIPT`=`calls:read_transcript`, `CALLS_READ_RECORDING`=`calls:read_recording`, `CALLS_MONITOR_LIVE`=`calls:monitor_live`, `CALLS_TRANSFER`=`calls:transfer`, `CALLS_TERMINATE`=`calls:terminate`, `CONTACTS_READ`=`contacts:read`, `CONTACTS_WRITE`=`contacts:write`, `CONTACTS_EXPORT`=`contacts:export`, `CONTACTS_DELETE`=`contacts:delete`, `KNOWLEDGE_READ`=`knowledge:read`, `KNOWLEDGE_WRITE`=`knowledge:write`, `BOOKINGS_READ`=`bookings:read`, `BOOKINGS_WRITE`=`bookings:write`, `WAITLIST_READ`=`waitlist:read`, `WAITLIST_WRITE`=`waitlist:write`, `INTEGRATIONS_READ`=`integrations:read`, `INTEGRATIONS_MANAGE`=`integrations:manage`, `CUSTOM_TOOLS_MANAGE`=`custom_tools:manage`, `WEBHOOKS_MANAGE`=`webhooks:manage`, `API_KEYS_MANAGE`=`api_keys:manage`, `ANALYTICS_READ`=`analytics:read`, `QUALITY_READ`=`quality:read`, `SIMULATIONS_READ`=`simulations:read`, `SIMULATIONS_RUN`=`simulations:run`, `PHONE_NUMBERS_READ`=`phone_numbers:read`, `PHONE_NUMBERS_ORDER`=`phone_numbers:order`, `PHONE_NUMBERS_MANAGE`=`phone_numbers:manage`, `BILLING_READ`=`billing:read`, `BILLING_MANAGE`=`billing:manage`, `INVOICES_READ`=`invoices:read`, `PROVISIONING_READ`=`provisioning:read`, `SETTINGS_READ`=`settings:read`, `SETTINGS_MANAGE`=`settings:manage`, `RETENTION_MANAGE`=`retention:manage`, `PRIVACY_REQUESTS_MANAGE`=`privacy_requests:manage`, `NOTIFICATIONS_MANAGE`=`notifications:manage`, `SECURITY_READ`=`security:read`, `SECURITY_MANAGE`=`security:manage`, `AUDIT_LOGS_READ`=`audit_logs:read`, `SUPPORT_ACCESS_GRANT`=`support_access:grant`

**PlatformPermission**: `TENANTS_SEARCH`=`platform.tenants:search`, `TENANTS_READ`=`platform.tenants:read`, `TENANTS_SUSPEND`=`platform.tenants:suspend`, `SUPPORT_SESSIONS_START`=`platform.support_sessions:start`, `SENSITIVE_CONTENT_READ`=`platform.sensitive_content:read`, `CALLS_TERMINATE`=`platform.calls:terminate`, `WEBHOOKS_REPLAY`=`platform.webhooks:replay`, `SYNC_RETRY`=`platform.sync:retry`, `EMAIL_RESEND`=`platform.email:resend`, `KNOWLEDGE_REINDEX`=`platform.knowledge:reindex`, `PROVISIONING_MANAGE`=`platform.provisioning:manage`, `REFUNDS_APPROVE`=`platform.refunds:approve`, `FEATURE_FLAGS_MANAGE`=`platform.feature_flags:manage`, `KILL_SWITCHES_MANAGE`=`platform.kill_switches:manage`, `PROVIDER_ROUTING_MANAGE`=`platform.provider_routing:manage`, `CONFIG_ROLLBACK`=`platform.config:rollback`, `AUDIT_READ`=`platform.audit:read`, `STAFF_MANAGE`=`platform.staff:manage`

**SupportGrantStatus** (value = key): `REQUESTED`, `ACTIVE`, `DENIED`, `EXPIRED`, `REVOKED`

**SupportAccessLevel** (value = key): `REDACTED`, `SENSITIVE`

**AuthMode** (value = key): `SESSION_COOKIE`, `API_KEY`, `SERVICE_JWT`, `WEBHOOK_SIGNATURE`, `WIDGET_TOKEN`

**ActorType** (value = key): `USER`, `API_KEY`, `SERVICE`, `SUPPORT_STAFF`, `PROVIDER_WEBHOOK`, `SYSTEM`

**MembershipStatus** (value = key): `INVITED`, `ACTIVE`, `SUSPENDED`, `REMOVED`

**LocationStatus** (value = key): `ACTIVE`, `INACTIVE`, `ARCHIVED`

**TenantSecretKind** (value = key): `OPENAI_SERVICE_ACCOUNT_KEY`, `OPENAI_WEBHOOK_SECRET`, `OAUTH_REFRESH_TOKEN`, `OAUTH_ACCESS_TOKEN`, `SMTP_PASSWORD`, `CUSTOM_API_CREDENTIAL`, `OUTBOUND_WEBHOOK_SIGNING_SECRET`, `WIDGET_SIGNING_KEY`

**IdempotencyRecordState** (value = key): `IN_PROGRESS`, `COMPLETED`

#### Provisioning, phone numbers and KYC

**ProvisioningState** (value = key): `ORDER_CREATED`, `PAYMENT_PENDING`, `PAYMENT_CONFIRMED`, `BILLING_PENDING`, `BILLING_DOCUMENT_CREATED`, `TENANT_PROVISIONING`, `TENANT_CREATED`, `OPENAI_PROJECT_PROVISIONING`, `OPENAI_SERVICE_ACCOUNT_PROVISIONING`, `OPENAI_READY`, `PHONE_RESERVING`, `PHONE_ORDERING`, `PHONE_KYC_REQUIRED`, `WAITING_FOR_CUSTOMER`, `PHONE_UNDER_REVIEW`, `WAITING_FOR_PROVIDER`, `PHONE_READY`, `SIP_AGENT_BINDING`, `AGENT_READY`, `TEST_CALL_READY`, `GO_LIVE_ELIGIBLE`, `ACTIVE`, `MANUAL_REVIEW_REQUIRED`, `COMPENSATING`, `COMPENSATED`, `CANCELED`

**ProvisioningStep** (value = key): `PAYMENT`, `BILLING_DOCUMENT`, `TENANT`, `OPENAI_PROJECT`, `OPENAI_SERVICE_ACCOUNT`, `OPENAI_API_KEY`, `PHONE_RESERVATION`, `PHONE_ORDER`, `PHONE_REGULATORY`, `SIP_ROUTING`, `DEFAULT_AGENT`, `KNOWLEDGE_IMPORT`, `TEST_CALL`, `GO_LIVE`, `NOTIFICATION`

**ProvisioningStepStatus** (value = key): `PENDING`, `RUNNING`, `WAITING`, `SUCCEEDED`, `RETRYING`, `FAILED`, `SKIPPED`, `COMPENSATED`

**PhoneOrderStatus** (value = key): `NUMBER_SELECTED`, `RESERVED`, `ORDER_SUBMITTED`, `KYC_REQUIRED`, `UNDER_REVIEW`, `APPROVED`, `DECLINED`, `NO_INVENTORY`, `FAILED`, `CANCELED`

**PhoneNumberStatus** (value = key): `PROVISIONING`, `PORTING_IN`, `ACTIVE`, `SUSPENDED`, `RETENTION_HOLD`, `RELEASE_PENDING`, `RELEASED`

**KycRequirementStatus** (value = key): `NOT_REQUIRED`, `REQUIRED`, `SUBMITTED`, `UNDER_REVIEW`, `APPROVED`, `DECLINED`, `EXPIRED`

**PhoneNumberType** (value = key): `LOCAL`, `MOBILE`, `NATIONAL`, `TOLL_FREE`

#### Providers and models

**ProviderId**: `OPENAI`=`openai`, `TELNYX`=`telnyx`, `TWILIO`=`twilio`, `STRIPE`=`stripe`, `BILLINGO`=`billingo`, `GOOGLE`=`google`, `MICROSOFT`=`microsoft`, `AWS_SES`=`aws_ses`, `SMTP`=`smtp`, `WORKOS`=`workos`, `CUSTOM_API`=`custom_api`

**TelephonyProvider**: `TELNYX`=`telnyx`, `TWILIO`=`twilio`

**ProviderCapability**: `REALTIME_VOICE`=`realtime_voice`, `BACKEND_REASONING`=`backend_reasoning`, `EMBEDDINGS`=`embeddings`, `TRANSCRIPTION`=`transcription`, `SIP_INBOUND`=`sip_inbound`, `SIP_OUTBOUND`=`sip_outbound`, `CALL_TRANSFER`=`call_transfer`, `NUMBER_INVENTORY`=`number_inventory`, `PAYMENTS`=`payments`, `INVOICING`=`invoicing`, `EMAIL`=`email`, `CALENDAR`=`calendar`, `IDENTITY`=`identity`

**ProviderHealthStatus** (value = key): `HEALTHY`, `DEGRADED`, `UNAVAILABLE`, `UNKNOWN`

**CircuitState** (value = key): `CLOSED`, `OPEN`, `HALF_OPEN`

**ModelTier** (value = key): `VOICE_FRONTEND`, `ROUTINE`, `COMPLEX`, `ESCALATION`, `FRONTIER`, `TRANSCRIPTION`, `SPEECH_SYNTHESIS`

**ModelId**: `GPT_LIVE_1`=`gpt-live-1`, `GPT_REALTIME_2_1_MINI`=`gpt-realtime-2.1-mini`, `GPT_REALTIME_2_1`=`gpt-realtime-2.1`, `GPT_REALTIME_2`=`gpt-realtime-2`, `GPT_REALTIME_1_5`=`gpt-realtime-1.5`, `GPT_5_6_LUNA`=`gpt-5.6-luna`, `GPT_5_6_TERRA`=`gpt-5.6-terra`, `GPT_5_6_SOL`=`gpt-5.6-sol`, `GPT_6_ASTRA`=`gpt-6-astra`, `GPT_LIVE_TRANSCRIBE`=`gpt-live-transcribe`, `GPT_4O_MINI_TTS`=`gpt-4o-mini-tts`

#### Agents and conversations

**SpecialistAgentKind** (value = key): `RECEPTION_ROUTER`, `BOOKING`, `SUPPORT`, `SALES`, `BILLING`, `HANDOFF_COMPLIANCE`

**AgentStatus** (value = key): `DRAFT`, `ACTIVE`, `PAUSED`, `ARCHIVED`

**AgentVersionStatus** (value = key): `DRAFT`, `VALIDATING`, `VALIDATION_FAILED`, `STAGING`, `CANARY`, `PRODUCTION`, `SUPERSEDED`, `ROLLED_BACK`, `ARCHIVED`

**VerticalPack** (value = key): `RESTAURANT`, `DENTAL_CLINIC`, `AUTO_SERVICE`, `CAR_DETAILING`, `SALON`, `HOTEL`, `REAL_ESTATE`, `WEBSHOP`, `B2B_SUPPORT`, `GENERAL`

**VerticalSlug**: `RESTAURANT`=`restaurant`, `DENTAL_CLINIC`=`dental-clinic`, `AUTO_SERVICE`=`auto-service`, `CAR_DETAILING`=`car-detailing`, `SALON`=`salon`, `HOTEL`=`hotel`, `REAL_ESTATE`=`real-estate`, `WEBSHOP`=`webshop`, `B2B_SUPPORT`=`b2b-support`

**ConversationState** (value = key): `GREETING`, `DISCOVERY`, `IDENTITY`, `ACTION_PREVIEW`, `CONFIRMATION_GATE`, `TOOL_EXECUTION`, `RESULT_CONFIRMATION`, `FOLLOW_UP`, `HANDOFF`, `SAFE_FAILURE`, `CLOSING`, `END`

#### Calls, admission and transfer

**CallDirection** (value = key): `INBOUND`, `OUTBOUND`

**CallChannel** (value = key): `PSTN`, `WEB_VOICE`, `SIMULATION`

**CallStatus** (value = key): `INITIATED`, `QUEUED`, `IN_PROGRESS`, `TRANSFERRING`, `TRANSFERRED`, `COMPLETED`, `FAILED`, `REJECTED`, `ABANDONED`

**CallEndReason** (value = key): `CALLER_HANGUP`, `AGENT_HANGUP`, `TRANSFER_COMPLETED`, `MAX_DURATION_REACHED`, `SILENCE_TIMEOUT`, `SPEND_CAP_REACHED`, `TOOL_BUDGET_EXHAUSTED`, `KILL_SWITCH`, `OPERATOR_TERMINATED`, `POLICY_VIOLATION`, `ADMISSION_REJECTED`, `QUEUE_TIMEOUT`, `PROVIDER_FAILURE`, `RUNTIME_FAILURE`, `ORPHAN_RECONCILED`

**CallOutcome** (value = key): `RESOLVED`, `INFORMATION_PROVIDED`, `BOOKING_CREATED`, `BOOKING_CHANGED`, `BOOKING_CANCELED`, `WAITLISTED`, `LEAD_CAPTURED`, `CALLBACK_REQUESTED`, `MESSAGE_TAKEN`, `TRANSFERRED_TO_HUMAN`, `UNRESOLVED`, `ABANDONED`, `SPAM`, `POLICY_BLOCKED`, `FAILED`

**CallIntentCategory** (value = key): `BOOKING`, `SUPPORT`, `SALES`, `LEAD`, `BILLING`, `GENERAL_INQUIRY`, `HUMAN_REQUEST`, `SPAM`, `OTHER`

**AdmissionDecision** (value = key): `ADMITTED`, `QUEUED`, `OVERFLOWED`, `REJECTED`

**AdmissionRejectReason** (value = key): `TENANT_CONCURRENCY_LIMIT`, `LOCATION_CONCURRENCY_LIMIT`, `NUMBER_CONCURRENCY_LIMIT`, `GLOBAL_CAPACITY`, `PROVIDER_CAPACITY`, `CPS_LIMIT`, `ENTITLEMENT_INACTIVE`, `TENANT_SUSPENDED`, `SPEND_CAP_REACHED`, `FRAUD_BLOCK`, `KILL_SWITCH`, `NO_PRODUCTION_AGENT`, `RUNTIME_DRAINING`, `SNAPSHOT_UNAVAILABLE`

**OverloadPolicy** (value = key): `SHORT_QUEUE`, `HUMAN_OVERFLOW`, `CALLBACK_REQUEST`, `VOICEMAIL`, `PAID_BURST`, `DEGRADED_MESSAGE`

**RuntimeInstanceState** (value = key): `STARTING`, `READY`, `DRAINING`, `STOPPED`

**TransferType** (value = key): `COLD`, `WARM`

**TransferState** (value = key): `PREPARING`, `DIALING_AGENT`, `AGENT_ANSWERED`, `WHISPER`, `BRIDGING`, `COMPLETED`, `FAILED`, `RETURNED_TO_AI`, `CANCELED`

**TransferTrigger** (value = key): `CALLER_REQUEST`, `DTMF`, `REPEATED_MISUNDERSTANDING`, `TOOL_FAILURE`, `POLICY`, `SENSITIVE_TOPIC`, `EMERGENCY`, `OUTSIDE_BUSINESS_HOURS`, `AGENT_LOOP`, `OPERATOR`

**TransferFailureReason** (value = key): `NO_ANSWER`, `BUSY`, `DECLINED_BY_AGENT`, `DESTINATION_NOT_ALLOWED`, `CALLER_HANGUP`, `PROVIDER_ERROR`, `TIMEOUT`, `KILL_SWITCH`

#### Tools and integrations

**ToolKind** (value = key): `BUILT_IN`, `CONNECTOR`, `CUSTOM_API`

**ToolSideEffectClass** (value = key): `READ`, `WRITE`, `HIGH_RISK_WRITE`, `EXTERNAL_COMMUNICATION`

**ToolConfirmationPolicy** (value = key): `NONE`, `CALLER_CONFIRMATION`, `CALLER_CONFIRMATION_WITH_VERIFICATION`, `HUMAN_APPROVAL`

**ToolRunStatus** (value = key): `PENDING`, `AWAITING_CONFIRMATION`, `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELED`, `REJECTED_BY_POLICY`, `DEDUPLICATED`

**ToolAuthType** (value = key): `NONE`, `BEARER`, `OAUTH2`, `HMAC`

**IntegrationType** (value = key): `GOOGLE_CALENDAR`, `MICROSOFT_365`, `CUSTOM_SMTP`, `CUSTOM_API`, `OUTBOUND_WEBHOOK`

**IntegrationStatus** (value = key): `PENDING_AUTHORIZATION`, `CONNECTED`, `DEGRADED`, `AUTH_EXPIRED`, `REVOKED`, `DISCONNECTED`, `ERROR`

#### Booking and waitlist

**ResourceType** (value = key): `EMPLOYEE`, `DOCTOR`, `ROOM`, `TABLE`, `BAY`, `VEHICLE`, `EQUIPMENT`, `SERVICE_POINT`

**BookingStatus** (value = key): `PENDING_DEPOSIT`, `CONFIRMED`, `CANCELED`, `NO_SHOW`, `COMPLETED`

**BookingHoldStatus** (value = key): `ACTIVE`, `CONVERTED`, `EXPIRED`, `RELEASED`

**BookingSource** (value = key): `VOICE_AGENT`, `DASHBOARD`, `PUBLIC_API`, `WAITLIST`, `EXTERNAL_CALENDAR`

**ExternalSyncStatus** (value = key): `NOT_REQUIRED`, `PENDING`, `SYNCED`, `FAILED`, `CONFLICT`

**WaitlistStatus** (value = key): `ACTIVE`, `OFFERED`, `ACCEPTED`, `DECLINED`, `EXPIRED`, `FULFILLED`, `CANCELED`

#### Knowledge, contacts and consent

**KnowledgeSourceType** (value = key): `FILE_PDF`, `FILE_DOCX`, `FILE_TXT`, `FILE_MARKDOWN`, `FILE_CSV`, `URL`, `WEBSITE`, `FAQ`, `MANUAL_QA`

**KnowledgeSourceStatus** (value = key): `PENDING_UPLOAD`, `QUEUED`, `SCANNING`, `PARSING`, `CHUNKING`, `EMBEDDING`, `READY`, `ACTIVE`, `FAILED`, `QUARANTINED`, `SUPERSEDED`, `ARCHIVED`, `DELETING`

**KnowledgeFreshness** (value = key): `FRESH`, `STALE`, `EXPIRED`, `UNKNOWN`

**IdentityType** (value = key): `PHONE`, `EMAIL`, `NAME`, `EXTERNAL_ID`

**VerificationState** (value = key): `OBSERVED`, `CALLER_PROVIDED`, `INFERRED`, `OTP_VERIFIED`, `EMAIL_VERIFIED`, `CRM_VERIFIED`, `CONNECTOR_VERIFIED`, `HUMAN_VERIFIED`

**RecordingConsent** (value = key): `NOT_REQUESTED`, `GRANTED`, `DENIED`, `NOT_APPLICABLE`

#### Notifications, privacy and retention

**NotificationType** (value = key): `RENEWAL_REMINDER_5D`, `RENEWAL_REMINDER_3D`, `RENEWAL_REMINDER_1D`, `PAYMENT_SUCCEEDED`, `PAYMENT_FAILED_GRACE_STARTED`, `GRACE_PERIOD_REMINDER`, `GRACE_PERIOD_FINAL_DAY`, `SERVICE_RESTRICTED`, `SERVICE_SUSPENDED_BILLING`, `SERVICE_REACTIVATED`, `PLAN_CHANGED`, `ADD_ON_CHANGED`, `SUBSCRIPTION_CANCELED`, `CANCELED_GRACE_ENDING`, `DATA_RETENTION_STARTED`, `DATA_DELETION_COMPLETED`, `PHONE_NUMBER_RETENTION_ENDING`, `PHONE_NUMBER_RELEASED`, `REFUND_ISSUED`, `DISPUTE_OPENED`, `INVOICE_DELIVERY_FAILED`, `PROVISIONING_STARTED`, `PROVISIONING_KYC_REQUIRED`, `PROVISIONING_KYC_DECLINED`, `PROVISIONING_DELAYED`, `PHONE_NUMBER_ACTIVE`, `TEST_CALL_READY`, `GO_LIVE_COMPLETED`, `SPEND_CAP_WARNING`, `SPEND_CAP_REACHED`, `CONCURRENCY_LIMIT_REACHED`, `INTEGRATION_AUTH_EXPIRED`, `KNOWLEDGE_SYNC_FAILED`, `QUALITY_ALERT`, `SECURITY_MEMBER_INVITED`, `SECURITY_MEMBER_ROLE_CHANGED`, `SECURITY_API_KEY_CREATED`, `SECURITY_SSO_CONFIGURATION_CHANGED`, `SECURITY_SUPPORT_ACCESS_GRANTED`, `SUPPORT_REQUEST_RECEIVED`, `SUPPORT_REQUEST_UPDATED`, `DSAR_EXPORT_READY`, `CALLER_BOOKING_CONFIRMATION`, `CALLER_BOOKING_CHANGED`, `CALLER_BOOKING_CANCELED`, `CALLER_WAITLIST_OFFER`, `TENANT_CALLBACK_REQUESTED`, `TENANT_MESSAGE_TAKEN`

**NotificationChannel** (value = key): `EMAIL`, `SMS`, `IN_APP`, `WEBHOOK`

**NotificationStatus** (value = key): `PENDING`, `SCHEDULED`, `SENDING`, `SENT`, `DELIVERED`, `BOUNCED`, `COMPLAINED`, `FAILED`, `SUPPRESSED`, `CANCELED`

**RetentionClass** (value = key): `RAW_AUDIO`, `TRANSCRIPT`, `CALL_EVENTS`, `TOOL_PAYLOAD`, `CALLER_PROFILE`, `ANALYTICS`, `RAW_PROVIDER_PAYLOAD`, `KNOWLEDGE_DOCUMENT`, `KYC_REFERENCE`, `CONSENT`, `AUDIT`, `BILLING`, `DISPUTE_EVIDENCE`, `OPERATIONAL_LOG`, `EXPORT_ARTIFACT`

**DsarRequestType** (value = key): `EXPORT`, `DELETE`, `RECTIFY`, `RESTRICT`

**DsarRequestStatus** (value = key): `RECEIVED`, `VERIFYING`, `IN_PROGRESS`, `ON_LEGAL_HOLD`, `COMPLETED`, `REJECTED`

#### Flags and kill switches

**FeatureFlagScope** (value = key): `GLOBAL`, `REGION`, `TENANT`, `LOCATION`, `AGENT`, `TOOL`

**FeatureFlagKey**: `AGENT_CANARY_ROLLOUT`=`feature.agent.canary_rollout`, `ROUTING_COMPLEX_ESCALATION`=`feature.routing.complex_escalation`, `ROUTING_PREMIUM_REASONING`=`feature.routing.premium_reasoning`, `ROUTING_FRONTIER_REASONING`=`feature.routing.frontier_reasoning`, `CALLER_MEMORY`=`feature.caller_memory`, `WEB_VOICE_WIDGET`=`feature.web_voice_widget`, `WAITLIST`=`feature.waitlist`, `WARM_TRANSFER`=`feature.warm_transfer`, `OUTBOUND_CALLS`=`feature.outbound_calls`, `CALL_RECORDING`=`feature.call_recording`, `KNOWLEDGE_WEBSITE_SYNC`=`feature.knowledge.website_sync`, `ONBOARDING_WEBSITE_IMPORT`=`feature.onboarding.website_import`, `SIMULATION_LAB`=`feature.simulation_lab`, `QUALITY_AUTO_ROLLBACK_RECOMMENDATION`=`feature.quality.auto_rollback_recommendation`, `PCI_PAYMENT_MODE`=`feature.pci_payment_mode`, `ANALYST_TRANSCRIPT_ACCESS`=`feature.analyst_transcript_access`

**KillSwitchKey**: `GLOBAL_NEW_CALLS`=`kill.global_new_calls`, `TENANT_TRAFFIC`=`kill.tenant_traffic`, `OUTBOUND_CALLS`=`kill.outbound_calls`, `CALL_TRANSFER`=`kill.call_transfer`, `PROVIDER`=`kill.provider`, `MODEL`=`kill.model`, `TOOL`=`kill.tool`, `RECORDING`=`kill.recording`, `PAYMENT`=`kill.payment`, `AGENT_PUBLISH`=`kill.agent_publish`

#### Quality and simulation

**SimulationScenarioClass** (value = key): `HAPPY_PATH`, `CONVERSATION_STRESS`, `AUDIO_STRESS`, `TOOL_FAILURE`, `SECURITY`, `CONCURRENCY`

**SimulationRunStatus** (value = key): `QUEUED`, `RUNNING`, `PASSED`, `FAILED`, `ERRORED`, `CANCELED`

**QualityFlag** (value = key): `LOOP_DETECTED`, `REPEATED_QUESTION`, `WRONG_LANGUAGE`, `UNSUPPORTED_ANSWER`, `KNOWLEDGE_GAP`, `LONG_RESPONSE`, `EXCESSIVE_FILLER`, `EXCESSIVE_CLARIFICATION`, `DEAD_AIR`, `INTERRUPTION_MISHANDLED`, `TOOL_FAILURE`, `LATENCY_SPIKE`, `ABANDONMENT`, `POLICY_BREACH`

#### Events, errors and topology names

**EventType**: `TENANT_CREATED`=`tenant.created`, `TENANT_STATUS_CHANGED`=`tenant.status_changed`, `CHECKOUT_ORDER_PAID`=`checkout.order_paid`, `SUBSCRIPTION_UPDATED`=`subscription.updated`, `ENTITLEMENT_SNAPSHOT_CREATED`=`entitlement.snapshot_created`, `BILLING_DOCUMENT_CREATED`=`billing.document_created`, `PROVISIONING_STATE_CHANGED`=`provisioning.state_changed`, `PHONE_NUMBER_STATUS_CHANGED`=`phone_number.status_changed`, `AGENT_VERSION_PUBLISHED`=`agent_version.published`, `AGENT_VERSION_ROLLED_BACK`=`agent_version.rolled_back`, `FEATURE_FLAG_CHANGED`=`feature_flag.changed`, `KILL_SWITCH_CHANGED`=`kill_switch.changed`, `CALL_STARTED`=`call.started`, `CALL_ADMISSION_DECIDED`=`call.admission_decided`, `CALL_CONVERSATION_STATE_CHANGED`=`call.conversation_state_changed`, `CALL_LANGUAGE_CHANGED`=`call.language_changed`, `CALL_DISCLOSURE_DELIVERED`=`call.disclosure_delivered`, `CALL_TOOL_REQUESTED`=`call.tool_requested`, `CALL_TOOL_COMPLETED`=`call.tool_completed`, `CALL_TRANSFER_STATE_CHANGED`=`call.transfer_state_changed`, `CALL_ENDED`=`call.ended`, `USAGE_RECORDED`=`usage.recorded`, `PROVIDER_COST_RECORDED`=`provider_cost.recorded`, `KNOWLEDGE_INGESTION_REQUESTED`=`knowledge.ingestion_requested`, `KNOWLEDGE_INGESTION_COMPLETED`=`knowledge.ingestion_completed`, `KNOWLEDGE_INGESTION_FAILED`=`knowledge.ingestion_failed`, `KNOWLEDGE_SOURCE_ACTIVATED`=`knowledge.source_activated`, `BOOKING_CREATED`=`booking.created`, `BOOKING_CHANGED`=`booking.changed`, `BOOKING_CANCELED`=`booking.canceled`, `WAITLIST_SLOT_RELEASED`=`waitlist.slot_released`, `INTEGRATION_AUTH_EXPIRED`=`integration.auth_expired`, `QUALITY_SCORE_REQUESTED`=`quality.score_requested`, `QUALITY_SCORED`=`quality.scored`, `SIMULATION_RUN_REQUESTED`=`simulation.run_requested`, `SIMULATION_RUN_COMPLETED`=`simulation.run_completed`, `NOTIFICATION_REQUESTED`=`notification.requested`, `PROVIDER_HEALTH_CHANGED`=`provider_health.changed`, `RUNTIME_INSTANCE_STATE_CHANGED`=`runtime.instance_state_changed`

**ApiErrorCode** (value = key): `VALIDATION_FAILED`, `MALFORMED_REQUEST`, `IDEMPOTENCY_KEY_REQUIRED`, `OAUTH_STATE_INVALID`, `UNAUTHENTICATED`, `SESSION_EXPIRED`, `API_KEY_INVALID`, `SERVICE_TOKEN_INVALID`, `WEBHOOK_SIGNATURE_INVALID`, `WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE`, `PAYMENT_REQUIRED`, `FORBIDDEN`, `CSRF_TOKEN_INVALID`, `SERVICE_SCOPE_MISSING`, `SUPPORT_GRANT_REQUIRED`, `STEP_UP_REQUIRED`, `TENANT_SUSPENDED`, `ENTITLEMENT_REQUIRED`, `PLAN_LIMIT_EXCEEDED`, `SPEND_CAP_REACHED`, `APPROVAL_REQUIRED`, `FRAUD_REVIEW_REQUIRED`, `TOOL_NOT_ALLOWED`, `TRANSFER_DESTINATION_NOT_ALLOWED`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `CONFLICT`, `IDEMPOTENCY_KEY_IN_PROGRESS`, `INVALID_STATE_TRANSITION`, `BOOKING_SLOT_UNAVAILABLE`, `BOOKING_HOLD_EXPIRED`, `PHONE_NUMBER_UNAVAILABLE`, `KYC_REQUIRED`, `SIMULATION_GATE_FAILED`, `CONFIRMATION_REQUIRED`, `INTEGRATION_AUTH_EXPIRED`, `RETENTION_LEGAL_HOLD`, `VERSION_CONFLICT`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `IDEMPOTENCY_KEY_REUSED`, `BILLING_PROFILE_INCOMPLETE`, `VAT_ID_INVALID`, `PRICE_BOOK_UNAVAILABLE`, `SSRF_BLOCKED`, `TOOL_SCHEMA_INVALID`, `PRECONDITION_REQUIRED`, `RATE_LIMITED`, `CONCURRENCY_LIMIT_REACHED`, `TOOL_BUDGET_EXCEEDED`, `INTERNAL_ERROR`, `PROVIDER_ERROR`, `PROVIDER_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `KILL_SWITCH_ACTIVE`, `UPSTREAM_TIMEOUT`

**NatsStream** (value = key): `CALL_EVENTS`, `USAGE`, `DOMAIN`, `JOBS`, `DEAD_LETTER`

**JobQueue**: `KNOWLEDGE_INGEST`=`knowledge_ingest`, `QUALITY_SCORE`=`quality_score`, `SIMULATION_RUN`=`simulation_run`, `CONNECTOR_SYNC`=`connector_sync`, `EXPORT_BUILD`=`export_build`

**TemporalTaskQueue**: `PROVISIONING`=`provisioning`, `BILLING`=`billing`, `NOTIFICATIONS`=`notifications`, `RETENTION`=`retention`, `KNOWLEDGE`=`knowledge`, `SIMULATIONS`=`simulations`, `RECONCILIATION`=`reconciliation`

**S3BucketPurpose**: `KNOWLEDGE`=`knowledge`, `ARTIFACTS`=`artifacts`, `RECORDINGS`=`recordings`, `EXPORTS`=`exports`, `EVIDENCE`=`evidence`, `TRANSIENT`=`transient`

**RateLimitScope**: `IP`=`ip`, `USER`=`user`, `TENANT`=`tenant`, `API_KEY`=`api_key`, `WEBHOOK`=`webhook`, `WIDGET`=`widget`

### 3.5 Plans and limits

Pricing version `2026-09-11.v6`. Money is an integer in ISO 4217 minor units plus a currency (HUF has exponent 2, so 39 900 Ft = `3990000`). Usage is measured in seconds; see 3.2 for the charge formula.

| Plan       | HU monthly net (minor HUF) | Overage per minute net (minor HUF) | Included voice seconds | Concurrent calls                  | Burst policy | Included numbers | Included locations | Max agents | Max call seconds | Contract defined |
| ---------- | -------------------------- | ---------------------------------- | ---------------------- | --------------------------------- | ------------ | ---------------- | ------------------ | ---------- | ---------------- | ---------------- |
| START      | 3990000                    | 14900                              | 9000                   | 2                                 | NONE         | 1                | 1                  | 1          | 1800             | false            |
| BUSINESS   | 6990000                    | 12900                              | 24000                  | 10                                | PAID_BURST   | 1                | 1                  | 3          | 1800             | false            |
| PRO        | 12990000                   | 10900                              | 60000                  | 50                                | CONFIGURABLE | 1                | 1                  | 10         | 1800             | false            |
| ENTERPRISE | contract                   | contract                           | contract               | 100 (minimum; contract overrides) | CONTRACTUAL  | 1                | 1                  | unlimited  | 1800             | true             |

Plan features (cumulative):

- START: `knowledge_base`, `human_handoff`, `dtmf_routing`, `business_hours_routing`, `caller_memory`, `transactional_email`, `quality_monitoring`, `web_voice_test_call`
- BUSINESS: `knowledge_base`, `human_handoff`, `dtmf_routing`, `business_hours_routing`, `caller_memory`, `transactional_email`, `quality_monitoring`, `web_voice_test_call`, `google_calendar`, `microsoft_365`, `custom_smtp`, `custom_api_tools`, `outbound_webhooks`, `public_api`, `booking_engine`, `waitlist`, `warm_transfer`, `knowledge_intelligence`, `web_voice_widget`, `roi_analytics`
- PRO: `knowledge_base`, `human_handoff`, `dtmf_routing`, `business_hours_routing`, `caller_memory`, `transactional_email`, `quality_monitoring`, `web_voice_test_call`, `google_calendar`, `microsoft_365`, `custom_smtp`, `custom_api_tools`, `outbound_webhooks`, `public_api`, `booking_engine`, `waitlist`, `warm_transfer`, `knowledge_intelligence`, `web_voice_widget`, `roi_analytics`, `multi_workflow`, `advanced_call_routing`, `multi_location`, `simulation_lab`, `priority_support`
- ENTERPRISE: `knowledge_base`, `human_handoff`, `dtmf_routing`, `business_hours_routing`, `caller_memory`, `transactional_email`, `quality_monitoring`, `web_voice_test_call`, `google_calendar`, `microsoft_365`, `custom_smtp`, `custom_api_tools`, `outbound_webhooks`, `public_api`, `booking_engine`, `waitlist`, `warm_transfer`, `knowledge_intelligence`, `web_voice_widget`, `roi_analytics`, `multi_workflow`, `advanced_call_routing`, `multi_location`, `simulation_lab`, `priority_support`, `premium_reasoning`, `sso_scim`, `siem_export`, `byok`, `pci_payments`, `dedicated_redundancy`, `contractual_sla`, `white_label`

### 3.6 Add-ons

`CONCURRENCY_BOOST` adds 5 concurrent calls per purchased unit.

| Code                     | Billing type      | Available for                    | Grants features                       | Stackable |
| ------------------------ | ----------------- | -------------------------------- | ------------------------------------- | --------- |
| EXTRA_PHONE_NUMBER       | RECURRING_MONTHLY | START, BUSINESS, PRO, ENTERPRISE | none                                  | true      |
| EXTRA_LOCATION           | RECURRING_MONTHLY | PRO, ENTERPRISE                  | none                                  | true      |
| OUTBOUND_CALLING         | RECURRING_MONTHLY | BUSINESS, PRO, ENTERPRISE        | `outbound_calling`                    | false     |
| PREMIUM_REASONING        | USAGE_BASED       | PRO                              | `premium_reasoning`                   | false     |
| CUSTOM_INTEGRATION_SETUP | ONE_TIME          | START, BUSINESS, PRO, ENTERPRISE | none                                  | true      |
| PRIVATE_CONNECTOR        | RECURRING_MONTHLY | PRO, ENTERPRISE                  | none                                  | true      |
| LARGE_KNOWLEDGE_STORAGE  | RECURRING_MONTHLY | START, BUSINESS, PRO, ENTERPRISE | none                                  | true      |
| CALL_RECORDING           | RECURRING_MONTHLY | START, BUSINESS, PRO, ENTERPRISE | `call_recording`                      | false     |
| EXTENDED_RETENTION       | RECURRING_MONTHLY | START, BUSINESS, PRO, ENTERPRISE | none                                  | false     |
| PHONE_NUMBER_RETENTION   | RECURRING_MONTHLY | START, BUSINESS, PRO, ENTERPRISE | none                                  | true      |
| DEDICATED_SLA_SUPPORT    | RECURRING_MONTHLY | PRO, ENTERPRISE                  | `contractual_sla`, `priority_support` | false     |
| WHITE_LABEL_DOMAIN       | RECURRING_MONTHLY | PRO, ENTERPRISE                  | `white_label`                         | false     |
| SIMULATION_CREDITS       | USAGE_BASED       | BUSINESS, PRO, ENTERPRISE        | `simulation_lab`                      | true      |
| PCI_PAYMENTS             | RECURRING_MONTHLY | ENTERPRISE                       | `pci_payments`                        | false     |
| SSO_SCIM                 | RECURRING_MONTHLY | PRO, ENTERPRISE                  | `sso_scim`                            | false     |
| SIEM_EXPORT              | RECURRING_MONTHLY | ENTERPRISE                       | `siem_export`                         | false     |
| BYOK                     | RECURRING_MONTHLY | ENTERPRISE                       | `byok`                                | false     |
| DEDICATED_REDUNDANCY     | RECURRING_MONTHLY | ENTERPRISE                       | `dedicated_redundancy`                | false     |
| CONCURRENCY_BOOST        | RECURRING_MONTHLY | BUSINESS, PRO, ENTERPRISE        | none                                  | true      |

### 3.7 Role to permission matrix

Workspace roles. `OPERATOR`, `VIEWER` memberships may carry a `location_scope`. Support-internal (master 11) is modelled by platform roles below, never by a workspace membership.

| Permission                | OWNER | ADMIN | OPERATOR | ANALYST | DEVELOPER | BILLING | VIEWER |
| ------------------------- | ----- | ----- | -------- | ------- | --------- | ------- | ------ |
| `workspace:read`          | x     | x     | x        | x       | x         | x       | x      |
| `workspace:update`        | x     | x     |          |         |           |         |        |
| `workspace:cancel`        | x     |       |          |         |           |         |        |
| `members:read`            | x     | x     |          |         |           |         |        |
| `members:manage`          | x     |       |          |         |           |         |        |
| `roles:manage`            | x     |       |          |         |           |         |        |
| `locations:read`          | x     | x     | x        | x       | x         | x       | x      |
| `locations:manage`        | x     | x     |          |         |           |         |        |
| `agents:read`             | x     | x     | x        | x       | x         |         | x      |
| `agents:write`            | x     | x     |          |         |           |         |        |
| `agent_versions:publish`  | x     | x     |          |         |           |         |        |
| `agent_versions:rollback` | x     | x     |          |         |           |         |        |
| `calls:read`              | x     | x     | x        | x       | x         |         | x      |
| `calls:read_transcript`   | x     | x     | x        |         |           |         |        |
| `calls:read_recording`    | x     | x     |          |         |           |         |        |
| `calls:monitor_live`      | x     | x     | x        |         |           |         |        |
| `calls:transfer`          | x     | x     | x        |         |           |         |        |
| `calls:terminate`         | x     | x     | x        |         |           |         |        |
| `contacts:read`           | x     | x     | x        |         |           |         |        |
| `contacts:write`          | x     | x     | x        |         |           |         |        |
| `contacts:export`         | x     | x     |          |         |           |         |        |
| `contacts:delete`         | x     | x     |          |         |           |         |        |
| `knowledge:read`          | x     | x     | x        | x       | x         |         | x      |
| `knowledge:write`         | x     | x     |          |         |           |         |        |
| `bookings:read`           | x     | x     | x        | x       |           |         | x      |
| `bookings:write`          | x     | x     | x        |         |           |         |        |
| `waitlist:read`           | x     | x     | x        |         |           |         |        |
| `waitlist:write`          | x     | x     | x        |         |           |         |        |
| `integrations:read`       | x     | x     |          |         | x         |         |        |
| `integrations:manage`     | x     | x     |          |         | x         |         |        |
| `custom_tools:manage`     | x     | x     |          |         | x         |         |        |
| `webhooks:manage`         | x     | x     |          |         | x         |         |        |
| `api_keys:manage`         | x     | x     |          |         | x         |         |        |
| `analytics:read`          | x     | x     |          | x       |           |         | x      |
| `quality:read`            | x     | x     |          | x       |           |         |        |
| `simulations:read`        | x     | x     |          | x       | x         |         |        |
| `simulations:run`         | x     | x     |          |         | x         |         |        |
| `phone_numbers:read`      | x     | x     | x        | x       | x         | x       | x      |
| `phone_numbers:order`     | x     | x     |          |         |           |         |        |
| `phone_numbers:manage`    | x     | x     |          |         |           |         |        |
| `billing:read`            | x     | x     |          |         |           | x       |        |
| `billing:manage`          | x     |       |          |         |           | x       |        |
| `invoices:read`           | x     |       |          |         |           | x       |        |
| `provisioning:read`       | x     | x     |          |         |           | x       |        |
| `settings:read`           | x     | x     | x        |         |           |         | x      |
| `settings:manage`         | x     | x     |          |         |           |         |        |
| `retention:manage`        | x     |       |          |         |           |         |        |
| `privacy_requests:manage` | x     | x     |          |         |           |         |        |
| `notifications:manage`    | x     | x     |          |         |           |         |        |
| `security:read`           | x     | x     |          |         |           |         |        |
| `security:manage`         | x     |       |          |         |           |         |        |
| `audit_logs:read`         | x     | x     |          |         |           |         |        |
| `support_access:grant`    | x     |       |          |         |           |         |        |

Platform (staff) roles. Permissions requiring an active customer support grant: `platform.sensitive_content:read`.

| Platform permission                | SUPPORT_AGENT | SUPPORT_LEAD | PLATFORM_OPS | FINANCE_OPS | PLATFORM_ADMIN |
| ---------------------------------- | ------------- | ------------ | ------------ | ----------- | -------------- |
| `platform.tenants:search`          | x             | x            | x            | x           | x              |
| `platform.tenants:read`            | x             | x            | x            | x           | x              |
| `platform.tenants:suspend`         |               | x            | x            |             | x              |
| `platform.support_sessions:start`  | x             | x            |              |             | x              |
| `platform.sensitive_content:read`  |               | x            |              |             | x              |
| `platform.calls:terminate`         |               | x            | x            |             | x              |
| `platform.webhooks:replay`         | x             | x            | x            |             | x              |
| `platform.sync:retry`              | x             | x            | x            |             | x              |
| `platform.email:resend`            | x             | x            |              |             | x              |
| `platform.knowledge:reindex`       | x             | x            |              |             | x              |
| `platform.provisioning:manage`     |               | x            |              | x           | x              |
| `platform.refunds:approve`         |               |              |              | x           | x              |
| `platform.feature_flags:manage`    |               |              | x            |             | x              |
| `platform.kill_switches:manage`    |               |              | x            |             | x              |
| `platform.provider_routing:manage` |               |              | x            |             | x              |
| `platform.config:rollback`         |               | x            | x            |             | x              |
| `platform.audit:read`              | x             | x            | x            | x           | x              |
| `platform.staff:manage`            |               |              |              |             | x              |

### 3.8 Feature flags and kill switches

Scope precedence (most specific first): `TOOL` > `AGENT` > `LOCATION` > `TENANT` > `REGION` > `GLOBAL`. A kill switch set at any applicable scope wins over every flag. Flags are default-safe and every change writes an audit event.

| Flag key                                       | Allowed scopes           | Default |
| ---------------------------------------------- | ------------------------ | ------- |
| `feature.agent.canary_rollout`                 | TENANT, AGENT            | on      |
| `feature.routing.complex_escalation`           | GLOBAL, TENANT, AGENT    | on      |
| `feature.routing.premium_reasoning`            | GLOBAL, TENANT, AGENT    | off     |
| `feature.routing.frontier_reasoning`           | GLOBAL, TENANT, AGENT    | off     |
| `feature.caller_memory`                        | TENANT, LOCATION         | off     |
| `feature.web_voice_widget`                     | GLOBAL, TENANT           | off     |
| `feature.waitlist`                             | TENANT, LOCATION         | off     |
| `feature.warm_transfer`                        | GLOBAL, TENANT, LOCATION | on      |
| `feature.outbound_calls`                       | GLOBAL, TENANT           | off     |
| `feature.call_recording`                       | TENANT, LOCATION         | off     |
| `feature.knowledge.website_sync`               | GLOBAL, TENANT           | on      |
| `feature.onboarding.website_import`            | GLOBAL, TENANT           | on      |
| `feature.simulation_lab`                       | GLOBAL, TENANT           | on      |
| `feature.quality.auto_rollback_recommendation` | TENANT, AGENT            | on      |
| `feature.pci_payment_mode`                     | TENANT                   | off     |
| `feature.analyst_transcript_access`            | TENANT                   | off     |

| Kill switch key         | Allowed scopes           | Requires target id                     |
| ----------------------- | ------------------------ | -------------------------------------- |
| `kill.global_new_calls` | GLOBAL, REGION           | no                                     |
| `kill.tenant_traffic`   | TENANT                   | no                                     |
| `kill.outbound_calls`   | GLOBAL, TENANT           | no                                     |
| `kill.call_transfer`    | GLOBAL, TENANT, LOCATION | no                                     |
| `kill.provider`         | GLOBAL, REGION, TENANT   | yes (provider id, model id or tool id) |
| `kill.model`            | GLOBAL, TENANT, AGENT    | yes (provider id, model id or tool id) |
| `kill.tool`             | GLOBAL, TENANT, TOOL     | yes (provider id, model id or tool id) |
| `kill.recording`        | GLOBAL, TENANT, LOCATION | no                                     |
| `kill.payment`          | GLOBAL, TENANT           | no                                     |
| `kill.agent_publish`    | GLOBAL, TENANT, LOCATION | no                                     |

### 3.9 Model tiers

| Tier             | Default model         | Enabled by default |
| ---------------- | --------------------- | ------------------ |
| VOICE_FRONTEND   | `gpt-live-1`          | yes                |
| ROUTINE          | `gpt-5.6-luna`        | yes                |
| COMPLEX          | `gpt-5.6-terra`       | yes                |
| ESCALATION       | `gpt-5.6-sol`         | no (policy + flag) |
| FRONTIER         | `gpt-6-astra`         | no (policy + flag) |
| TRANSCRIPTION    | `gpt-live-transcribe` | yes                |
| SPEECH_SYNTHESIS | `gpt-4o-mini-tts`     | yes                |

Realtime voice fallback order after `gpt-live-1`: `gpt-realtime-2.1-mini` then `gpt-realtime-2.1`.

### 3.10 API error codes

Retryable codes (clients may retry with the same Idempotency-Key and backoff): `IDEMPOTENCY_KEY_IN_PROGRESS`, `RATE_LIMITED`, `CONCURRENCY_LIMIT_REACHED`, `PROVIDER_ERROR`, `PROVIDER_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `UPSTREAM_TIMEOUT`. Message key is `errors.<code lowercased>`.

| Code                               | HTTP |
| ---------------------------------- | ---- |
| VALIDATION_FAILED                  | 400  |
| MALFORMED_REQUEST                  | 400  |
| IDEMPOTENCY_KEY_REQUIRED           | 400  |
| OAUTH_STATE_INVALID                | 400  |
| UNAUTHENTICATED                    | 401  |
| SESSION_EXPIRED                    | 401  |
| API_KEY_INVALID                    | 401  |
| SERVICE_TOKEN_INVALID              | 401  |
| WEBHOOK_SIGNATURE_INVALID          | 401  |
| WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE | 401  |
| PAYMENT_REQUIRED                   | 402  |
| FORBIDDEN                          | 403  |
| CSRF_TOKEN_INVALID                 | 403  |
| SERVICE_SCOPE_MISSING              | 403  |
| SUPPORT_GRANT_REQUIRED             | 403  |
| STEP_UP_REQUIRED                   | 403  |
| TENANT_SUSPENDED                   | 403  |
| ENTITLEMENT_REQUIRED               | 403  |
| PLAN_LIMIT_EXCEEDED                | 403  |
| SPEND_CAP_REACHED                  | 403  |
| APPROVAL_REQUIRED                  | 403  |
| FRAUD_REVIEW_REQUIRED              | 403  |
| TOOL_NOT_ALLOWED                   | 403  |
| TRANSFER_DESTINATION_NOT_ALLOWED   | 403  |
| NOT_FOUND                          | 404  |
| METHOD_NOT_ALLOWED                 | 405  |
| CONFLICT                           | 409  |
| IDEMPOTENCY_KEY_IN_PROGRESS        | 409  |
| INVALID_STATE_TRANSITION           | 409  |
| BOOKING_SLOT_UNAVAILABLE           | 409  |
| BOOKING_HOLD_EXPIRED               | 409  |
| PHONE_NUMBER_UNAVAILABLE           | 409  |
| KYC_REQUIRED                       | 409  |
| SIMULATION_GATE_FAILED             | 409  |
| CONFIRMATION_REQUIRED              | 409  |
| INTEGRATION_AUTH_EXPIRED           | 409  |
| RETENTION_LEGAL_HOLD               | 409  |
| VERSION_CONFLICT                   | 412  |
| PAYLOAD_TOO_LARGE                  | 413  |
| UNSUPPORTED_MEDIA_TYPE             | 415  |
| IDEMPOTENCY_KEY_REUSED             | 422  |
| BILLING_PROFILE_INCOMPLETE         | 422  |
| VAT_ID_INVALID                     | 422  |
| PRICE_BOOK_UNAVAILABLE             | 422  |
| SSRF_BLOCKED                       | 422  |
| TOOL_SCHEMA_INVALID                | 422  |
| PRECONDITION_REQUIRED              | 428  |
| RATE_LIMITED                       | 429  |
| CONCURRENCY_LIMIT_REACHED          | 429  |
| TOOL_BUDGET_EXCEEDED               | 429  |
| INTERNAL_ERROR                     | 500  |
| PROVIDER_ERROR                     | 502  |
| PROVIDER_UNAVAILABLE               | 503  |
| SERVICE_UNAVAILABLE                | 503  |
| KILL_SWITCH_ACTIVE                 | 503  |
| UPSTREAM_TIMEOUT                   | 504  |

## 4. Contracts package seed

`packages/contracts` exists now so parallel agents can import it immediately; the contracts module extends it (API/event TypeBox schemas, OpenAPI generation, protobuf). Current modules:

| File                | Exports                                                                                                                                                                                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/enum-utils.ts` | `EnumDefinition`, `EnumValue`, `enumValues`, `isEnumValue`, `parseEnumValue`                                                                                                                                                                                                            |
| `src/enums.ts`      | every enumeration in section 3                                                                                                                                                                                                                                                          |
| `src/topology.ts`   | `LOCAL_SERVICE_PORTS`, `LOCAL_INFRA_PORTS`, `NatsStream`, `NATS_STREAM_SUBJECTS`, `JobQueue`, `TemporalTaskQueue`, `S3BucketPurpose`, `RateLimitScope`, `NATS_CONNECTOR_EXECUTE_SUBJECT_PREFIX`, `NATS_CONNECTOR_QUEUE_GROUP`, `natsSubjects`, `redisKeys`, `s3`, `temporalWorkflowIds` |
| `src/envelope.ts`   | `EventEnvelope`, `EVENT_ENVELOPE_SCHEMA_VERSION`, `PLATFORM_SCOPED_EVENT_TYPES`, `eventEnvelopeIssues`, `isEventEnvelope`, `isUuidV7`, `isTraceId`, `isUtcTimestamp`                                                                                                                    |
| `src/errors.ts`     | `API_ERROR_HTTP_STATUS`, `RETRYABLE_API_ERROR_CODES`, `ApiErrorEnvelope`, `apiErrorMessageKey`, `apiErrorHttpStatus`, `createApiErrorEnvelope`                                                                                                                                          |
| `src/plans.ts`      | `PRICING_VERSION`, `CURRENCY_MINOR_UNIT_EXPONENT`, `PROVIDER_COST_MICROS_PER_UNIT`, `DEFAULT_MAX_CALL_DURATION_SECONDS`, `PLAN_CATALOG`, `ADD_ON_CATALOG`, `CONCURRENCY_BOOST_CALLS_PER_UNIT`, `planPriceForMarket`, `planIncludesFeature`                                              |
| `src/rbac.ts`       | `ROLE_PERMISSIONS`, `LOCATION_SCOPABLE_ROLES`, `PLATFORM_ROLE_PERMISSIONS`, `PLATFORM_PERMISSIONS_REQUIRING_SUPPORT_GRANT`, `roleHasPermission`, `platformRoleHasPermission`                                                                                                            |
| `src/flags.ts`      | `FEATURE_FLAG_DEFINITIONS`, `KILL_SWITCH_DEFINITIONS`, `FLAG_SCOPE_PRECEDENCE`                                                                                                                                                                                                          |
| `src/models.ts`     | `MODEL_TIER_DEFAULT_MODEL`, `MODEL_TIERS_ENABLED_BY_DEFAULT`, `REALTIME_VOICE_FALLBACK_MODELS`                                                                                                                                                                                          |
| `src/registry.ts`   | `ENUM_REGISTRY`, `ENUMS_JSON_SCHEMA_VERSION`, `renderEnumsJson`                                                                                                                                                                                                                         |

Planned additions owned by contracts: `src/api/public/**`, `src/api/internal/**` (TypeBox), `src/events/**` (TypeBox payloads per event type and version), `src/generated/proto/**`, `generated/json-schema/**`. Commands: `build`, `typecheck`, `test`, `test:coverage`, `generate:enums [--check]`.

## 5. State machines

### 5.1 Canonical definition

Every state machine is defined once in TypeScript in `packages/domain/src/state-machines/<machine>.ts` using the enumerations from `@velyric/contracts`. Each module exports a `StateMachineDefinition`:

```ts
interface StateMachineDefinition<S extends string, E extends string> {
  readonly name: string;
  readonly version: number;
  readonly states: readonly S[];
  readonly initial: S;
  readonly terminal: readonly S[];
  readonly events: readonly E[];
  readonly transitions: readonly {
    readonly from: S;
    readonly event: E;
    readonly to: S;
    readonly guard?: string;
  }[];
}
```

`guard` is a stable guard identifier (for example `payment_verified_server_side`), implemented as a pure function in the domain package; it is data in the JSON table so other languages can assert that the guard exists.

Required machines and file names:

| Machine (`name`)   | States enum             | JSON file                                                 |
| ------------------ | ----------------------- | --------------------------------------------------------- |
| `tenant_lifecycle` | `TenantStatus`          | `packages/contracts/state-machines/tenant_lifecycle.json` |
| `subscription`     | `SubscriptionStatus`    | `subscription.json`                                       |
| `checkout_order`   | `CheckoutOrderStatus`   | `checkout_order.json`                                     |
| `billing_document` | `BillingDocumentStatus` | `billing_document.json`                                   |
| `provisioning`     | `ProvisioningState`     | `provisioning.json`                                       |
| `phone_order`      | `PhoneOrderStatus`      | `phone_order.json`                                        |
| `phone_number`     | `PhoneNumberStatus`     | `phone_number.json`                                       |
| `kyc_requirement`  | `KycRequirementStatus`  | `kyc_requirement.json`                                    |
| `conversation`     | `ConversationState`     | `conversation.json`                                       |
| `call`             | `CallStatus`            | `call.json`                                               |
| `transfer`         | `TransferState`         | `transfer.json`                                           |
| `agent_version`    | `AgentVersionStatus`    | `agent_version.json`                                      |
| `tool_run`         | `ToolRunStatus`         | `tool_run.json`                                           |
| `booking`          | `BookingStatus`         | `booking.json`                                            |
| `booking_hold`     | `BookingHoldStatus`     | `booking_hold.json`                                       |
| `waitlist_entry`   | `WaitlistStatus`        | `waitlist_entry.json`                                     |
| `knowledge_source` | `KnowledgeSourceStatus` | `knowledge_source.json`                                   |
| `notification`     | `NotificationStatus`    | `notification.json`                                       |
| `integration`      | `IntegrationStatus`     | `integration.json`                                        |
| `support_grant`    | `SupportGrantStatus`    | `support_grant.json`                                      |
| `dsar_request`     | `DsarRequestStatus`     | `dsar_request.json`                                       |
| `runtime_instance` | `RuntimeInstanceState`  | `runtime_instance.json`                                   |

### 5.2 Export and consumption

- `pnpm --filter @velyric/domain run generate:state-machines [--check]` writes the JSON tables (`{ "schema_version": 1, "name", "version", "states", "initial", "terminal", "events", "transitions" }`, sorted deterministically).
- TypeScript services import the machines from `@velyric/domain` and call `transition(machine, from, event)` which returns the next state or throws `INVALID_STATE_TRANSITION`.
- PostgreSQL: status columns carry `CHECK` constraints from `enums.json`; state changes happen only through domain services inside a transaction that also writes the audit event and outbox row. Tables with `version` columns use optimistic concurrency.
- Rust (`voice-runtime`, `metering-worker`): the conversation, call, transfer, tool_run and runtime_instance machines are implemented natively in `velyric-runtime-policy` for latency, and a contract test (`crates/runtime-policy/tests/state_machine_contract.rs`) loads the JSON files via `include_str!` and asserts identical state sets, initial/terminal states and transition triples, plus a proptest that random event sequences never produce a transition absent from the JSON.
- Python services consume only statuses (`knowledge_source`, simulation runs) and assert the transition triples in a pytest contract test reading the same JSON.
- A change to a machine bumps `version`; consumers fail their contract test until updated.

## 6. Service topology

### 6.1 Deploy units and local ports

Deploy units follow master 4.1. Local ports are defined in `LOCAL_SERVICE_PORTS` and `LOCAL_INFRA_PORTS` in `packages/contracts/src/topology.ts`.

| Unit               | Language                               | Local port(s)                                                                                  | Production scaling signal             |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------- |
| web                | TS / Next.js                           | 3000                                                                                           | HTTP RPS / CPU                        |
| control-api        | TS / Fastify                           | 4000 public (`/v1`, webhooks), 4001 internal (`/internal/v1`, service JWT only)                | HTTP RPS                              |
| provider-simulator | TS (`@velyric/testkit`, local/ci only) | 4010                                                                                           | n/a                                   |
| voice-runtime      | Rust / Tokio + Axum                    | 7000 public (provider sideband/webhooks), 7001 admin (health, metrics, drain; private network) | active sessions, CPU, event lag       |
| metering-worker    | Rust                                   | 7100 (health/metrics)                                                                          | NATS consumer lag                     |
| workflow-worker    | TS / Temporal                          | 7200 (health/metrics)                                                                          | task queue backlog                    |
| connector-worker   | TS                                     | 7300 (health/metrics)                                                                          | NATS request backlog, provider limits |
| document-worker    | Python                                 | 7400 (health/metrics)                                                                          | job backlog, CPU                      |
| eval-runner        | Python + TS                            | 7500 (health/metrics)                                                                          | batch jobs                            |

| Infra (local)              | Port          |
| -------------------------- | ------------- |
| Postgres                   | 55432         |
| Redis                      | 56379         |
| NATS client / monitoring   | 54222 / 58222 |
| Temporal frontend / UI     | 57233 / 58233 |
| MinIO API / console        | 59000 / 59001 |
| Mailpit SMTP / UI          | 51025 / 58025 |
| ClamAV                     | 53310         |
| OTel collector gRPC / HTTP | 54317 / 54318 |
| Grafana                    | 53000         |

Every service exposes `GET /healthz/live`, `GET /healthz/ready` and `GET /metrics` (Prometheus text) on its health port (control-api on 4001, voice-runtime on 7001, web on `/api/healthz/*`).

### 6.2 Internal service authentication

- Every internal call carries `Authorization: Bearer <service JWT>`: JWS `alg=EdDSA` (Ed25519), header `kid`, claims `iss` = caller `ServiceName`, `aud` = callee `ServiceName`, `sub` = caller `ServiceName`, `iat`, `nbf`, `exp` (lifetime 300 s, clock skew 30 s), `jti` (UUIDv7), `scope` (space-separated from the list below), optional `tenant_id` when the call is tenant-bound.
- Signing keys: one Ed25519 key per service per environment in AWS Secrets Manager `velyric/<env>/service-keys/<service>` (PKCS#8 PEM). Public keys are distributed as a JWKS document at `velyric/<env>/service-jwks` and cached by verifiers for 10 minutes. Rotation publishes the new key to JWKS first, waits one cache period, then switches the signer.
- Replay: verifiers reject a `jti` already seen within `exp` (Redis `SET NX` on `vly:<env>:jti:<iss>:<jti>`, TTL = remaining lifetime).
- Implemented in `@velyric/security` (`signServiceToken`, `verifyServiceToken`) and in `velyric-runtime-policy::service_auth` for Rust; both are tested against shared vectors in `packages/testkit/fixtures/service-jwt/`.
- Scopes: `runtime.snapshot.read`, `runtime.admission.read`, `tool.execute`, `call.control`, `usage.write`, `provider_cost.write`, `knowledge.ingest`, `knowledge.retrieve`, `simulation.run`, `quality.write`, `notification.send`, `provisioning.execute`, `billing.execute`, `connector.execute`, `support.ops`.
- Local development uses the same JWT mechanism; `pnpm --filter @velyric/config run generate:local-keys` (platform-config) writes per-service Ed25519 keys and the JWKS into `.env` (never committed).

### 6.3 voice-runtime and control-api boundary

voice-runtime never reads control-plane tables. It consumes three internal APIs on control-api port 4001 and caches their results:

| API                          | Method + path                                                                                   | Scope                    | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent config snapshot        | `GET /internal/v1/runtime/agent-snapshots/{agent_version_id}` with `If-None-Match`              | `runtime.snapshot.read`  | Immutable `AgentConfigSnapshot` (TypeBox `packages/contracts/src/api/internal/agent-snapshot.ts`): `snapshot_id`, `tenant_id`, `agent_id`, `agent_version_id`, `config_hash` (sha256 hex of canonical JSON), `voice`, `languages`, `disclosure` (text per locale + `disclosure_version`), `specialists` (kind, tool allowlist, model tier, budgets), `handoff` (allowed destinations, DTMF map), `limits` (max duration, tool budget, spend cap), `recording_policy`, `retention_classes`. ETag = `"<config_hash>"`. Cached in memory and Redis `agentSnapshot`; the runtime keeps serving a cached snapshot when control-api is unavailable. |
| Routing + admission snapshot | `GET /internal/v1/runtime/routing?provider={provider}&e164={e164}`                              | `runtime.admission.read` | `RoutingSnapshot`: `tenant_id`, `location_id`, `phone_number_id`, `production_agent_version_id`, canary `{agent_version_id, rollout_percent}`, `tenant_status`, `entitlement` (`entitlement_version`, `max_concurrent_calls`, `location_concurrency`, `number_concurrency`, `overload_policy`, `max_wait_seconds`, features), `spend` (daily/monthly caps minor + currency), `kill_switches` applicable, `valid_until` (<= 60 s). Refreshed by TTL and invalidated by `domain.v1.*.entitlement.snapshot_created`, `tenant.status_changed`, `agent_version.published`, `kill_switch.changed`.                                                  |
| Tool gateway                 | `POST /internal/v1/tool-gateway/executions` with `Idempotency-Key` = `<call_id>:<tool_call_id>` | `tool.execute`           | Request: `tenant_id`, `call_id`, `agent_version_id`, `specialist`, `tool_name`, `arguments` (validated against the tool JSON Schema), `conversation_state`, `confirmation` (`confirmed_at`, `confirmation_turn_seq`) when required, `trace_id`. Response: `status` (`ToolRunStatus`), `result` (schema-validated, PII-minimized), `error_code`, `retryable`. The gateway enforces allowlist, side-effect class, confirmation policy, budgets, kill switch `kill.tool`, and forwards egress to connector-worker over NATS request/reply.                                                                                                       |

Call control from control-api to voice-runtime (operator transfer/terminate, kill switches) goes through NATS subject `runtime.v1.cmd.<tenant_id>.<call_id>` (core NATS request/reply, not JetStream) signed with a service JWT in the `Authorization` message header; voice-runtime replies with the resulting state.

### 6.4 NATS JetStream

| Stream        | Subjects      | Retention  | Storage / replicas | Max age | Writers                                      | Consumers (durable name)                                                                                                                                                         |
| ------------- | ------------- | ---------- | ------------------ | ------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CALL_EVENTS` | `call.v1.>`   | limits     | file / 3 (1 local) | 7 d     | voice-runtime                                | control-api `control-api-call-events`, metering-worker `metering-call-events`, workflow-worker `workflow-call-events`                                                            |
| `USAGE`       | `usage.v1.>`  | limits     | file / 3           | 14 d    | voice-runtime, connector-worker, control-api | metering-worker `metering-usage`                                                                                                                                                 |
| `DOMAIN`      | `domain.v1.>` | limits     | file / 3           | 7 d     | control-api outbox relay, workflow-worker    | voice-runtime `runtime-domain-<instance>` (ephemeral ordered), workflow-worker `workflow-domain`, connector-worker `connector-domain`                                            |
| `JOBS`        | `jobs.v1.>`   | work-queue | file / 3           | 3 d     | control-api, workflow-worker                 | document-worker `document-knowledge-ingest`, eval-runner `eval-quality-score`, `eval-simulation-run`, connector-worker `connector-sync`, workflow-worker `workflow-export-build` |
| `DEAD_LETTER` | `dlq.v1.>`    | limits     | file / 3           | 30 d    | all consumers after max deliveries           | support console                                                                                                                                                                  |

Subject builders are in `natsSubjects` (`topology.ts`): `call.v1.<tenant_id>.<call_id>.<event_type>`, `usage.v1.<tenant_id>.<metric>`, `domain.v1.<tenant_id|platform>.<event_type>`, `jobs.v1.<job_queue>.<tenant_id>`, `dlq.v1.<stream>.<consumer>`, `runtime.v1.cmd.<tenant_id>.<call_id>`, `svc.v1.connector.execute.<tenant_id>` (core request/reply, queue group `connector-worker`). Event types contain a dot, so a subject's final token pair is the event type. Message id header `Nats-Msg-Id` = `event_id` for JetStream deduplication (duplicate window 2 min). Consumers ack explicitly, `max_deliver` 10 with backoff 1 s, 5 s, 30 s, 2 m, 10 m, then publish to `dlq.v1.<stream>.<consumer>`. Every consumer is idempotent on `event_id` (processed-event table or Redis `SET NX` with TTL >= stream max age).

### 6.5 Event envelope

Defined in `packages/contracts/src/envelope.ts` (`EventEnvelope`, `eventEnvelopeIssues`, `isEventEnvelope`), JSON on NATS and in the outbox:

| Field            | Type                           | Rule                                                                                                                       |
| ---------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `schema_version` | integer >= 1                   | version of this event type's payload schema                                                                                |
| `event_id`       | lowercase UUIDv7               | unique; dedupe key                                                                                                         |
| `event_type`     | `EventType`                    | `<aggregate>.<event>`                                                                                                      |
| `tenant_id`      | UUIDv7 or `null`               | `null` only for `feature_flag.changed`, `kill_switch.changed`, `provider_health.changed`, `runtime.instance_state_changed` |
| `trace_id`       | 32 lowercase hex, non-zero     | W3C trace id; `traceparent` also sent as NATS header                                                                       |
| `occurred_at`    | RFC 3339 UTC with milliseconds | producer clock                                                                                                             |
| `producer`       | `ServiceName`                  | emitting service                                                                                                           |
| `payload`        | object                         | TypeBox schema `packages/contracts/src/events/<event_type>.v<schema_version>.ts`                                           |

No other top-level fields are allowed. Breaking payload changes publish a new `schema_version` alongside the old one until consumers migrate. Call events on the protobuf path (`proto/call_events.proto`) carry the same envelope fields.

### 6.6 Redis key schema

Builders are in `redisKeys` (`topology.ts`). Prefix `vly:<env>`. Every call-scoped key contains both `tenant_id` and `call_id` (v6 4.1). All keys have a TTL.

| Key                        | Pattern                                                                                     | Type                                             | TTL                        |
| -------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------- |
| Call state                 | `vly:<env>:call:<tenant_id>:<call_id>:state`                                                | hash                                             | max call duration + 10 min |
| Call tool budget           | `...:call:<tenant_id>:<call_id>:tool_budget`                                                | counter                                          | same                       |
| Call spend                 | `...:call:<tenant_id>:<call_id>:spend`                                                      | counter (USD micros)                             | same                       |
| Call lock                  | `...:call:<tenant_id>:<call_id>:lock:<name>`                                                | string token                                     | lock lease                 |
| Tenant admission semaphore | `vly:<env>:adm:tenant:<tenant_id>`                                                          | sorted set of `<call_id>` scored by lease expiry | lease 30 s, heartbeat 10 s |
| Location admission         | `vly:<env>:adm:location:<tenant_id>:<location_id>`                                          | sorted set                                       | same                       |
| Number admission           | `vly:<env>:adm:number:<tenant_id>:<phone_number_id>`                                        | sorted set                                       | same                       |
| Global admission           | `vly:<env>:adm:global:<aws_region>`                                                         | sorted set                                       | same                       |
| Provider admission         | `vly:<env>:adm:provider:<provider>:<aws_region>`                                            | sorted set                                       | same                       |
| CPS token bucket           | `vly:<env>:cps:<provider>:<aws_region>:<inbound                                             | outbound>`                                       | hash                       | 1 h idle |
| Rate limit                 | `vly:<env>:rl:<scope>:<subject_id>:<bucket>`                                                | counter / GCRA                                   | window                     |
| Tenant daily spend         | `vly:<env>:spend:<tenant_id>:<YYYY-MM-DD>`                                                  | counter                                          | 48 h                       |
| Agent snapshot cache       | `vly:<env>:snap:agent:<tenant_id>:<agent_version_id>`                                       | string JSON                                      | 24 h                       |
| Booking slot lock          | `vly:<env>:booking:<tenant_id>:<resource_id>:<slot_start_epoch_s>`                          | string token                                     | hold TTL (default 300 s)   |
| Idempotency in flight      | `vly:<env>:idem:<tenant_id>:<sha256(key)>`                                                  | string                                           | 60 s                       |
| OAuth state                | `vly:<env>:oauth_state:<sha256(state)>`                                                     | string JSON                                      | 10 min                     |
| Provider health            | `vly:<env>:provider_health:<provider>:<aws_region>:<capability>`                            | hash                                             | 5 min                      |
| Runtime instance           | `vly:<env>:runtime:instance:<instance_id>`                                                  | hash                                             | 30 s heartbeat             |
| Service JWT replay         | `vly:<env>:jti:<iss>:<jti>` (builder `redisKeys.serviceJwtReplay` to be added by contracts) | string                                           | token remaining lifetime   |

Admission uses a Lua script (acquire = remove expired, check `ZCARD` against the limit, `ZADD` with lease) run atomically for global, provider, tenant, location and number sets in that order; release removes the member from all sets. If Redis is unavailable, admission falls back to the conservative per-instance limit `VOICE_RUNTIME_FALLBACK_MAX_CALLS_PER_TENANT` (default 1) and never exceeds the plan limit (master 32). Redis is never a source of truth for billing, bookings or idempotency results.

### 6.7 Temporal

- Namespaces: `velyric-local`, `velyric-ci`, `velyric-staging`, `velyric-production`.
- Task queues (`TemporalTaskQueue`): `provisioning`, `billing`, `notifications`, `retention`, `knowledge`, `simulations`, `reconciliation`. All are served by `services/workflow-worker`; activities that call providers use `@velyric/connectors`.
- Workflow ids are deterministic and built only via `temporalWorkflowIds` (`topology.ts`): `provisioning:<order_id>`, `subscription-lifecycle:<tenant_id>`, `renewal-reminders:<tenant_id>:<period_end_date>`, `dunning:<tenant_id>:<stripe_invoice_id>`, `invoice:<stripe_invoice_id>`, `reactivation:<tenant_id>:<stripe_invoice_id>`, `cancellation:<tenant_id>:<stripe_subscription_id>`, `refund-compensation:<order_id>`, `phone-number-retention:<tenant_id>:<phone_number_id>`, `secret-rotation:<tenant_id>:<secret_kind>:<version>`, `dsar:<tenant_id>:<request_id>`, `retention-sweep:<tenant_id>:<date>`, `tenant-deletion:<tenant_id>`, `knowledge-sync:<tenant_id>:<source_id>`, `provider-reconciliation:<provider>:<date>`, `notification:<sha256(dedupe_key)>`.
- Start policy: `WorkflowIdReusePolicy.REJECT_DUPLICATE` for business workflows (a second start is a no-op returning the existing run), `ALLOW_DUPLICATE_FAILED_ONLY` for reconciliation. Workflow code is deterministic; PostgreSQL remains the business source of truth and every activity writes its own idempotent row keyed by `(workflow_id, activity_name, attempt_key)`.
- Search attributes: `VelyricTenantId` (Keyword), `VelyricOrderId` (Keyword), `VelyricState` (Keyword).
- Tests use `@temporalio/testing` `TestWorkflowEnvironment.createTimeSkipping()` (runs locally without Docker).

### 6.8 S3 object storage

- Buckets: `<bucket_prefix>-<purpose>` with `bucket_prefix` = `velyric-<env>-<aws_region>` in AWS (for example `velyric-production-eu-central-1-knowledge`) and `velyric-local` in MinIO. Purposes (`S3BucketPurpose`): `knowledge`, `artifacts`, `recordings`, `exports`, `evidence`, `transient`.
- Object keys: `tenants/<tenant_id>/<domain>/<object_id>/v<version>/<filename>` via `s3.tenantObjectKey`. Platform-level objects (not tenant data) use `platform/<domain>/<object_id>/v<version>/<filename>`.
- All buckets: SSE-KMS with the per-purpose CMK, versioning on, public access blocked, TLS-only bucket policy. `evidence` has Object Lock (governance) for dispute retention. `transient` expires after 1 day. Uploads use presigned PUT with content-length and content-type conditions to `transient`, then malware scan and move to `knowledge`.

## 7. Configuration, secrets and provider modes

### 7.1 Environments and provider modes

`VELYRIC_ENV` (`VelyricEnvironment`) is required by every process. Provider mode per provider is `VELYRIC_PROVIDER_MODE_<PROVIDER>` (`ProviderMode`), for example `VELYRIC_PROVIDER_MODE_STRIPE=sandbox`.

| Environment | Data                    | Allowed provider modes | Default     |
| ----------- | ----------------------- | ---------------------- | ----------- |
| local       | synthetic fixtures      | `simulator`, `sandbox` | `simulator` |
| ci          | ephemeral DB/Redis/NATS | `simulator`            | `simulator` |
| staging     | non-production PII only | `sandbox`              | `sandbox`   |
| production  | real tenants            | `live`                 | `live`      |

Config validation rejects any other combination at boot (for example `live` outside production or `simulator` in staging). In `simulator` mode the adapter is the real adapter pointed at `VELYRIC_PROVIDER_SIMULATOR_URL` (`http://127.0.0.1:4010/<provider>`) with simulator credentials; there is no separate fake implementation. The simulator process (`@velyric/testkit` bin `velyric-provider-simulator`) exits with code 78 unless `VELYRIC_ENV` is `local` or `ci`. A missing credential for a `sandbox`/`live` provider fails boot with `CONFIG_INVALID: <VAR> is required when VELYRIC_PROVIDER_MODE_<PROVIDER>=<mode>`.

### 7.2 Environment variable naming

- Format `UPPER_SNAKE`. Shared variables use the `VELYRIC_` prefix; service-specific variables use the service prefix: `WEB_`, `CONTROL_API_`, `VOICE_RUNTIME_`, `WORKFLOW_WORKER_`, `CONNECTOR_WORKER_`, `METERING_WORKER_`, `DOCUMENT_WORKER_`, `EVAL_RUNNER_`. Browser-exposed variables use `NEXT_PUBLIC_VELYRIC_` and may never hold secrets.
- Secrets are never read from plain env vars in staging/production. The env var holds a Secrets Manager id with suffix `_SECRET_ARN`; locally the value itself is provided with suffix `_SECRET` in `.env`. Config loaders accept exactly one of the two and zeroize after loading where possible.
- Schemas: TypeScript `@velyric/config` (TypeBox, `loadConfig(serviceName)`), Rust a `serde` config struct deserialized from the environment with explicit validation in each binary's `config.rs`, Python `pydantic-settings`. `.env.example` (platform-config) documents every variable without values.

Shared variables:

| Variable                                                                | Example (local)                                                 |
| ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| `VELYRIC_ENV`                                                           | `local`                                                         |
| `VELYRIC_AWS_REGION`                                                    | `eu-central-1`                                                  |
| `VELYRIC_SERVICE_INSTANCE_ID`                                           | generated UUIDv7 at boot when unset                             |
| `VELYRIC_DATABASE_URL` (role-specific, see 9.2)                         | `postgres://velyric_app@127.0.0.1:55432/velyric`                |
| `VELYRIC_REDIS_URL`                                                     | `redis://127.0.0.1:56379`                                       |
| `VELYRIC_NATS_URL` / `VELYRIC_NATS_CREDS_SECRET[_ARN]`                  | `nats://127.0.0.1:54222`                                        |
| `VELYRIC_TEMPORAL_ADDRESS` / `VELYRIC_TEMPORAL_NAMESPACE`               | `127.0.0.1:57233` / `velyric-local`                             |
| `VELYRIC_S3_ENDPOINT` (local only) / `VELYRIC_S3_BUCKET_PREFIX`         | `http://127.0.0.1:59000` / `velyric-local`                      |
| `VELYRIC_OTEL_EXPORTER_OTLP_ENDPOINT`                                   | `http://127.0.0.1:54318`                                        |
| `VELYRIC_SENTRY_DSN`                                                    | empty locally (Sentry disabled)                                 |
| `VELYRIC_LOG_LEVEL`                                                     | `info`                                                          |
| `VELYRIC_PROVIDER_SIMULATOR_URL`                                        | `http://127.0.0.1:4010`                                         |
| `VELYRIC_SERVICE_SIGNING_KEY_SECRET[_ARN]` / `VELYRIC_SERVICE_JWKS_URL` | PEM / `http://127.0.0.1:4001/internal/v1/.well-known/jwks.json` |
| `VELYRIC_CONTROL_API_INTERNAL_URL`                                      | `http://127.0.0.1:4001`                                         |
| `VELYRIC_PUBLIC_WEB_ORIGIN` / `VELYRIC_PUBLIC_API_ORIGIN`               | `http://localhost:3000` / `http://localhost:4000`               |
| `VELYRIC_PROVIDER_MODE_<OPENAI                                          | TELNYX                                                          | TWILIO | STRIPE | BILLINGO | GOOGLE | MICROSOFT | AWS_SES | WORKOS>` | `simulator` |

Service-specific examples: `CONTROL_API_PUBLIC_PORT=4000`, `CONTROL_API_INTERNAL_PORT=4001`, `CONTROL_API_CORS_ALLOWED_ORIGINS`, `WEB_PORT=3000`, `VOICE_RUNTIME_PUBLIC_PORT=7000`, `VOICE_RUNTIME_ADMIN_PORT=7001`, `VOICE_RUNTIME_DRAIN_TIMEOUT_SECONDS=1800`, `VOICE_RUNTIME_FALLBACK_MAX_CALLS_PER_TENANT=1`, `METERING_WORKER_PORT=7100`, `WORKFLOW_WORKER_PORT=7200`, `CONNECTOR_WORKER_PORT=7300`, `CONNECTOR_WORKER_EGRESS_ALLOW_HTTP` (local only), `DOCUMENT_WORKER_PORT=7400`, `DOCUMENT_WORKER_CLAMAV_ADDRESS=127.0.0.1:53310`, `EVAL_RUNNER_PORT=7500`.

### 7.3 Secret catalog

Secrets Manager path `velyric/<env>/<name>`; KMS CMK aliases `alias/velyric-<env>-<purpose>`. IAM principals are the ECS task roles `velyric-<env>-<service>`.

| Secret name                                                    | Content                                                                                    | Readable by                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database/<role>`                                              | Postgres credentials per role (`migrator`, `app`, `readonly`, `support`, `metering`)       | `migrator`: CI deploy role only; `app`: control-api, workflow-worker, connector-worker; `metering`: metering-worker; `readonly`: Grafana analytics datasource and export jobs; `support`: control-api support module via a separate pool |
| `redis/auth`                                                   | Redis ACL user + password                                                                  | control-api, voice-runtime, workflow-worker, connector-worker                                                                                                                                                                            |
| `nats/<service>`                                               | NATS user credentials (nkey/JWT) scoped to the service's subjects                          | the named service                                                                                                                                                                                                                        |
| `service-keys/<service>`                                       | Ed25519 service JWT signing key                                                            | the named service                                                                                                                                                                                                                        |
| `service-jwks`                                                 | public JWKS                                                                                | all services                                                                                                                                                                                                                             |
| `session-signing-key`                                          | HMAC key for signing local auth session tokens                                             | control-api                                                                                                                                                                                                                               |
| `stripe/secret-key`, `stripe/webhook-signing-secret`           | Stripe                                                                                     | control-api (webhooks, checkout), workflow-worker                                                                                                                                                                                        |
| `billingo/api-key`                                             | Billingo API v3                                                                            | workflow-worker only                                                                                                                                                                                                                     |
| `telnyx/api-key`, `telnyx/webhook-public-key`                  | Telnyx                                                                                     | workflow-worker (orders), control-api (webhook verify), voice-runtime (call control)                                                                                                                                                     |
| `twilio/account-sid`, `twilio/auth-token`                      | Twilio fallback                                                                            | voice-runtime, control-api (webhook verify)                                                                                                                                                                                              |
| `openai/admin-key`                                             | OpenAI Admin API key (organization)                                                        | workflow-worker provisioning activities only (master 7); access alarmed                                                                                                                                                                  |
| `openai/platform-key`                                          | platform key for non-tenant jobs (eval, embeddings for platform docs)                      | eval-runner, document-worker                                                                                                                                                                                                             |
| `openai/webhook-secret`                                        | OpenAI webhook signing secret                                                              | voice-runtime, control-api                                                                                                                                                                                                               |
| `tenants/<tenant_id>/openai-service-account-key/v<version>`    | per-tenant scoped key (`TenantSecretKind.OPENAI_SERVICE_ACCOUNT_KEY`)                      | voice-runtime, document-worker, eval-runner (read); workflow-worker (create/rotate)                                                                                                                                                      |
| `tenants/<tenant_id>/<secret_kind>/<secret_ref_id>/v<version>` | OAuth tokens, SMTP passwords, custom API credentials, webhook signing secrets, widget keys | connector-worker (read); control-api (create/rotate, never read back)                                                                                                                                                                    |
| `google/oauth-client`, `microsoft/oauth-client`                | OAuth client id + secret                                                                   | control-api (callback), connector-worker (refresh)                                                                                                                                                                                       |
| `ses/configuration`                                            | SES configuration set + identity ARN (IAM auth, no static key)                             | workflow-worker, connector-worker                                                                                                                                                                                                        |
| `sentry/dsn-<service>`                                         | Sentry DSN                                                                                 | named service                                                                                                                                                                                                                            |

Tenant secret metadata (`tenant_secret_refs` table: provider, kind, secret_ref, version, expires_at, rotated_at) is stored in PostgreSQL; plaintext never is. Rotation workflow: create new version -> publish ref -> health check -> revoke old (Temporal `secret-rotation:*`).

### 7.4 Local development rules

- Auth: email/password authentication is fully in-house (control-api's `/v1/auth/{register,login,logout}`, scrypt-hashed passwords, HMAC-signed revocable session tokens); there is no external identity provider and no "dev login" bypass in application code.
- Seeds (`db/seeds/local/**`) contain synthetic tenants only and are applied only when `VELYRIC_ENV` is `local` or `ci`.
- Adapters must expose `mode` in health output so an operator can see which mode is active.

## 8. API conventions

### 8.1 Surfaces and auth modes

| Surface           | Base                                                         | Auth (`AuthMode`)                                                                                                         | Consumers                              |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Browser app API   | `https://api.<domain>/v1` (local `http://localhost:4000/v1`) | `SESSION_COOKIE` (in-house HMAC-signed, DB-revocable session cookie `vly_session`, validated server-side)                 | web                                    |
| Public API        | same `/v1`                                                   | `API_KEY` (`Authorization: Bearer vly_<env>_<key_id>_<secret>`; stored as `key_id` + argon2id hash; scopes = permissions) | customers                              |
| Provider webhooks | `/v1/webhooks/providers/<provider>`                          | `WEBHOOK_SIGNATURE`                                                                                                       | Stripe, Telnyx, Twilio, OpenAI         |
| Web voice widget  | `/v1/widget/*`                                               | `WIDGET_TOKEN` (EdDSA JWT, 5 min, origin-bound)                                                                           | embedded widget                        |
| Internal          | port 4001 `/internal/v1`                                     | `SERVICE_JWT`                                                                                                             | services                               |

Tenant context is always resolved from the authenticated membership or API key, never from the request body. Resource routes are not nested under the workspace: browser requests send the active workspace as header `X-Velyric-Workspace: <tenant_id>`, which control-api verifies against the session user's memberships (`FORBIDDEN` otherwise). Public API keys are bound to exactly one tenant and ignore the header.

### 8.2 CSRF, cookies and CORS

- Session cookie: `HttpOnly; Secure; SameSite=Lax; Path=/`, `__Host-` prefix in staging/production.
- CSRF for cookie-authenticated state-changing requests (`POST, PUT, PATCH, DELETE`): double-submit token. The web app sets `__Host-vly_csrf` (random 32 bytes, base64url, `SameSite=Strict`, not HttpOnly) and sends header `X-CSRF-Token`; control-api compares in constant time and additionally requires `Origin` to be in the CORS allowlist. Failure returns `CSRF_TOKEN_INVALID`. API-key and service-JWT requests are exempt.
- CORS allowlist per environment: `CONTROL_API_CORS_ALLOWED_ORIGINS` (comma-separated exact origins; local `http://localhost:3000`; production `https://velyric.com,https://www.velyric.com,https://app.velyric.com`), `credentials: true`, no wildcards. Widget endpoints use the tenant's configured widget domain allowlist.

### 8.3 Idempotency

- `Idempotency-Key` header (1-255 chars `[A-Za-z0-9_.:-]`) is required on every externally repeatable write (all `POST` creating resources or triggering side effects, every endpoint marked "idempotency" in master 13) and returns `IDEMPOTENCY_KEY_REQUIRED` when missing.
- Storage: table `idempotency_records` (`tenant_id`, `actor_scope`, `key_hash` sha256, `method`, `route`, `request_hash` sha256 of canonical body, `state` (`IdempotencyRecordState`), `response_status`, `response_body` (encrypted if it may hold PII), `created_at`, `expires_at` = +24 h), unique `(tenant_id, actor_scope, key_hash)`. Redis `idempotencyInFlight` only short-circuits concurrent duplicates.
- Semantics: first request inserts `IN_PROGRESS` inside the business transaction; replay with identical `request_hash` returns the stored response with header `Idempotency-Replayed: true`; replay with a different hash returns `IDEMPOTENCY_KEY_REUSED` (422); a replay while `IN_PROGRESS` returns `IDEMPOTENCY_KEY_IN_PROGRESS` (409, `Retry-After: 1`). 5xx responses are not stored, so retries re-execute safely.
- Webhooks are deduplicated on provider event id (`provider_webhook_events` unique `(provider, provider_event_id)`), not Idempotency-Key.

### 8.4 Optimistic concurrency

Mutable configuration resources expose `version` (integer) and `ETag: W/"<version>"`. `PATCH`/`PUT` require `If-Match` (missing -> `PRECONDITION_REQUIRED` 428, mismatch -> `VERSION_CONFLICT` 412). Updates run `UPDATE ... WHERE id = $1 AND version = $2` and increment `version`.

### 8.5 Pagination, filtering and formats

- Cursor pagination on every list: query `limit` (1-200, default 50) and `cursor`; response `{ "data": [...], "page": { "next_cursor": string | null, "limit": number } }`. Cursor = base64url of JSON `{ "v": 1, "k": [<sort key values>], "id": "<uuid>" }`, HMAC-SHA256 signed with a server key (`.<sig>` suffix) so it cannot be forged. No offset pagination.
- JSON field names `snake_case`; ids UUIDv7 strings; timestamps RFC 3339 UTC; money `{ "amount_minor": integer, "currency": "HUF" }`; durations in seconds or `_ms` suffixed milliseconds; phone numbers E.164.

### 8.6 Error envelope

Every non-2xx response body is exactly `ApiErrorEnvelope`:

```json
{
  "code": "VERSION_CONFLICT",
  "message_key": "errors.version_conflict",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "details": { "current_version": 7 }
}
```

`code` from `ApiErrorCode`, HTTP status from `API_ERROR_HTTP_STATUS`, `message_key` translated by the client via `@velyric/i18n` (`errors` namespace), `details` optional and never contains stack traces, SQL, secrets or PII. The same `trace_id` is returned in header `X-Trace-Id`. Validation errors use `details.issues: [{ "path": "/body/name", "rule": "minLength" }]`.

### 8.7 Rate limits

Algorithm GCRA in Redis (`redisKeys.rateLimit`). Limits apply per `RateLimitScope` with an operation cost weight; a request consumes `weight` tokens from every applicable bucket.

| Scope     | Bucket        | Capacity per minute             |
| --------- | ------------- | ------------------------------- |
| `ip`      | `global`      | 600 (unauthenticated routes 60) |
| `user`    | `global`      | 1 200                           |
| `tenant`  | `global`      | 6 000                           |
| `api_key` | `global`      | 1 200                           |
| `webhook` | `<provider>`  | 3 000                           |
| `widget`  | `<tenant_id>` | 120                             |

| Operation class                                                                                 | Weight |
| ----------------------------------------------------------------------------------------------- | ------ |
| read/list                                                                                       | 1      |
| config write                                                                                    | 5      |
| search heavy (`POST /v1/phone-numbers/search`, call search with full-text)                      | 20     |
| provider side effect (`/phone-numbers/order`, `/billing/checkout`, OAuth connect, webhook test) | 50     |
| batch (`/simulations/runs`, exports, knowledge upload)                                          | 100    |

Responses include `RateLimit-Policy` and `RateLimit` headers (IETF draft) and `Retry-After` on `RATE_LIMITED`.

### 8.8 Other rules

- Body limit 1 MiB JSON (uploads go to presigned S3), request timeout 30 s, `@fastify/under-pressure` returns `SERVICE_UNAVAILABLE`.
- OpenAPI 3.1 generated from TypeBox route schemas; `additionalProperties: false` on every request object; responses are serialized through their schema.
- Every state-changing request writes an `audit_logs` row in the same transaction.
- Internal routes are never registered on the public port.

## 9. Database conventions

### 9.1 Migrations

- Plain SQL, forward-only, in `db/migrations/<track>/<NNNN>_<snake_case_name>.sql` (`NNNN` zero-padded, gapless per track). Two tracks: `core` (everything that runs on any PostgreSQL 18) and `vector` (objects that need the `vector` extension: `CREATE EXTENSION vector`, embedding columns/tables, HNSW indexes). `core` never depends on `vector`; `vector` depends on `core`.
- `db/migrations/manifest.json` is the ordered source of truth (no metadata in SQL comments):

```json
{
  "schema_version": 1,
  "migrations": [
    {
      "id": "core/0001_roles_and_schemas",
      "track": "core",
      "file": "core/0001_roles_and_schemas.sql",
      "sha256": "<hex>",
      "phase": "expand",
      "transactional": true,
      "requires_extensions": [],
      "depends_on": [],
      "contract_of": null,
      "release_introduced": "2026.09.0"
    }
  ]
}
```

`phase` is `expand`, `migrate` (data backfill, batched and idempotent) or `contract`; a `contract` migration names the `expand` migration it finishes in `contract_of` and may only ship in a later release than it. `transactional: false` is required for `CREATE INDEX CONCURRENTLY`.

- Runner: `@velyric/db` bin `velyric-migrate` (`migrate`, `status`, `verify`), using `pg` as `velyric_migrator`. It takes `pg_advisory_lock` on key `hashtext('velyric.migrations')`, records rows in `velyric_meta.schema_migrations (id text primary key, track text, sha256 text, applied_at timestamptz, applied_by text)`, refuses checksum mismatches or unknown applied ids, and applies `core` then `vector`. `--tracks core` applies only `core`.
- Rollback is a new forward migration. Every migration is tested on a clean database and on a database at the previous release (N-1 compatibility: the previous application release's DB test suite runs against the new schema in CI).

### 9.2 Roles

| Role                | Login | Purpose                                                                                                                                                    |
| ------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `velyric_owner`     | no    | owns all schemas and objects                                                                                                                               |
| `velyric_migrator`  | yes   | member of `velyric_owner`; only used by the migration runner                                                                                               |
| `velyric_app`       | yes   | control-api, workflow-worker, connector-worker; DML on application tables, subject to RLS, `NOBYPASSRLS`, no DDL, no UPDATE/DELETE on append-only tables   |
| `velyric_metering`  | yes   | metering-worker; INSERT on `usage_events`, `provider_cost_events`; INSERT/UPDATE on `usage_aggregates`; SELECT on the tables it reconciles; subject to RLS |
| `velyric_readonly`  | yes   | SELECT on `analytics` schema views only                                                                                                                    |
| `velyric_support`   | yes   | SELECT on `support` schema security-barrier views that require an active support grant (`support_grants`) for the session's `app.support_grant_id`         |
| `velyric_retention` | no    | granted to `velyric_app` only through `SECURITY DEFINER` retention functions that delete per retention class and write the deletion evidence audit row     |

Schemas: `app` (application tables), `analytics` (views/materialized aggregates), `support` (redacted views), `velyric_meta` (migration bookkeeping). Every role has `search_path = app, public` fixed with `ALTER ROLE ... SET`.

### 9.3 Tenant isolation (RLS)

- Every tenant-owned table has `tenant_id uuid NOT NULL REFERENCES app.tenants(id)`, `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`, and the policy:

```sql
CREATE POLICY tenant_isolation ON app.<table>
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
```

`app.current_tenant_id()` returns `nullif(current_setting('app.tenant_id', true), '')::uuid`, so an unset context matches no rows.

- Platform background jobs that must see many tenants (dunning sweeps, reconciliation, retention) iterate tenant ids from `app.tenant_directory` (id, status only, no RLS) and open one tenant transaction per tenant. There is no RLS bypass for application roles.
- Session context is set only inside an explicit transaction with transaction-local settings (`set_config(..., true)` is `SET LOCAL`). `@velyric/db` provides the only allowed entry point:

```ts
withTenantTransaction(db, { tenantId, actorType, actorId, traceId }, async (trx) => { ... })
```

which runs `db.transaction().execute(async (trx) => { await sql\`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.actor_type', ${actorType}, true), set_config('app.actor_id', ${actorId}, true), set_config('app.trace_id', ${traceId}, true)\`.execute(trx); return fn(trx); })`. Rust uses the same statements on an `sqlx::Transaction`. Pool connections never carry session-level settings.

- RAG retrieval SQL lives only in `@velyric/db` query functions that take `tenantId` as a required parameter and filter `tenant_id` (and ACL) before vector ordering; an adversarial cross-tenant dataset test is mandatory.
- Indirect ownership (for example `call_events` through `calls`) still stores `tenant_id` denormalized with a composite FK `(tenant_id, call_id) REFERENCES app.calls(tenant_id, id)`.

### 9.4 Append-only tables

`audit_logs`, `consent_ledger`, `usage_events`, `provider_cost_events`, `payment_events`, `billing_ledger_entries`, `provider_webhook_events`, `call_events`, `notification_events` (status changes are new rows in `notification_attempts`). Enforcement: `REVOKE UPDATE, DELETE` from `velyric_app` and `velyric_metering`, plus trigger `app.forbid_mutation()` (`BEFORE UPDATE OR DELETE ... RAISE EXCEPTION`) that only the `velyric_retention` definer functions bypass via `app.retention_context = 'on'` checked inside the trigger. Corrections are compensating rows.

### 9.5 Identifiers, time and money

- Primary keys `id uuid` UUIDv7, generated by the application (`uuid` v7 in TS, `uuid` crate `now_v7`, `uuid-utils` in Python); columns also default to PostgreSQL 18 `uuidv7()`.
- All timestamps `timestamptz`; `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at` maintained by trigger `app.touch_updated_at()`; business dates that are local use `date` + an IANA `timezone text` column.
- Money: `<name>_minor bigint NOT NULL` + `currency char(3) NOT NULL CHECK (currency IN ('HUF','EUR','USD'))`; provider costs `<name>_usd_micros bigint`. Usage quantities `bigint` in the `UsageUnit`.
- Mutable config rows carry `version integer NOT NULL DEFAULT 1` (section 8.4).
- E.164 phone numbers `text CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$')`; normalized identity values are stored with a sha256 lookup hash where the value is sensitive.

### 9.6 Enum strategy

Enumerated columns are `text` with a named `CHECK` constraint `<table>_<column>_check` listing the values from `packages/contracts/generated/enums.json`. `pnpm --filter @velyric/db run enums:check` fails when a constraint and `enums.json` disagree; adding a value is an `expand` migration that drops and re-adds the constraint (`NOT VALID` then `VALIDATE CONSTRAINT`). PostgreSQL `ENUM` types are not used.

### 9.7 Expand/contract

Destructive changes (drop/rename column or table, narrowing type, new NOT NULL without default) are three manifest entries across at least two releases: `expand` (add new structure, dual-write in code) -> `migrate` (batched backfill with `WHERE ... LIMIT`, safe to re-run) -> `contract` (remove old structure after no deployed code reads it). CI rejects a `contract` migration whose `contract_of` shipped in the same release.

### 9.8 Table ownership by services

All tables are created by `db/migrations` (owner: db module). Writers: control-api owns all `app` tables except the metering tables; workflow-worker and connector-worker write only through domain repositories in `@velyric/db`; metering-worker (Rust, sqlx, `velyric_metering`) writes `usage_events`, `provider_cost_events`, `usage_aggregates`; voice-runtime, document-worker and eval-runner never connect to PostgreSQL and use internal APIs/NATS.

### 9.9 Databases for tests

- `@velyric/db/testing` exports `createTestDatabase({ tracks }: { tracks: readonly ('core' | 'vector')[] })` returning `{ connectionString | pglite, kind, dispose }`.
- Resolution order: (1) `VELYRIC_TEST_DATABASE_URL` set -> use that server (CI service container `pgvector/pgvector:0.8.6-pg18`), apply requested tracks into a fresh database cloned from a migrated template database per test file; (2) otherwise `embedded-postgres` 18 on a free port (`get-port`) with a temporary data directory, used for the `core` track and every RLS, constraint, concurrency and locking test (real multi-connection server); (3) the `vector` track locally runs on `@electric-sql/pglite` with `@electric-sql/pglite/vector` (core + vector migrations applied), used for retrieval ranking and tenant-filter tests only.
- `CI=true` sets `VELYRIC_REQUIRE_FULL_DB=1`: every suite must run on the server from (1) with both tracks; any fallback is a failure. Locally, a suite that cannot run on the available engine reports `not run locally: <reason>` and stays mandatory in CI.
- Command: `pnpm test:db` runs `pnpm -r --if-present run test:db`; every package keeps DB-backed tests in `*.db.test.ts` behind its own `test:db` script.

## 10. Frontend conventions

### 10.1 Route tree (`apps/web/src/app`)

| Path                                                                                                                          | Route group / owner                                       | Notes                                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| `/[locale]`                                                                                                                   | `[locale]/(marketing)/page.tsx` web-marketing             | homepage; `locale` in `hu`, `de`, `en`                |
| `/[locale]/product`, `/pricing`, `/integrations`, `/security`, `/docs`                                                        | `[locale]/(marketing)/...` web-marketing                  | index                                                 |
| `/[locale]/solutions/[vertical]`                                                                                              | `[locale]/(marketing)/solutions/[vertical]` web-marketing | `vertical` in `VerticalSlug`; unknown -> 404          |
| `/[locale]/login`, `/[locale]/signup`                                                                                         | `[locale]/(auth)/...` web-dashboard-admin                 | `noindex`                                             |
| `/[locale]/checkout`, `/[locale]/checkout/return`                                                                             | `[locale]/(commerce)/...` web-dashboard-admin             | return page only polls order state; never activates   |
| `/legal/privacy`, `/legal/terms`, `/legal/dpa`                                                                                | `legal/[document]` web-marketing                          | rendered in the resolved locale; alternates `?lang=hu | de  | en`, canonical includes `lang` |
| `/status`                                                                                                                     | `status/route.ts` web-marketing                           | 308 to `VELYRIC_STATUS_PAGE_URL`                      |
| `/app`                                                                                                                        | `app/page.tsx` web-foundation                             | redirects to last used workspace or onboarding        |
| `/app/onboarding/**` (incl. `/app/onboarding/[workspace]/go-live`)                                                            | web-dashboard-admin                                       |                                                       |
| `/app/[workspace]/dashboard`, `calls`, `calls/[id]`, `agents`, `agents/[id]`, `agents/[id]/versions`                          | `app/[workspace]/(core)/...` web-dashboard-core           |                                                       |
| `/app/[workspace]/knowledge`, `contacts`, `bookings`, `integrations`, `analytics`, `phone-numbers`, `locations`, `simulation` | `app/[workspace]/(ops)/...` web-dashboard-ops             |                                                       |
| `/app/[workspace]/billing`, `settings`, `security`                                                                            | `app/[workspace]/(admin)/...` web-dashboard-admin         |                                                       |
| `/internal/support/**`                                                                                                        | `internal/support` web-support-console                    | staff only, `noindex`, 404 for non-staff              |
| `/api/healthz/live`, `/api/healthz/ready`                                                                                      | web-foundation                                            |                                                       |

`[workspace]` is the tenant id (UUIDv7). App and support routes are not locale-prefixed; their locale is the account preference, then the locale cookie, then `en`. `app/[workspace]/layout.tsx` (web-foundation) renders the shared shell (sidebar, top bar) matching the dashboard reference.

### 10.2 Request pipeline (`apps/web/src/proxy.ts`, Node.js runtime)

Next.js 16 uses `proxy.ts` (exported `proxy` function; the Edge runtime is not available). next-intl routing is `defineRouting({ locales: ['hu','de','en'], defaultLocale: 'en', localePrefix: 'always', localeDetection: false, localeCookie: { name: 'NEXT_LOCALE', maxAge: 31536000, sameSite: 'lax' } })` in `apps/web/src/i18n/routing.ts`; the proxy performs detection itself so geo can be applied. Order:

1. Matcher excludes `/_next`, `/api`, and paths containing a dot.
2. Generate a per-request CSP nonce; set security headers (CSP with nonce and `strict-dynamic`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-Content-Type-Options`, HSTS in staging/production).
3. `/internal/support/**`: require the `vly_session` cookie to be present; otherwise rewrite to 404 (the support console still needs a real staff-role check, tracked separately).
4. `/app/**`: require the `vly_session` cookie to be present (presence-only at the edge; control-api validates the signature and DB revocation state on each request); unauthenticated -> 307 to `/<resolved-locale>/login?return_to=<path>`.
5. Public paths without a locale prefix: resolve locale by master 10 priority: account preference (session) -> `NEXT_LOCALE` cookie -> first anonymous visit country header `CF-IPCountry` (`HU` -> `hu`; `DE`, `AT`, `CH`, `LI` -> `de`; any other valid country -> `en`) -> `Accept-Language` best match when the country header is missing, `XX` or `T1` -> `en`; respond 307 to `/<locale><path>`. Detection never writes the cookie.
6. Prefixed public paths: pass to next-intl `createMiddleware(routing)`; an explicit language switch navigates to the other prefix and the switcher writes `NEXT_LOCALE` (the only place the cookie is written).
7. Theme cookie is read in the root layout, not in the proxy (10.3).

### 10.3 Theme without flash

Cookie `vly_theme` = `light | dark | system` (`ThemePreference`, 1 year, `SameSite=Lax`). The root layout reads it server-side and renders `<html data-theme="light|dark">`. For `system` the server uses the `Sec-CH-Prefers-Color-Scheme` client hint (responses send `Accept-CH` and `Critical-CH: Sec-CH-Prefers-Color-Scheme`); if the hint is absent it renders `data-theme="system"` plus a nonce-bearing inline script in `<head>` that sets `data-theme` from `matchMedia` before first paint. The theme switch writes the cookie and updates the attribute. CSS tokens are keyed on `[data-theme="dark"]`.

### 10.4 Data fetching and state

- Server Components fetch read-heavy data from control-api through `apps/web/src/server/api-client.ts` (forwards the session, workspace header, `traceparent`); results are never cached across users (`cache: 'no-store'` for tenant data).
- Interactive dashboard state uses TanStack Query in client components with query keys `['<resource>', tenantId, params]`, hydrated from server-rendered data via `HydrationBoundary`. Live data (active calls) polls every 5 s or uses SSE from control-api `/v1/calls/live/stream`.
- Mutations go through TanStack Query mutations calling control-api with `Idempotency-Key` (UUIDv7 per user action) and CSRF header; optimistic updates only for rollback-safe writes.
- Forms: React Hook Form + `standardSchemaResolver` with Zod input schemas from `@velyric/domain` (section 2.2).
- Large lists (calls, events, contacts) virtualize with TanStack Virtual.
- Errors render the translated `message_key` and show `trace_id` as a copyable support reference.

### 10.5 Design tokens

Brand tokens are master 8.2 verbatim, defined as CSS custom properties in `packages/ui/src/styles/tokens.css` and exposed to Tailwind v4 through `@theme inline`:

| Token             | Light     | Dark      |
| ----------------- | --------- | --------- |
| `--bg`            | `#FFFFFF` | `#08090D` |
| `--surface`       | `#FFFFFF` | `#11131A` |
| `--surface-muted` | `#FFF7FB` | `#17131B` |
| `--text`          | `#071327` | `#F8FAFC` |
| `--text-muted`    | `#5B6578` | `#AAB2C2` |
| `--magenta`       | `#F000FF` | `#F000FF` |
| `--pink`          | `#FF007A` | `#FF2B91` |
| `--crimson`       | `#FF174E` | `#FF315F` |
| `--coral`         | `#FF7A59` | `#FF8F73` |
| `--plum`          | `#8E0069` | `#C11A8B` |
| `--border`        | `#EDE8F0` | `#262833` |
| `--success`       | `#11A66A` | `#34D399` |
| `--warning`       | `#E6A100` | `#FBBF24` |
| `--danger`        | `#D92D4C` | `#FB7185` |

Derived scale from the landing and dashboard references (the dashboard block is the 1:1 target):

| Group                                   | Tokens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gradients                               | `--gradient-cta: linear-gradient(90deg, #FF007A 0%, #FF174E 55%, #FF7A59 100%)`; `--gradient-band: linear-gradient(100deg, #8E0069 0%, #F000FF 45%, #FF007A 72%, #FF7A59 100%)` (bottom CTA); `--glow-blush: radial-gradient(closest-side, rgba(255,0,122,0.18), rgba(240,0,255,0.08) 55%, transparent)`                                                                                                                                                                                                 |
| Radius                                  | `--radius-xs: 6px` (chips), `--radius-sm: 8px` (intent/outcome badges, inputs), `--radius-md: 12px` (buttons, sidebar active item, date range select), `--radius-lg: 16px` (KPI and dashboard cards), `--radius-xl: 20px` (dashboard frame, feature cards), `--radius-2xl: 28px` (bottom CTA band, phone mockup), `--radius-full: 9999px` (avatars, toggles)                                                                                                                                             |
| Shadow                                  | `--shadow-card: 0 1px 2px rgba(7,19,39,0.04), 0 8px 24px -6px rgba(7,19,39,0.06)`; `--shadow-float: 0 24px 60px -16px rgba(142,0,105,0.22)` (floating conversation cards); `--shadow-cta: 0 10px 24px -8px rgba(255,0,122,0.45)`; dark theme uses `0 0 0 1px var(--border)` plus `0 12px 32px -12px rgba(0,0,0,0.6)`                                                                                                                                                                                     |
| Spacing                                 | 4 px base: `--space-1..12` = 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128 px; dashboard card padding 20 px, grid gap 16 px, sidebar width 208 px at 1440 px viewport, section vertical rhythm 96 px (marketing)                                                                                                                                                                                                                                                                                         |
| Typography                              | Geist Sans via `geist/font/sans` (`--font-sans`), Geist Mono via `geist/font/mono` (`--font-mono`, ids, phone numbers in tables, timestamps in timelines). Scale (size/line-height/tracking/weight): display 64/1.02/-0.035em/700; h1 48/1.05/-0.03em/700; h2 40/1.1/-0.028em/700; h3 24/1.25/-0.015em/600; kpi 28/1.1/-0.02em/650; title 18/1.35/-0.01em/600; body 16/1.6/0/400; body-sm 14/1.5/0/400; caption 12/1.4/0/500; eyebrow 11/1.2/0.18em/600 uppercase in `--plum` (light) or `--pink` (dark) |
| Dashboard intent badges (reference 1:1) | `--badge-sales-bg: #EAF2FD`, `--badge-sales-text: #2E5FA8`; `--badge-support-bg: #EAF2FD`, `--badge-support-text: #2E5FA8`; `--badge-leads-bg: #FFF1E8`, `--badge-leads-text: #B4532A`; outcome success badge `--badge-success-bg: #E7F7EE`, `--badge-success-text: #11A66A`                                                                                                                                                                                                                             |
| Charts                                  | series order `--chart-1: #FF007A`, `--chart-2: #B84DFF` (violet sparkline in the reference), `--chart-3: #F000FF`, `--chart-4: #FF7A59`; area fill = series color at 18% to 0% vertical gradient; live indicator dot `--success`                                                                                                                                                                                                                                                                         |
| Motion                                  | durations 150 ms (hover/press), 220 ms (popover, tab), 320 ms (sheet, page section); easing `cubic-bezier(0.2, 0, 0, 1)`; all motion disabled under `prefers-reduced-motion: reduce`                                                                                                                                                                                                                                                                                                                     |
| Focus                                   | `outline: 2px solid var(--pink); outline-offset: 2px`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

The dashboard intent badge blue is used only where the reference shows it; no other "SaaS blue" appears in the product.

### 10.6 i18n namespaces

Messages live in `packages/i18n/messages/<locale>/<namespace>.json` for `hu`, `de`, `en`; keys are nested camelCase; every key exists in all three locales (checked by `pnpm --filter @velyric/i18n test`).

| Namespace files                                                                                             | Owner                    |
| ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| `common`, `errors`, `enums`, `formats`, `navigation`                                                        | i18n                     |
| `marketing*`, `legal*`                                                                                      | web-marketing            |
| `dashboard`, `calls`, `agents`                                                                              | web-dashboard-core       |
| `knowledge`, `contacts`, `bookings`, `integrations`, `analytics`, `phoneNumbers`, `locations`, `simulation` | web-dashboard-ops        |
| `auth`, `checkout`, `onboarding`, `billing`, `settings`, `security`                                         | web-dashboard-admin      |
| `support`                                                                                                   | web-support-console      |
| `notifications` (e-mail subjects/bodies)                                                                    | workflow-worker          |
| `voice` (disclosure, greetings, fallback phrases)                                                           | control-api-agents-calls |

Formatting (dates, numbers, currency, phone numbers via libphonenumber-js, time zones) goes only through `@velyric/i18n` formatters.

## 11. Build and test command catalog

### 11.1 Root scripts (`package.json`)

| Script            | Command                                                                                     | Purpose                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap`       | `node scripts/bootstrap.mjs [--check] [--skip-rust] [--skip-python] [--skip-build]`         | verify toolchains (2.1), then `pnpm install --frozen-lockfile`, `uv sync --all-packages --frozen`, `cargo fetch --locked` (each under its lock), then `build:ts` |
| `dev`             | `node scripts/dev.mjs [--no-infra] [--only a,b]`                                            | supervised local stack (section 12); refuses unless `VELYRIC_ENV=local`                                                                                          |
| `build`           | `build:ts && build:rust`                                                                    |                                                                                                                                                                  |
| `build:ts`        | `pnpm -r --workspace-concurrency=4 --if-present run build`                                  | topological TS build                                                                                                                                             |
| `build:rust`      | `cargo build --workspace --locked`                                                          |                                                                                                                                                                  |
| `lint`            | `lint:ts && lint:rust && lint:py`                                                           |                                                                                                                                                                  |
| `lint:ts`         | `eslint . --max-warnings=0 && prettier --check .`                                           |                                                                                                                                                                  |
| `lint:rust`       | `cargo fmt --all --check && cargo clippy --workspace --all-targets --locked -- -D warnings` |                                                                                                                                                                  |
| `lint:py`         | `uv run --frozen ruff check . && uv run --frozen ruff format --check .`                     |                                                                                                                                                                  |
| `format`          | `prettier --write . && cargo fmt --all && uv run --frozen ruff format .`                    |                                                                                                                                                                  |
| `typecheck`       | `pnpm -r --if-present run typecheck && uv run --frozen mypy`                                |                                                                                                                                                                  |
| `test`            | `test:scripts && test:ts && test:rust && test:py`                                           |                                                                                                                                                                  |
| `test:scripts`    | `node --test "scripts/test/*.test.mjs"`                                                     | root tooling tests                                                                                                                                               |
| `test:ts`         | `pnpm -r --if-present run test`                                                             | Vitest per package                                                                                                                                               |
| `test:rust`       | `cargo test --workspace --locked`                                                           |                                                                                                                                                                  |
| `test:py`         | `uv run --frozen pytest`                                                                    |                                                                                                                                                                  |
| `test:coverage`   | `pnpm -r --if-present run test:coverage`                                                    | enforces 11.5 thresholds                                                                                                                                         |
| `test:db`         | `pnpm -r --if-present run test:db`                                                          | PostgreSQL-backed suites (9.9)                                                                                                                                   |
| `test:e2e`        | `pnpm --filter @velyric/e2e run test`                                                       | Playwright journeys                                                                                                                                              |
| `contracts:check` | `pnpm -r --if-present run generated:check`                                                  | every generator in `--check` mode (1.2)                                                                                                                          |
| `verify`          | `lint && typecheck && contracts:check && test && build`                                     | local equivalent of the PR gate                                                                                                                                  |

Per-package script names are fixed: `build`, `typecheck`, `test`, `test:coverage`, `test:db`, `test:int` (needs Redis/NATS/Temporal/simulator), `dev`, `generated:check`, and for apps `start`. Packages never define their own `lint`; the root ESLint flat config covers the whole repo, and packages may export additional config through `eslint.config.js` only via the root file (web-foundation adds the Next.js, React hooks and jsx-a11y blocks there by requesting the change from blueprint).

### 11.2 Internal TypeScript packages

One approach for Next.js, Fastify services and Temporal workers:

- Every internal package is ESM (`"type": "module"`), compiles with `tsc -p tsconfig.build.json` to `dist/` (JS + `.d.ts` + maps; `customConditions: []`), and publishes this `exports` shape:

```json
{
  ".": {
    "@velyric/source": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  }
}
```

- The `@velyric/source` condition points at TypeScript sources. It is enabled by `tsconfig.base.json` `customConditions` (typecheck without building), by Vitest (`resolve.conditions: ['@velyric/source']` in each `vitest.config.ts`) and by `tsx --conditions=@velyric/source` for service `dev` scripts. Everything else resolves `dist/`.
- Next.js (`apps/web`) consumes the built `dist/` output of internal packages; `pnpm dev` runs each package's `dev` script (`tsc -p tsconfig.build.json --watch --preserveWatchOutput`) alongside `next dev`, and `build:ts` builds dependencies first because `pnpm -r run build` is topological.
- Fastify services and connector-worker run `node dist/main.js` in production (built with `tsc`), `tsx watch --conditions=@velyric/source src/main.ts` in development.
- workflow-worker bundles workflow code with `@temporalio/worker` `bundleWorkflowCode` from `dist/workflows/index.js`; activities import packages normally.
- Package `tsconfig.json` extends `../../tsconfig.base.json` with `noEmit: true` and includes `src`, `test`, `scripts` and config files; `tsconfig.build.json` includes only `src`. Browser packages (`ui`, `web`) add `"lib": ["ES2024", "DOM", "DOM.Iterable"]` and `"jsx": "react-jsx"`.
- Dependencies between internal packages use `"workspace:*"`; external dependencies use `"catalog:"`.

### 11.3 Rust

`cargo build --workspace --locked`, `cargo test --workspace --locked`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo fmt --all --check`, `cargo deny check` (config `deny.toml`), `cargo llvm-cov --workspace --locked --fail-under-lines <threshold>` per crate (installed with `cargo install cargo-llvm-cov --locked` into the user cargo home), fuzzing `cargo +nightly fuzz run <target>` is CI-only; the stable smoke build is `cargo test -p velyric-fuzz` replaying `fuzz/corpus/<target>/`. The shared `target/` directory is never overridden. Adding a dependency means editing `[workspace.dependencies]` under the `cargo-manifest` lock.

### 11.4 Python

`uv sync --all-packages --frozen`, `uv lock` (under the `uv` lock), `uv run --frozen ruff check .`, `uv run --frozen ruff format --check .`, `uv run --frozen mypy`, `uv run --frozen pytest`, per service `uv run --frozen --package velyric-document-worker velyric-document-worker`. Each service keeps tests in `services/<svc>/tests/` and generated enum mirrors in `src/<module>/generated/`.

### 11.5 Coverage thresholds (master 35.1)

| Scope                                                                                                                                                                        | Gate                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/domain` (policies, state machines, pricing/entitlement) and `packages/contracts`                                                                                   | 90% branches, 90% lines                                                      |
| TypeScript backend: `apps/control-api`, `services/workflow-worker`, `services/connector-worker`, `packages/{db,security,config,connectors,notifications,observability,i18n}` | 80% lines                                                                    |
| Rust critical crates: `velyric-voice-runtime`, `velyric-runtime-policy`, `velyric-call-protocol`, `velyric-metering-worker`                                                  | 85% lines (`cargo llvm-cov`), plus proptest/fuzz for parsers and state logic |
| Python services                                                                                                                                                              | 80% lines (`pytest --cov --cov-fail-under=80`)                               |
| `packages/ui`                                                                                                                                                                | 80% lines (Vitest browser/component tests) plus Storybook a11y checks        |
| `apps/web` business interactions                                                                                                                                             | covered by Playwright E2E + visual + axe suites rather than a line threshold |

Thresholds live in each package's `vitest.config.ts` / crate CI step / `pyproject.toml`; lowering one requires a waiver entry with reason and expiry in that module's `docs/architecture/modules/<key>.md`.

## 12. Local development stack

### 12.1 `infra/docker/compose.dev.yml` (owned by runtime-ops)

Compose project name `velyric-dev`; images from 2.6 pinned by digest; named volumes per stateful service; every service has a healthcheck so `docker compose up --wait` blocks until ready.

| Service name     | Image                                | Host port(s) -> container    | Notes                                                                                                               |
| ---------------- | ------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `postgres`       | pgvector/pgvector                    | 55432 -> 5432                | database `velyric`; init script creates roles from 9.2 with local passwords from `.env`                             |
| `redis`          | redis                                | 56379 -> 6379                | ACL user from `.env`                                                                                                |
| `nats`           | nats                                 | 54222 -> 4222, 58222 -> 8222 | `-js -sd /data -m 8222`                                                                                             |
| `temporal`       | temporalio/temporal                  | 57233 -> 7233, 58233 -> 8233 | `server start-dev --ip 0.0.0.0 --namespace velyric-local --db-filename /data/temporal.db`                           |
| `minio`          | locally built `velyric-minio`        | 59000 -> 9000, 59001 -> 9001 | `server /data --console-address :9001`; one-shot `minio-init` job creates the six `velyric-local-<purpose>` buckets |
| `mailpit`        | axllent/mailpit                      | 51025 -> 1025, 58025 -> 8025 | SMTP sink for SES-simulator and custom SMTP tests                                                                   |
| `clamav`         | clamav/clamav                        | 53310 -> 3310                | clamd for document-worker                                                                                           |
| `otel-collector` | otel/opentelemetry-collector-contrib | 54317 -> 4317, 54318 -> 4318 | config `infra/observability/otel-collector.dev.yaml`, exports to Grafana stack                                      |
| `grafana`        | grafana/grafana                      | 53000 -> 3000                | provisioned dashboards from `infra/dashboards/`                                                                     |

CI uses the same images as GitHub Actions service containers. Where Docker is unavailable (for example this Windows workstation), DB tests use 9.9, Temporal tests use `@temporalio/testing`, NATS tests may use a `nats-server` binary installed with `go install github.com/nats-io/nats-server/v2@v2.14.6` into GOPATH, and suites needing other services are reported as not run locally.

### 12.2 `pnpm dev` process table (`scripts/lib/dev-processes.mjs`)

| Name                 | Kind    | Command                                                                                 |
| -------------------- | ------- | --------------------------------------------------------------------------------------- |
| `infra`              | task    | `docker compose -f infra/docker/compose.dev.yml up --detach --wait`                     |
| `migrate`            | task    | `pnpm --filter @velyric/db run migrate`                                                 |
| `provider-simulator` | service | `pnpm --filter @velyric/testkit run provider-simulator`                                 |
| `typescript`         | service | `pnpm -r --parallel --if-present run dev` (web, control-api, workers, package watchers) |
| `voice-runtime`      | service | `cargo run --locked -p velyric-voice-runtime`                                           |
| `metering-worker`    | service | `cargo run --locked -p velyric-metering-worker`                                         |
| `document-worker`    | service | `uv run --frozen --package velyric-document-worker velyric-document-worker`             |

Tasks run sequentially and abort on failure; services run in parallel with prefixed output; if any service exits, all are stopped and its exit code is returned. `.env` at the repo root is loaded (process env wins).

### 12.3 Provider simulator (`packages/testkit`, owned by platform-config)

- One HTTP server on port 4010 with path prefixes `/openai`, `/telnyx`, `/twilio`, `/stripe`, `/billingo`, `/google`, `/microsoft`, `/ses`, `/workos`, implementing the subset of each provider's documented API that the adapters call, with the provider's real request/response shapes validated against fixtures captured from provider docs in `packages/testkit/fixtures/providers/<provider>/`.
- Webhooks are delivered to control-api with real signature schemes (Stripe `Stripe-Signature` HMAC, Telnyx Ed25519, Twilio `X-Twilio-Signature`, OpenAI webhook signature) using the local secrets from `.env`, including duplicate, out-of-order, delayed and replayed deliveries on demand.
- Deterministic with `VELYRIC_SIMULATOR_SEED`; scenario control endpoints under `/_control` (inject latency, 429, 5xx, timeouts, KYC decline, no inventory) are used by integration, chaos and load tests.
- The same simulator instance is started in-process by `@velyric/testkit` `startProviderSimulator()` for tests.
- Refuses to start unless `VELYRIC_ENV` is `local` or `ci`.

## 13. Human policy inputs

Only decisions that cannot be inferred from the specifications. Each has a safe default implemented in code until a human provides the value through configuration (`packages/config` policy files `packages/config/policies/<name>.json`, loaded and schema-validated at boot and changed only via reviewed PRs).

| Input                                                                                           | Why human                           | Safe default mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| EUR price book (`INTERNATIONAL` market plan prices and overage)                                 | commercial pricing (master 21.1)    | `PLAN_CATALOG` has only HU prices; checkout for billing profiles outside Hungary returns `PRICE_BOOK_UNAVAILABLE`; pricing page shows HUF prices only                                                                                                                                                                                                                                                                                                                                                                                      |
| Add-on prices (all `AddOnCode`, including Concurrency Boost and phone-number retention)         | commercial pricing (v6 23.1, 32.10) | add-ons without a Stripe price in `policies/stripe-price-map.json` are shown as "contact sales" and cannot be purchased self-serve                                                                                                                                                                                                                                                                                                                                                                                                         |
| Stripe product/price ids per environment                                                        | created in the Stripe account       | boot fails in staging/production if a plan used by checkout has no mapped price id                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Billingo document block id, bank account id, invoice language/type rules                        | Billingo account setup              | invoice workflow fails fast with `CONFIG_INVALID`; orders stay `BILLING_PENDING` and alert, provisioning is not started                                                                                                                                                                                                                                                                                                                                                                                                                    |
| VAT/tax rule matrix (domestic B2B, EU reverse charge, non-EU, B2C) approved by an accountant    | tax law (v6 24.1)                   | only Hungarian billing profiles with a valid Hungarian tax number are accepted at checkout (27% VAT); all other combinations return `BILLING_PROFILE_INCOMPLETE` with reason `tax_matrix_not_approved`                                                                                                                                                                                                                                                                                                                                     |
| Correction vs cancellation (storno) invoice rule for refunds                                    | accounting policy (v6 32.3)         | refunds create a cancellation invoice for the full original document and, for partial refunds, a new invoice for the retained amount; the workflow requires `platform.refunds:approve`                                                                                                                                                                                                                                                                                                                                                     |
| Phone-number retention: included days, fee, release timing                                      | carrier cost policy (master 24)     | 30 days `RETENTION_HOLD` after suspension/cancellation with reminders at 7 and 1 days, then release; retention add-on not sellable until priced                                                                                                                                                                                                                                                                                                                                                                                            |
| Grace and retention durations: `CANCELED_GRACE`, `DATA_RETENTION`, per `RetentionClass` periods | legal/privacy policy (master 31)    | CANCELED_GRACE 30 d, DATA_RETENTION 60 d; RAW_AUDIO not stored (recording off); TRANSCRIPT 90 d; CALL_EVENTS 180 d; TOOL_PAYLOAD 30 d; RAW_PROVIDER_PAYLOAD 30 d; OPERATIONAL_LOG 30 d; EXPORT_ARTIFACT 7 d; CALLER_PROFILE until tenant deletion or 24 months inactivity; ANALYTICS (aggregates only) 25 months; KNOWLEDGE_DOCUMENT until source deletion; KYC_REFERENCE while number held + 30 d; CONSENT and AUDIT 6 years; BILLING 8 years; DISPUTE_EVIDENCE until dispute closure + 18 months. Tenant settings may only shorten these |
| Recording consent rules per country                                                             | telecom/privacy law (v6 19)         | recording disabled everywhere (`feature.call_recording` off, `kill.recording` available)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Refund deadline for paid-but-unprovisionable orders                                             | commercial policy (v6 32.13)        | order enters `MANUAL_REVIEW_REQUIRED`; no automatic refund; support console shows the compensation action                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Trust ramp thresholds and default spend caps                                                    | risk policy (master 25, v6 31.9)    | `TrustTier.NEW`: concurrency min(plan, 2), outbound off, daily spend cap HUF 20 000 of provider cost, premium routing off, max call 1 200 s; promotion to `ESTABLISHED` only by staff action                                                                                                                                                                                                                                                                                                                                               |
| Legal texts (privacy notice, terms, DPA, subprocessor list, AI disclosure wording per locale)   | legal review (v6 19)                | legal routes render only documents present in the versioned legal registry; production deploy gate fails when a required document or locale is missing; voice disclosure uses the spec wording "a [COMPANY] AI-asszisztense vagyok" pattern translated per locale and is non-disableable                                                                                                                                                                                                                                                   |
| Seller legal entity data (company name, address, tax number, registration number)               | company data                        | invoice and footer rendering fail boot validation in staging/production when missing                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Enterprise contract values (concurrency, SLA, pricing)                                          | per-contract negotiation            | ENTERPRISE entitlements are created only by staff through the support console with an audited contract reference                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Staff role assignments for the support console                                                  | organizational                      | `/internal/support` returns 404 for everyone until a real staff-role check is implemented                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Public status page URL                                                                          | vendor choice                       | `/status` returns 503 with a translated message until `VELYRIC_STATUS_PAGE_URL` is set                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
