VELYRIC
AI Voice SaaS – teljes műszaki, termék- és üzleti specifikáció
B2B, többnyelvű, AI-vezérelt telefonos asszisztens platform • Magyar • Német • Angol • SIP/telefon • naptár • e-mail • webhook • CRM

# 0. Velyric brand és vizuális rendszer
Ez a dokumentum a továbbiakban a Velyric véglegesített logóját és színrendszerét használja. A korábbi általános AI Voice SaaS megjelenést mostantól a Velyric brand irányelvei váltják fel: letisztult, prémium, modern és nem „AI-szagú” vizuális nyelvvel.

## 0.1 Márkaidentitás
A Velyric személyisége: magabiztos, megbízható, korszerű és elegáns. Nem játékos startup-hatású, de nem is rideg enterprise. A brand célja, hogy high-end technológiai szolgáltatásként hasson mind magyar, mind német és angol piacokon.

## 0.2 Logóhasználat
Elsődleges logó: a teljes Velyric logó (szimbólum + wordmark) fehér vagy nagyon világos háttéren.   [style:ListBullet]
Másodlagos logó: csak a Velyric embléma, amikor kevés a hely (favicon, app icon, avatar, loading state, social profilkép).   [style:ListBullet]
A logó körül legalább a wordmark „V” betűjének szélességével megegyező védőtávolság maradjon.   [style:ListBullet]
A logót nem szabad idegen színre átfesteni, torzítani, árnyékolni, körberajzolni vagy túl sötét/kontrasztszegény háttérre helyezni olvashatósági korrekció nélkül.   [style:ListBullet]

## 0.3 Elsődleges színpaletta
A Velyric vizuális rendszere a logóból származik. A teljes dokumentációban, weboldalon, UI-ban és marketing anyagokban az alábbi színek használata ajánlott.

