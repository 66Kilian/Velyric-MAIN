FULL-SYSTEM AUTONOMOUS IMPLEMENTATION MASTER SPECIFICATION
Production-grade AI voice SaaS • Web • Dashboard • Voice Runtime • Billing • Provisioning • Integrations • Security • Testing • Infrastructure
Dokumentum célja: a fejlesztő AI kapjon minden szükséges végrehajtási instrukciót ahhoz, hogy a Velyric teljes rendszerét egyetlen teljes implementációs munkaként készítse el, ne fázisonként leadott félkész állapotként.

| KÖTELEZŐ INPUTOK
A coding agent ezt a dokumentumot együtt kapja meg a „Velyric_Teljes_Dokumentacio_2026-09-12_v6.docx” termék/üzleti specifikációval és a csatolt landing-page referencia képpel. A három forrást együtt kell értelmezni. |

Verzió: 1.0 • Dátum: 2026. szeptember 12.

# Tartalom és végrehajtási térkép
1. Végrehajtási szerződés a coding agent számára   [style:ListBullet]
2. Source of truth és konfliktuskezelés   [style:ListBullet]
3. Végső deliverable-ek és Definition of Done   [style:ListBullet]
4. Rendszerarchitektúra   [style:ListBullet]
5. Nyelv- és technológiaválasztás   [style:ListBullet]
6. Monorepo és modulhatárok   [style:ListBullet]
7. Környezetek, konfiguráció és secret-kezelés   [style:ListBullet]
8. Public weboldal és design rendszer   [style:ListBullet]
9. Dashboard és termék UI   [style:ListBullet]
10. Lokalizáció és nyelvi routing   [style:ListBullet]
11. Identity, auth, tenant és jogosultságok   [style:ListBullet]
12. PostgreSQL adatmodell és invariánsok   [style:ListBullet]
13. Saját API és contract-rendszer   [style:ListBullet]
14. Telefon/SIP és voice runtime   [style:ListBullet]
15. Agent orchestration és multi-agent rendszer   [style:ListBullet]
16. Caller identity és memory   [style:ListBullet]
17. Knowledge/RAG   [style:ListBullet]
18. Booking és waitlist   [style:ListBullet]
19. Connector és tool platform   [style:ListBullet]
20. Human handoff és call transfer   [style:ListBullet]
21. Billing, Stripe, Billingo és usage ledger   [style:ListBullet]
22. Automatikus provisioning   [style:ListBullet]
23. Supplier-cost buffer és pénzügyi kontroll   [style:ListBullet]
24. Dunning, suspension és reactivation   [style:ListBullet]
25. Fraud, dispute és abuse védelem   [style:ListBullet]
26. Concurrency, autoscaling és backpressure   [style:ListBullet]
27. Observability, quality és analytics   [style:ListBullet]
28. Simulation Lab és eval platform   [style:ListBullet]
29. Internal Support Console   [style:ListBullet]
30. Security hardening   [style:ListBullet]
31. GDPR, EU AI Act és retention   [style:ListBullet]
32. Disaster Recovery és provider failover   [style:ListBullet]
33. Infrastructure és deployment   [style:ListBullet]
34. CI/CD és supply-chain security   [style:ListBullet]
35. Teljes tesztstratégia   [style:ListBullet]
36. Performance és load testing   [style:ListBullet]
37. Accessibility, SEO és frontend quality   [style:ListBullet]
38. Dokumentáció és developer experience   [style:ListBullet]
39. Kötelező acceptance matrix   [style:ListBullet]
40. Végső coding-agent utasítás   [style:ListBullet]

# 1. Végrehajtási szerződés a coding agent számára
Ez a dokumentum nem roadmap és nem ajánlásgyűjtemény. Ez végrehajtási specifikáció. A coding agent feladata a Velyric teljes, működő, production-grade rendszerének elkészítése a megadott üzleti specifikáció, design referencia és jelen dokumentum alapján. A belső fejlesztési sorrend természetesen dependency-alapú lehet, de a leadott eredmény nem lehet „Phase 1”, „MVP skeleton”, „frontend only” vagy „backend later”.

| NEM PHASE-ALAPÚ LEADÁS
Ne állj meg részleges implementációnál. Ne kérj külön engedélyt minden modulhoz. A teljes kódbázist, adatbázist, integrációkat, teszteket, infrastructure-as-code-ot, migrációkat, monitoringot és dokumentációt készítsd el, majd addig javítsd, amíg a kötelező ellenőrzések át nem mennek. |

Ne hagyj TODO, FIXME, placeholder, „implement later”, fake success vagy hardcoded demo behavior elemet production kódban.   [style:ListBullet]
Mock kizárólag tesztben vagy explicit local-dev adapterben lehet; staging/production integráció valódi provider API-kon működjön.   [style:ListBullet]
Ha egy külső provider credential hiányzik, készíts teljes adaptert, konfigurációt, validációt, sandbox/test-mode támogatást és egyértelmű boot-time hibát; ne cseréld hamis implementációra.   [style:ListBullet]
Minden külső inputot runtime-validálni kell. LLM output, webhook payload, OAuth callback, query/body/header és fájl egyaránt untrusted input.   [style:ListBullet]
Minden write művelet legyen idempotens, auditálható és retry-safe.   [style:ListBullet]
Minden adatbázis migration legyen forward-safe; destructive módosítást expand/contract mintával kell megoldani.   [style:ListBullet]
A kód legyen determinisztikusan buildelhető lockfile-okkal, pinned container image digestekkel és reprodukálható CI-vel.   [style:ListBullet]
A rendszer induljon fel egy dokumentált bootstrap paranccsal developmentben, és egy dokumentált deploy folyamattal staging/production környezetben.   [style:ListBullet]
Minden modulhoz készíts teszteket; ne tekintsd késznek pusztán attól, hogy fordul vagy a happy-path manuálisan működik.   [style:ListBullet]
A biztonsági és adatvédelmi gate-ek ugyanolyan kötelező release gate-ek, mint a feature-ek.   [style:ListBullet]

## 1.1 AI-autonómia és döntési szabály
Ha a specifikációból egy implementációs részlet egyértelműen levezethető, a coding agent hozza meg a mérnöki döntést és implementálja. Csak olyan ponton kérjen emberi választást, ahol jogi, pénzügyi vagy üzleti policy döntés ténylegesen nem inferálható. Technikai nehézség nem indok a kérdezésre vagy a funkció kihagyására.
Ha két technológia közül az egyik fejlesztésben kényelmesebb, a másik viszont mérhetően alkalmasabb a konkrét feladatra - például Rust a nagy párhuzamosságú, latency-kritikus data plane-hez -, akkor az alkalmasabbat kell választani. A „TypeScript egyszerűbb” önmagában nem indok arra, hogy realtime/media/protokoll kritikus részt TypeScriptben valósíts meg.

# 2. Source of truth és konfliktuskezelés

| Prioritás | Forrás | Mire authoritative? |
| 1 | Jelen Implementation Master Spec | Technikai architektúra, kódszerkezet, biztonsági/test/deployment követelmények, design implementációs szabályok. |
| 2 | Velyric_Teljes_Dokumentacio_2026-09-12_v6.docx | Terméklogika, csomagok, üzleti szabályok, feature scope, model/provider stratégia, compliance alapelvek. |
| 3 | Csatolt landing-page referencia kép | Vizuális irány. A dashboard blokk 1:1 referenciaértékű; a marketing oldal többi része inspiráció, nem pixelmásolat. |
| 4 | Provider hivatalos dokumentációja | API signature, webhook ellenőrzés, rate limit, aktuális SDK/protokoll részletek. |
| 5 | Kódkomment / régi README | Csak akkor, ha nem ütközik a fenti forrásokkal. |

Ha a v6 üzleti dokumentum és ez a dokumentum implementációs részletei eltérnek, az üzleti cél tekintetében a v6, a technikai megvalósítás tekintetében ez a dokumentum nyer. Ha provider API változott, az aktuális hivatalos API dokumentációt kell követni úgy, hogy a kívánt Velyric behavior változatlan maradjon.

# 3. Végső deliverable-ek és Definition of Done
Teljes monorepo forráskód web, control plane, realtime voice runtime, workers, evals, infra és shared contractok számára.   [style:ListBullet]
Production-ready PostgreSQL schema és minden migration.   [style:ListBullet]
Real Stripe, Billingo, Telnyx, OpenAI, Google és Microsoft adapterek; Twilio fallback adapter.   [style:ListBullet]
Teljes HU/DE/EN public site és dashboard light/dark theme-mel.   [style:ListBullet]
Automatikus onboarding, billing, number provisioning, OpenAI provisioning, KYC waiting state és go-live workflow.   [style:ListBullet]
Automatikus e-mail notification rendszer megújítás, dunning, provisioning, security és support eseményekhez.   [style:ListBullet]
Infrastructure-as-Code, CI/CD, monitoring, backups, restore procedure, alerting és runbookok.   [style:ListBullet]
Unit, integration, contract, E2E, visual, accessibility, security, fuzz/property, load, chaos és disaster-restore tesztek.   [style:ListBullet]
OpenAPI/spec contractok, environment reference, local-dev guide, staging/prod deployment guide és operations handbook.   [style:ListBullet]
Zero cross-tenant leakage; minden kritikus write idempotens; minden provider webhook signature-verified és deduplikált.   [style:ListBullet]
Az összes kötelező acceptance gate zöld. Nincs TODO/FIXME vagy kikapcsolt teszt kritikus útvonalon.   [style:ListBullet]

