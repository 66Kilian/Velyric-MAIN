# Module notes: blueprint

Owner of the root scaffold, `scripts/**` and `docs/architecture/blueprint.md`.

## Decisions recorded during the scaffold run (2026-09-13)

- Resumed an interrupted run; kept the existing root configs, scripts and contracts seed. Fixed `packages/contracts/src/registry.ts` (a leftover `ENUM_NAME` reference replaced by `isEnumName`), formatted contracts and scripts with Prettier, regenerated `packages/contracts/generated/enums.json`.
- Root `test:db` is recursive (`pnpm -r --if-present run test:db`) so every package can own DB-backed suites. Root `contracts:check` runs `generated:check` in every package; `@velyric/contracts` gained `generated:check`. Generators in other packages must expose the same script name.
- Four pins intentionally trail the latest release (blueprint 2.5): typescript 6.0.3 (typescript-eslint peer range), @types/node 22 (runtime match), zod 4.6.2 (release quarantine), ed25519-dalek 2.2.0 (jsonwebtoken 11 dependency).
- Wire contracts use TypeBox 1.x; form/input schemas shared with the server use Zod 4 through `@hookform/resolvers/standard-schema`, because `@hookform/resolvers/typebox` 5.9.1 targets `@sinclair/typebox` 0.x. A contract test keeps paired schemas equivalent.
- Next.js 16 uses `proxy.ts` (Node.js runtime only). Locale detection including geo is done in the proxy; next-intl runs with `localeDetection: false` and `localePrefix: 'always'`.
- Migrations are split into `core` and `vector` tracks so real multi-connection PostgreSQL tests (embedded-postgres, no pgvector on Windows) cover RLS/constraints/concurrency, while vector retrieval tests run on PGlite with its bundled vector extension locally and everything runs on `pgvector/pgvector:0.8.6-pg18` in CI.
- MinIO community images stopped at `RELEASE.2025-09-07T16-13-09Z.hotfix.7aa24e772`; runtime-ops pins that digest for local/CI only (production uses AWS S3).
- Python `testpaths` in the root `pyproject.toml` point at `services/<svc>/tests`, which the service owners create; until then `pnpm test:py` reports no tests collected.