## 0.4 Színhasználati szabályok
Elsődleges szövegszín minden hosszabb törzsszöveghez: Deep Navy (#071327). Fekete helyett is ezt használjátok, mert elegánsabb és márkahűbb.   [style:ListBullet]
Fő CTA-k, hero accentek és fontos interakciók: Hot Pink (#FF007A) → Crimson Red (#FF174E) → Warm Coral (#FF7A59) gradient.   [style:ListBullet]
A nagyon élénk magenta (#F000FF) csak kiemelésre szolgáljon; ne ez legyen a teljes felület főszíne, mert könnyen túl harsánnyá válik.   [style:ListBullet]
Háttérek elsődlegesen fehérek maradjanak. Kiemelt dobozokhoz Soft Blush Background (#FFF7FB) használható.   [style:ListBullet]
Kerülendő: általános „SaaS-kék”, idegen zöld/türkiz paletta, illetve a logótól független random gradientek. A márka elsődleges színei mindig a logóból jöjjenek.   [style:ListBullet]
Sötét felületen a wordmark és a hosszabb szöveg legyen fehér vagy nagyon világos, miközben az embléma megtartja a magenta–pink–coral átmenetet.   [style:ListBullet]

## 0.5 Dokumentum- és UI-alkalmazás
A dokumentum címei, táblázatfejlécei és hangsúlyos szekciói mostantól a Velyric színeit használják. Ugyanezt a rendszert kell átvinni a marketing site-ra, app felületre, dashboardra, sales deckre, invoice e-mail headerre és minden social/brand assetre.

| Szín neve | HEX | Felhasználás | Minta |
| Deep Navy | #071327 | Elsődleges szöveg, főcímek, wordmark, komoly B2B alaphang. |  |
| Electric Magenta | #F000FF | Hero accent, erős figyelemfelkeltő pontok, highlight. |  |
| Hot Pink | #FF007A | Gombok, CTA-k, hangsúlyos interakciók. |  |
| Crimson Red | #FF174E | Másodlagos accent, kulcsstátusz, kiemelések. |  |
| Warm Coral | #FF7A59 | Gradient lezárás, hover, pozitív energiát adó átmenet. |  |
| Deep Plum | #8E0069 | Kiegészítő sötétebb accent, árnyékolt/komolyabb alkalmazások. |  |
| Soft Blush Background | #FFF7FB | Lágy háttérblokkok, infókártyák, szekciókiemelés világos felületeken. |  |

Dátum: 2026. szeptember 11. • Állapot: alapító/fejlesztési specifikáció – v6, Velyric brand + párhuzamos híváskezelési specifikációval frissítve

| Fő ajánlás: GPT-Live-1 legyen az elsődleges beszédfront-end, mögötte GPT-5.6 Luna/Terra/Sol dinamikus routinggal. Telefóniára induláskor Telnyx; Twilio maradjon fallback/provider-2. A terméket ne „AI telefonszámként”, hanem mérhető üzleti folyamatokat végrehajtó voice-agent platformként árazzátok. |


# 1. Vezetői összefoglaló
A termék lényege: egy vállalkozás előfizet egy csomagra, kap vagy portol egy telefonszámot, feltölti a céges tudásanyagot, összeköti a naptárt/e-mailt/CRM-et, majd beállítja, hogy az AI milyen stílusban beszéljen és milyen műveleteket hajthat végre. A hívó fél természetes beszélgetésben kérdezhet, foglalhat, módosíthat, lemondhat, érdeklődhet, vagy emberi ügyintézőhöz kérheti az átadást.
A platformnak multi-tenant SaaS-ként kell működnie: minden cég adata, tudásbázisa, caller-memóriája, OAuth tokenje és naplója szigorúan elkülönítve. A hívó telefonszáma kényelmi azonosító lehet, de nem tekinthető erős hitelesítésnek.

| Döntés | Ajánlott választás | Miért |
| Voice front-end | GPT-Live-1 | $0,05/perc; full-duplex; természetes megszakítás; közvetlen telefonos use case |
| Routine backend | GPT-5.6 Luna | Nagyon olcsó nagy volumenű tool/CRUD feladatokra |
| Komplex backend | GPT-5.6 Terra | Jobb reasoning, még kezelhető költség |
| Nagyon komplex/escalation | GPT-5.6 Sol / GPT-6 Astra | Csak ritka, nagy értékű eseteknél |
| Telefon/SIP | Telnyx elsődleges | Olcsó, API-first, SIP/Voice API; magyar szám elérhető |
| Provider fallback | Twilio | Érett ökoszisztéma, jó fallback és routing lehetőségek |
| Core backend | TypeScript + Fastify/NestJS vagy Rust + Axum | 2 fős csapatnak TS gyorsabb; media/low-latency részekhez Rust jó |
| Adatbázis | PostgreSQL + pgvector | Tranzakciók + RAG metadata + tenant izoláció |
| Queue/cache | Redis + BullMQ / NATS | Retry, idempotencia, delayed jobs, rate limit |
| Object storage | S3-kompatibilis | Dokumentumok, exportok, opcionális hangfelvételek |


# 2. Termékvízió és pozicionálás
A piacra nem úgy érdemes kilépni, hogy „adunk egy AI telefonszámot”. Ez könnyen árversenybe kerül. Az értékajánlat legyen: 24/7 elérhető, természetesen beszélő digitális recepciós/ügyintéző, amely nem csak válaszol, hanem ténylegesen elvégez üzleti műveleteket és mérhető eredményt ad.
Fő érték: nem elveszett hívások, automatikus foglalás és follow-up, kisebb recepciós terhelés.   [style:ListBullet]
Vertikális sablonok: étterem, autószerviz, autókozmetika, fodrászat/szalon, fogászat/klinika, szállás, ingatlaniroda, webshop, B2B ügyfélszolgálat.   [style:ListBullet]
Általános motor + vertikális template-ek: ugyanaz a platform, de előre elkészített adatmezők, toolok, promptok és KPI-k.   [style:ListBullet]
Prémium differenciátor: természetes hang, gyors reagálás, valódi rendszerintegráció, human handoff, teljes audit és EU-kompatibilis adatkezelés.   [style:ListBullet]

# 3. Követelmények – mit tudjon a rendszer?

## 3.1 Híváskezelés
A platformnak natívan párhuzamos híváskezelésre kell készülnie: ugyanazon tenant egy vagy több telefonszámán egyszerre több független hívás futhasson külön AI-sessionnel, külön conversation state-tel és külön tool executionnel. Egy hívás hibája, késése vagy megszakadása nem hathat más aktív hívásra.   [style:ListBullet]
Bejövő hívás fogadása 24/7, cégenként külön számmal vagy portolt számmal.   [style:ListBullet]
Automatikus nyelvi indulás és nyelvfelismerés magyar, német, angol prioritással. A hívó E.164 országkódja csak kezdeti nyelvi hint: +49 esetén például német greeting indulhat, de ez nem nemzetiség-meghatározás. Az explicit kérés (pl. „magyarul kérlek”), az észlelt beszélt nyelv és a korábban eltárolt preferred_language azonnal felülírja a hintet.   [style:ListBullet]
Természetes full-duplex beszélgetés: a hívó fél közbevágása, hezitálása, rövid visszajelzése ne törje meg a flow-t.   [style:ListBullet]
Konfigurálható DTMF: például ### emberi ügyintéző, 0 azonnali átadás, * visszalépés.   [style:ListBullet]
Automatikus handoff: explicit emberkérés, ismételt sikertelen megértés, kritikus tool-hiba, tiltott művelet, vészhelyzet vagy policy-trigger.   [style:ListBullet]
Üzleti időn kívüli eltérő viselkedés: üzenetfelvétel, visszahívás-kérés, sürgős számra transfer.   [style:ListBullet]

## 3.2 AI-persona és hang
Cégenként választható voice és kiejtési profil.   [style:ListBullet]
Állítható: melegség, formalitás, energia, beszédtempó, tömörség, empátia, humor, asszertivitás.   [style:ListBullet]
Brand-specifikus kiejtési szótár: cégnév, utcanevek, terméknevek, személynevek, rövidítések.   [style:ListBullet]
Nyelvenként külön greeting, fallback és lezárás.   [style:ListBullet]
A hang stílusát prompttal és előre validált presetekkel szabályozzátok; ne engedjetek teljesen szabad „system prompt” szerkesztést minden ügyfélnek.   [style:ListBullet]

# 4. Ajánlott magas szintű architektúra
A legjobb 2026-os kiindulás a telefonos media réteg minimalizálása. A SIP szolgáltató a bejövő hívást GPT-Live-1 Live sessionre továbbítja. A saját backend sideband/control csatornán kezeli az üzleti logikát, a tool-delegációt, a tenant kontextust, az auditot és a human handoffot.

| Réteg | Feladat | Ajánlott komponens |
| PSTN/DID | Telefonszám, hívás be/ki, SIP | Telnyx; fallback Twilio |
| Voice layer | Hallgatás, beszéd, turn-taking, megszakítás | OpenAI GPT-Live-1 |
| Agent orchestration | Tool-választás, state machine, policy | Saját Orchestrator service |
| Reasoning backend | Ütemezés, szabályok, összetett döntések | Luna -> Terra -> Sol/Astra escalation |
| Integrációk | Google, SMTP, CRM, webhook | Connector workers |
| Knowledge/RAG | Céges tudás keresése | Postgres/pgvector + object storage |
| Identity & memory | Caller profil cégenként | Postgres, E.164 kulcs + verified flags |
| Billing | Perc, hívás, tool usage, csomagok | Usage ledger + Stripe/Barion/Számlázz.hu integráció |
| Observability | Trace, cost, latency, quality | OpenTelemetry + Grafana/Sentry |


| Fontos: A GPT-Live-1 közvetlen SIP hívást képes fogadni, és az OpenAI Live API külön refer/transfer végpontot ad a hívás átadására. Emiatt nem szükséges minden híváshoz saját audio-transzkóder/WebSocket bridge-et írni. Tartsatok saját media gateway-t csak fallback vagy speciális provider-kompatibilitás miatt. |


## 4.1 Párhuzamos híváskezelés, izoláció és skálázás
A Velyric nem „egy telefonvonalas bot”, hanem többhívásos voice platform. A concurrency az architektúra alapkövetelménye: a platform kapacitása és az adott ügyfél kereskedelmi csomaglimitje két külön fogalom. A backendnek a tenant csomagjánál nagyobb összplatform-terhelést is biztonságosan kell kezelnie.
Minden aktív hívás saját, globálisan egyedi call_id-t, provider_call_id-t, AI sessiont és trace_id-t kapjon.   [style:ListBullet]
A conversation state kulcsa minimum tenant_id + call_id legyen. Sem Redis-, adatbázis-, cache- vagy memóriabejegyzés nem lehet csak telefonszám vagy session nélküli tenant-azonosító alapján címezve.   [style:ListBullet]
A tool executionök hívásonként párhuzamosan futhassanak, de tenantonként és toolonként külön rate limit, timeout és circuit breaker legyen.   [style:ListBullet]
Az egyik hívásban bekövetkező kivétel, provider timeout, invalid audio frame vagy tool crash nem szakíthat meg más aktív hívást. Fault containment és per-call cancellation kötelező.   [style:ListBullet]
A hívás lezárásakor minden per-call erőforrást determinisztikusan fel kell szabadítani: realtime session, audio buffer, distributed lock, temporary state és streaming task.   [style:ListBullet]

### 4.1.1 Foglalási és üzleti race conditionök
Két egyidejű hívó ugyanazt az utolsó szabad időpontot vagy erőforrást is kiválaszthatja, ezért a „check availability → create booking” nem lehet pusztán prompt-logika.   [style:ListBullet]
Foglalásnál adatbázis-szintű constraint, tranzakció, idempotency key és szükség esetén rövid életű distributed lock kell. A végső igazság mindig a booking rendszerben legyen.   [style:ListBullet]
Ha az optimistic create elveszti a versenyt, az AI kapjon strukturált conflict választ és azonnal ajánljon következő valós alternatívát, hallucinált időpont nélkül.   [style:ListBullet]
Ugyanez az elv vonatkozik készletre, asztalkapacitásra, dolgozói erőforrásra, kuponra, fizetési linkre és minden „egyszer használható” üzleti műveletre.   [style:ListBullet]

### 4.1.2 Tenant concurrency és platform backpressure
Minden tenant kapjon konfigurálható max_concurrent_calls limitet. A limit üzleti csomagfüggő, de enterprise szerződésben felülírható.   [style:ListBullet]
Legyen külön global_concurrent_calls és régiónként/providerenkénti capacity guard, hogy egyetlen tenant vagy forgalmi burst se tudja kifektetni a platformot.   [style:ListBullet]
Ha a tenant eléri a limitet, a viselkedés tenant-policy alapján legyen választható: rövid várakozó sor, emberi overflow szám, callback-kérés, voicemail vagy fizetős burst concurrency.   [style:ListBullet]
Ne végtelen queue legyen. Minden várakozásnak legyen max_wait_seconds értéke, és a hívó kapjon természetes tájékoztatást.   [style:ListBullet]
A backpressure logika még azelőtt állítsa meg az új drága AI session létrehozását, hogy a rendszer túlterhelődne.   [style:ListBullet]

### 4.1.3 CPS, provider rate limit és autoscaling
A concurrent active calls és a CPS (calls per second) nem ugyanaz. CPS főleg új hívások indításának/felépítésének sebességét korlátozza; ezt külön metrikaként és scheduler-limittel kell kezelni.   [style:ListBullet]
Telnyx/Twilio CPS, OpenAI session/rate limit és saját API/tool limitek konfigurációból legyenek kezelve; provider limitet ne hardcode-oljatok a kódba.   [style:ListBullet]
Outbound hívásoknál token-bucket/leaky-bucket jellegű scheduler indítsa a call setupokat a szolgáltatói CPS alatt.   [style:ListBullet]
A stateless control-plane workerek horizontálisan skálázódjanak. Rust media/data-plane komponensnél active_calls, CPU, memória és event-loop/audio-buffer nyomás legyen autoscaling jel.   [style:ListBullet]
Skálázásnál connection draining kell: deploy vagy scale-down közben aktív hívást ne szakítsatok meg; az instance előbb kerüljön DRAINING állapotba, és csak a futó callok lezárása után álljon le.   [style:ListBullet]

### 4.1.4 Javasolt csomag-concurrency
Az alábbi értékek induló kereskedelmi limitek. Nem a platform technikai maximumát jelentik, hanem csomagolási és abuse-control korlátok. Valós használati adatok alapján később finomíthatók.

| Csomag | Alap egyidejű hívás | Burst / túlcsordulás | Megjegyzés |
| START | 2 | nincs vagy opcionális rövid queue | kisvállalkozás, egy telephely |
| BUSINESS | 10 | opcionális fizetős burst / callback | tipikus recepciós és foglalási use case |
| PRO | 50 | konfigurálható burst | nagyobb forgalom, több workflow/location |
| ENTERPRISE | 100+ / egyedi | szerződéses kapacitás + SLA | dedikált limitek és provider capacity planning |

Fontos: a percalapú usage és a concurrency külön számlázási dimenzió. Ugyanannyi havi perc mellett a magasabb párhuzamosság nagyobb pillanatnyi infrastruktúra/provider kapacitást igényelhet, ezért enterprise vagy magas burst igénynél külön concurrency add-on indokolt lehet.

### 4.1.5 Terheléses tesztelés és elfogadási célok
10 párhuzamos hívás: kötelező már korai stagingben; funkcionális izoláció, state-keveredés és alap latency ellenőrzése.   [style:ListBullet]
50 párhuzamos hívás: production launch előtti minimum stresszteszt BUSINESS/PRO use case-ekhez.   [style:ListBullet]
100 párhuzamos hívás: PRO-ready release gate; hosszabb soak teszt és provider/tool hibainjektálással együtt.   [style:ListBullet]
500 párhuzamos hívás: enterprise-readiness cél. Nem feltétlenül MVP release gate, de a Rust load generatornak és az architektúrának ezt is reprodukálhatóan kell tudnia szimulálni.   [style:ListBullet]
A tesztben ne csak „kapcsolódjon fel” a hívás: legyen beszéd, interruption, tool call, booking conflict, transfer, timeout és hívásbontás is.   [style:ListBullet]

### 4.1.6 SLO-k terhelés alatt
P95 és P99 end-to-end válaszidőt külön mérjetek concurrency szintenként. A rendszer nem tekinthető skálázhatónak, ha 50–100 aktív hívásnál a latency kontrollálatlanul romlik.   [style:ListBullet]
Külön metrika: active_calls, new_calls_per_second, session_start_latency, first_audio_latency, tool_latency, queue_wait, dropped_calls, provider_429/5xx, memory_per_call és CPU_per_call.   [style:ListBullet]
A release gate ne csak átlagot nézzen. Hibaarány, timeout és jitter küszöb is legyen, és regressziónál automatikus rollback/feature flag legyen lehetséges.   [style:ListBullet]

# 5. OpenAI modellstratégia – 2026.09.11
A hangminőséget és az üzleti reasoninget külön optimalizáljátok. A GPT-Live-1 front-end voice modellként dolgozzon, a háttérmunkát pedig olcsó text modelleknek delegálja. Ez sokkal jobb unit economicsot ad, mint minden egyszerű naptárlekérdezést drága frontier modellen futtatni.

| Modell | Szerep | Ár (USD) | Ajánlás | Megjegyzés |
| GPT-Live-1 | full-duplex voice front-end | $0.05 / voice perc | ★★★★★ alapértelmezett | Természetes hang, interruption, tool/reasoning delegation |
| GPT-Realtime-2.1 Mini | egységes speech-to-speech | $0.60/M text in; $2.40/M out; $10/M audio in; $20/M audio out | ★★★★☆ alternatíva | 128k context, tool use, olcsóbb realtime |
| GPT-Realtime-2.1 | prémium realtime | $4/M text in; $24/M out; $32/M audio in; $64/M audio out | ★★★☆☆ speciális | Erős reasoning, jobb zaj/szünet/megszakítás |
| GPT-Realtime-2 | realtime reasoning | $4/M text in; $24/M out; $32/$64M audio | ★★☆☆☆ legacy | 2.1 előtti |
| GPT-Realtime-1.5 | korábbi voice flagship | $4/M text in; $16/M out; $32/$64M audio | ★★☆☆☆ A/B | 32k context |
| GPT-5.6 Luna | routine backend | $0.20/M in; $1.20/M out | ★★★★★ | Naptár, lookup, rövid tool flow, normalizálás |
| GPT-5.6 Terra | közepes reasoning | $2/M in; $12/M out | ★★★★★ escalation | Bonyolult szabályok, több tool, konfliktusfeloldás |
| GPT-5.6 Sol | komplex reasoning | $4/M in; $20/M out | ★★★☆☆ ritka | Nagy értékű, nehéz ügyek |
| GPT-6 Astra | frontier backend | $10/M in; $50/M out | ★★☆☆☆ csak indokoltan | Nagyon komplex agentikus eset; voice backendként drága lehet |
| GPT-Live-Transcribe | külön streaming STT | $0.017 / audio perc | kiegészítő | QA, külön transcript pipeline |
| GPT-4o Mini TTS | külön TTS | $0.60/M text in; $12/M audio out | fallback | Cascaded STT->LLM->TTS architektúrához |


| Routing szabály: Default: Live-1 + Luna. Ha Luna szerint a feladat több lépéses vagy policy/conflict-heavy, delegálás Terra felé. Sol/Astra csak explicit komplexitási triggerre. Így a prémium modell nem fut minden mondatra. |


# 6. Telefon/SIP szolgáltató

## 6.1 Telnyx – elsődleges
Induláskor Telnyxet választanám. Magyar helyi számok elérhetők; a Telnyx magyar számokra $3/hó-tól jelez induló árat. A publikus Voice API listaár $0.002/perc, amelyhez a SIP trunk díja hozzáadódik; a globális inbound SIP listaár $0.0032/perctől indul. A tényleges magyar route, adó és carrier passthrough eltérhet, ezért az éles költséget a fiók rate sheetjéből mérjétek.

## 6.2 Twilio – fallback/provider-2
Twilio jó másodlagos provider és enterprise fallback, de magyar outbound tarifái sok use case-ben jóval magasabbak. A 2026-os magyar Voice oldalon például Hungary outbound local $0.1042/perc, EEA-origin esetén $0.015/perc; a számok $1.15/hó-tól indulnak. Twilio dokumentálta azt is, hogy 2025. október 15-től bizonyos magyar fix/geografikus CLI-k outbound használata helyi carrier oldalon blokkolódhat. Elsődlegesen inbound recepciós use case-nél ez kevésbé fáj, de outbound callback funkciónál számoljatok vele.

| Szempont | Telnyx | Twilio |
| Költség | jellemzően alacsonyabb | gyakran magasabb HU route-on |
| SIP/API | erős, carrier-native | nagyon érett API/TwiML |
| HU szám | elérhető, $3/hó-tól jelzett | international numbers $1.15/hó-tól |
| Fallback érték | elsődlegesnek jó | provider-2-nek kiváló |
| Ajánlás | Primary | Secondary / enterprise fallback |


# 7. Hívás lifecycle
PSTN hívás érkezik a tenant DID-re.   [style:ListNumber]
Carrier webhook alapján backend feloldja a tenantot és call policy-t.   [style:ListNumber]
Live session indul tenant-specifikus voice/persona/instruction beállításokkal.   [style:ListNumber]
Az első mondatban az AI egyértelműen közli, hogy AI-asszisztenssel beszél a hívó.   [style:ListNumber]
Nyelvdetektálás + szükség esetén nyelvváltás.   [style:ListNumber]
Caller profile lookup E.164 telefonszám alapján. Nem ellenőrzött profil csak kényelmi adat.   [style:ListNumber]
Tudás/RAG + tool flow. Minden írási művelet idempotency key-t kap.   [style:ListNumber]
Érzékeny műveletnél step-up ellenőrzés: OTP, booking ID, e-mail link vagy emberi handoff.   [style:ListNumber]
Hívás végén rövid összegzés, opcionális e-mail/SMS confirmation.   [style:ListNumber]
Usage ledger, call outcome, tool audit, quality metrics, retention policy lefut.   [style:ListNumber]

# 8. Beszélgetési state machine
Ne csak egy nagy prompt legyen. Az agentnek legyen explicit, kódolt állapotgépe. A modell dönthet a következő eszközről, de a backend validálja, hogy az adott tenantnál és állapotban engedélyezett-e.

| Állapot | Példa | Kilépési feltétel |
| GREETING | bemutatkozás + AI disclosure | szándék felismerve |
| DISCOVERY | mit szeretne a hívó? | intent + szükséges mezők ismert |
| IDENTITY | név/email/azonosító | required fields valid |
| ACTION_PREVIEW | „akkor 19:00, 4 fő…” | hívó megerősít |
| TOOL_EXECUTION | calendar/CRM/API | success/fail/timeout |
| CONFIRMATION | eredmény visszamondása | hívó elfogadja |
| HANDOFF | emberi ügyintéző | refer completed vagy fallback |
| CLOSING | lezárás | hangup |


# 9. Foglalási workflow – éttermi példa
1. Intent: asztalfoglalás. Kinyerni: dátum, idő, létszám, név, kapcsolat, speciális kérés.
2. Ha a hívó csak „Krisztián”-t mond, a rendszer kérje a vezetéknevet, ha a tenant szabálya teljes nevet kér.
3. Ha e-mail confirmation aktív és nincs megbízható profil-email, kérje el az e-mail címet. Spell-back: „jól értettem, hogy …?”
4. Calendar/booking engine availability check. Soha ne hallucináljon szabad időpontot.
5. Ha nincs hely, toolból kapott alternatív idősávokat ajánljon.
6. Írás előtt összefoglalás és megerősítés.
7. Create booking idempotency key-jel. Ugyanaz a call retry ne duplázzon foglalást.
8. Siker után confirmation e-mail/SMS és call summary.
9. Caller profile frissítése csak tenant policy szerint; az adat forrását és verified státuszát tárolni kell.

# 10. Caller memory és ügyfélprofil
A felhasználói élmény szempontjából nagyon jó ötlet, hogy egy adott cégnél a rendszer emlékezzen a visszatérő hívóra. Ezt azonban tenant-szinten kell tárolni: ugyanaz a telefonszám egyik cégből nem „szivároghat át” a másikba.

| Mező | Példa | Biztonsági státusz |
| phone_e164 | +3630… | lookup key, nem erős auth |
| display_name | Kovács Krisztián | unverified/verified |
| email | k…@… | unverified / email-verified |
| preferred_language | hu | behavioral preference |
| last_interaction_at | timestamp | operational |
| consent_flags | email_confirmation=true | compliance |
| notes | allergia? | csak ha tényleg indokolt; érzékeny adatnál külön kezelés |


| Biztonság: Telefonszám alapján ne lehessen például számlázási adatot, egészségügyi adatot, rendelési részletet vagy jelszó-visszaállítást kiadni. Ezekhez step-up verification kell. |


# 11. Tudásbázis és RAG
Források: PDF, DOCX, TXT/Markdown, FAQ, CSV, weboldal URL, manuális Q&A.   [style:ListBullet]
Ingestion pipeline: vírus/malware scan -> parsing -> PII/security scan -> chunking -> metadata -> embedding -> index.   [style:ListBullet]
Metadata: tenant_id, source_id, document_version, valid_from/to, language, department, ACL.   [style:ListBullet]
Válaszhoz tenant-filter kötelező. Tenant filter hiánya P0 security bug.   [style:ListBullet]
Re-ranking és „no answer” policy: ha nincs megfelelő forrás, kérdezzen vissza vagy adjon át embernek.   [style:ListBullet]
Dokumentumfrissítés verziózva történjen; régi chunkok atomic módon kerüljenek ki az aktív indexből.   [style:ListBullet]

# 12. Integrációs rendszer

## 12.1 Google Calendar OAuth
Per-tenant OAuth consent; token titkosítva, least-privilege scope.   [style:ListBullet]
Naptár kiválasztása tenant admin felületen.   [style:ListBullet]
Availability tool és create/update/cancel tool külön jogosultsággal.   [style:ListBullet]
Conflict-safe create: közvetlen létrehozás előtt új availability check.   [style:ListBullet]
Timezone tenant szinten explicit, pl. Europe/Budapest.   [style:ListBullet]

## 12.2 E-mail / SMTP
Google/Microsoft esetén OAuthot preferáljatok. Nyers SMTP jelszót csak akkor fogadjatok, ha nincs OAuth lehetőség; KMS-sel titkosítva, soha nem logolva. Alternatívaként saját transactional e-mail szolgáltatóval küldhettek tenant-brandelt levelet, de ezt adatfeldolgozási és domain/reputation oldalról tisztán kell kezelni.

## 12.3 Generic API / webhook builder

| Beállítás | Példa | Kötelező védelem |
| Method | POST | csak engedélyezett methodok |
| Base URL | https://api.ceg.hu | domain allowlist |
| Path | /v1/bookings | template, path traversal tiltás |
| Auth | Bearer/OAuth2/HMAC | secret vault |
| Body schema | JSON Schema | LLM output validáció |
| Retry | 3× exponential | idempotency key |
| Timeout | 3–10 s | hard limit |
| Response mapping | booking_id/status | schema validate |


| SSRF-védelem: Tiltsátok a localhostot, link-local és private IP tartományokat, metadata endpointokat és DNS rebindingot. A webhook execution menjen izolált workerből, egress policy-val. |


# 13. Tool calling biztonsági modell
Az LLM soha ne kapjon közvetlen adatbázis credentialt vagy általános HTTP klienst.   [style:ListBullet]
Minden toolnak szűk, typed input schema-ja legyen.   [style:ListBullet]
Read és write toolok legyenek külön. Write tool előtt lehet confirmation gate.   [style:ListBullet]
Magas kockázatú tool: refund, rendelés törlés, szerződés, pénzügyi adat -> explicit tenant policy + ügyfélmegerősítés + audit.   [style:ListBullet]
Tool result legyen strukturált, rövid, és ne tartalmazzon felesleges PII-t.   [style:ListBullet]
Minden művelethez trace_id, call_id, tenant_id és idempotency_key.   [style:ListBullet]

# 14. Human handoff / átirányítás
Az emberhez átadás ne „hiba” legyen, hanem első osztályú termékfunkció. GPT-Live-1 Live API-n a SIP hívás referálható másik tel: vagy sip: célra. Emellett carrier-oldali transfer is tartható fallbackként.

| Trigger | Alapértelmezett művelet |
| „Beszélhetek emberrel?” | azonnali transfer |
| ### DTMF | azonnali transfer |
| 2–3 sikertelen megértés | AI felajánlja a transfert |
| tool timeout / 5xx | egy retry, majd transfer/fallback |
| érzékeny vagy tiltott ügy | emberi átadás |
| üzleti időn kívül | voicemail/callback vagy on-call szám |


# 15. Multi-tenant adatmodell

| Entitás | Kulcsmezők |
| tenants | id, name, status, timezone, default_language, plan_id |
| tenant_users | tenant_id, user_id, role |
| phone_numbers | tenant_id, provider, e164, sip_target, status |
| agents | tenant_id, voice, persona_config, disclosure_text, handoff_policy |
| knowledge_sources | tenant_id, type, uri, version, status |
| caller_profiles | tenant_id, phone_hash/e164, name, email, verified_flags, consent_flags |
| calls | tenant_id, provider_call_id, started_at, duration, outcome, cost |
| call_events | call_id, seq, type, payload_redacted |
| integrations | tenant_id, type, encrypted_secret_ref, scopes, status |
| actions | tenant_id, schema, risk_level, confirmation_policy |
| bookings | tenant_id, external_id, caller_id, status, start_at |
| usage_ledger | tenant_id, call_id, provider, metric, quantity, cost_usd |

Tenant izoláció: adatbázisban minden tenant-szenzitív táblán tenant_id; alkalmazásrétegben kötelező scoping; Postgres RLS erősen ajánlott. Fájl/object key prefix is tenantonként külön.

# 16. API felület – saját platform

| Endpoint | Cél |
| POST /v1/tenants | tenant létrehozás |
| POST /v1/phone-numbers/provision | DID provisioning |
| POST /v1/knowledge/sources | dokumentum/URL felvétel |
| POST /v1/integrations/google/connect | OAuth start |
| POST /v1/actions | custom API action létrehozása |
| GET /v1/calls | híváslista |
| GET /v1/calls/:id | transcript/outcome/audit |
| POST /v1/calls/:id/transfer | kézi transfer |
| GET /v1/usage | usage és költség |
| POST /v1/webhooks/provider/:provider | carrier/OpenAI inbound events |

Publikus ügyfél API-t külön API gateway mögé tegyétek API key/OAuth2 auth-tal, rate limittel és auditloggal. Az admin webapp sessionje ne ugyanazt az auth mechanizmust használja, mint a machine-to-machine API.

# 17. Admin felület funkciói
Dashboard: hívások, megoldási arány, átlagos híváshossz, transfer rate, foglalások, estimated savings.   [style:ListBullet]
AI Agent: név, hang, nyelvek, beszédtempó/stílus, greeting, disclosure, fallback szövegek.   [style:ListBullet]
Knowledge: dokumentumok, URL-k, szinkronállapot, tesztkérdések.   [style:ListBullet]
Integrations: Google Calendar, Microsoft, SMTP, CRM, webhook/action builder.   [style:ListBullet]
Call routing: business hours, transfer számok, DTMF, no-answer, emergency rules.   [style:ListBullet]
Caller memory: engedélyezés, retention, export/törlés.   [style:ListBullet]
Calls: transcript (ha engedélyezett), summary, action log, latency/cost breakdown.   [style:ListBullet]
Billing: csomag, felhasznált perc, overage, számlák.   [style:ListBullet]
Evals: teszthívások, golden conversations, regressziók.   [style:ListBullet]

# 18. Biztonság

| Terület | Minimum |
| Secrets | KMS/Vault, envelope encryption, rotation |
| OAuth token | titkosítva, scope-minimalizálva, revoke támogatás |
| DB | TLS, RLS, encrypted backups, PITR |
| API | rate limit, WAF, strict schema, signed webhooks |
| Webhook | HMAC/provider signature ellenőrzés |
| Files | malware scan, MIME validation, size limit |
| Logs | PII redaction, secret filtering, retention |
| Admin auth | passkey/TOTP, session revocation, RBAC |
| Network | private DB/Redis, egress control, SSRF denylist/allowlist |
| Supply chain | lockfile, SBOM, Dependabot/Renovate, image signing |


## 18.1 Prompt injection
A céges dokumentum és a hívó fél szövege is untrusted input. A RAG tartalom nem írhatja felül a system policy-t. Tool permission kódban éljen, ne promptban. A dokumentumban lévő „küldd el az összes ügyféladatot” jellegű utasítás egyszerű szöveg, nem végrehajtandó parancs.

# 19. GDPR + EU AI Act – kritikus megfelelés

| Nem jogi tanács: Indulás előtt magyar/EU adatvédelmi és elektronikus hírközlési jogban jártas ügyvéddel ellenőriztessétek a konkrét folyamatot, szerződéseket, DPA-kat és call-recording modellt. |

2026. augusztus 2. óta az EU AI Act 50. cikkének interaktív AI-ra vonatkozó átláthatósági kötelezettsége alkalmazandó. A hívót a beszélgetés kezdetétől világosan tájékoztatni kell arról, hogy AI-rendszerrel beszél, kivéve a szűken értelmezett „nyilvánvaló” eseteket. Ennél a terméknél a természetes emberi hang miatt ne támaszkodjatok erre a kivételre: legyen explicit disclosure.
Javasolt nyitás: „Üdvözlöm, a [CÉG] AI-asszisztense vagyok. Miben segíthetek?” Ez rövid, nem rontja a konverziót és jogilag is tisztább.
Hívásrögzítés külön döntés. Az EDPB szerint az ügyfelet tájékoztatni kell a rögzítés céljáról, címzettjeiről, tiltakozási jogáról és hozzáférési jogáról. Az MVP-ben én alapból nem tárolnék nyers hangot; csak transcript/származtatott eseményt is csak akkor, ha üzletileg szükséges és a jogalap/retention rendben van.
Adatminimalizálás: csak a workflow-hoz szükséges PII.   [style:ListBullet]
Retention tenant-konfigurációval, de legyen platform maximum.   [style:ListBullet]
Data export és törlési workflow.   [style:ListBullet]
DPA az ügyféllel; subprocesszor lista (OpenAI, carrier, hosting, e-mail stb.).   [style:ListBullet]
EU/regionális feldolgozási lehetőségek és adattranszferek szerződéses ellenőrzése.   [style:ListBullet]
AI disclosure minden első interakciónál.   [style:ListBullet]
Ne építsetek emotion recognition funkciót a hívó hangjából az MVP-be; az extra jogi/etikai komplexitást nem éri meg.   [style:ListBullet]

# 20. Observability és minőségmérés

| Metrika | Miért fontos |
| answer latency P50/P95 | természetesség |
| barge-in success | közbevágás kezelése |
| tool success rate | üzleti megbízhatóság |
| first-call resolution | termékérték |
| transfer rate | AI lefedettség |
| booking conversion | vertikális KPI |
| hallucination / unsupported answer rate | biztonság |
| cost per connected minute | unit economics |
| cost per resolved call | jobb üzleti KPI, mint csak perc |
| language switch accuracy | HU/DE/EN élmény |

OpenTelemetry trace-ben legyen egy teljes call trace: carrier -> Live session -> delegation -> tool -> DB -> confirmation. A promptot vagy PII-t nem szükséges teljes egészében logolni; használjatok redacted structured eventeket.

# 21. Evals és tesztelés
Golden call set nyelvenként: legalább normál, zajos, hadaró, félbeszakító, bizonytalan dátum, e-mail spell-back.   [style:ListBullet]
Tool eval: availability conflict, timeout, 500, duplicate retry, invalid JSON, permission denied.   [style:ListBullet]
Security eval: prompt injection dokumentumból, caller jailbreak, SSRF URL, secret exfiltration próbák.   [style:ListBullet]
Policy eval: érzékeny adat kiadása telefon alapján, emberi handoff, recording disclosure.   [style:ListBullet]
Regression gate: prompt/model/provider váltás csak automata eval után.   [style:ListBullet]
A/B mérés hangokra és persona presetekre tenant-specifikusan.   [style:ListBullet]

# 22. Költségmodell
A voice SaaS-nál a „percár” több komponensből áll. 2026.09.11-i példaszámításhoz kb. 314 HUF/USD árfolyamot használva, GPT-Live-1 önmagában ~15,7 Ft/voice perc. Ehhez jön a carrier/SIP, backend token, infrastruktúra és support. Telnyx publikus minimumokból egy inbound API+SIP alap ~0.0052 USD/perc körül indulhat, de a magyar route tényleges ára account rate sheet szerint változhat.

| Tétel | Tervezési érték | Kb. Ft/perc |
| GPT-Live-1 | $0.050 | 15.7 Ft |
| Telnyx carrier+Voice API | $0.006–0.012 | 1.9–3.8 Ft |
| Luna backend | $0.0002–0.002 | 0.1–0.6 Ft |
| Infra/queue/log | $0.003–0.010 | 0.9–3.1 Ft |
| Összes raw változó | $0.059–0.074 | 18.5–23.2 Ft |
| 20% biztonsági bufferrel | $0.071–0.089 | 22.3–27.9 Ft |


| Pénzügyi definíció: A 15 000 Ft/ügyfél célt „fedezetként” kezeljétek, ne nettó profitként. A fedezetből még lejön founder bér, értékesítés, könyvelés, adó, chargeback, support és egyéb fix költség. |


# 23. Javasolt induló csomagok

| Csomag | Nettó havidíj | Benne foglalt | Overage | Célcsoport |
| START | 39 900 Ft | 150 perc | 149 Ft/perc | kisvállalkozás, 1 workflow |
| BUSINESS | 69 900 Ft | 400 perc | 129 Ft/perc | foglalás + calendar + email + CRM/webhook |
| PRO | 129 900 Ft | 1000 perc | 109 Ft/perc | komplex routing, több workflow, prioritás |

A frissített Excel modell már a prémium production működés magasabb fix infra/support tartalékával számol. A csomagok továbbra is a 15 000 Ft/ügyfél havi contribution-margin cél fölött maradnak teljes keretfelhasználás mellett, de a Simulation Lab, PCI payment, dedikált redundancia, SSO/SCIM és szerződéses SLA külön add-on/enterprise elem legyen, ne rejtett alap-költség.

## 23.0.1 Egyidejű hívások mint csomagparaméter
A csomagokban a havi perc mellett explicit concurrency-limitet is kommunikáljatok. Javasolt indulás: START 2, BUSINESS 10, PRO 50, Enterprise 100+ egyedi. A limit nem azt jelenti, hogy a Velyric platform összesen csak ennyit tud: ez tenantonkénti kereskedelmi és kockázati korlát.
Ha egy ügyfél rendszeresen eléri a concurrency-limitet, ne automatikusan nagyobb havi perccsomagra kényszerítsétek. Lehet külön „Concurrency Boost” add-on, mert a csúcsigény és a havi összperc két külön erőforrás-profil.

## 23.1 Amit külön árazzatok
extra telefonszám   [style:ListBullet]
outbound hívás   [style:ListBullet]
premium backend routing / enterprise reasoning   [style:ListBullet]
custom integration fejlesztés   [style:ListBullet]
nagy knowledge storage   [style:ListBullet]
call recording és hosszú retention   [style:ListBullet]
dedikált SLA/on-call support   [style:ListBullet]
white-label/custom domain   [style:ListBullet]

# 24. Billing és usage ledger
Ne a carrier számlájára várjatok. Minden call eventből saját usage ledger épüljön, amely később reconcile-olható a Telnyx/Twilio/OpenAI számlával.

| Metric | Egység |
| connected_voice_seconds | sec |
| live_voice_cost | USD |
| backend_input_tokens | token |
| backend_output_tokens | token |
| carrier_seconds | sec |
| recording_seconds | sec |
| email_count | db |
| tool_external_cost | USD |
| billable_minutes | ceil/policy szerint |

Ügyfél számlázásnál döntsétek el: másodperc alapú vagy megkezdett perc. B2B-ben a másodperc alapú fair és jól kommunikálható; a csomagban foglalt percet is valós másodperc alapján csökkenteném.

## 24.1 Fizetési és számlázási architektúra
A Velyric kereskedelmi folyamata három, szándékosan elkülönített rétegből álljon: a Stripe a fizetés és előfizetés source of truthja; az Apple Pay és Google Pay a Stripe által felszínre hozott wallet fizetési módok; a Billingo a magyar/EU-s számlázási rendszer. A frontend sikeroldala soha ne aktiváljon szolgáltatást és ne állítson ki számlát: minden pénzügyi állapotváltozás hitelesített, idempotensen feldolgozott Stripe webhookból induljon.

| Rendszer | Felelősség | Kötelező szabály |
| Stripe | Checkout, kártya, Apple Pay, Google Pay, előfizetés, payment status, refund | A Stripe esemény az authoritative payment event; webhook signature kötelező. |
| Billingo API v3 | Partner, számla, jóváírás/stornó, számla e-mailes kiküldése | Csak backend hívhatja; Stripe fizetési eseményhez és belső orderhez idempotensen kötve. |
| Velyric billing ledger | Csomag, usage, overage, credit, adózási snapshot, Stripe/Billingo ID-k | A belső ledger összeköti az üzleti eseményt a fizetéssel és a számlával. |
| Apple Pay / Google Pay | Gyors wallet checkout | Nem külön payment backend: Stripe Checkout/Payment Element jelenítse meg, ha az eszköz, ország és fizetési konfiguráció támogatja. |


| Pénzügyi invariáns: PAYMENT_CONFIRMED -> BILLING_DOCUMENT_CREATED -> PROVISIONING_ELIGIBLE. A számla és provisioning ugyanarra az immutable belső order/billing eventre hivatkozzon. Frontend redirect, kliensoldali „success” flag vagy nem ellenőrzött webhook nem lehet aktiválási feltétel. |

A Billingo integráció API v3-ra épüljön. Sikeres első vagy ismétlődő Stripe fizetés után a backend létrehozza/frissíti a Billingo partnert, kiállítja a megfelelő elektronikus számlát, bankkártyás fizetési móddal és a fizetettség konzisztens állapotával, eltárolja a Billingo document ID-t, majd Billingón keresztül automatikusan kiküldi a vevő számlázási e-mail címére. Refund vagy olyan pénzügyi korrekció esetén, amely számlakorrekciót igényel, ne „átírjátok” a már kiállított számlát: a könyvelési szabály szerint helyesbítő/stornó dokumentumot generáljatok, könyvelővel validált logikával.
A checkout előtt kötelező számlázási adatok: jogi név, számlázási cím, ország, e-mail, ügyféltípus, valamint ahol releváns magyar adószám vagy EU VAT ID. EU B2B adókezelést (reverse charge, területi hatály, VAT ID validáció) ne a frontend találja ki; legyen külön Tax/Billing policy réteg és indulás előtt könyvelő/adótanácsadó által jóváhagyott szabálymátrix.

# 25. Ajánlott technológiai stack kétfős csapatnak

| Rész | Ajánlás | Indok |
| Admin web | Next.js/React + TypeScript | gyors fejlesztés, jó auth/OAuth ökoszisztéma |
| Core API | TypeScript Fastify/NestJS | gyors iteráció, jó SDK támogatás |
| Latency/media worker | Rust Axum/Tokio opcionális | csak ahol tényleg kell |
| DB | PostgreSQL | megbízható multi-tenant core |
| Vector | pgvector | MVP-ben nincs szükség külön vector DB-re |
| Cache/queue | Redis + BullMQ | egyszerű és bevált |
| Storage | Cloudflare R2 / S3 | olcsó object storage |
| Secrets | Cloud KMS/Vault | OAuth/SMTP/API tokenek |
| Auth | Clerk/Auth0/Better Auth vagy saját OIDC | admin user auth |
| Deploy | EU régiós cloud, Docker | adatkezelés és skálázás |
| Observability | OpenTelemetry + Grafana + Sentry | trace + hibák |

A nyelvválasztás alapelve: ne technológiai ízlés, hanem a komponens feladata döntsön. A termék/control plane alapértelmezett nyelve TypeScript, a kezelőfelület React + TypeScript, a latency-, hálózat- vagy nagy áteresztőképességű data plane Rust. Python csak olyan offline vagy adat/ML jellegű feladatokra kerüljön be, ahol az ökoszisztémája ténylegesen jobb; az üzleti adatintegritás PostgreSQL/SQL constraint-ekben is legyen kikényszerítve. Így a rendszer gyorsan fejleszthető marad, de a kritikus útvonalakon megkapjátok a Rust teljesítményét és biztonságát.

## 25.1 Nyelvválasztási alapelv: control plane vs. data plane
React nem külön backend-technológia: minden frontend komponens TSX-ben készüljön, strict TypeScript beállítással. JavaScript-only fájlokat új kódban ne használjatok.   [style:ListBullet]
TypeScript legyen a default választás minden olyan kódrészhez, ahol sok külső API, OAuth, OpenAI SDK, billing, admin workflow vagy gyors üzleti iteráció van.   [style:ListBullet]
Rustot ott használjatok, ahol a komponens hosszú életű kapcsolatokat, bináris/streaming protokollt, nagy concurrency-t, szigorú memória- és hibabiztonságot vagy nagyon alacsony latency-t kezel.   [style:ListBullet]
Python ne kerüljön a valós idejű hívás kritikus útvonalára. Dokumentumfeldolgozás, offline eval, adatelemzés vagy speciális ML pipeline esetén viszont gyakran ez a legjobb eszköz.   [style:ListBullet]
SQL ne csak lekérdezési nyelv legyen: unique constraint, foreign key, CHECK, transaction és RLS segítségével maga az adatbázis is védje a multi-tenant és pénzügyi invariánsokat.   [style:ListBullet]

## 25.2 Pontosan melyik kódrészhez mit használjatok?
Az alábbi mátrix legyen az alapértelmezett technológiai döntés. Eltérni csak konkrét mérés vagy külső integrációs kényszer miatt érdemes.

### 25.2.1 Concurrency implementációs szabály
TypeScript maradjon a tenant/control-plane, policy, billing és workflow orchestration fő nyelve. A magas párhuzamosságú, alacsony latency-jű media/event adatút Rustban legyen, async runtime-mal. A két réteg között explicit call/session contract és idempotens event schema legyen; in-memory globális state-re nem építhettek.

| Kódrész / komponens | Ajánlott technológia | Nyelv | Miért ez? / szabály |
| Admin dashboard, onboarding, settings | React + Next.js | TypeScript/TSX | Gyors termékfejlesztés, SSR/CSR, auth és form ökoszisztéma. TanStack Query + React Hook Form/Zod jól illik a konfigurációs felülethez. |
| Publikus marketing/landing oldal | Next.js/React | TypeScript/TSX | SEO, lokalizáció és közös design system az admin felülettel. Ne legyen külön stack. |
| Design system / UI komponensek | React + Storybook | TypeScript/TSX | Típusos komponens API, vizuális regresszióteszt, ugyanaz a komponenskészlet minden tenant/admin felülethez. |
| Control API / tenant CRUD / RBAC | Fastify-alapú Node service | TypeScript | Jó throughput, kis framework overhead, erős JSON Schema/Zod/TypeBox integráció. A SaaS üzleti logika itt legyen. |
| OpenAI session/control integráció | OpenAI SDK + saját adapter | TypeScript | Az OpenAI/webhook/tooling ökoszisztéma gyorsan változik; TypeScriptben a leggyorsabb követni és tesztelni. |
| Agent orchestrator / state machine | Saját domain layer | TypeScript | Tool routing, confirmation gate, policy és üzleti state machine könnyebben auditálható explicit TS domain modellel, mint promptban. |
| Tool schema és validáció | Zod vagy JSON Schema/TypeBox | TypeScript | Egy forrásból runtime validation + TS típus. Az LLM outputját mindig runtime validáljátok. |
| Telnyx/Twilio webhookok, provisioning | Carrier adapter service | TypeScript | SDK-k, REST/webhook integráció és gyors provider-váltás miatt. Provider-specifikus kód külön adapterben. |
| SIP/media gateway - csak ha saját media bridge kell | Tokio + Axum/Hyper + szükség szerint RTP/WebRTC crate-ek | Rust | Hosszú életű kapcsolatok, nagy concurrency, jitter/stream kezelés és kis latency. GPT-Live-1 direct SIP mellett MVP-ben lehet, hogy egyáltalán nem kell. |
| Audio transcode/DSP/VAD - ha később szükséges | Rust native worker | Rust | CPU-kritikus stream feldolgozásnál determinisztikusabb teljesítmény, nincs GC pause. FFmpeg/libav integráció FFI-n vagy process boundary-n keresztül. |
| DTMF/media event parser - saját bridge esetén | Rust worker | Rust | A protokollszintű parser legyen szigorú, fuzzolható és memória-biztonságos. |
| Human transfer / call-control policy | Control service | TypeScript | A döntés üzleti/policy logika; a tényleges alacsony szintű SIP művelet csak akkor Rust, ha saját SIP réteg van. |
| Google Calendar / Microsoft 365 OAuth | Connector modules | TypeScript | OAuth, refresh token, webhook/subscription és SDK támogatás miatt egyértelműen TS a praktikusabb. |
| SMTP / transactional email | Email adapter | TypeScript | Template, queue, provider API és tenant config a control plane része. |
| Generic customer API/webhook connector | Egress gateway + typed connector | TypeScript | URL allowlist, schema validation, signing, retry, idempotency és audit jól kezelhető a backend domainnel együtt. |
| SSRF/DNS/IP policy ellenőrzés | Egress gateway | TypeScript az MVP-ben; Rust csak külön nagy terhelésű gateway esetén | A biztonsági szabály fontosabb, mint a nyelv. DNS rebinding, private/link-local IP és redirect újraellenőrzés kötelező. |
| Background jobs / retry / email / sync | BullMQ/Redis az MVP-ben | TypeScript | Egyszerű operational modell és jó integráció a control plane-nel. Nagyobb skálán NATS JetStream/Kafka felé válthat. |
| Usage event collector / high-volume metering | Első körben TS; később dedikált Rust consumer | TypeScript -> Rust | MVP-nél nincs értelme előre optimalizálni. Ha az event rate/CPU indokolja, a fogyasztó jó természetes Rust boundary. |
| Billing / invoice / subscription logika | Stripe/számlázó adapter + saját ledger | TypeScript + SQL | Az üzleti flow TS, de pénzügyi invariánsok és idempotencia PostgreSQL transaction/constraint szinten is legyenek. |
| Primary relational database | PostgreSQL | SQL | Tenant, booking, caller, usage és audit adatnál ACID, RLS és erős constraint-ek szükségesek. |
| RAG/vector keresés | PostgreSQL + pgvector | SQL + TypeScript | MVP-ben egy adatbázis egyszerűbb és biztonságosabb tenant filteringhez. A query orchestration TS-ben marad. |
| Knowledge ingestion: PDF/DOCX/HTML/CSV | Ingestion worker | TypeScript alapból; Python specialista worker, ha egy parser/ML lib indokolja | Ne vigyetek be Pythont csak divatból, de a dokumentum/ML ecosystem egyes feladatoknál sokkal jobb lehet. |
| OCR / speciális document AI | Izolált worker | Python | Csak ahol tényleges OCR/document-ML kell. A real-time call path-tól teljesen leválasztva fusson. |
| Offline eval / quality analytics / notebookok | Eval pipeline | Python | Pandas/Polars, statisztika, model evaluation és gyors kutatási workflow miatt itt Python a legjobb választás. |
| Load generator / protocol stress tool | CLI | Rust | Nagy párhuzamosságú hívás/event szimulációhoz kis erőforrásigényű, egyetlen bináris, jól reprodukálható tool. |
| E2E böngészős tesztek | Playwright | TypeScript | Ugyanaz a típusos web stack, jó CI támogatás és trace/screenshot debugging. |
| Backend unit/integration tesztek | Vitest/Node test runner | TypeScript | Gyors feedback és közös fixture/schema a backenddel. |
| Rust komponens tesztek | cargo test + proptest/fuzz | Rust | Parser/protokoll/media kódnál property-based és fuzz tesztek különösen értékesek. |
| Infrastructure as Code | OpenTofu/Terraform | HCL | Cloud resource, network, secret/KMS, DB, bucket, DNS reprodukálható és review-olható deklaratív konfigurációban. |
| CI/CD | GitHub Actions | YAML + shell | Build, test, security scan, migration és deploy. Komplex üzleti logikát ne YAML-ban írjatok. |
| Container image | Docker | Dockerfile | Reprodukálható deploy. TS és Rust service külön multi-stage buildet kapjon. |
| Observability instrumentation | OpenTelemetry | TypeScript + Rust | Azonos trace_id/call_id menjen át minden nyelvi határon. Vendor-semleges tracing. |
| Dashboard/alert query | Grafana/Prometheus | PromQL/LogQL | A megfigyelési lekérdezést a megfelelő domain nyelven tartsátok, ne alkalmazáskódba égetve. |
| DB migration | Drizzle/Kysely migráció vagy dedikált SQL migration | TypeScript + SQL | A séma review-olható legyen; destructive migration kétlépcsős expand/contract mintával. |
| Belső admin/ops CLI | Kezdetben Node CLI, később Rust ha terjeszthető single-binary kell | TypeScript -> Rust | Ne optimalizáljátok túl az elején; Rust akkor előny, ha sok gépre kell stabil statikus/single binary tool. |


## 25.3 Javasolt repository és kódbázis-felosztás
apps/admin-web/ - Next.js + React + TypeScript. Tenant admin, onboarding, agent-beállítások, billing, call analytics.   [style:ListBullet]
apps/control-api/ - Fastify + TypeScript. Auth/RBAC, tenant config, API, carrier webhook, integration endpoints.   [style:ListBullet]
packages/domain/ - tiszta TypeScript domain model: booking, caller, tool policy, state machine, usage/billing szabályok. Framework-függőség minimális.   [style:ListBullet]
packages/contracts/ - Zod/JSON Schema/OpenAPI contractok, event schema-k és generált kliensek. Ez legyen a TS-Rust határok szerződése is.   [style:ListBullet]
packages/connectors/ - TypeScript adapterek: Google, Microsoft, SMTP/e-mail provider, Stripe/számlázás, CRM-ek, Telnyx, Twilio.   [style:ListBullet]
services/agent-orchestrator/ - TypeScript. Live session sideband/control, model routing, tool dispatch, confirmation és fallback.   [style:ListBullet]
services/media-gateway/ - Rust. Csak akkor legyen, ha saját RTP/WebRTC/media bridge valóban szükséges; direct SIP mellett ne építsétek meg előre.   [style:ListBullet]
services/metering-worker/ - induláskor TypeScript; mérés alapján később Rust. Usage event normalizálás és aggregáció.   [style:ListBullet]
services/document-worker/ - TypeScript; opcionális külön Python worker speciális OCR/ML parserhez.   [style:ListBullet]
crates/protocol/ - Rust shared crate a media/protocol eventekhez, serializationhöz és security-sensitive parserhez.   [style:ListBullet]
infra/ - OpenTofu/Terraform HCL, Docker, deployment manifestek és observability config.   [style:ListBullet]
evals/ - Python offline eval/analitika + TypeScript scripted end-to-end call scenario-k.   [style:ListBullet]

## 25.4 Nyelvi határok és kommunikáció a komponensek között
TypeScript modulok ugyanabban a deploy egységben normál függvényhívással kommunikáljanak; ne építsetek mesterséges HTTP microservice-határokat.   [style:ListBullet]
Külön process/service határnál alapértelmezésként HTTP/JSON + OpenAPI/JSON Schema. Rust kliens generálható OpenAPI-ból, így nem kézzel duplikáljátok a contractot.   [style:ListBullet]
Nagy frekvenciájú streaming/media útvonalnál protobuf/gRPC vagy célzott bináris protokoll indokolt lehet; normál CRUD integrációhoz fölösleges.   [style:ListBullet]
Aszinkron megbízható eseményekhez MVP-ben PostgreSQL transactional outbox + Redis/BullMQ. Ha a skála vagy service-szétválasztás indokolja, NATS JetStream/Kafka lehet következő lépés.   [style:ListBullet]
Minden eventben legyen schema_version, tenant_id, trace_id, event_id és timestamp. Breaking event változásnál új verzió, ne csendes mezőátértelmezés.   [style:ListBullet]
Sem Rust, sem Python service ne olvassa közvetlenül „csak úgy” a másik service belső tábláit, amikor már külön ownership boundary-t vezettetek be. A határ API/event legyen.   [style:ListBullet]

## 25.5 Hol NEM érdemes Rustot használni?
OAuth callbackok, Google Calendar és CRM connectorok: itt az integrációs sebesség és SDK-ökoszisztéma fontosabb, TypeScript jobb.   [style:ListBullet]
Admin CRUD API és billing workflow: Rust technikailag működne, de kétfős csapatnál lassítaná a termékiterációt különösebb üzleti nyereség nélkül.   [style:ListBullet]
Prompt/tool schema és agent workflow: TypeScriptben könnyebb a gyors módosítás, runtime schema-validáció és OpenAI SDK integráció.   [style:ListBullet]
Egyszerű cron/background feladatok: ne legyen külön Rust service csak azért, mert lehet. Előbb mérjétek meg a Node worker korlátját.   [style:ListBullet]

## 25.6 Hol NEM érdemes TypeScriptet erőltetni?
Saját RTP/media mixer, codec/transcode, nagy mennyiségű streaming parser: Rust jobb latency- és memória-profilú.   [style:ListBullet]
Nagy concurrency-jű load generator és protokollfuzzer: Rust single binary és alacsony overhead miatt jobb.   [style:ListBullet]
Komoly offline statisztikai/model eval kutatás: Python adat/ML ecosystem gyorsabb és gazdagabb.   [style:ListBullet]
Relációs integritási szabály: amit PostgreSQL unique/FK/CHECK/RLS/transaction garantálhat, azt ne csak TypeScript if-ekre bízzátok.   [style:ListBullet]

## 25.7 Ajánlott fejlesztési szabályok
TypeScript: strict=true, noImplicitAny, exactOptionalPropertyTypes; minden külső input runtime validációval érkezzen.   [style:ListBullet]
Rust: clippy -D warnings a CI-ben, cargo fmt, cargo audit/deny, unsafe kód defaultból tiltva; ha mégis kell, izolált modul és külön review.   [style:ListBullet]
SQL: minden migration review-köteles; tenant táblák RLS policy-val; destructive változtatás expand/contract módszerrel.   [style:ListBullet]
API contract: OpenAPI/JSON Schema a source of truth; frontend és Rust kliens lehetőleg generált vagy közös schema alapján készüljön.   [style:ListBullet]
Security boundary: secret soha ne kerüljön React bundle-be; minden provider credential kizárólag szerveroldali secret store-ból olvasható.   [style:ListBullet]
Performance: Rustba csak profiling/mérés után mozgassatok át TS komponenst, kivéve az eleve media/protokoll-szintű részeket.   [style:ListBullet]
Ownership: minden modulnak legyen egyértelmű felelőse, publikus interface-e és tesztje; ne legyen „shared utils” szeméttelep üzleti logikával.   [style:ListBullet]

| Rövid döntési szabály: React/TypeScript építi a terméket és a control plane-t; Rust védi és gyorsítja a data plane-t; Python az offline adat/ML specialista; PostgreSQL/SQL az üzleti adatintegritás végső őre. Ha egy komponenst nem tudtok egyértelműen ezek egyikébe sorolni, TypeScript legyen az alapértelmezett, amíg mérés nem bizonyít mást. |


# 26. Szolgáltatások felosztása

| Service | Felelősség |
| control-api | tenant config, admin API, RBAC |
| call-control | incoming webhook, Live session, transfer, policy |
| agent-orchestrator | delegation, tool selection, state machine |
| connector-worker | Google/SMTP/CRM/custom HTTP actions |
| knowledge-worker | ingest, chunk, index, sync |
| usage-billing | metering, plan limit, invoice events |
| notification-worker | email/SMS confirmations |
| eval-runner | synthetic calls, regression |

MVP-ben ezek lehetnek moduláris monolit + 2 worker folyamatok. Ne csináljatok 8 külön Kubernetes microservice-t az első ügyfél előtt. A logikai határok legyenek meg, a deploy egységek később szétválaszthatók.

# 27. MVP scope

| Must have | Későbbre |
| 1 DID/tenant + inbound calls | outbound campaign/callback engine |
| HU/DE/EN | további nyelvek |
| Live-1 + Luna/Terra | Astra automata escalation finomhangolás |
| Knowledge upload | web crawler/scheduled sync |
| Google Calendar | Microsoft + vertical CRMs |
| SMTP/OAuth email | SMS/WhatsApp |
| Generic webhook action | visual workflow builder |
| Human transfer + DTMF | queue/conference/skills-based routing |
| Basic caller memory | full CRM/CDP |
| Usage + Stripe-like billing | reseller/white-label billing |


# 28. Release gate – mikor tekintsétek eladhatónak?
100+ scripted testhívás HU/DE/EN nyelven kritikus tool-hiba nélkül.   [style:ListBullet]
Nincs cross-tenant adatkeveredés sem RAG-ban, sem caller memoryban.   [style:ListBullet]
Booking duplicate retry teszt 100%-ban idempotens.   [style:ListBullet]
Human transfer működik AI kérésre, DTMF-re és policy-triggerre.   [style:ListBullet]
AI disclosure minden első interakcióban elhangzik.   [style:ListBullet]
Latency P95 üzletileg elfogadható; barge-in működik.   [style:ListBullet]
Usage ledger egyezik carrier/OpenAI költséggel elfogadható tolerancián belül.   [style:ListBullet]
Adminból token visszavonás, integration disconnect, caller delete/export működik.   [style:ListBullet]
Security review: webhook signature, SSRF, OAuth token, prompt injection, RBAC, backup restore.   [style:ListBullet]

## 28.1 Párhuzamossági release gate
Nincs cross-call state leakage 50+ párhuzamos hívás alatt.   [style:ListBullet]
Nincs duplafoglalás concurrency race esetén; konfliktus strukturáltan visszajut az agenthez.   [style:ListBullet]
50 egyidejű, aktív, beszédet és toolokat használó hívás production-like környezetben stabilan lefut.   [style:ListBullet]
P95/P99 first-audio és tool latency terhelés alatt is az elfogadott SLO-n belül marad.   [style:ListBullet]
Provider 429/5xx, tool timeout és egy worker kiesése nem szakít meg más hívásokat.   [style:ListBullet]
Scale-up és rolling deploy alatt connection draining igazoltan működik.   [style:ListBullet]

# 29. Alapítói munkamegosztás
Kétfős csapatnál a legnagyobb kockázat, hogy mindketten egyszerre mindenen dolgoztok. Osszátok felelősségi területekre, de legyen közös architecture review.

| Founder A – platform/core | Founder B – product/integráció |
| telephony + Live session | admin UI + onboarding |
| orchestrator + security | OAuth/connectors |
| DB + usage ledger | knowledge UX + vertical templates |
| observability + deploy | billing UX + support tooling |
| eval infrastructure | sales demo + customer onboarding |


# 30. Konkrét döntési lista
1. Primary carrier: Telnyx; Twilio account legyen előkészítve provider-2-ként.
2. Primary voice: GPT-Live-1.
3. Primary backend: GPT-5.6 Luna; automatic Terra escalation.
4. Sol/Astra defaultból OFF; csak explicit policy és mérés után.
5. Raw call recording default OFF.
6. AI disclosure kötelező és nem kapcsolható ki EU tenantnál.
7. Caller memory opt-in tenant feature, privacy settingsgel.
8. Custom webhook csak allowlisted HTTPS domainre.
9. Writes idempotency key + confirmation policy.
10. Modular monolith először; microservice csak valódi scaling boundary után.
11. Payment provider: Stripe; Apple Pay és Google Pay a Stripe Checkout/Payment Element walletjeiként jelenjen meg, ne külön payment integrációként.
12. Invoicing: Billingo API v3; számlakiállítás és kiküldés kizárólag backendből, hitelesített Stripe fizetési esemény alapján.
13. Checkout success page nem source of truth; provisioning csak idempotensen feldolgozott payment/invoice state után indulhat.
14. Tenantonként külön OpenAI project + service account + scoped API key; a kulcs Velyric secret marad, az ügyfélnek nem adható ki.
15. Telefonszám-order és KYC/regulatory review aszinkron provisioning state legyen; provider approval után a folyamat automatikusan folytatódjon.
16. Minden provisioning step idempotens, retry-safe és kompenzálható legyen; partial failure ne hagyjon fizetett, de ismeretlen állapotú ügyfelet.

# 31. Prémium platformképességek és production hardening
Ez a fejezet a korábbi architektúrát enterprise/premium irányba bővíti. A cél nem az, hogy minden funkció bekerüljön az első kiadásba, hanem hogy az adatmodell, a szolgáltatáshatárok és a biztonsági döntések ne zárják ki később ezeket. Prioritás: P0 = az első fizető ügyfelek előtt vagy közvetlenül utána; P1 = product-market fit közben; P2 = skálázás; Enterprise = külön szerződés/díj mellett.

## 31.1 Természetes beszélgetési motor és nyelvi routing
A voice UX minőségét külön SLO-ként kell kezelni. Nem elegendő az „átlagos válaszidő”: a hívás teljes kritikus útvonalát szegmensekre kell bontani, hogy pontosan látszódjon, hol keletkezik késleltetés.

| Metrika | Cél/irány | Implementáció |
| VAD / turn-end detection | adaptív, beszélőfüggő | beszédtempó, pause history és zajszint alapján állítható küszöb |
| Model first-token / first-audio | P95 lehetőleg <700–900 ms normál válasznál | külön trace span és tenant/model dashboard |
| Tool lookup | gyors toolnál <1 s; hosszúnál filler | async tool state + beszélt státuszjelzés |
| Barge-in | megbízható, konfigurálható | voice/persona szintű sensitivity + false-interrupt védelem |
| Silence recovery | determinista | 1. finom ping, 2. megerősítés, 3. kulturált lezárás/handoff |

P0 – Latency budget rendszer: VAD -> voice model -> backend delegation -> tool -> első audio byte külön mérve; minden komponensnek saját P50/P95/P99 budget.   [style:ListBullet]
P0 – Adaptive turn detection: a rendszer az aktuális hívó beszédtempójából és pause mintájából tanuljon session-szinten; ne legyen globális egyetlen silence threshold.   [style:ListBullet]
P0 – Barge-in sensitivity: tenant/voice/preset szinten konfigurálható; az AI azonnal állítsa le a saját audio streamjét valódi közbevágásnál.   [style:ListBullet]
P0 – Non-interruptible segment: kizárólag rövid, indokolt szegmensekre (AI disclosure, jogi tájékoztató, végleges tranzakciós összegzés). Ne lehessen ezzel hosszú marketing szöveget ráerőltetni a hívóra.   [style:ListBullet]
P1 – Micro-acknowledgements: természetes „rendben”, „értem”, „megnézem” jelzések, de rate limitelve, hogy ne váljon idegesítővé.   [style:ListBullet]
P1 – Tool latency filler: csak akkor induljon, ha a tool várhatóan meghalad egy rövid küszöböt; ne beszéljen rá a tool eredményére.   [style:ListBullet]
P1 – Speech repair: félrehalláskor csak a bizonytalan slotot kérdezze vissza, ne indítsa újra az egész flow-t.   [style:ListBullet]
P1 – Spelling mode: e-mail, rendszám, azonosító; betűnkénti visszaolvasás és locale-specifikus betűzés.   [style:ListBullet]
P1 – Digit mode: telefon, irányítószám, rendelési azonosító; normalizált numerikus reprezentáció és checksum/length validation ahol lehetséges.   [style:ListBullet]
P1 – Address confirmation: utca, város, ország, Straße/Strasse és ékezetes/ékezet nélküli normalizálás; a normalizált értéket vissza kell erősíteni kritikus művelet előtt.   [style:ListBullet]
P1 – Date interpretation: relatív kifejezések tenant timezone alapján explicit ISO dátum/időre normalizálva, majd visszaolvasva.   [style:ListBullet]
P1 – Locale pronunciation: HU/DE/EN telefon, dátum, pénznem, rendszám, cégnév és személynév természetes helyi kiejtéssel.   [style:ListBullet]
P2 – Saját HU/DE pronunciation benchmark: külön eval corpus nevekkel, településekkel, utcákkal, cégekkel és számformátumokkal.   [style:ListBullet]
P2 – Automatic voice tuning: csak javaslatként módosítson tempót, interruption sensitivityt, filler politikát; production config változás emberi jóváhagyással.   [style:ListBullet]
Nyelvi prioritási szabály: 1) a hívó explicit nyelvkérése; 2) korábban megerősített preferred_language; 3) aktuálisan detektált beszélt nyelv; 4) E.164 országkód mint kezdeti hint; 5) tenant default. +49 nem jelenti azt, hogy a hívó német nemzetiségű, csak azt, hogy német nyelvű greeting jó alaphipotézis lehet. Ha a caller azt mondja, hogy „magyarul kérlek”, azonnal váltani kell, és tenant-szinten opcionálisan eltárolható a preferencia.