# 4. Rendszerarchitektúra
A Velyricet control plane és realtime data plane szemlélettel kell felépíteni. A control plane kezeli a tenantot, agentet, billinget, onboardingot, connectorokat, knowledge-t, user/auth/RBAC-ot és admin API-t. A realtime data plane kezeli a hívás session lifecycle-t, OpenAI Live eseményeket, interruption/turn state-et, provider/session limiteket, call-local state-et és nagy frekvenciájú usage eseményeket.
Célarchitektúra
Public Internet / PSTN   [style:CodeBlock]
|   [style:CodeBlock]
+--> Cloudflare WAF/CDN/Geo ----> Next.js Web (marketing + dashboard)   [style:CodeBlock]
|                                   |   [style:CodeBlock]
|                                   +--> Control API (TypeScript/Fastify)   [style:CodeBlock]
|                                            |   [style:CodeBlock]
Telnyx DID/SIP ---> OpenAI Live SIP <----> Rust Voice Runtime / Sideband Controller   [style:CodeBlock]
|                                            |   [style:CodeBlock]
|                                            +--> Tool Gateway / Policy API   [style:CodeBlock]
|                                            +--> NATS / domain events   [style:CodeBlock]
|                                            +--> Metering   [style:CodeBlock]
|   [style:CodeBlock]
+--> Twilio fallback path   [style:CodeBlock]
Control API / Workers   [style:CodeBlock]
+--> PostgreSQL + pgvector   [style:CodeBlock]
+--> Redis   [style:CodeBlock]
+--> Temporal durable workflows   [style:CodeBlock]
+--> S3 object storage   [style:CodeBlock]
+--> Stripe / Billingo   [style:CodeBlock]
+--> Google / Microsoft OAuth   [style:CodeBlock]
+--> Connector Egress Worker   [style:CodeBlock]
+--> SES transactional email   [style:CodeBlock]
+--> OpenTelemetry / Grafana / Sentry   [style:CodeBlock]

| FONTOS ARCHITEKTÚRAI ELV
A realtime hívás kritikus útvonalán ne legyen szükségtelen marketing/dashboard backend függőség. A voice runtime cache-elt/verziózott agent-config snapshotból tudjon dolgozni, és a control plane átmeneti hibája ne szakítson meg már futó hívást. |


## 4.1 Deploy egységek

| Deploy unit | Nyelv | Feladat | Skálázás |
| web | TypeScript / Next.js | Marketing, auth UI, tenant dashboard, internal support UI. | HTTP request / CPU, stateless. |
| control-api | TypeScript / Fastify | Tenant CRUD, RBAC, agent config, billing API, connector API, public REST. | HTTP throughput; stateless. |
| voice-runtime | Rust / Tokio/Axum | Call/session actorok, OpenAI Live sideband, realtime event handling, concurrency, handoff orchestration. | Active sessions / event throughput. |
| workflow-worker | TypeScript / Temporal | Provisioning, dunning, KYC wait, invoice, cancellation, reactivation, long-running workflow-k. | Task queue depth. |
| connector-worker | TypeScript | Google/Microsoft/SMTP/CRM/custom webhook execution, retry és egress policy. | Queue depth / external API limits. |
| metering-worker | Rust | Nagy frekvenciájú usage event normalizálás, aggregation és provider cost reconciliation. | Event throughput. |
| document-worker | Python | Parsing, OCR, chunking support, offline embeddings/eval preprocessing. | Queue depth / CPU. |
| eval-runner | Python + TypeScript scenarios | Offline quality scoring, regression suites, simulation orchestration. | Batch jobs. |
| infra | OpenTofu/Terraform HCL | Cloud resources, IAM, network, DB, cache, alarms, secrets. | N/A |


# 5. Nyelv- és technológiaválasztás
A cél nem a minimális nyelvszám, hanem az optimális technológia komponensenként. Ugyanakkor minden extra runtime nyelv csak akkor maradhat, ha világos technikai előnyt ad. A frontend és control plane TypeScript, a realtime/concurrency/protokoll réteg Rust, a dokumentum/ML/eval ökoszisztéma Python, az adatintegritás PostgreSQL/SQL.

| Terület | Kötelező választás | Fő könyvtárak / eszközök | Indok |
| Marketing + dashboard | React + Next.js + TypeScript | Next.js App Router, React, TanStack Query, React Hook Form, Zod, Tailwind CSS, Radix primitives, Motion, Visx | SEO/i18n + app UX + erős TS ökoszisztéma. |
| Control API | TypeScript | Fastify, TypeBox/Zod, OpenAPI, Drizzle/Kysely | Integráció-heavy üzleti control plane. |
| Realtime call runtime | Rust | Tokio, Axum, Tower, Serde, Reqwest/WebSocket, tracing | Nagy concurrency, latency, memória- és hibabiztonság. |
| Metering | Rust | Tokio, serde, sqlx/NATS client | Sok kis usage event, determinisztikus aggregation. |
| Durable workflows | TypeScript | Temporal SDK | Provider SDK és üzleti workflow-k gyors auditálható implementációja. |
| Connectorok | TypeScript | Provider SDK-k, undici/HTTP client, Zod | OAuth/API ökoszisztéma. |
| Dokumentum/OCR/eval | Python | uv, pydantic, pandas/polars, pytest, document parser stack | Adat/ML ökoszisztéma. |
| Adatbázis | PostgreSQL + SQL | RLS, pgvector, migrations, constraints | Tenant izoláció és pénzügyi invariánsok. |
| Cache/rate-limit | Redis | Managed Redis | Token bucket, distributed semaphore, short-lived cache. |
| Realtime internal event bus | NATS JetStream | Rust + TS clients | Kis latency, backpressure, könnyebb mint Kafka ehhez a mérethez. |
| IaC | OpenTofu/Terraform HCL | OpenTofu | Reprodukálható cloud. |
| CI/CD | GitHub Actions | OIDC, buildx, Trivy, OSV, cargo-deny, Playwright | Automatikus quality/security gates. |


# 6. Monorepo és modulhatárok
velyric/   [style:CodeBlock]
apps/   [style:CodeBlock]
web/                       # Next.js marketing + tenant dashboard + support console   [style:CodeBlock]
control-api/               # Fastify public/internal control API   [style:CodeBlock]
services/   [style:CodeBlock]
voice-runtime/             # Rust realtime session/data plane   [style:CodeBlock]
metering-worker/           # Rust usage/cost ingestion   [style:CodeBlock]
workflow-worker/           # Temporal TypeScript workflows   [style:CodeBlock]
connector-worker/          # OAuth/API/SMTP/custom tools   [style:CodeBlock]
document-worker/           # Python ingestion/OCR   [style:CodeBlock]
eval-runner/               # Python/TS simulation & quality   [style:CodeBlock]
packages/   [style:CodeBlock]
domain/                    # TS domain model, policies, state machines   [style:CodeBlock]
contracts/                 # OpenAPI/JSON Schema/protobuf/event contracts   [style:CodeBlock]
ui/                        # bespoke React design system, Storybook   [style:CodeBlock]
i18n/                      # HU/DE/EN messages + formatting   [style:CodeBlock]
connectors/                # reusable provider adapters   [style:CodeBlock]
config/                    # env schema, feature flags, shared config   [style:CodeBlock]
testkit/                   # fixtures, provider simulators, factories   [style:CodeBlock]
crates/   [style:CodeBlock]
call-protocol/             # Rust protobuf/event types   [style:CodeBlock]
runtime-policy/            # call-local safety primitives   [style:CodeBlock]
common-observability/      # tracing/metrics helpers   [style:CodeBlock]
db/   [style:CodeBlock]
migrations/   [style:CodeBlock]
policies/   [style:CodeBlock]
seeds/   [style:CodeBlock]
proto/   [style:CodeBlock]
call_events.proto   [style:CodeBlock]
metering.proto   [style:CodeBlock]
evals/   [style:CodeBlock]
scenarios/   [style:CodeBlock]
rubrics/   [style:CodeBlock]
datasets/   [style:CodeBlock]
infra/   [style:CodeBlock]
tofu/   [style:CodeBlock]
docker/   [style:CodeBlock]
runbooks/   [style:CodeBlock]
dashboards/   [style:CodeBlock]
docs/   [style:CodeBlock]
architecture/   [style:CodeBlock]
api/   [style:CodeBlock]
operations/   [style:CodeBlock]
security/   [style:CodeBlock]
.github/workflows/   [style:CodeBlock]
Business logic ne kerüljön React komponensbe vagy route handlerbe; domain service/policy modulban legyen.   [style:ListBullet]
A Rust service ne olvassa „csak úgy” a control-plane belső tábláit; agent-config snapshot, explicit API vagy event contract legyen a határ.   [style:ListBullet]
Contractokat egy helyen definiáljatok; TypeScript és Rust kliens/típus generálható legyen.   [style:ListBullet]
Shared util könyvtár csak cross-cutting primitive-eket tartalmazhat; tenant/billing/booking üzleti logika ne legyen generikus utilsban.   [style:ListBullet]

# 7. Környezetek, konfiguráció és secret-kezelés

| Environment | Cél | Adat | Provider mód |
| local | Fejlesztői futtatás | Synthetic/dev fixture | Provider sandbox/test, local simulators |
| ci | Deterministic test | Ephemeral DB/Redis/NATS | Mock server + provider contract fixtures |
| staging | Production-szerű validáció | Nem production PII | Valódi sandbox/test resources, dedikált test DID ahol kell |
| production | Éles ügyfélforgalom | Valódi tenant adatok | Valódi provider accountok, strict secrets/IAM |

Environment változókat Zod/TypeBox/Pydantic schema validálja induláskor; hiányzó kritikus secret esetén fail-fast.   [style:ListBullet]
Secret érték ne legyen Gitben, DB plaintextben, React bundle-ben, logban, trace attribute-ban vagy support UI-ban.   [style:ListBullet]
AWS KMS + Secrets Manager legyen production default; tenant OpenAI service-account kulcs envelope encryptionnel és versionnel kezelendő.   [style:ListBullet]
Kulcsrotáció zero-downtime: create new -> publish version -> health check -> revoke old.   [style:ListBullet]
Provider admin/master kulcs csak provisioning worker IAM role számára legyen olvasható.   [style:ListBullet]