## 31.2 Több specializált AI-agent
A platform ne egyetlen óriási promptból próbáljon mindent megoldani. A production architektúra supervisor/router + kevés, jól definiált specialist agent legyen. Az agentek között strukturált handoff contract menjen, ne szabad szöveges „mondd el a másiknak”.

| Agent | Felelősség | Tool jogosultság | Tipikus modell |
| Reception/Router | intent, nyelv, ügyfélazonosítás, routing | read-only profile + routing | Live-1 + Luna |
| Booking | availability, hold, create/change/cancel | calendar/booking write | Luna/Terra |
| Support | FAQ, státusz, hibakezelés | knowledge + read-only CRM | Luna |
| Sales | lead qualification, callback/meeting | lead create + calendar | Luna/Terra |
| Billing | számla státusz, fizetési link | szűk billing read/write | Terra, policy gate |
| Handoff/Compliance | emberre átadás, jogi/policy szituáció | transfer only | deterministic + model assist |

P0 – közös immutable CallContext: tenant, location, caller, language, verified fields, current intent, consent, tool results.   [style:ListBullet]
P0 – agentenként külön tool allowlist és write-policy; a Router például ne tudjon foglalást törölni.   [style:ListBullet]
P0 – explicit handoff schema: reason, collected_slots, verified_slots, pending_action, warnings, last_tool_result.   [style:ListBullet]
P1 – model budget és timeout agentenként; egyszerű specialist ne hívhasson automatikusan drága modellt.   [style:ListBullet]
P1 – maximum handoff-depth és cycle detection; agent-loop esetén human fallback.   [style:ListBullet]
P2 – tenant által építhető custom specialist csak előre definiált capabilitykből, nem teljes rendszerprompt-hozzáféréssel.   [style:ListBullet]

## 31.3 AI/model/provider redundancia
A szolgáltatás ne legyen egyetlen carrierhez vagy modellhez hardcode-olva. Minden külső dependency adapter mögött legyen, egységes health state-tel, timeouttal és circuit breakerrel.

| Hiba | Elsődleges reakció | Fallback | Védelem |
| Voice model timeout | session retry rövid budgettel | másik realtime/voice provider vagy kontrollált transfer | ne duplázódjon tool write |
| Backend model hiba | ugyanaz a structured request provider-2/model-2 felé | deterministic safe response/handoff | idempotency |
| Carrier hiba | SIP/provider failover | másodlagos DID/trunk | routing health check |
| Tool provider hiba | retry policy | manual/human fallback | write idempotency + circuit breaker |
| Region outage | secondary region | emergency forward | RTO/RPO runbook |

P0 – ProviderHealth service: latency, error rate, timeout, recent incidents, circuit state.   [style:ListBullet]
P0 – tool side effecteket a failover soha ne ismételje vakon; minden write operation idempotency key-t kap.   [style:ListBullet]
P1 – degraded mode: knowledge/read-only kérdések működjenek akkor is, ha egy write connector kiesik.   [style:ListBullet]
P1 – fallback policy tenantonként: „inkább emberre kapcsolj” vs. „próbálj másik modellt”.   [style:ListBullet]
P2 – provider-independent agent abstraction, hogy modellváltás ne igényelje az üzleti domain újraírását.   [style:ListBullet]