# 8. Public weboldal és design rendszer
A landing page a csatolt referencia képből induljon ki: brilliant white / near-black alap, organikus aszimmetria, puha magenta/pink/coral diffused blur, lebegő UI kártyák, erős geometrikus tipográfia és egyedi Velyric vizuális ritmus. Nem szabad generic AI SaaS template-et, stock 3D blobot vagy shadcn-default kinézetet másolni.

| DESIGN REFERENCIA
A következő kép vizuális inspiráció. A hero, floating phone/chat composition, feature treatment, spacing és CTA-rendszer nagyrészt kövesse ezt a nyelvet, de ne legyen pixelpontos másolat. A dashboard showcase viszont külön, 1:1 referenciaértékű. |

Landing-page referencia – vizuális irány, nem teljes pixelmásolat.   [style:Caption]

## 8.1 Dashboard referencia – 1:1 vizuális cél
A dashboard fő elrendezését, vizuális súlyait, sidebar/stats/live-call/call-summary struktúráját 1:1 referenciaértékűnek kell kezelni.   [style:Caption]

## 8.2 Design tokenek

| Token | Light | Dark | Használat |
| --bg | #FFFFFF | #08090D | Oldal háttér. |
| --surface | #FFFFFF | #11131A | Card, nav, panel. |
| --surface-muted | #FFF7FB | #17131B | Subtle section/card. |
| --text | #071327 | #F8FAFC | Elsődleges szöveg. |
| --text-muted | #5B6578 | #AAB2C2 | Másodlagos szöveg. |
| --magenta | #F000FF | #F000FF | Ritka highlight. |
| --pink | #FF007A | #FF2B91 | CTA/active accent. |
| --crimson | #FF174E | #FF315F | Gradient közép. |
| --coral | #FF7A59 | #FF8F73 | Gradient vég. |
| --plum | #8E0069 | #C11A8B | Dark accent. |
| --border | #EDE8F0 | #262833 | Finom border. |
| --success | #11A66A | #34D399 | Siker státusz. |
| --warning | #E6A100 | #FBBF24 | Figyelmeztetés. |
| --danger | #D92D4C | #FB7185 | Hiba/kritikus. |

Font: Geist Sans legyen az elsődleges UI/marketing font, Geist Mono a technikai/azonosító jellegű tartalomhoz. Fallback: system sans-serif. A headingeknél tight tracking, a törzsszövegnél magas olvashatóság. A logótól független „SaaS blue” ne legyen főszín.

## 8.3 Kötelező public route-ok

| Route | Tartalom | SEO/index |
| /[locale] | Homepage | index |
| /[locale]/product | Termék áttekintés + call/demo visual | index |
| /[locale]/solutions/[vertical] | Vertikális landingek | index |
| /[locale]/pricing | START/BUSINESS/PRO + enterprise | index |
| /[locale]/integrations | Connector katalógus | index |
| /[locale]/security | Security/compliance | index |
| /[locale]/docs | Public developer docs landing | index |
| /[locale]/login | Auth | noindex |
| /[locale]/signup | Self-serve signup | noindex |
| /legal/privacy | Privacy | index |
| /legal/terms | Terms | index |
| /legal/dpa | DPA info | index |
| /status | Status link/redirect | index |


## 8.4 Landing page komponensek
Hero: headline + rövid értékajánlat + primary CTA + secondary CTA; jobb oldalon Velyric call interface és lebegő conversation cards. A copy valódi Velyric feature-t kommunikáljon.   [style:ListBullet]
Proof bar: HU/DE/EN, 24/7, human handoff, calendar/CRM integrations. Ne használjon hamis ügyféllogókat vagy hamis számokat.   [style:ListBullet]
Feature constellation: multilingual voice, natural conversation, calendar/resource booking, CRM/API, call transfer, analytics.   [style:ListBullet]
Dashboard showcase: a referencia elrendezését 1:1 kövesse.   [style:ListBullet]
Integrations: Google Calendar, Microsoft, Stripe, Telnyx, API/Webhooks, későbbi CRM connectorok. Csak valóban implementált integráció legyen „available”.   [style:ListBullet]
Pricing: a v6 aktuális csomagjai. Currency/price book locale/market szerint, nem live FX konverzióval.   [style:ListBullet]
Security/compliance teaser: AI disclosure, GDPR controls, audit logs, EU hosting/residency policy csak akkor állítható, ha az infra ténylegesen megfelel.   [style:ListBullet]
Bottom CTA: rich magenta/plum/coral gradient, rounded container, egyetlen erős CTA.   [style:ListBullet]
Footer: product, solutions, pricing, integrations, docs, security, legal, status; language + theme switch.   [style:ListBullet]

# 9. Dashboard és termék UI
A dashboard fő layoutja a referencia alapján készüljön: bal oldali finom sidebar, középen overview, felül KPI cards, alul Live calls és Call summary. A vizuális hierarchy, card radii, border, shadow, spacing és accent kezelés 1:1 célt kövessen. A későbbi oldalakon ugyanazt a design language-et kell továbbvinni, nem egy új sablont használni.

| Route | Fő funkciók |
| /app/[workspace]/dashboard | KPI-k, active calls, quality alerts, latest outcomes, setup health. |
| /app/[workspace]/calls | Call list, filters, live/historical, outcome, duration, language, location, agent. |
| /app/[workspace]/calls/[id] | Transcript, audio/recording policy szerint, event timeline, tool calls, transfer, quality score, cost. |
| /app/[workspace]/agents | Agent lista, status, phone bindings, language, rollout. |
| /app/[workspace]/agents/[id] | Persona, voice, policy, tools, knowledge, languages, handoff, limits. |
| /app/[workspace]/agents/[id]/versions | Draft/staging/production versions, diff, canary, rollback. |
| /app/[workspace]/simulation | Simulation suites, batch runs, failures, regression comparison. |
| /app/[workspace]/knowledge | Sources, freshness, gaps, sync, conflicts. |
| /app/[workspace]/contacts | Caller/person profiles, identities, consent, history. |
| /app/[workspace]/bookings | Bookings, resources, waitlist, conflicts. |
| /app/[workspace]/integrations | OAuth connectors, custom API tools, health, secrets metadata. |
| /app/[workspace]/analytics | ROI, resolution, conversion, transfer, quality, latency, cost. |
| /app/[workspace]/phone-numbers | Numbers, KYC state, routing, location binding. |
| /app/[workspace]/billing | Subscription, usage, invoices, payment method, add-ons. |
| /app/[workspace]/locations | Multi-location config and inheritance. |
| /app/[workspace]/settings | Workspace, retention, language, notifications, security. |
| /app/[workspace]/security | Members, roles, SSO/SCIM, audit log, API keys. |
| /internal/support | Internal support console, staff-only. |


## 9.1 Frontend engineering szabályok
Server Components használhatók read-heavy oldalakhoz; interaktív dashboard state kliens komponensben, TanStack Query cache-sel.   [style:ListBullet]
Form: React Hook Form + Zod; ugyanaz a schema legyen szerveroldalon is.   [style:ListBullet]
UI primitives: Radix használható accessibility primitive-ként, de a default shadcn vizuált nem szabad átvenni. A Velyric UI package saját komponenseket és tokeneket ad.   [style:ListBullet]
Charts: Visx/custom SVG; kerülni kell a generic chart-library default kinézetet. Dashboard wave chart a referenciához igazodjon.   [style:ListBullet]
Motion: rövid, fizikailag természetes micro-interaction; prefers-reduced-motion tiszteletben tartása.   [style:ListBullet]
Loading: skeleton ne villogjon; optimistic update csak rollback-biztos write-oknál.   [style:ListBullet]
Error state: konkrét, akcióképes; correlation ID support esetén jelenjen meg.   [style:ListBullet]
Minden route light és dark theme-ben vizuális regresszió tesztet kap.   [style:ListBullet]

# 10. Lokalizáció és nyelvi routing

| Prioritás | Forrás | Működés |
| 1 | Explicit URL locale / account preference | Mindig nyer. |
| 2 | Locale cookie | A felhasználó korábbi választása. |
| 3 | Első anonim látogatás IP country | HU -> hu; DE/AT/CH/LI -> de; minden más -> en. |
| 4 | Accept-Language | Finomítás, ha geo nem egyértelmű. |
| 5 | Fallback | en |

A language switch mindig látható legyen; explicit választást ne írja felül új geo-detection.   [style:ListBullet]
URL-struktúra locale prefixet használjon: /hu, /de, /en. Canonical/hreflang helyes legyen.   [style:ListBullet]
Dátum, idő, pénznem, telefonszám, decimal, timezone locale szerint formázódjon; business logic UTC + location timezone alapján dolgozzon.   [style:ListBullet]
Minden UI message translation key; ne maradjon hardcoded angol string komponensben.   [style:ListBullet]
E-mail template és transactional notification ugyanazon locale rendszerből dolgozzon.   [style:ListBullet]
Voice agent nyelve külön call-level detection; E.164 country code csak kezdeti hint, explicit caller request felülírja.   [style:ListBullet]

# 11. Identity, auth, tenant és jogosultságok
B2B SaaS authnál ne saját jelszó-cryptography legyen. Ajánlott: WorkOS AuthKit/Organizations enterprise SSO és Directory Sync támogatással. Ha más provider kerül kiválasztásra, azonos követelményeket teljesítsen. Session HttpOnly + Secure + SameSite cookie; CSRF-védelem a state-changing browser requesteken.