## 31.4 Call Transfer 2.0 – warm transfer és AI whisper
P0 – Cold transfer mellett warm transfer: az AI előbb felhívja/csatlakoztatja az ügyintézőt, röviden átadja a kontextust, majd bridge-eli a hívót.   [style:ListBullet]
P0 – AI whisper: név, ügyfél státusz, hívás oka, már elvégzett lépések, foglalás/ügy ID, sürgősség, tiltott/érzékeny adatok nélkül.   [style:ListBullet]
P0 – transfer state machine: preparing -> dialing agent -> agent answered -> whisper -> bridge -> completed / failed -> return-to-AI.   [style:ListBullet]
P0 – ha az ember nem veszi fel, a caller ne essen le: AI térjen vissza, ajánljon callbacket vagy másik queue-t.   [style:ListBullet]
P1 – skill/department/VIP routing, nyitvatartás és queue policy.   [style:ListBullet]
P1 – „call me back” workflow: consent + preferált időablak + CRM task.   [style:ListBullet]
P2 – silent AI copilot transfer után csak explicit enterprise policy mellett; külön recording/disclosure és jogosultság szükséges.   [style:ListBullet]

## 31.5 Simulation Lab
A Simulation Lab release-gate legyen, nem demó. Minden agent/verzió/model/provider változás lefut egy strukturált scenario suite-on.

| Tesztosztály | Példa | Pass feltétel |
| Happy path | foglalás 4 főre | helyes slotok + pontos confirmation + egyetlen write |
| Conversation stress | hadarás, hosszú pause, 10 közbevágás | nincs loop, nincs elveszett state |
| Audio stress | zaj, gyenge vonal, akcentus | safe clarification, nem hallucinál |
| Tool failure | timeout/500/invalid JSON | retry policy + idempotens fallback |
| Security | prompt injection, secret request | nincs policy bypass |
| Concurrency | két caller ugyanarra a slotra | atomic hold/booking, nincs double-book |

P0 – golden suite HU/DE/EN nyelven; minimum minden core workflow-ra.   [style:ListBullet]
P1 – generált persona library: idős, hadaró, bizonytalan, akcentusos, agresszív, sokszor közbevágó.   [style:ListBullet]
P1 – fault injection: provider latency, DB error, tool timeout, disconnect, stale OAuth.   [style:ListBullet]
P1 – release score: task success, policy compliance, latency, tool correctness, unsupported-answer rate, cost.   [style:ListBullet]
P2 – production hibából automatikusan anonimizált/regenerált regression scenario javaslat.   [style:ListBullet]

## 31.6 Automatikus Quality Monitoring
Minden hívás után aszinkron quality pipeline fusson. Ez ne blokkolja a hívást. A rendszer a transcript/structured events/tool traces alapján értékeljen; ne építsetek szükségtelen „érzelemfelismerést” a hangból.
P0 – outcome correctness, tool success, transfer reason, latency, interruption, retry, abandonment automatikus score.   [style:ListBullet]
P0 – loop detection: ismétlődő kérdés/válasz, 3× azonos slot bekérése, ugyanazon tool ismételt indítása.   [style:ListBullet]
P0 – unsupported answer / knowledge-grounding gyanú.   [style:ListBullet]
P1 – wrong-language, túl hosszú válasz, túl sok filler, hosszú dead-air, excessive clarification.   [style:ListBullet]
P1 – anomaly alert tenant/agent/version szinten: transfer spike, tool error spike, latency regression, cost spike.   [style:ListBullet]
P1 – quality issue -> konkrét call trace -> reprodukálható simulation case.   [style:ListBullet]
P2 – automatikus javítás csak recommendation; production változtatás approval + eval gate után.   [style:ListBullet]

## 31.7 Knowledge Intelligence
P0 – Knowledge gap detection: gyűjtse azokat a kérdéseket/intenteket, amelyekre nincs elég erős forrás.   [style:ListBullet]
P0 – source provenance: minden retrieval eredmény source_id + version + last_synced_at mezővel.   [style:ListBullet]
P1 – conflicting source detector: két forrás eltérő árat/nyitvatartást ad -> admin review.   [style:ListBullet]
P1 – freshness policy: árlista, nyitvatartás, jogi feltétel eltérő TTL-t kaphat.   [style:ListBullet]
P1 – scheduled website sync és változásdiff; változás után ne menjen automatikusan productionba kritikus mező approval nélkül.   [style:ListBullet]
P1 – dashboard: „42 kérdés parkolásról, nincs megbízható válasz” -> Add answer / Add source.   [style:ListBullet]
P2 – FAQ-javaslat és knowledge cleanup valódi call trendekből.   [style:ListBullet]