| Role | Scope | Példa jogosultság |
| Owner | Workspace | Billing, security, delete/cancel, members, all config. |
| Admin | Workspace | Agents, integrations, knowledge, calls, analytics. |
| Operator | Workspace/Location | Live calls, handoff, bookings, contact operations. |
| Analyst | Read | Analytics, call outcomes, quality; sensitive transcript scope policy szerint. |
| Developer | Integration | API keys, webhooks, connectors; nincs billing/security. |
| Billing | Financial | Invoices, payment method, subscription; nincs call content. |
| Support-internal | Platform | JIT access, audited impersonation, redacted by default. |

Membership és permission check szerveroldali. Frontend hiding nem authorization.   [style:ListBullet]
Tenant_id soha ne csak request bodyból jöjjön; authenticated membership/context alapján resolve.   [style:ListBullet]
PostgreSQL RLS legyen defense-in-depth minden tenant-owned táblán.   [style:ListBullet]
Internal support impersonation csak explicit reason + short-lived grant + immutable audit event mellett.   [style:ListBullet]
Enterprise SSO/SCIM disabled-but-retained configgal élje túl a plan downgrade-et retention ideig.   [style:ListBullet]

# 12. PostgreSQL adatmodell és invariánsok

| Entitás | Kulcsmezők | Invariáns / megjegyzés |
| tenants | id, legal_name, status, default_locale, timezone, plan, created_at | status enum; immutable id |
| users | id, auth_subject, email, locale | unique auth_subject |
| memberships | tenant_id, user_id, role, location_scope | unique tenant+user |
| locations | id, tenant_id, name, timezone, hours, inherited_config | tenant FK; status |
| phone_numbers | id, tenant_id, location_id, provider, e164, status, provider_ref | unique provider+e164 |
| agents | id, tenant_id, name, status, production_version_id | tenant FK |
| agent_versions | id, agent_id, version, config_json, config_hash, rollout_percent, status | unique agent+version; immutable config after publish |
| agent_phone_bindings | agent_id, phone_number_id, priority | unique phone active binding rules |
| calls | id, tenant_id, provider_call_id, agent_version_id, direction, language, status, started_at, ended_at | unique provider+provider_call_id |
| call_events | id, call_id, seq, type, payload, timestamp | unique call+seq/event_id |
| transcript_segments | call_id, speaker, start_ms, end_ms, text, redaction_state | ordered, retention-aware |
| caller_profiles | id, tenant_id, display_name, preferred_language, trust_level | tenant-scoped |
| person_identities | person_id, tenant_id, type, normalized_value, verified_at, source | unique tenant+type+normalized_value |
| knowledge_sources | id, tenant_id, type, uri, version, status, freshness | tenant scoped |
| knowledge_chunks | source_id, tenant_id, embedding, text, metadata | tenant filter mandatory |
| integrations | id, tenant_id, provider, status, secret_ref, config | no plaintext secrets |
| tool_definitions | id, tenant_id, name, method, base_url, schema, auth_ref, policy | domain allowlist |
| tool_runs | id, tenant_id, call_id, tool_id, idempotency_key, status, request_hash, response_meta | unique idempotency scope |
| resources | id, tenant_id, location_id, type, capacity, calendar_ref | booking resource |
| availability_rules | resource_id, recurrence, buffers, exceptions | validated timezone rules |
| bookings | id, tenant_id, resource_id, person_id, start_at, end_at, status, idempotency_key | unique idempotency; overlap protection |
| waitlist_entries | id, tenant_id, desired_window, party_size, priority, status | state transitions |
| billing_profiles | id, tenant_id, legal data, VAT ID, Billingo partner ref | validated before payment |
| subscriptions | tenant_id, stripe_customer_id, stripe_subscription_id, status, plan | unique stripe subscription |
| entitlements | tenant_id, period, feature_snapshot, minute_limit, concurrency_limit | versioned snapshot |
| usage_events | id, tenant_id, call_id, metric, quantity, provider, timestamp | immutable/deduped |
| usage_aggregates | tenant_id, billing_period, metric, quantity, cost | rebuildable |
| provider_cost_events | provider, tenant_id, external_ref, amount, currency, occurred_at | reconciliation |
| billing_documents | tenant_id, stripe_invoice_id, billingo_document_id, status | unique external refs |
| provisioning_workflows | id, tenant_id, order_id, state, retry_count, last_error | durable state |
| notification_events | tenant_id, type, locale, destination, status, dedupe_key | unique dedupe |
| quality_scores | call_id, rubric_version, metrics_json, flags | versioned rubric |
| simulation_suites | tenant_id, agent_id, name, config | versioned |
| simulation_runs | suite_id, agent_version_id, status, scores, artifacts | reproducible seed |
| feature_flags | scope_type, scope_id, key, value, reason, expires_at | audited changes |
| consent_ledger | tenant_id, call_id, person_id, disclosure_version, language, recording_consent, timestamp | append-only |
| audit_logs | tenant_id, actor, action, object_type, object_id, diff_hash, trace_id, timestamp | append-only |
| fraud_signals | tenant_id, order/payment ref, signal, score, evidence | no raw PAN |
| disputes | tenant_id, stripe_dispute_id, status, evidence_ref | retention override |
| provider_health | provider, region, capability, status, latency, error_rate | time-series snapshot |


## 12.1 RLS és tenant izoláció
Minden tenant-owned rekordhoz explicit tenant_id. Indirect ownership csak indokolt esetben, és RLS policy akkor is join-safe legyen.   [style:ListBullet]
API transaction elején SET LOCAL app.tenant_id / authenticated context; pool reset/transaction boundary kötelező.   [style:ListBullet]
RAG query tenant filter nélkül compile/test failure-nek számítson; integration test cross-tenant adversarial datasetet használjon.   [style:ListBullet]
Pénzügyi, audit és consent táblák append-only jellegűek; application UPDATE/DELETE permission korlátozva.   [style:ListBullet]
Booking overlap és idempotency DB constraint/transaction segítségével legyen védve, ne csak app-level checkkel.   [style:ListBullet]

# 13. Saját API és contract-rendszer
Public és internal API contract source of truth OpenAPI 3.1 + JSON Schema/TypeBox. Realtime call events protobufbal is definiálhatók. Minden schema verziózott és backward-compatible policy alá esik.

| Endpoint | Cél | Kritikus védelem |
| POST /v1/workspaces | Tenant/workspace create | auth; idempotency |
| GET /v1/workspaces/:id | Workspace config | RBAC |
| GET/POST /v1/agents | Agent list/create | RBAC |
| GET/PATCH /v1/agents/:id | Agent config | optimistic concurrency/version |
| POST /v1/agents/:id/versions | Create draft version | config hash |
| POST /v1/agent-versions/:id/publish | Publish/canary | approval gate |
| POST /v1/agent-versions/:id/rollback | Rollback | audit |
| GET /v1/calls | Call search | scoped filters |
| GET /v1/calls/:id | Call detail | PII policy |
| POST /v1/calls/:id/transfer | Human transfer | operator role |
| POST /v1/calls/:id/terminate | Emergency terminate | operator/admin |
| GET/POST /v1/knowledge-sources | Knowledge | file/url policy |
| POST /v1/integrations/google/connect | OAuth start | state/PKCE |
| POST /v1/integrations/custom-tools | Create custom API tool | SSRF validation |
| GET /v1/bookings | Bookings | location scope |
| POST /v1/bookings | Create booking | idempotency |
| POST /v1/waitlist | Waitlist entry | policy |
| GET /v1/analytics/overview | KPI dashboard | aggregated |
| GET /v1/billing/subscription | Plan/usage | billing role |
| POST /v1/billing/checkout | Stripe checkout | server price map |
| POST /v1/phone-numbers/search | Telnyx inventory | rate limit |
| POST /v1/phone-numbers/order | Number order | paid entitlement |
| GET /v1/provisioning/:id | Provisioning state | tenant scope |
| POST /v1/simulations/runs | Simulation batch | credit/limit |
| GET /v1/audit-logs | Audit | admin/security |
| POST /v1/webhooks/test | Outbound webhook tester | developer role |

Idempotency-Key kötelező minden külsőleg ismételhető write-on.   [style:ListBullet]
ETag/version vagy explicit version field config update-nél, hogy lost update ne legyen.   [style:ListBullet]
Pagination cursor-alapú; nagy call/event listán offset pagination kerülendő.   [style:ListBullet]
Error response: stable machine code + localized user message key + trace_id; ne szivárogjon stack trace.   [style:ListBullet]
Rate limit tenant/user/IP + operation cost alapján.   [style:ListBullet]

# 14. Telefon/SIP és voice runtime
A primary carrier Telnyx. A primary voice layer a v6-ban meghatározott OpenAI Live modellstratégia. A voice runtime Rust service feladata nem feltétlenül a teljes audio proxyzása, hanem a call/session control, sideband event kezelés, tool dispatch koordináció, concurrency, metrics és provider state. Ha direct SIP útvonal használható, ne építs szükségtelen RTP bridge-et.

| Lépés | Működés |
| DID inbound | Telnyx a tenant phone number alapján a konfigurált SIP útvonalra irányít. |
| Call admission | Distributed concurrency semaphore + tenant entitlement + fraud/spend/call-duration limit. |
| Session config | Immutable agent-version snapshot: voice, language hints, disclosure, tool set, policy, handoff. |
| Accept | OpenAI Live session accept / provider-specific session establishment. |
| Sideband | Rust voice-runtime eseményeket fogad, trace-eli, turn/interrupt state-et kezeli. |
| Tool call | Runtime structured tool requestet küld a Tool Gatewaynek; schema + policy validáció. |
| Write tool | Confirmation/idempotency gate után connector execution. |
| Transfer | Warm transfer / DTMF / policy; allowed destination only. |
| Hangup | Usage flush, final state, transcript retention/redaction, quality job enqueue. |
| Provider failure | Circuit breaker/fallback/handoff; write side effects dedupe. |