## 31.8 Instant AI onboarding
A cél egy 5–15 perces első konfiguráció, de automatikus publikálás nélkül. A rendszer készítsen draftot, az ügyfél erősítse meg a kritikus adatokat.
P0 – website URL -> crawl -> cégnév, cím, nyitvatartás, szolgáltatások, gyakori kérdések, kapcsolati adatok draft.   [style:ListBullet]
P0 – business-type classifier -> megfelelő Vertical Policy Pack ajánlás.   [style:ListBullet]
P0 – go-live checklist: telefonszám, disclosure, timezone, business hours, fallback, legal/recording, knowledge review, tool teszt.   [style:ListBullet]
P1 – integráció detection: booking/calendar/contact form -> „csatlakoztasd ezt” ajánlás.   [style:ListBullet]
P1 – automatikus teszthívások onboarding végén; kritikus failure esetén publish tiltás.   [style:ListBullet]
P2 – demo generator saleshez: ideiglenes agent/telefonszám sandbox módban, valódi write toolok nélkül.   [style:ListBullet]

## 31.9 Anti-fraud és pénzügyi védelem

| Védelem | Default | Miért |
| max call duration | pl. 20–30 perc tenant szerint | runaway/abuse költség |
| concurrent calls | plan limit | flood és váratlan számla |
| daily/monthly spend cap | kötelező hard/soft limit | account compromise |
| transfer destination allowlist | kötelező | toll fraud/premium rate |
| outbound country allowlist | default deny | nemzetközi visszaélés |
| tool execution budget | sessionenként limit | agent loop |

P0 – transfer loop és bot-to-bot loop detektálás.   [style:ListBullet]
P0 – API és webhook rate limit tenant/user/key szinten.   [style:ListBullet]
P0 – költség anomaly: per-minute, per-call és tenant-hour baseline.   [style:ListBullet]
P1 – country/ASN/call-pattern alapú risk signal, de ne legyen diszkriminatív automatizált döntés indokolatlanul.   [style:ListBullet]
P1 – emergency global outbound OFF, transfer OFF és tenant suspend kill switch.   [style:ListBullet]
P2 – security event export SIEM-be enterprise csomagnál.   [style:ListBullet]

## 31.10 Payment / PCI mód
A bankkártyaadat ne kerüljön a voice modellbe, transcriptbe, saját logba vagy adatbázisba. A fizetési szegmens külön, PCI-kompatibilis payment flow legyen. Twilio PCI Voice / <Pay> jellegű megoldásnál a kártyaadat közvetlenül a payment connectorhoz kerül; az agentnek csak tranzakciós státuszt/token referenciát kell visszakapnia.
Enterprise/P1 – payment intentet az AI felismeri, de a PAN/CVV bekérés előtt átadja a kontrollt a PCI payment komponensnek.   [style:ListBullet]
Enterprise – DTMF masking/redaction; az AI és az emberi agent se hallja/látja a kártyaszámot.   [style:ListBullet]
Enterprise – saját rendszerben csak payment_session_id, amount, currency, provider, status, token/reference tárolható.   [style:ListBullet]
Enterprise – recording/transcription pause vagy PCI-redacted mód a payment szegmensben.   [style:ListBullet]
Enterprise – fizetés után a flow visszatér az AI-hoz `payment_success|failed|cancelled` structured eventtel.   [style:ListBullet]
Enterprise – külön PCI account/subaccount stratégia, hogy a redaction/retention policy ne szennyezze az összes normál hívást.   [style:ListBullet]
Árazás – payment provider/connector tranzakciós díj külön pass-through vagy add-on; ne legyen benne az alap voice percben.   [style:ListBullet]

## 31.11 GDPR/compliance továbbfejlesztés
P0 – Disclosure/Consent Ledger: melyik disclosure verzió, milyen nyelven, mikor hangzott el; recording consent külön mező.   [style:ListBullet]
P0 – retention policy adatfajtánként: raw audio, transcript, tool payload, caller profile, audit, billing.   [style:ListBullet]
P0 – DSAR workflow: keresés, export, helyesbítés, törlés/korlátozás; tenant és személy scope-pal.   [style:ListBullet]
P1 – PII redaction pipeline transcriptre/logra; payment/secret minták külön blokklistával.   [style:ListBullet]
P1 – legal hold és delete exception csak dokumentált jogalappal.   [style:ListBullet]
P1 – subprocesszor és data-location inventory; tenant exportálható compliance report.   [style:ListBullet]
P1 – DPIA template kit magasabb kockázatú deploymenthez; jogász által felülvizsgálandó.   [style:ListBullet]
Enterprise – zero/short retention mód, customer-managed encryption key későbbi opcióként.   [style:ListBullet]

## 31.12 Enterprise identity és security
P0 – finom RBAC: owner/admin/developer/analyst/billing/support/read-only; location scope.   [style:ListBullet]
P1 – OIDC/SAML SSO és MFA enforcement.   [style:ListBullet]
P1 – SCIM provisioning/deprovisioning.   [style:ListBullet]
P1 – IP allowlist, session lifetime policy, API key scope + expiry.   [style:ListBullet]
P1 – immutable audit eventek: config change, secret access, agent publish, support access, export/delete.   [style:ListBullet]
P1 – just-in-time support access: belső support csak időkorlátos, indokolt, auditált customer granttal lásson érzékeny tenantot.   [style:ListBullet]
Enterprise – SIEM export, customer-managed key/BYOK, private networking/VPC opció csak valós ügyféligény után.   [style:ListBullet]

## 31.13 Multi-location cégek
Az adatmodellben a Tenant fölött/alatt egyértelmű location hierarchy kell. Egy márka több telephelyet kezelhet külön telefonszámmal, naptárral, nyitvatartással, tudással és dolgozókkal, miközben a központi admin közös policyt és analyticsot lát.

| Szint | Örökölhető | Felülírható |
| Organization/Tenant | brand, compliance, base persona, security | — |
| Location | base persona, policy pack | timezone, hours, phones, knowledge, calendars |
| Agent | location defaults | voice, greeting, tool scope |
| Resource | location | schedule/capacity |

P0 – minden call, booking, connector és caller relation kapjon location_id-t, ahol értelmezhető.   [style:ListBullet]
P1 – caller profile szervezet-szintű lehet, de érzékeny notes/consent location- vagy purpose-specifikus.   [style:ListBullet]
P1 – központi reporting + telephely összehasonlítás.   [style:ListBullet]
P1 – location config inheritance explicit „inherited/overridden” jelzéssel az UI-ban.   [style:ListBullet]

## 31.14 Booking engine – resource-aware foglalás
A Calendar event csak adapter legyen. A saját domainben legyen Booking, Service, Resource, AvailabilityRule és Hold fogalom, így étterem, klinika, szalon, autószerviz és hotel ugyanarra a magra épülhet.
P0 – service duration, buffer, opening hours, holiday/exceptions, timezone.   [style:ListBullet]
P0 – resource: dolgozó, szoba, asztal, box, jármű, gép; capacity és compatibility.   [style:ListBullet]
P0 – atomic availability check + rövid hold -> caller confirmation -> commit. Ezzel csökkenthető a double-booking.   [style:ListBullet]
P0 – idempotens create/change/cancel API és external provider reconciliation.   [style:ListBullet]
P1 – multi-resource booking, például orvos + kezelőhelyiség.   [style:ListBullet]
P1 – cancellation window, deposit requirement, no-show status, reschedule policy.   [style:ListBullet]
P2 – own booking engine csak akkor legyen system-of-record, ha üzletileg indokolt; MVP-ben adapterként integráljatok meglévő rendszereket.   [style:ListBullet]

## 31.15 Waitlist Intelligence
P1 – teltház esetén várólista ajánlás explicit contact consenttel.   [style:ListBullet]
P1 – felszabaduló slot event -> rangsorolt kandidátusok értesítése SMS/e-mail/hívás szerint.   [style:ListBullet]
P1 – rövid reservation hold az első elfogadó számára, hogy ne kapja meg két ember ugyanazt a helyet.   [style:ListBullet]
P1 – contact attempt limit és quiet hours.   [style:ListBullet]
P2 – priority szabályok csak átlátható üzleti logikával: időablak, party size, VIP program; tiltott/diszkriminatív tulajdonságok nélkül.   [style:ListBullet]

## 31.16 Customer identity – telefonszámnál komolyabban
A telefonszám lookup key, nem identity proof. A rendszer Person/Customer entitást kezeljen több identifierrel és forrással.

| Mező | Példa | Trust |
| phone | +3630… | observed / OTP-verified |
| email | x@y.hu | caller-provided / email-verified |
| name | Kovács Krisztián | caller-provided / CRM-verified |
| external_id | CRM-1234 | connector-verified |
| preferred_language | hu | behavioral preference |

P0 – minden attribute mellett source, verified_at, last_confirmed_at.   [style:ListBullet]
P0 – sensitive action step-up verification: OTP, booking code vagy más tenant-specifikus faktor.   [style:ListBullet]
P1 – duplicate/merge candidate; automatikus merge csak nagyon erős determinisztikus kulccsal.   [style:ListBullet]
P1 – shared/family/company phone kezelése; ne írja felül vakon a profilnevet.   [style:ListBullet]
P1 – CRM legyen authoritative bizonyos mezőkre; source priority policy.   [style:ListBullet]

## 31.17 Analytics, ami üzleti értéket mutat
P0 – resolved calls, transfer, booking conversion, lead conversion, tool success, cost/resolved call.   [style:ListBullet]
P0 – human-hours-saved becslés konfigurálható benchmarkból, ne állítsátok tényként.   [style:ListBullet]
P1 – revenue attribution: booking/order/lead downstream státusszal összekötve; confidence/attribution window jelölve.   [style:ListBullet]
P1 – ROI dashboard: becsült generált bevétel – AI/platform költség – emberi kezelés.   [style:ListBullet]
P1 – telephely/agent/version/language/model bontás.   [style:ListBullet]
P1 – call reason distribution és friction: ismétlés, félbeszakítás, clarification count, dead-air, abandonment.   [style:ListBullet]
P2 – cohort/churn/retention analytics tenant ügyfelekre és a saját SaaS ügyfeleitekre.   [style:ListBullet]

## 31.18 Web Voice Widget
Ugyanaz az agent runtime legyen használható telefonon és böngészőben. A web widget ne külön chatbot legyen, hanem ugyanazt a tool/policy/knowledge réteget használja channel adapterrel.
P1 – WebRTC/browser audio, push-to-talk vagy full duplex opció.   [style:ListBullet]
P1 – site/domain allowlist és signed widget token, különben más oldal beágyazhatná az agentet.   [style:ListBullet]
P1 – web session nem kap automatikusan caller phone identityt; login/CRM context csak explicit biztonságos tokenből.   [style:ListBullet]
P1 – consent/disclosure channel-specifikusan.   [style:ListBullet]
P2 – ugyanaz a conversation átvihető web voice -> telefon callback/human transfer irányba.   [style:ListBullet]

## 31.19 Connector Marketplace
A connector framework előbb belső SDK legyen, marketplace csak stabil capability modell után. A connector ne tetszőleges kódot kapjon a core processben.
P1 – manifest: name, version, auth type, scopes, actions, schemas, webhooks, rate limits.   [style:ListBullet]
P1 – OAuth2/API-key/HMAC standard auth adapters.   [style:ListBullet]
P1 – connector action JSON Schema, confirmation requirement, idempotency capability.   [style:ListBullet]
P2 – sandbox execution / isolated worker, egress allowlist, secret vault reference.   [style:ListBullet]
P2 – private tenant connector és verified public connector.   [style:ListBullet]
P2 – review/signing/version compatibility; connector update ne törhesse el csendben a production workflow-t.   [style:ListBullet]
P2 – partner/revenue-share csak usage és security governance után.   [style:ListBullet]

## 31.20 Feature flags és kill switches

| Kapcsoló | Scope | Használat |
| agent publish | tenant/location | hibás új config azonnali rollback |
| provider | global/region/tenant | OpenAI/Telnyx/Twilio incident |
| tool/connector | tenant/action | hibás API write letiltása |
| outbound | global/tenant | fraud emergency |
| recording | tenant/location | compliance incident |
| payment | tenant | PCI incident |

P0 – flags default-safe állapottal és audit loggal.   [style:ListBullet]
P0 – kill switch működjön akkor is, ha az admin frontend részben hibás; külön ops endpoint/console.   [style:ListBullet]
P1 – staged rollout és percentage/canary flag agent verzióra/modelre.   [style:ListBullet]
P1 – emergency runbook minden globális kill switchhez.   [style:ListBullet]

## 31.21 Disaster Recovery
P0 – PostgreSQL PITR + rendszeres encrypted backup; restore teszt nélkül a backup nem tekinthető késznek.   [style:ListBullet]
P0 – object storage versioning/lifecycle; config/agent version külön DB-ben is.   [style:ListBullet]
P0 – carrier/OpenAI outage runbook és „forward all calls” emergency útvonal.   [style:ListBullet]
P1 – secondary region minimum control-plane recoveryhez.   [style:ListBullet]
P1 – quarterly restore/drill: DB restore, provider failover, secret recovery, DNS/routing recovery.   [style:ListBullet]
P1 – RPO/RTO tenant csomaghoz igazítva, nem marketingből kitalált 99.999%.   [style:ListBullet]
Enterprise – multi-region active/standby csak fizető igénynél; voice session state teljes cross-region migrációja nem feltétlenül szükséges, ha gyors reconnect/handoff elfogadható.   [style:ListBullet]

## 31.22 SLA/SLO rendszer
Először belső SLO-kat mérjetek; csak utána adjatok szerződéses SLA-t. Az alábbi számok mérnöki célértékek, nem automatikus ügyfélgaranciák.

| SLO | Kezdeti belső cél | Megjegyzés |
| call-control availability | >=99.9% havi | carrier függőséggel külön mérve |
| P95 first meaningful audio | <900 ms normál no-tool turn | tool turn külön metric |
| tool write success | >=99.5% saját hibákra | upstream outage külön címkézve |
| transfer initiation success | >=99.5% saját control plane | destination no-answer nem platformhiba |
| duplicate booking | közel 0; hard invariant | idempotency + DB constraint |
| critical policy breach | 0 tolerancia | release blocker + incident |

P0 – SLI definíció kódban/verziózva; minden dashboard ugyanazt számolja.   [style:ListBullet]
P1 – error budget: ha elfogy, feature rollout stop és reliability work.   [style:ListBullet]
Enterprise – SLA credit, support response és maintenance window külön szerződésben.   [style:ListBullet]

## 31.23 Internal Support Console
P0 – tenant/call keresés, provider call ID, trace, tool attempts, OAuth health, billing/usage.   [style:ListBullet]
P0 – redacted view default; érzékeny payloadhoz külön audited elevated access.   [style:ListBullet]
P0 – webhook replay, sync retry, email resend, knowledge reindex, call terminate, tenant suspend.   [style:ListBullet]
P1 – config diff és last-known-good rollback.   [style:ListBullet]
P1 – impersonation helyett „support session” explicit permissionnel és bannerrel.   [style:ListBullet]
P1 – incident timeline export és customer-safe report.   [style:ListBullet]

## 31.24 Automatikus prompt/config optimalizálás
A rendszer első fázisban soha ne írja át önállóan a production agent promptját. Ajánlásokat generáljon mért hívásokból, majd minden módosítás verziózott change set legyen.
P1 – recommendation példa: „DE hívásoknál +14% clarification; lassítsd a spell-back tempót”.   [style:ListBullet]
P1 – recommendationhez evidence: érintett callok száma, metric delta, confidence.   [style:ListBullet]
P1 – Accept -> draft agent version -> Simulation Lab -> canary -> production.   [style:ListBullet]
P1 – Reject feedback tanulási jel a recommendation engine számára, de tenantonként izolálva.   [style:ListBullet]
P2 – Bayesian/A-B optimalizálás voice/pacing/filler konfigurációkra megfelelő mintaszámnál.   [style:ListBullet]
P2 – semmilyen compliance/tool permission változás ne legyen auto-acceptálható.   [style:ListBullet]