## 14.1 Call-local state
CallSession {   [style:CodeBlock]
call_id,   [style:CodeBlock]
tenant_id,   [style:CodeBlock]
location_id,   [style:CodeBlock]
phone_number_id,   [style:CodeBlock]
agent_version_id,   [style:CodeBlock]
provider_call_id,   [style:CodeBlock]
direction,   [style:CodeBlock]
language,   [style:CodeBlock]
state,   [style:CodeBlock]
caller_identity_hint,   [style:CodeBlock]
tool_budget,   [style:CodeBlock]
spend_budget,   [style:CodeBlock]
started_at,   [style:CodeBlock]
trace_id,   [style:CodeBlock]
sequence,   [style:CodeBlock]
}   [style:CodeBlock]
A session actoron kívül ne legyen process-global mutable call state. Minden external side effect event/idempotency azonosítóval rendelkezzen. Process crash esetén a call megszakadhat, de a ledger/audit/event state konzisztens maradjon és a reconciliation képes legyen lezárni az orphaned callt.

# 15. Agent orchestration és multi-agent rendszer

| Specialist | Feladat | Engedélyezett toolok | Default backend |
| Reception/Router | Greeting, disclosure, language, intent, routing | profile read, routing | Live + routine backend |
| Booking | Availability, hold, create/change/cancel | booking/calendar read/write | routine/complex routing |
| Support | FAQ, status, troubleshooting | knowledge + read-only CRM | routine |
| Sales | Lead qualification, meeting/callback | lead create, calendar | routine/complex |
| Billing | Invoice/status/payment link | scoped billing read/write | complex + deterministic policy |
| Handoff/Compliance | Human transfer, policy boundary | transfer only | deterministic + model assist |

Supervisor/router csak specialist választ, ne kapjon minden write toolhoz hozzáférést.   [style:ListBullet]
Agent handoff context structured summary legyen, ne korlátlan teljes prompt concatenation.   [style:ListBullet]
Minden specialist explicit tool allowlist és max tool execution budget.   [style:ListBullet]
AgentVersion immutable publish után; config hash és rollout_percent szükséges.   [style:ListBullet]
Canary és rollback productionban one-click; quality regression trigger automatikus rollbacket javasolhat, de production auto-rollback policy configurable.   [style:ListBullet]

## 15.1 Conversation state machine
GREETING -> DISCOVERY -> IDENTITY? -> ACTION_PREVIEW -> CONFIRMATION_GATE   [style:CodeBlock]
-> TOOL_EXECUTION -> RESULT_CONFIRMATION -> FOLLOW_UP -> END   [style:CodeBlock]
\-> HANDOFF   [style:CodeBlock]
\-> SAFE_FAILURE   [style:CodeBlock]
Ne csak system prompt irányítsa a flow-t. A domain state machine kódban legyen; az LLM structured decisiont adhat, de nem ugorhat át confirmation/compliance gate-et.

# 16. Caller identity és memory
E.164 telefonszám lookup key és nyelvi hint lehet, de nem erős authentication.   [style:ListBullet]
Person identity több telefonszámot, e-mailt, external CRM ID-t és verified/inferred mezőt tud kezelni.   [style:ListBullet]
Név/e-mail csak tenanton belül tárolódik és policy/retention vonatkozik rá.   [style:ListBullet]
Érzékeny művelethez OTP, booking ID, e-mail magic link vagy human verification kell.   [style:ListBullet]
Minden profilmezőhöz source, confidence/verified state és last_confirmed_at.   [style:ListBullet]
Duplicate identity merge auditált; automatikus merge csak magas bizonyosságnál.   [style:ListBullet]

# 17. Knowledge/RAG

| Pipeline step | Követelmény |
| Upload/URL | MIME/size validation, malware scan, SSRF-safe fetch. |
| Parse | PDF/DOCX/TXT/Markdown/CSV; OCR only when needed. |
| Normalize | Language, headings, structured metadata. |
| PII/security scan | Sensitive content marking, tenant policy. |
| Chunk | Semantic + structural chunking. |
| Embed/index | pgvector, tenant_id mandatory. |
| Retrieve | tenant + ACL filter before semantic ranking. |
| Rerank | Optional; no-answer threshold. |
| Answer | Source-grounded; tool facts never invented. |
| Freshness | Version, valid_from/to, website scheduled sync. |
| Gap intelligence | Unanswered questions -> suggested FAQ/source update. |

Prompt injection a knowledge source-ban untrusted content; retrieval text nem írhatja felül system/tool policy-t.   [style:ListBullet]
Knowledge source versioning atomic activation/deactivation.   [style:ListBullet]
Admin UI mutassa source attributiont és conflicting source warningot.   [style:ListBullet]
Website crawler robots/policy és rate-limit tiszteletben tartása; private/internal URL tiltott SSRF miatt.   [style:ListBullet]

# 18. Booking és waitlist
A booking engine resource-aware legyen; ne csak Google Calendar event létrehozó wrapper. A domain modell kezeljen employee/room/table/bay/doctor/service resource-ot, capacity-t, service durationt, buffer time-ot, timezone-t, holiday/exception szabályt és cancellation policy-t.
Availability check és create egy tranzakciós/hold mechanizmuson keresztül védje a double bookingot.   [style:ListBullet]
Concurrent callers ugyanarra a slotra: egy nyer, a másik valós időben alternatív slotot kap.   [style:ListBullet]
External calendar connector eventual consistency miatt provider idempotency + local booking source of truth mapping szükséges.   [style:ListBullet]
Waitlist entry desired time window + party/service/resource constraints; felszabaduláskor notification/AI callback policy.   [style:ListBullet]
No-show, cancellation window, deposit-required és reschedule policy tenant-configurable.   [style:ListBullet]
Booking confirmation e-mail/SMS csak sikeres committed booking után mehet.   [style:ListBullet]

# 19. Connector és tool platform
A connector rendszer két szintű: built-in verified connectorok és custom API tool builder. Minden toolnak machine-readable input/output schema, auth policy, timeout, retry, idempotency és side-effect classification kell.

| Connector | Auth | Minimum toolok |
| Google Calendar | OAuth2 | list calendars, free/busy, create/update/cancel event |
| Microsoft 365 | OAuth2 | calendar + optional mail |
| Platform e-mail | AWS SES | send confirmation/notification |
| Custom SMTP | Credential secret | send mail, test connection |
| Stripe | Secret + webhook signing | subscription/payment read; checkout server-side |
| Billingo | API v3 key | partner + invoice/correction/send |
| Telnyx | API key + webhook/signature | number search/order/state/routing |
| Twilio fallback | API credentials | fallback call routing |
| Custom API/Webhook | Bearer/OAuth/HMAC | tenant-defined schema + allowlisted host |


## 19.1 Custom API egress security
Domain allowlist; scheme HTTPS only productionban.   [style:ListBullet]
Private, loopback, link-local, metadata és reserved IP tartományok tiltása IPv4/IPv6-ban.   [style:ListBullet]
DNS resolve -> IP validation -> connection; rebinding elleni újraellenőrzés.   [style:ListBullet]
Redirect default deny, vagy minden hop újra validálva.   [style:ListBullet]
Hard connect/read/total timeout, response size limit, content type limit.   [style:ListBullet]
Auth secret vault reference, soha nem LLM promptban.   [style:ListBullet]
Write tool csak idempotency/confirmation policy szerint.   [style:ListBullet]
Egress külön worker/network policyval; control API ne legyen szabad proxy.   [style:ListBullet]

# 20. Human handoff és call transfer
Explicit „emberrel szeretnék beszélni” intent azonnal handoff policyt indít.   [style:ListBullet]
DTMF például ### vagy tenant-configured shortcut.   [style:ListBullet]
Warm transfer: AI röviden összefoglal a fogadó embernek, caller holdon marad.   [style:ListBullet]
AI whisper: név, intent, fontos státusz, eddigi próbálkozás, booking/order ID, urgency - csak szükséges adatok.   [style:ListBullet]
Transfer destination tenant allowlist; premium-rate és nem engedélyezett nemzetközi cél tiltva.   [style:ListBullet]
Fogadó nem veszi fel -> vissza AI-hoz, callback request vagy másik queue.   [style:ListBullet]
Transfer után event/usage/audit konzisztens marad.   [style:ListBullet]

# 21. Billing, Stripe, Billingo és usage ledger
Stripe az egyetlen payment/subscription source of truth. Apple Pay és Google Pay Stripe-on keresztül jelenik meg; nincs külön wallet backend. Billingo API v3 a számlázási source of truth. A frontend success URL soha nem aktivál szolgáltatást.

| Esemény | Velyric művelet |
| checkout/payment success | Server-side verified Stripe event -> order PAID -> invoice/provisioning workflow. |
| invoice.paid | Új billing period entitlement + usage cycle + Billingo invoice. |
| payment failed | PAST_DUE/GRACE; email; retry; nincs delete. |
| subscription updated | Entitlement snapshot atomic update. |
| refund | Ledger adjustment + Billingo correction/storno policy. |
| dispute created | Risk suspension + evidence retention + alert. |
| subscription deleted | Cancel/grace/suspend workflow; config retained. |


## 21.1 Csomagparaméterek a v6 alapján

| Plan | Nettó havidíj | Included voice | Overage | Concurrency |
| START | 39 900 Ft | 150 perc | 149 Ft/perc | 2 |
| BUSINESS | 69 900 Ft | 400 perc | 129 Ft/perc | 10 |
| PRO | 129 900 Ft | 1000 perc | 109 Ft/perc | 50 |
| ENTERPRISE | egyedi | egyedi | egyedi | 100+ / szerződéses |

Nemzetközi piacra külön Stripe Price Book készül EUR-ban. Ne futásidejű FX konverzióból legyen az ügyfél ára. HU/DE/EN locale nem feltétlenül azonos a billing countryval; price selection billing market alapján.