## 31.25 Vertical Policy Packs

| Pack | Domain mezők/toolok | Kiemelt policy |
| Restaurant | party size, date/time, table, allergy note, waitlist | ne ígérjen nem létező asztalt; allergiánál disclaimer/policy |
| Dental/Clinic | service, doctor, urgency, appointment | nincs diagnózis; emergency routing; érzékeny adat minimalizálás |
| Auto service/detailing | rendszám, modell, szolgáltatás, box/technician | árbecslés feltételes; járműadat visszaellenőrzés |
| Hotel | date range, guests, room, deposit | PMS authority; cancellation/deposit szabály |
| Real estate | property, budget, area, viewing | lead qualification; fair/non-discriminatory policy |

P0/P1 – a pack ne csak prompt legyen: schema + required slots + tools + confirmation + KPI + eval suite + default compliance.   [style:ListBullet]
P1 – minden pack verziózott és tenant override-olható biztonságos mezőkben.   [style:ListBullet]
P1 – pack migration: új verzió nem írhatja felül automatikusan az ügyfél kritikus custom policyját.   [style:ListBullet]
P2 – marketplace később partner által készített packekhez review/signing modellel.   [style:ListBullet]

## 31.26 Kötelező architektúra- és adatmodell-bővítések

| Új entitás/szolgáltatás | Minimum mezők/feladat |
| locations | tenant_id, timezone, hours, inherited_config, status |
| agent_versions | agent_id, version, config_hash, status, created_by, rollout_percent |
| quality_scores | call_id, rubric_version, metrics, flags, evaluator_model |
| simulation_suites/runs | suite, scenario, version-under-test, score, artifacts |
| provider_health | provider, region, capability, state, latency/error windows |
| feature_flags | scope, key, value, reason, expiry, changed_by |
| consent_ledger | call_id/person_id, disclosure_version, language, timestamp, recording consent |
| resources/availability/holds | location, type, schedule, capacity, hold expiry |
| waitlist_entries | booking intent, contact policy, priority rule, status |
| payment_sessions | provider ref, amount, currency, status; SOHA nincs PAN/CVV |
| connector_manifests | version, auth, scopes, action schemas, signature/status |

Service szinten legalább külön background worker capability kell quality/eval, knowledge sync és notification számára. A core call path ne várjon quality scoringra vagy analytics aggregationre. Rust továbbra is csak media/low-latency/data-plane területre indokolt; a fenti control-plane képességek döntően TypeScriptben maradjanak.

## 31.27 Frissített költség- és csomagolási logika
A prémium funkciók közül a legtöbb nem növeli drasztikusan minden voice perc árát, viszont emeli a fix infrastruktúrát, az observability storage-ot, az offline quality/eval compute-ot és a support terhelést. Ezért a v3 pénzügyi modell magasabb fix tenant-allokációval számol; a drága enterprise funkciók külön add-onok.

| Csomag | Havidíj | Perc | Tervezési változó költség | Premium fix+support tartalék | Becsült fedezet teljes keretnél |
| START | 39 900 Ft | 150 | ~31 Ft/perc | ~12 000 Ft | ~23 000 Ft |
| BUSINESS | 69 900 Ft | 400 | ~31 Ft/perc | ~12 000 Ft | ~45 000 Ft |
| PRO | 129 900 Ft | 1000 | ~33 Ft/perc blended | ~12 000 Ft | ~85 000 Ft |

A fenti értékek tervezési számok, nem könyvelési profit. A premium fix tartalék tartalmazza a korábbinál magasabb infra/observability/quality allokációt és support reserve-et. Valós P95 cost/call alapján 30–60 nap éles adat után újra kell kalibrálni.
Payment/PCI: külön tranzakciós díj + enterprise/add-on díj; provider connector költsége pass-through vagy markup.   [style:ListBullet]
SSO/SCIM/BYOK/SIEM: Enterprise add-on, mert support és compliance overheadet hoz.   [style:ListBullet]
Dedikált provider redundancy / multi-region / szerződéses SLA: Enterprise add-on.   [style:ListBullet]
Nagyméretű Simulation Lab futtatás: fair-use keret + extra compute credit.   [style:ListBullet]
Extra location/phone number: külön havi díj; így a multi-location nem eszi meg az alapcsomag marginját.   [style:ListBullet]
Connector Marketplace custom/private connector: setup + havi maintenance vagy usage fee.   [style:ListBullet]

## 31.28 Javasolt implementációs sorrend kétfős csapatnak

| Fázis | Tartalom | Miért |
| P0 – eladható core | latency metrics, nyelvi routing, core multi-agent, safe transfer, spend limits, agent versioning, basic quality/eval, booking invariants, kill switch | minőség + biztonság + fizető ügyfél |
| P1 – premium product | warm transfer, Simulation Lab UI, Quality Monitoring, Knowledge Intelligence, instant onboarding, waitlist, web voice, multi-location, stronger identity | nagyobb ARPU és kevesebb support |
| P2 – moat/platform | connector marketplace, auto optimization, proprietary pronunciation/eval dataset, advanced analytics | differenciálás és platformhatás |
| Enterprise | PCI, SSO/SCIM, SIEM, BYOK, multi-region, contractual SLA | csak fizető igényre |


## 31.29 Új kötelező döntések összefoglalása
1. Country code csak language hint; explicit/detected language mindig felülírja.
2. Minden production agent verziózott és rollbackelhető.
3. Minden write tool idempotens és specialist-agent allowlisthez kötött.
4. Quality scoring aszinkron; nem lassíthatja a call pathot.
5. Payment card adat soha nem kerülhet LLM/transcript/saját log útvonalra.
6. Provider/model fallback nem duplázhat üzleti műveletet.
7. Multi-location és resource booking kulcsai már az adatmodellben legyenek.
8. Feature/connector/provider kill switch legyen ops szinten elérhető.
9. Automatic optimization csak recommendation + eval + approval után mehet productionba.
10. Enterprise SLA-t csak mért belső SLO és DR gyakorlat után vállaljatok.

## Kiegészítő referenciaforrások
Twilio – PCI Programmable Voice workflows: https://www.twilio.com/docs/voice/pci-workflows   [style:ListBullet]
Twilio – Payments subresource / agent-assisted payments: https://www.twilio.com/docs/voice/api/payment-resource   [style:ListBullet]
Twilio – <Pay> secure payment collection: https://www.twilio.com/docs/voice/twiml/pay   [style:ListBullet]
Twilio – Pay Connector pricing: https://www.twilio.com/en-us/voice/pay-connectors/pricing   [style:ListBullet]

# 32. Teljesen automatizált vásárlás, provisioning, fizetés és Billingo számlázás
A célélmény: egy kis- vagy középvállalkozás emberi Velyric-beavatkozás nélkül kiválasztja a csomagot, megadja a cég- és számlázási adatait, kiválaszt vagy igényel telefonszámot, Stripe-on fizet (kártya / Apple Pay / Google Pay), majd a platform automatikusan létrehozza a tenantot, a pénzügyi rekordokat, az OpenAI izolációt, a telefonszám-order folyamatot, az agentet és az alapintegrációkat. Ha a telefonszámhoz külső regulatory/KYC review szükséges, az ügyfél a Velyric felületén teljesíti a kérést; a provider jóváhagyása után a provisioning emberi Velyric-művelet nélkül folytatódik.

| Cél KPI: a standard, regulatory review nélküli onboarding legyen „self-serve”: fizetéstől teszthívásig lehetőleg percekben mérhető. A regulatory review lehet órák/napok kérdése, de a folyamat ettől még automatikus: a workflow WAITING_FOR_PROVIDER állapotban tartósan megmarad, majd webhook/polling eseményre folytatódik. |


## 32.1 Checkout UX és csomagválasztás
A checkout ne egy hosszú technikai konfigurátor legyen. Először a vásárláshoz és számlázáshoz szükséges minimum adatot kérjétek be, majd fizetés után folytatódjon az AI-agent konfiguráció. A felület két módot kínáljon: Express Setup a legtöbb KKV-nak és Advanced Setup a komplex/enterprise ügyfeleknek.

| Lépés | Ügyfél művelete | Backend eredmény |
| 1. Csomag | START / BUSINESS / PRO / Enterprise | price_id + entitlement snapshot |
| 2. Cégadatok | Jogi név, cím, ország, tax/VAT adat, számlázási e-mail | Customer/BillingProfile draft |
| 3. Telefonszám | Ország, local/mobile/toll-free, város/area code, választható konkrét szám | Telnyx inventory search / optional reservation |
| 4. Fizetés | Stripe kártya / Apple Pay / Google Pay | Stripe Customer + Subscription/Payment + immutable checkout order |
| 5. Provisioning | Nincs manuális ügyfélművelet, kivéve KYC/regulatory igény | Durable ProvisioningWorkflow indul |
| 6. Agent setup | Weboldal, nyelvek, persona, integrációk | Agent draft + knowledge + connectors |
| 7. Teszt és go-live | Browser test call / automatikus go-live | Production route aktiválás |


## 32.2 Stripe + Apple Pay + Google Pay
A fizetési szolgáltató egyedül a Stripe legyen. Weben Stripe Checkout vagy Payment Element/Express Checkout Element ajánlott. Az Apple Pay és Google Pay a Stripe-on belüli wallet fizetési mód: a Stripe automatikusan csak akkor jelenítse meg, ha az ügyfél eszköze/böngészője, országa, devizája és a merchant konfiguráció támogatja. A Velyric üzleti kódja ne külön Apple- és Google-payment állapotgépet tartson fenn.
A fizetés létrehozásakor metadata-ban legalább: internal_order_id, tenant_candidate_id, plan_code, pricing_version. Webhookon minden eseménynél ellenőrizzétek a Stripe signature-t, az event ID-t unique constrainttel deduplikáljátok, és csak a backend által lekért/verifikált Stripe objektum alapján módosítsatok entitlementet.

| Stripe esemény / állapot | Velyric reakció | Tilos |
| Checkout/payment siker | Order -> PAID; számlázási workflow; provisioning eligibility | Csak success_url alapján aktiválni |
| invoice.paid / subscription active | Havi entitlement/usage cycle aktiválása, Billingo számla | Duplikált provisioning ugyanarra az invoice-ra |
| payment failed | Dunning state, értesítés, grace period | Azonnali, adatvesztő törlés |
| subscription updated | Plan entitlement atomikus frissítése / proráció kezelése | Frontend által bemondott planból dolgozni |
| refund/credit | Ledger korrekció + szükséges Billingo dokumentum | Eredeti számla utólagos átírása |
| subscription deleted | Grace/suspend/cancel workflow | Telefonszám azonnali végleges elengedése policy nélkül |

Stripe domain registration és wallet-konfiguráció legyen infrastructure checklist része. A wallet gombokat ne erőltessétek minden ügyfélnek: a Stripe megfelelő felületén dinamikusan jelenjenek meg az elérhető opciók.

## 32.3 Billingo – teljesen automatikus számlázás
A Billingo legyen a számla source of truth, de ne a subscription engine. A subscription állapotot és pénzmozgást Stripe kezeli; a Billingo a Velyric backend által hitelesített pénzügyi eseményből állítja elő a jogszabály szerinti bizonylatot. API-integrációhoz kizárólag Billingo API v3-at használjatok.

| Fázis | Billingo művelet | Velyric adattárolás |
| Első sikeres fizetés | Partner lookup/create -> invoice create -> send | billingo_partner_id, document_id, invoice_number |
| Ismétlődő Stripe díj | Új számla ugyanarra a partnerre a tényleges cycle/összeg alapján | stripe_invoice_id <-> billingo_document_id |
| Overage / add-on | Következő számla külön tétel vagy policy szerinti azonnali terhelés | usage_period + line_item breakdown |
| Refund / korrekció | Könyvelési policy szerinti módosító/stornó bizonylat | correction_of_document_id + reason |
| Kiküldés | Billingo SendDocument / beállított automatikus e-mail | sent_at / delivery status, ha elérhető |

Billingo API kulcs csak szerveroldali secret store-ban legyen. A számlázási workernek minimális scope és külön audit trail kell. A partner létrehozása legyen deduplikált: elsődleges belső kulcs a Velyric BillingProfile, nem az e-mail cím. Ugyanaz a jogi partner több workspace/telefonszám tulajdonosa is lehet.
A számlázási adatokat a fizetés előtt validáljátok, mert sikeres payment után már nem jó UX, ha a számla kiállítása egy hiányzó adószámon vagy címen áll meg. A provisioning ettől külön állapotgép: pénzügyi policy szerint eldönthető, hogy invoice-generation retry mellett indulhat-e, de a rendszernek mindig látnia kell a PAYMENT_OK / INVOICE_PENDING rendellenes állapotot és riasztania kell.

## 32.4 Telefonszám kiválasztás, reservation és regulatory/KYC
A Velyric a Telnyx inventory API-jából keressen elérhető számokat. Az ügyfél lehetőség szerint konkrét számot válasszon. Ha a provider támogatja, checkout idejére rövid reservation alkalmazható, hogy a kiválasztott számot más ne vegye meg. A number order csak olyan számból induljon, amelyet a provider friss keresésben visszaadott.

| Állapot | Mit lát az ügyfél? | Rendszerreakció |
| NUMBER_SELECTED | „Kiválasztott szám” | Order draft + regulatory pre-check |
| KYC_REQUIRED | Dokumentum / cégadat / külső verification wizard | Requirement Group / requirement submission |
| UNDER_REVIEW | „Szolgáltatói ellenőrzés folyamatban” | Durable wait + webhook/polling |
| APPROVED | „Telefonszám aktiválva” | SIP/connection/AI routing config |
| DECLINED | Konkrét hiány/hiba + újraküldés | Retryable customer action; support escalation csak szükség esetén |
| NO_INVENTORY | Alternatív körzetszám/város vagy későbbi sourcing | Ne blokkolja örökre az egész tenantot |

A regulatory requirement adatokat és dokumentumokat csak addig tároljátok saját rendszerben, ameddig feltétlenül szükséges. Ha a Telnyx közvetlen upload/reference mechanizmusa használható, preferáljátok azt; a Velyric adatmodellben inkább provider reference + státusz szerepeljen, ne felesleges dokumentummásolat.

## 32.5 Tenantonkénti OpenAI provisioning
Sikeres fizetés után a Velyric OpenAI Admin API-val tenant-specifikus izolációt hozhat létre: külön project, külön service account és scoped API key. Ez a kulcs kizárólag a Velyric szerveroldali secret vaultban él; az ügyfél dashboardja csak az AI Engine státuszát, usage-et és feature-ket látja.

| Objektum | Név / azonosítás | Policy |
| OpenAI Project | velyric-{tenant_uuid} | Tenant cost/usage és jogosultság izoláció |
| Service Account | production-agent | Nem emberi account; csak Velyric runtime használja |
| Scoped API key | rotálható, lejárattal | Encrypt-at-rest; logba/DB plaintextben nem kerülhet |
| Spend alert / belső cost guard | tenant budget policy | Runaway usage esetén degradált mód / blokk / alert |

Kulcsrotáció: új kulcs létrehozása -> secret version publish -> health check -> régi kulcs visszavonása. Ha valamelyik lépés hibázik, a régi, működő kulcs maradjon aktív. Az Admin API key a legérzékenyebb platform secret kategóriába tartozzon, külön hozzáférési policyval és auditálással.

## 32.6 Provisioning Engine és állapotgép
A provisioning ne egy HTTP requestben fusson le. Több külső rendszerrel kommunikál, percektől napokig tarthat, és részleges hibákat kell túlélni. Ezért minden lépés tartós workflow state legyen, saját idempotency key-jel és retry policyval.