# 22. Automatikus provisioning
ORDER_CREATED   [style:CodeBlock]
-> PAYMENT_PENDING   [style:CodeBlock]
-> PAYMENT_CONFIRMED   [style:CodeBlock]
-> BILLING_PENDING   [style:CodeBlock]
-> TENANT_CREATED   [style:CodeBlock]
-> OPENAI_PROJECT   [style:CodeBlock]
-> OPENAI_SERVICE_ACCOUNT   [style:CodeBlock]
-> PHONE_SEARCH/RESERVE   [style:CodeBlock]
-> KYC_REQUIRED? -> WAITING_FOR_CUSTOMER/PROVIDER   [style:CodeBlock]
-> PHONE_READY   [style:CodeBlock]
-> SIP_AGENT_BINDING   [style:CodeBlock]
-> KNOWLEDGE/DEFAULT_AGENT_READY   [style:CodeBlock]
-> TEST_CALL_READY   [style:CodeBlock]
-> GO_LIVE_ELIGIBLE   [style:CodeBlock]
-> ACTIVE   [style:CodeBlock]
Temporal workflow durable state; több napos KYC wait nem tarthat nyitott HTTP requestet.   [style:ListBullet]
Minden external create/write saját idempotency key + external ref alapján reconcile-olható.   [style:ListBullet]
OpenAI tenant isolation: külön project + service account + scoped secret; ügyfél nem kapja meg a provider kulcsot.   [style:ListBullet]
Telnyx number order csak fresh inventory resultból és payment/fraud gate után.   [style:ListBullet]
KYC dokumentum lehetőleg providerhez közvetlenül; Velyric provider reference-et tároljon, ne felesleges másolatot.   [style:ListBullet]
Web Voice test call phone approval előtt is működjön.   [style:ListBullet]
Go-live gate: disclosure, routing, limits, billing entitlement, provider health, tool permissions, mandatory tests.   [style:ListBullet]

# 23. Supplier-cost buffer és pénzügyi kontroll
Az ügyfél által fizetett összeget ne próbálja a Velyric tenantonként OpenAI prepaid walletbe „átutalni”. A customer billing ledger és a supplier prepaid balance két külön rendszer. OpenAI/Telnyx felé a platform közös, kontrollált working-capital buffert tart; tenantonként belső usage/cost reserve és hard limit fut.
A negyedelős budget ötlet belső cost-budgetként használható: Q1 aktív, 80% usage-nél Q2 unlock, stb. Ez nem provider credit purchase.   [style:ListBullet]
OpenAI organization supplier balance auto-recharge threshold + target balance + monthly cap; alert a küszöbökre.   [style:ListBullet]
Tenant cost guard call közben is számol: max cost/call, max tool execution, max duration, daily/monthly spend.   [style:ListBullet]
Billing period végén fel nem használt belső reserve felszabadul marginba; customernek ez nem cash wallet.   [style:ListBullet]
Reconciliation naponta: Velyric usage ledger vs provider usage/cost export; eltérés alert.   [style:ListBullet]

# 24. Dunning, suspension és reactivation

| Időpont | Notification / state |
| -5 nap | Renewal reminder e-mail |
| -3 nap | Renewal reminder e-mail |
| -1 nap | Renewal reminder e-mail |
| 0 | Stripe renewal attempt; siker -> új period; hiba -> GRACE_PERIOD + e-mail |
| +1 nap | Grace reminder; szolgáltatás működik policy szerint |
| +2 nap | Utolsó grace nap; e-mail; nap végén SUSPENDED_BILLING ha nincs fizetés |

Suspension soha nem törli az agent configot, knowledge-t, OAuth configot, analyticsot vagy tenantot.   [style:ListBullet]
Reactivation invoice.paid után automatikus; config áll vissza. Revoked credentialt csak szükséges esetben provision újra.   [style:ListBullet]
Telefonszám retention nem lehet végtelen ingyen, mert carrier költséget generál. Policy: pl. 30 nap included retention; utána retention add-on/debt/number release szabály.   [style:ListBullet]
Data deletion csak explicit retention policy és jogi feltételek után, külön audited workflow-ban.   [style:ListBullet]

# 25. Fraud, dispute és abuse védelem
Stripe Radar + 3DS/SCA ahol indokolt; server-side fraud state.   [style:ListBullet]
Új account trust ramp: alacsony concurrency, outbound default off/limit, daily usage cap, premium routing limit.   [style:ListBullet]
B2B verification: company legal data, domain/business e-mail, VAT/company data policy szerint.   [style:ListBullet]
Payment siker önmagában nem garantál korlátlan provisioninget: fraud gate a drága number/OpenAI/outbound erőforrások előtt.   [style:ListBullet]
Chargeback/dispute létrejöttekor SUSPENDED_DISPUTE vagy risk-restricted state; adatok/evidence nem törölhető.   [style:ListBullet]
Automatikus evidence package: payment/3DS metadata, accepted terms version, IP/session, company verification, provisioning logs, actual usage, e-mail history.   [style:ListBullet]
Toll fraud: transfer destination allowlist, outbound country allowlist default deny, premium number block, call duration/concurrency/spend caps.   [style:ListBullet]
Bot/flood detection: IP/account/card/device/phone velocity signals és rate limit. Ne tárolj nyers kártyaadatot.   [style:ListBullet]

# 26. Concurrency, autoscaling és backpressure
A rendszernek egyszerre több egymástól izolált hívást kell kezelnie. A concurrent-call plan limit nem egyetlen telefonvonal logikája: minden call saját Rust actor/session, saját trace és saját tool budget. A distributed admission control tenantonként és globálisan működik.
Plan concurrency: START 2, BUSINESS 10, PRO 50, Enterprise 100+ szerződés szerint.   [style:ListBullet]
Redis distributed semaphore tenantonként + location/number policy szerint. Crash-safe lease/TTL + cleanup.   [style:ListBullet]
Provider CPS token bucket külön inbound/outbound/provider/region kulcsokkal.   [style:ListBullet]
Autoscaling voice-runtime active session count + CPU + event lag alapján.   [style:ListBullet]
Connector worker provider-rate-limit aware queue; 429 Retry-After tiszteletben.   [style:ListBullet]
Overload policy: új call queue/callback/human-forward/degraded message tenant config szerint; futó callt ne dobjon le csak azért, mert új burst érkezett.   [style:ListBullet]
Booking write DB transaction/lock/constraint védi a race conditiont.   [style:ListBullet]
Egy call panic/exception nem rántja le process-szinten a többi sessiont; Rust task boundary és error isolation.   [style:ListBullet]

# 27. Observability, quality és analytics

| Signal | Példa |
| Trace | call_id, tenant_id, provider, agent_version, tool execution spans |
| Metrics | active calls, call admission reject, P50/P95/P99 response latency, tool latency, transfer success, provider error |
| Logs | structured, PII-redacted, trace_id, event_id |
| Business KPI | resolved by AI, booking conversion, lead conversion, transfer rate, human hours saved, revenue attribution |
| Quality | hallucination risk, loop, repeat question, silence, interruption handling, wrong language |
| Cost | provider cost/call, cost/resolved call, cost/minute, margin estimate |

OpenTelemetry minden service-ben. Trace propagation HTTP/NATS/Temporal callon át.   [style:ListBullet]
Prometheus-compatible metrics + Grafana dashboard; Sentry app errors PII scrubberrel.   [style:ListBullet]
Alert: provider outage, payment webhook backlog, provisioning stuck, call failure spike, quality regression, cost anomaly, DB/Redis saturation.   [style:ListBullet]
Raw transcript/audio observability exportba ne kerüljön. Call content külön access-controlled storage/policy.   [style:ListBullet]

# 28. Simulation Lab és eval platform
Scenario suite: happy path, interruption, silence, noisy audio, accent, wrong e-mail, ambiguous date, angry caller, prompt injection, provider timeout, duplicate webhook, concurrent booking.   [style:ListBullet]
Minden agent version publish előtt minimum regression suite; production canary után quality comparison.   [style:ListBullet]
Seeded reproducibility: scenario input, agent_version, model/provider version, tool fixture, random seed, rubric version.   [style:ListBullet]
Offline evaluator model eredménye nem lehet egyetlen gate; deterministic assertions + human review sample + model score kombináció.   [style:ListBullet]
Quality Monitoring automatikusan flaggel loopot, 3x repeatet, wrong language-et, tool failure spike-ot, latency spike-ot, knowledge gapet.   [style:ListBullet]
Knowledge Intelligence az unanswered/low-confidence kérdésekből javasol FAQ/source update-et; automatikusan ne írja át production knowledge-t approval nélkül.   [style:ListBullet]

# 29. Internal Support Console
Tenant search: legal name, workspace ID, Stripe customer, phone number.   [style:ListBullet]
Provisioning timeline: Stripe -> Billingo -> OpenAI -> Telnyx/KYC -> agent -> notification.   [style:ListBullet]
Call trace explorer redacted defaulttal; explicit elevated access sensitive contenthez.   [style:ListBullet]
Failed webhook/tool queue; retry/replay csak idempotency guard mellett.   [style:ListBullet]
OAuth health, knowledge sync, provider health, usage/cost anomaly.   [style:ListBullet]
Feature flags/kill switch: global, tenant, agent, provider.   [style:ListBullet]
JIT support impersonation explicit reasonnel és automatikus expiryvel.   [style:ListBullet]
Runbook link és correlation ID minden incidenthez.   [style:ListBullet]

# 30. Security hardening

| Kontroll | Kötelező megoldás |
| Tenant isolation | Postgres RLS + service authorization + adversarial integration tests |
| Secrets | KMS/Secrets Manager, envelope encryption, rotation, no logs |
| Webhooks | Signature verify, timestamp/replay, dedupe, rate limit |
| OAuth | PKCE/state, minimal scopes, encrypted refresh token, revoke |
| Custom egress | SSRF-safe isolated worker, allowlist, no private IP |
| Frontend | CSP, Trusted Types where practical, XSS escaping, CSRF, secure cookies |
| API | Schema validation, authz, rate limits, body size, CORS allowlist |
| Files | MIME sniff, size limits, malware scan, safe parser process |
| DB | TLS, least privilege roles, PITR, encrypted backups |
| Containers | non-root, read-only FS where possible, seccomp, minimal image |
| Supply chain | lockfiles, signed artifacts, SBOM, vulnerability scan, pinned CI actions |
| Rust | unsafe denied by default, clippy -D warnings, cargo deny/audit, fuzz parsers |
| TS | strict, no implicit any, runtime schema validation, eslint security rules |
| Infra | private subnets, security groups, no public DB/Redis, IAM least privilege |


## 30.1 Security testing gate
SAST: Semgrep/rules + TypeScript lint + Rust clippy.   [style:ListBullet]
Dependency: OSV scanner, cargo audit/deny, container Trivy.   [style:ListBullet]
Secret scan: gitleaks minden PR és history-sensitive release gate.   [style:ListBullet]
DAST staging: OWASP ZAP baseline + custom auth flows.   [style:ListBullet]
Fuzz: webhook parser, event/protobuf parser, DTMF/call event parser, custom tool schema parser.   [style:ListBullet]
Property tests: booking overlap, usage aggregation, idempotency, state transitions.   [style:ListBullet]
Authz matrix tests: minden role × endpoint × tenant cross-access.   [style:ListBullet]
SSRF tests IPv4/IPv6, redirect, DNS rebinding fixture, metadata endpoint.   [style:ListBullet]

# 31. GDPR, EU AI Act és retention
AI disclosure a hívás elején, tenant nyelvéhez/call nyelvéhez igazítva; disclosure_version consent ledgerbe.   [style:ListBullet]
Recording külön policy; consent és ország/jogi szabály szerint. Recording off esetén se kerüljön audio persistálásra.   [style:ListBullet]
Data minimization: transcript, profile, analytics és raw provider payload külön retention class.   [style:ListBullet]
DSAR: person identity alapján export/delete workflow tenanton belül; legal hold/dispute kivétel auditált.   [style:ListBullet]
Subprocessor és DPA inventory; customer-facing security/privacy docs valós deploymentből generálható legyen.   [style:ListBullet]
PII redaction log/tracing előtt; support console default redacted.   [style:ListBullet]
Retention background job deterministic és idempotens; deletion evidence audit event.   [style:ListBullet]

# 32. Disaster Recovery és provider failover

| Scenario | Primary response | Fallback |
| OpenAI voice outage | Circuit breaker; health state | Secondary realtime/voice path vagy controlled human-forward message. |
| Telnyx outage | Provider health -> route decision | Twilio fallback / emergency forward. |
| DB primary failure | Managed Multi-AZ failover | PITR/restore runbook. |
| Redis failure | Graceful loss of cache; admission safe default | DB/source of truth; conservative limits. |
| Region outage | DNS/provider routing | Secondary region/warm recovery Enterprise policy szerint. |
| Connector outage | Retry/circuit breaker | Human fallback / delayed action. |
| Billing provider outage | Persist event/outbox | Retry; service entitlement policy ne duplázódjon. |

RPO/RTO konkrétan mérve és dokumentálva; backup megléte nem elég, restore teszt kell.   [style:ListBullet]
Quarterly restore drill staging isolated accountba.   [style:ListBullet]
Database daily backup + PITR; object storage versioning; IaC teljes újraépíthetőség.   [style:ListBullet]
Emergency kill switches: outbound, provider, model, tool, recording, tenant, global.   [style:ListBullet]

# 33. Infrastructure és deployment
Ajánlott production default: Cloudflare a DNS/WAF/CDN/geo edge réteghez, AWS eu-central-1 az alkalmazás- és adat-infrastruktúrához. A cél managed, kevés operációs overhead mellett prémium reliability. Ha más cloud kerül használatra, ugyanazokat a biztonsági és HA tulajdonságokat kell biztosítani.

| Komponens | Ajánlott production megoldás |
| Network | AWS VPC, public ALB only ahol kell, private app/data subnets, NAT/egress policy |
| Containers | ECS Fargate / managed container runtime; voice-runtime külön service |
| Postgres | RDS PostgreSQL Multi-AZ + pgvector, encrypted, PITR |
| Redis | ElastiCache/managed Redis, TLS |
| Object storage | S3 encryption/versioning/lifecycle |
| Secrets/KMS | AWS Secrets Manager + KMS |
| Workflow | Temporal Cloud EU region ha elérhető; különben self-hosted managed deployment |
| NATS | Managed/self-hosted JetStream private network |
| Email | AWS SES eu-central-1 platform transactional |
| Observability | OpenTelemetry Collector -> Grafana/managed telemetry EU + PII scrub |
| WAF/CDN | Cloudflare WAF, rate limit, bot protection/Turnstile ahol indokolt |
| IaC | OpenTofu; remote encrypted state + state locking |


## 33.1 Deployment invariánsok
Blue/green vagy rolling deploy health gate-tel; active call runtime drain-elhető legyen deploy előtt.   [style:ListBullet]
DB migration backward-compatible legyen a régi és új app verzióval rollout idején.   [style:ListBullet]
Voice runtime deploykor új sessiont már új task kapjon, régi active session grace drain alatt fejezhesse be.   [style:ListBullet]
Production deploy CI artifact digestből, nem rebuild from branch.   [style:ListBullet]
IAM OIDC GitHub Actionsból; long-lived AWS key tilos CI secretként.   [style:ListBullet]

# 34. CI/CD és supply-chain security

| PR gate | Kötelező |
| Formatting/lint | prettier/eslint, cargo fmt/clippy, ruff/black |
| Type/build | tsc, Next build, cargo check/test, Python import/type checks |
| Unit | All workspaces |
| DB | Migration up on clean DB + schema invariant tests |
| Contract | OpenAPI/protobuf compatibility |
| Security | gitleaks, OSV, cargo deny/audit, Trivy/Semgrep |
| Frontend | Playwright component/E2E + accessibility + visual snapshot |
| Integration | Postgres/Redis/NATS/Temporal test env + provider simulators |
| Rust fuzz/property | Critical parsers/state logic smoke corpus |
| Container | Non-root scan + SBOM |
| Preview | Ephemeral preview with synthetic data |

Main merge után staging deploy automatikus. Production promotion csak staging E2E, synthetic call, migration check, security gate és manual production approval után. Release taghez SBOM és signed container digest tartozzon.

# 35. Teljes tesztstratégia

| Tesztosztály | Mit tesztel | Pass kritérium |
| Unit | Domain policy, state machine, pricing/entitlement, locale, formatter | Gyors, determinisztikus; critical domain magas branch coverage. |
| DB invariant | RLS, unique, FK, booking overlap, idempotency | Valódi Postgres. |
| Contract | OpenAPI/protobuf/provider fixtures | Backward compatibility. |
| Integration | Stripe/Billingo/Telnyx/OpenAI adapter sandbox/simulator | Valódi signatures/error modes. |
| E2E web | Signup -> checkout -> onboarding -> dashboard | Playwright HU/DE/EN + light/dark. |
| E2E provisioning | payment webhook -> Billingo -> OpenAI -> Telnyx state -> ready | Temporal workflow assertions. |
| Voice scripted | HU/DE/EN greeting, interruption, booking, handoff | Synthetic/test calls. |
| Concurrency | 2 callers same slot; 10/50/100/500 calls | No leak/double-book; latency target. |
| Visual regression | Marketing routes + dashboard | Dashboard reference 1:1 target; all themes/locales. |
| Accessibility | axe + keyboard + focus + screenreader semantics | WCAG 2.2 AA target. |
| Security | Authz, SSRF, webhook replay, prompt injection, secret exfil | Must pass. |
| Fuzz/property | Rust parser/state, billing/idempotency invariants | No panic / invariant break. |
| Chaos | Provider 500/timeout/429, DB failover, Redis failure | Graceful degradation. |
| DR restore | DB/S3 restore into isolated env | RPO/RTO measured. |
| Billing reconciliation | Provider cost vs ledger | Tolerance threshold, alert. |
| Quality eval | Simulation suites/rubrics | No critical regression before publish. |


## 35.1 Minimum test coverage policy
Coverage szám önmagában nem minőség, de minimum gate legyen: domain/policy/state-machine modulok 90%+ branch coverage cél; teljes TS backend 80%+ line; Rust critical crates 85%+ line ahol mérhető, kiegészítve property/fuzz tesztekkel; frontend üzleti interakciók E2E/visual teszttel. Coverage csökkentés csak indokolt waiverrel.

# 36. Performance és load testing

| Scenario | Terhelés | Mérendő |
| Baseline | 10 concurrent calls | P50/P95/P99 response, CPU, memory, event lag |
| Business burst | 50 concurrent | Admission, tool latency, DB pool, NATS lag |
| Pro/Enterprise | 100 concurrent | Session stability, provider limits |
| Stress | 500 concurrent simulated sessions | Graceful backpressure, no crash/leak |
| Webhook flood | 10x normal webhook rate | Dedup/rate limit, queue recovery |
| Tool provider slow | 2-10s connector latency | Filler/safe timeout/handoff |
| DB contention | Concurrent booking same resource | No double booking |
| Long call | 30 min + many interruptions | Memory stable, usage accurate |