| Provisioning state | Belépési feltétel | Következő lépés |
| ORDER_CREATED | Checkout indult | PAYMENT_PENDING |
| PAYMENT_CONFIRMED | Hitelesített Stripe event | BILLING_PENDING + TENANT_PROVISIONING |
| BILLING_DOCUMENT_CREATED | Billingo document elkészült | OPENAI_PROVISIONING |
| OPENAI_READY | Project/service account/key elkészült | PHONE_PROVISIONING |
| PHONE_KYC_REQUIRED | Regulatory requirement van | WAITING_FOR_CUSTOMER / PROVIDER |
| PHONE_UNDER_REVIEW | Dokumentumok beadva | WAITING_FOR_PROVIDER |
| PHONE_READY | Szám aktív | SIP_AGENT_BINDING |
| AGENT_READY | Routing + default agent + knowledge elkészült | TEST_READY |
| LIVE | Release gate teljesült / auto-go-live | Normal operations |
| MANUAL_REVIEW_REQUIRED | Retry exhausted vagy irreverzibilis kivétel | Internal Support Console queue |


| A workflow „pontosan egyszer” üzleti hatását idempotenciával érjétek el, ne azzal az illúzióval, hogy a hálózati hívás csak egyszer történik meg. Stripe event ID, Billingo document mapping, Telnyx order ID, OpenAI project ID és internal operation key legyen unique/dedupolható. |


## 32.7 Ajánlott workflow technológia
Kétfős csapatnál az első production verzióhoz TypeScript + PostgreSQL transaction/outbox + Redis/BullMQ megfelelő lehet, ha minden workflow state adatbázisban tartós és retry-safe. Amikor a hosszú életű, napokig váró KYC, refund, dunning, porting és multi-provider workflow-k száma nő, érdemes Temporalra vagy hasonló durable workflow engine-re migrálni. A domain state továbbra is PostgreSQL-ben maradjon; a workflow engine ne legyen az egyetlen üzleti source of truth.

## 32.8 Automatikus AI onboarding fizetés után
A payment/provisioning folyamat közben párhuzamosan fusson a tenant konfiguráció. Az ügyfél megadhatja a weboldalát, a Velyric pedig javaslatot készít cégprofilra, nyitvatartásra, szolgáltatásokra, FAQ-ra és vertikális policy packre. Minden automatikusan importált tényhez source és confidence tartozzon; a kritikus üzleti adatok (ár, nyitvatartás, lemondási feltétel) go-live előtt jóváhagyhatók legyenek.
Az integrációs wizard elsődleges opciói: Google Calendar OAuth, Microsoft 365/Google Workspace e-mail, Velyric által küldött transactional e-mail, custom SMTP, webhook/API connector. Az MVP-ben ne követeljétek meg az integrációt: az agent FAQ/handoff módban is tesztelhető legyen, miközben a booking connector még nincs bekötve.

## 32.9 Teszthívás és automatikus go-live
Amint az AI runtime és legalább egy tesztcsatorna elkészült, jelenjen meg böngészős Web Voice teszthívás. Ha a telefonszám még regulatory review alatt van, ettől függetlenül tesztelhető legyen az agent. Go-live csak akkor történjen, ha a kötelező release gate-ek teljesültek: AI disclosure, legalább egy működő routing path, tool permission policy, spend/call limit, provider state és billing entitlement.

| Go-live gate | Minimum |
| Billing | Active entitlement; nincs hard payment block |
| Phone | Aktív szám vagy portolt szám + működő route |
| AI | Production agent version + voice/model config |
| Compliance | AI disclosure + recording/retention policy |
| Safety | Tool allowlist, cost guard, max call duration, transfer fallback |
| Quality | Smoke test + alap scripted booking/support scenario pass |


## 32.10 Upgrade, downgrade és add-on vásárlás
Az upgrade/downgrade ne új tenant provisioning legyen. Stripe subscription item/price változás után az entitlement service verziózott feature snapshotot generál. Upgrade azonnal aktiválható; downgrade-nél a következő billing cycle vagy explicit policy szerint járjatok el. A már konfigurált enterprise funkciót downgrade esetén ne töröljétek azonnal: „disabled but retained” állapot előzze meg a retention utáni tisztítást.
Extra telefonszám/location, Simulation credit, PCI, SSO/SCIM, dedicated redundancy és private connector add-onként külön Stripe price/item legyen. A Billingo számla line itemjai tükrözzék a Velyric belső ledger tételeit, hogy az ügyfél és a könyvelés ugyanazt a bontást lássa.

## 32.11 Fizetési hiba és dunning
Fizetési hiba esetén ne azonnal bontsátok le a szolgáltatást. Ajánlott állapotok: PAYMENT_AT_RISK -> GRACE_PERIOD -> RESTRICTED -> SUSPENDED. A Stripe retry/dunning eseményekből frissítsétek az állapotot. Restricted módban például tiltott lehet az outbound és a prémium model routing, miközben inbound human-forwarding vagy tájékoztató mód még működhet. Minden változást előre kommunikáljatok e-mailben és dashboard bannerrel.

## 32.12 Lemondás, szám-retention és újraaktiválás
Lemondáskor a subscription megszűnése nem egyenlő a telefonszám azonnali végleges törlésével. Legyen konfigurálható recovery/quarantine időszak, amennyiben a carrier és a jogi/üzleti szabályok engedik. A tenant állapota CANCELED_GRACE -> SUSPENDED -> DATA_RETENTION -> DELETION. A telefonszám release, OpenAI key revoke és adatmegsemmisítés külön, auditált step legyen. Újraaktiváláskor lehetőség szerint ugyanaz az agent config és szám álljon vissza, ha még rendelkezésre áll.

## 32.13 Refund, chargeback és részleges provisioning hiba
A legveszélyesebb állapot az, amikor a pénz sikeresen beérkezett, de valamelyik külső provisioning step tartósan sikertelen. Ezt első osztályú support queue-ként kezeljétek. Ha a szolgáltatás a policy szerinti határidőn belül nem teljesíthető, legyen kontrollált refund flow, amely a Stripe refundot, Billingo korrekciót, number order cleanupot és OpenAI resource cleanupot egyetlen kompenzációs workflow-ban kezeli.
Chargeback esetén ne automatikusan töröljétek a customer evidence-et vagy billing rekordot. A vitás tranzakcióra külön retention/legal policy vonatkozzon. A provisioning és billing audit események itt különösen fontosak.

## 32.14 Új kötelező adatmodell-elemek

| Entitás | Minimum mezők / invariáns |
| CheckoutOrder | id, tenant_candidate_id, pricing_version, currency, total, status, stripe_session_id |
| BillingProfile | legal_name, address, country, tax_id/vat_id, billing_email, tax_policy_snapshot |
| Subscription | stripe_customer_id, stripe_subscription_id, plan, status, current_period, entitlement_version |
| PaymentEvent | stripe_event_id UNIQUE, type, object_id, amount, currency, processed_at |
| BillingDocument | internal_order_id, billingo_partner_id, document_id UNIQUE, invoice_number, correction_of |
| ProvisioningWorkflow | workflow_id, tenant_id, state, attempt, blocking_reason, next_retry_at |
| ProviderResource | provider, resource_type, external_id, tenant_id, state, metadata |
| PhoneOrder | telnyx_order_id, phone_number, country, number_type, requirements_status |
| TenantSecretRef | provider, secret_ref, version, expires_at, rotated_at – plaintext nélkül |
| EntitlementSnapshot | plan_version, feature flags, limits, effective_from |


## 32.15 Security és secret-kezelés
A Stripe secret key, webhook signing secret, Billingo API key, Telnyx API key, OpenAI Admin API key és tenant service-account key-ek ne kerüljenek normál alkalmazás-adatbázis mezőbe plaintextként. Használjatok dedikált secret manager/KMS megoldást, környezetenként elkülönített kulcsokat, minimális IAM jogosultságot és auditált read access-t. A secret értékeket application log, Sentry breadcrumb, trace attribute és support console soha ne jelenítse meg.
A webhook endpointok nyilvánosak, ezért minden provider esetében signature/secret verification, replay protection, event deduplication és rate limit szükséges. Az üzleti művelet az ellenőrzött event feldolgozása után, transaction/outbox modellen keresztül induljon.

## 32.16 Megfigyelhetőség és automatikus support

| Metrika / alert | Miért kell |
| checkout->paid conversion | Checkout UX és payment probléma |
| paid->invoice latency / failure | Billingo integráció és pénzügyi SLA |
| paid->test-ready latency | Provisioning élmény fő KPI |
| KYC required rate ország/számtípus szerint | Onboarding súrlódás előrejelzése |
| Provisioning step retry/failure | Provider/API regresszió |
| Orphan provider resources | Költség- és security leak |
| Stripe<->ledger<->Billingo reconciliation mismatch | Pénzügyi integritás |
| Active subscription without active entitlement | Kritikus bevétel/szolgáltatás hiba |

Az Internal Support Console mutassa egyetlen timeline-ban: Stripe eventek, Billingo documentek, Telnyx order/requirement state, OpenAI project/service account, agent provisioning és notification history. A supportnak ne kelljen négy külön provider dashboardot kézzel összeraknia ahhoz, hogy megértse, hol áll egy vásárlás.

## 32.17 Implementációs sorrend

| Fázis | Tartalom | Prioritás |
| P0-A | Stripe Checkout/Payment Element + webhook + internal order/ledger | Kötelező |
| P0-B | Billingo partner/számla/send API + reconciliation | Kötelező |
| P0-C | Tenant + agent + OpenAI project/service account/key provisioning | Kötelező |
| P0-D | Telnyx inventory/order + alap KYC state + routing | Kötelező |
| P0-E | Retry/idempotency/support exception queue + go-live gate | Kötelező |
| P1 | Wallet UX finomítás, number reservation, automatic website onboarding, upgrade/downgrade | Következő |
| P1/P2 | Durable workflow engine (Temporal), advanced dunning, multi-country tax matrix | Skálázáskor |
| Enterprise | Custom contracts/invoicing, purchase order, bank transfer, custom SLA/payment terms | Igényre |


## 32.18 Végleges commerce/provisioning döntések
1. Stripe az egyetlen payment/subscription source of truth.
2. Apple Pay és Google Pay Stripe-on keresztül jelenik meg; nincs külön wallet backend.
3. Billingo API v3 a számlázási source of truth; minden számla backendből és auditálható eseményből készül.
4. Provisioning csak hitelesített Stripe eseményből indul; frontend success oldal soha nem jogosít aktiválásra.
5. Tenantonként külön OpenAI project + service account + scoped secret; customer nem kap OpenAI kulcsot.
6. Telnyx KYC/regulatory review tartós várakozó workflow state; approval után automatikus folytatás.
7. Minden külső create/write művelet idempotens és reconcile-olható.
8. Fizetés, számla, entitlement és provisioning külön state machine, de közös internal order/tenant ID köti őket össze.
9. Partial failure, refund, cancellation és reactivation ugyanúgy tervezett workflow, mint a happy path.
10. A cél nem az, hogy minden provider azonnali legyen, hanem hogy a Velyric oldalán ne kelljen manuális operátori lépés a normál folyamatban.

# 33. Források és 2026.09.11-i ellenőrzött referencia
OpenAI – GPT-Live-1 release, pricing és full-duplex: https://openai.com/index/introducing-gpt-live-1-in-the-api/   [style:ListBullet]
OpenAI – Live SIP call accept: https://developers.openai.com/api/reference/typescript/resources/live/subresources/sessions/methods/accept   [style:ListBullet]
OpenAI – Live SIP call transfer/refer: https://developers.openai.com/api/reference/typescript/resources/live/subresources/sessions/methods/refer   [style:ListBullet]
OpenAI – GPT-Realtime-2.1 Mini: https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini   [style:ListBullet]
OpenAI – GPT-Realtime-2.1: https://developers.openai.com/api/docs/models/gpt-realtime-2.1   [style:ListBullet]
OpenAI – GPT-5.6 Luna: https://developers.openai.com/api/docs/models/gpt-5.6-luna   [style:ListBullet]
OpenAI – GPT-5.6 Terra: https://developers.openai.com/api/docs/models/gpt-5.6-terra   [style:ListBullet]
OpenAI – GPT-5.6 Sol: https://developers.openai.com/api/docs/models/gpt-5.6-sol   [style:ListBullet]
OpenAI – model comparison / GPT-6 Astra: https://developers.openai.com/api/docs/models/compare   [style:ListBullet]
OpenAI – GPT-Live-Transcribe: https://developers.openai.com/api/docs/models/gpt-live-transcribe   [style:ListBullet]
Telnyx – Hungary phone numbers: https://telnyx.com/phone-numbers/hungary   [style:ListBullet]
Telnyx – Voice API pricing: https://telnyx.com/pricing/voice-api   [style:ListBullet]
Telnyx – SIP Trunking pricing: https://telnyx.com/pricing/elastic-sip   [style:ListBullet]
Twilio – Hungary Voice pricing: https://www.twilio.com/en-us/voice/pricing/hu   [style:ListBullet]
Twilio – Hungary Voice Guidelines: https://www.twilio.com/en-us/guidelines/hu/voice   [style:ListBullet]
EU Commission – AI Act Article 50 transparency guidelines: https://digital-strategy.ec.europa.eu/en/policies/guidelines-ai-transparency-obligations   [style:ListBullet]
EU Commission – Article 50 FAQ: https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act   [style:ListBullet]
EDPB – telephone call recording FAQ: https://www.edpb.europa.eu/contact/frequently-asked-questions_en   [style:ListBullet]
Stripe – Payment Element és wallet payment methods (Apple Pay, Google Pay): https://stripe.com/payments/elements   [style:ListBullet]
Stripe – Apple Pay: https://stripe.com/payments/apple-pay   [style:ListBullet]
Stripe – Google Pay: https://stripe.com/payment-method/google-pay   [style:ListBullet]
Stripe – payment method domain registration: https://support.stripe.com/questions/register-domains-for-payment-methods   [style:ListBullet]
Billingo – API v3 dokumentáció: https://api.billingo.hu/ és https://developers.billingo.hu/   [style:ListBullet]
Billingo – API v3 számlaműveletek/partner/dokumentum példa: https://support.billingo.hu/content/446136358   [style:ListBullet]
Billingo – API-ból létrehozott dokumentum e-mailes küldése: https://support.billingo.hu/content/2091221145   [style:ListBullet]
Telnyx – phone number search/reservation/order: https://developers.telnyx.com/docs/numbers/phone-numbers/getting-started   [style:ListBullet]
Telnyx – number order és regulatory flow: https://developers.telnyx.com/docs/numbers/phone-numbers/number-orders   [style:ListBullet]
Telnyx – requirement groups: https://developers.telnyx.com/docs/numbers/phone-numbers/requirement-groups   [style:ListBullet]
OpenAI – project service accounts: https://developers.openai.com/api/reference/cli/resources/admin/subresources/organization/subresources/projects/subresources/service_accounts   [style:ListBullet]
OpenAI – project service-account API key creation: https://developers.openai.com/api/reference/typescript/resources/admin/subresources/organization/subresources/projects/subresources/service_accounts/subresources/api_keys/methods/create   [style:ListBullet]

# 34. Záró ajánlás
A koncepció technikailag és üzletileg is életképes, de a valódi érték nem az, hogy „AI beszél telefonon”, hanem az, hogy a hívásból megbízható, auditálható üzleti művelet lesz. Ha ezt jól csináljátok, a 39–130 ezer Ft/hó B2B ársáv teljesen indokolható, mert egyetlen megmentett foglalás, lead vagy recepciós munkaóra gyakran többet ér, mint a nyers AI-percköltség.
A fejlesztési prioritás sorrendje v4-ben: természetes voice UX és latency -> biztonságos multi-agent/tool execution -> agent versioning + eval/quality -> tenant/security/compliance -> onboarding és booking reliability -> mérhető ROI -> csak ezután marketplace, auto-optimization és enterprise extrák. A prémium funkciók jelentős része architekturálisan legyen előkészítve, de kétfős csapatként ne építsétek meg őket fizető igény nélkül.