Rust load generator a call/event protocol ellen; reproducible seed és metrics export.   [style:ListBullet]
Memory leak soak test több órás session churnnel.   [style:ListBullet]
P95/P99 latency regression threshold CI/nightly runban.   [style:ListBullet]
A provider valódi CPS/rate limitjét soha ne stresszeljük engedély nélkül; sandbox/simulator az elsődleges load target.   [style:ListBullet]

# 37. Accessibility, SEO és frontend quality
WCAG 2.2 AA: keyboard, focus visibility, form label, contrast, reduced motion, aria semantics.   [style:ListBullet]
Landing oldalon semantic headings, metadata, OG, JSON-LD Organization/SoftwareApplication csak valós adatból.   [style:ListBullet]
Locale-specific title/description/hreflang/canonical.   [style:ListBullet]
Core Web Vitals budget: image optimization, font preloading, avoid blocking JS.   [style:ListBullet]
Dashboard table/list virtualization nagy call listán.   [style:ListBullet]
No layout shift a hero/dashboard image/card betöltésnél.   [style:ListBullet]
Error boundary és offline/retry UX.   [style:ListBullet]
Light/dark theme no-flash server-side resolved cookie alapján.   [style:ListBullet]

# 38. Dokumentáció és developer experience
Root README: prerequisites, one-command local bootstrap, service map, common commands.   [style:ListBullet]
.env.example minden változó magyarázatával, de secret érték nélkül.   [style:ListBullet]
Architecture Decision Records a nagy döntésekről: Rust voice runtime, Temporal, RLS, provider routing, auth.   [style:ListBullet]
OpenAPI docs generálás + example request/response.   [style:ListBullet]
Runbooks: OpenAI outage, Telnyx outage, Stripe webhook backlog, KYC stuck, DB restore, fraud incident.   [style:ListBullet]
Connector authoring guide és test harness.   [style:ListBullet]
Agent policy authoring guide + simulation requirement.   [style:ListBullet]
Local provider simulators/fixtures determinisztikus devhez.   [style:ListBullet]
Database ERD és event catalog generálva a contractokból ahol lehet.   [style:ListBullet]

# 39. Kötelező acceptance matrix

| Gate | Elvárt állapot |
| Build | Minden workspace clean checkoutból buildel. |
| Local boot | Dokumentált parancs elindítja a teljes dev stack-et. |
| No placeholders | Production pathon nincs TODO/FIXME/fake success. |
| HU/DE/EN web | Minden public és app core route fordított. |
| Geo locale | HU -> hu, DE/AT/CH/LI -> de, más -> en első látogatásnál; override megmarad. |
| Light/dark | Minden route mindkét theme-ben működik. |
| Design | Landing vizuálisan a reference irányát követi, nem generic template. |
| Dashboard | Fő dashboard 1:1 reference layout/visual hierarchy. |
| Auth/RBAC | Role × endpoint matrix tesztelt. |
| RLS | Cross-tenant lekérdezés adversarial tesztben blokkolt. |
| Stripe | Valódi webhook signature + idempotency. |
| Apple/Google Pay | Stripe wallet integráció konfigurálva. |
| Billingo | Invoice flow API v3, retry és korrekció workflow. |
| Provisioning | Payment -> tenant/OpenAI/phone/agent state durable. |
| KYC wait | Napokig tartó wait után folytatható. |
| Dunning | -5/-3/-1/0/+1/+2 notification és +2 suspension. |
| No delete | Payment failure nem töröl tenant configot. |
| Fraud | Radar/3DS/trust ramp/cost guard/dispute workflow. |
| OpenAI isolation | Tenant project + service account + secret vault. |
| Telnyx | Number search/order/status and SIP routing. |
| Voice | HU/DE/EN call, interruption, tool call, hangup. |
| Concurrency | 2/10/50+ plan gates; distributed admission. |
| Booking race | Concurrent same-slot test no double-book. |
| Handoff | Explicit, DTMF, policy transfer. |
| RAG | Tenant-filtered retrieval; prompt injection safe. |
| Custom API | SSRF-safe egress + schema + timeout + idempotency. |
| Quality | Post-call quality job and flags. |
| Simulation | Regression suite before agent publish. |
| Observability | Trace/metrics/log correlation end-to-end. |
| Secrets | No secret in repo/log/frontend bundle. |
| Backups | PITR/backups and restore test. |
| CI security | SAST/dependency/secret/container scans green. |
| E2E | Playwright critical journeys green. |
| A11y | WCAG automated tests green; keyboard sanity. |
| Visual | Reference dashboard screenshot regression accepted. |
| Load | 10/50/100/500 simulated load passes defined SLO/backpressure. |
| DR | Provider/database failure runbook tested. |
| Docs | README/API/runbooks/env reference current. |
| Release | Staging synthetic call and production smoke gate green. |


# 40. Végső coding-agent utasítás

| EZ A LEADÁSI SZERZŐDÉS
A feladat akkor kész, amikor a teljes Velyric rendszer implementálva, integrálva, tesztelve, dokumentálva és deployolható. Ne add át félkészen és ne oszd a leadást „Phase 1/2/3”-ra. Belsőleg tarts dependency sorrendet, de a végső eredmény teljes legyen. |

Először olvasd végig ezt a dokumentumot és a Velyric v6 termékspecifikációt; készíts belső dependency mapet, de ne kérj fázisonkénti jóváhagyást.   [style:ListNumber]
Hozd létre a monorepot és contractokat úgy, hogy minden service és UI ugyanarra a domain/contract modellre épüljön.   [style:ListNumber]
Implementáld a teljes adatmodellt és RLS/constraint invariánsokat a feature kód előtt.   [style:ListNumber]
Implementáld valódi provider adapterekkel a Stripe/Billingo/Telnyx/OpenAI/Google/Microsoft/SES/Twilio útvonalakat.   [style:ListNumber]
Implementáld a public weboldalt és dashboardot a csatolt design referencia alapján; dashboard főképernyő 1:1 referenciaértékű.   [style:ListNumber]
Implementáld HU/DE/EN lokalizációt, geo-defaultot, explicit override-ot és localized notifications-t.   [style:ListNumber]
Implementáld Rust realtime voice runtime-ot, concurrency admissiont, sideband events, tool dispatchot és handoffot.   [style:ListNumber]
Implementáld durable provisioning/dunning/cancel/reactivate workflow-kat.   [style:ListNumber]
Implementáld fraud/cost/security/compliance gate-eket még az éles provider write-ok előtt.   [style:ListNumber]
Írd meg minden réteg tesztjeit, majd futtasd őket; javíts minden hibát. Ne kapcsold ki a tesztet a hiba eltüntetésére.   [style:ListNumber]
Futtass security scaneket, E2E/visual/a11y teszteket, load/simulation suite-okat és migration/restore ellenőrzést.   [style:ListNumber]
Készíts production és staging deploymentet IaC-ból; dokumentáld a bootstrap/deploy/rollback/incident folyamatokat.   [style:ListNumber]
Végül készíts machine-readable és emberi release reportot: commit/tag, image digestek, migration verzió, teszteredmények, ismert limitation csak olyan lehet, ami nem sért kötelező acceptance gate-et.   [style:ListNumber]

## 40.1 Tiltott shortcutok
„Demo mode” productionban, fake stats vagy fake customer testimonial.   [style:ListBullet]
Provider response hardcode-olása a valódi integráció helyett.   [style:ListBullet]
Authz csak frontendben.   [style:ListBullet]
Tenant izoláció csak query filterrel RLS nélkül.   [style:ListBullet]
LLM által generált URL szabad fetch-elése.   [style:ListBullet]
Plaintext secret adatbázisban.   [style:ListBullet]
Frontend success URL alapján payment/provisioning aktiválása.   [style:ListBullet]
In-memory-only durable provisioning/dunning state.   [style:ListBullet]
Booking create availability check nélkül vagy DB race védelem nélkül.   [style:ListBullet]
Logba transcript/secret/payment sensitive data kontroll nélkül.   [style:ListBullet]
Generic shadcn/AI template vizuál a jóváhagyott Velyric design helyett.   [style:ListBullet]
Rust-kritikus data plane TypeScriptre cserélése csak azért, mert rövidebb megírni.   [style:ListBullet]

## 40.2 Végső állapot
A kívánt végeredmény egy olyan Velyric platform, amelybe egy valós vállalkozás regisztrálhat, fizethet Stripe-on kártyával/Apple Pay/Google Pay-jel, automatikusan Billingo számlát kap, kiválaszthat/provisionálhat telefonszámot, KYC esetén automatikusan várakozik és folytatódik, létrejön a tenant izolált AI runtime-ja, feltölthető a knowledge, csatlakoztatható naptár/e-mail/API, teszthívás végezhető, majd több párhuzamos éles hívást képes biztonságosan kezelni. A rendszer mér, számláz, monitoroz, értékel, failoverel, auditál és suspend/reactivate folyamatot kezel emberi operátor nélkül a normál happy pathban.

# Melléklet A – Kötelező csatolmányok a coding agent számára

| Fájl | Szerep |
| Velyric_Teljes_Dokumentacio_2026-09-12_v6.docx | Üzleti/termék source of truth. |
| velyric_ai_voice_platform_honlap.png | Landing page visual reference; dashboard block 1:1 target. |
| Velyric logo assets (SVG/PNG) | Brand source of truth. |


# Melléklet B – Brand és UI gyorsreferencia

| Elem | Érték |
| Primary text / dark brand | #071327 |
| Electric Magenta | #F000FF |
| Hot Pink | #FF007A |
| Crimson | #FF174E |
| Warm Coral | #FF7A59 |
| Deep Plum | #8E0069 |
| Soft blush | #FFF7FB |
| Light background | #FFFFFF |
| Dark background | #08090D |
| Primary font | Geist Sans |
| Mono font | Geist Mono |
| Design language | Bespoke, white/black base, organic asymmetry, diffused pink/magenta gradients, floating glass cards, no generic AI template. |

