# Velyric VPS telepítés Cloudflare Tunnellel

Automatikus, SSH-n keresztüli GitHub Actions frissítéshez lásd:
[GitHub Actions beállítása](./GITHUB-ACTIONS.md).

Ez a telepítés **egyetlen bejövő portot sem nyit meg** a webes, API- és
hangforgalomhoz. A VPS-en futó `cloudflared` szolgáltatás kifelé kezdeményez
kapcsolatot a Cloudflare hálózata felé, és a Cloudflare Zero Trust
irányítópultján beállított hostname-ek ezen a kapcsolaton keresztül érik el a
helyi (127.0.0.1) szolgáltatásokat. A tűzfal (`ufw`) csak az SSH portot
engedi be.

## 1. Cloudflare Tunnel létrehozása (egyszeri, a Cloudflare irányítópulton)

1. Nyisd meg a [Cloudflare Zero Trust](https://one.dash.cloudflare.com/)
   irányítópultot (ha még nincs Zero Trust csomagod, az ingyenes "Free" plan
   elég ehhez).
2. **Networks → Tunnels → Create a tunnel**.
3. Connector típusnak válaszd a **Cloudflared**-et.
4. Adj neki nevet, pl. `velyric-vps`.
5. A következő lépésben megjelenik egy telepítő parancs (`cloudflared service
install <hosszú token>`). Csak a **tokenre** van szükséged — másold ki
   (kezdete kb. `eyJhIjoi...`). Ezt add majd meg a szerveren futtatott
   szkriptnek.
6. Ne zárd be az ablakot — a következő lépés (**Public Hostname**) ugyanitt
   folytatódik.

## 2. Nyilvános hostname-ek beállítása (ugyanabban a Tunnel-beállításban)

A **Public Hostname** fülön add hozzá az alábbi négy bejegyzést. Mindegyiknél
a "Service" típusa **HTTP**, a cím pedig a helyi porton figyelő szolgáltatás:

| Subdomain | Domain        | Path | Service URL             |
| --------- | ------------- | ---- | ----------------------- |
| (üres)    | `velyric.com` | —    | `http://localhost:3000` |
| `api`     | `velyric.com` | —    | `http://localhost:4000` |
| `voice`   | `velyric.com` | —    | `http://localhost:7000` |
| `sim`     | `velyric.com` | —    | `http://localhost:4010` |

A mentéskor a Cloudflare **automatikusan létrehozza a DNS CNAME rekordokat**
(proxyzott, narancssárga felhő) ezekhez a hostname-ekhez — külön DNS-beállítás
nem kell.

### `sim.velyric.com/_control/*` védelme (fontos!)

A `sim.velyric.com` a beépített szolgáltató-szimulátor (Stripe/OpenAI
stb. hamisítványa demó/sandbox módhoz), és van rajta egy `/_control/*` admin
API is (szintetikus felhasználók létrehozása, hibaszimuláció). Ezt érdemes
levédeni — de **csak ezt az egy útvonalat**, a többit nyitva kell hagyni,
mert ezeket a `control-api` szolgáltatás **szerver-szerver kapcsolattal**
éri el (pl. Stripe webhook-ok) — ha ezeket is Access mögé teszed, ezek a
hívások hibával elszállnak.

A Zero Trust irányítópulton:

1. **Access → Applications → Add an application → Self-hosted**.
2. Application domain: `sim.velyric.com`, és a **Path** mezőbe írd be:
   `/_control` (a felület verziójától függően `/_control/*` formában kérheti).
3. Policy: engedélyezd csak a saját email-címedet (One-time PIN vagy Google
   bejelentkezés).
4. Mentsd el.

Ha véletlenül path nélkül, az egész `sim.velyric.com`-ra vetted fel az
alkalmazást, és emiatt nem sikerül bejelentkezni, töröld azt, és hozd létre
újra a fenti, `/_control`-ra szűkített path-tal — vagy ideiglenesen töröld
teljesen az Access-alkalmazást (a szimulátor csak szintetikus teszt-adatot
szolgál ki, nem valódi ügyfélinformációt, úgyhogy rövid ideig védelem nélkül
sem kritikus kockázat).

`velyric.com`, `api.velyric.com` és `voice.velyric.com` maradjon teljesen
nyitva (ezekre az ügyfeleknek és a szolgáltatói webhookoknak el kell
érniük).

## 3. Telepítés a VPS-en

A telepítendő ág a `master`; a MinIO forrásból fordításának javítása is ezen
az ágon található. A GitHub-ellenőrzések és az image-build is a `master` pushaira
futnak. `--repo` használatakor a telepítő alapértelmezésben ezt az ágat klónozza.
Meglévő checkoutból indítva a checkout fájljait másolja: a `--branch master`
kapcsoló önmagában nem váltja át a forráskönyvtár Git-ágát.

A kódot juttasd fel a szerverre (privát repo esetén lásd a fő beszélgetést
vagy a `--repo` kapcsolót SSH deploy key-jel), majd rootként:

```bash
cd /root/velyric-src   # vagy ahova feltöltötted
chmod +x infra/vps/setup.sh
sudo ./infra/vps/setup.sh \
  --domain velyric.com \
  --tunnel-token eyJhIjoi...   # az 1. lépésben kimásolt token
```

A tokent környezeti változóként is átadhatod, hogy ne kerüljön a shell
historyba:

```bash
read -rsp 'Cloudflare Tunnel token: ' CLOUDFLARE_TUNNEL_TOKEN; echo
export CLOUDFLARE_TUNNEL_TOKEN
sudo --preserve-env=CLOUDFLARE_TUNNEL_TOKEN \
  bash ./infra/vps/setup.sh --domain velyric.com --mode sandbox
unset CLOUDFLARE_TUNNEL_TOKEN
```

### MinIO letöltési hiba (Quay 401)

A MinIO és az `mc` kliens a rögzített hivatalos GitHub-forrásból épül fel.
A forrásarchívumokat és az alap-image-eket SHA-256 ellenőrzőösszeg rögzíti;
a telepítéshez nem kell hozzáférés a `quay.io/minio/minio` tárolóhoz.
Az első fordítás több percig tarthat. Ehhez Docker Hub-, GitHub- és
Go-modulletöltési hozzáférés szükséges a VPS-ről. A Go fordító konténerben fut,
nem szükséges külön telepíteni a szerverre.

A telepítő előbb elkészíti a `velyric-minio:source-7aac2a2-77f82e1` image-et,
majd ezzel indítja a tárhelyet és a bucketeket létrehozó feladatot.
Újraindításkor a rendszer már a helyi image-et használja.
Az adatokat tároló Docker-volume neve és az elérési portok változatlanok.

Ez a meglévő **demo/sandbox** telepítés helyreállítása: a MinIO közösségi
forrása archivált, a saját fordítás nem jelent aktív upstream karbantartást.
Éles szolgáltatáshoz a tárhely támogatását külön kell rendezni.

Önálló ellenőrzés Linuxon, Dockerrel:

```bash
bash infra/docker/minio/smoke-test.sh
```

Ez elkészíti az image-et, majd egy elkülönített tesztkonténerben ellenőrzi a
bucket létrehozását, egy fájl feltöltését és visszaolvasását. Nem használja a
telepített Velyric adatbázisát vagy tárhely-volume-ját.

## 4. Ellenőrzés

```bash
systemctl status cloudflared
journalctl -u cloudflared -n 50
curl http://127.0.0.1:4000/healthz/ready   # helyi ellenőrzés a szerverről
```

A Cloudflare irányítópulton a **Networks → Tunnels → velyric-vps** alatt
"Healthy" állapotban kell lennie a kapcsolatnak.

Kívülről:

```bash
curl https://velyric.com
curl https://api.velyric.com/healthz/ready
```

Eredmény: a szerveren `sudo ufw status` csak az SSH portot mutatja nyitva — a
80/443-as portok soha nem is nyíltak meg.

## 5. Frissítés

### Egyszeri átállás a master ágra

A VPS-en, rootként, az `origin` remote-ot használó `~/velyric-src` checkoutban:

```bash
(
  set -e
  cd ~/velyric-src
  git fetch origin
  git branch "backup-vps-$(date +%Y%m%d-%H%M%S)"
  git stash push -m 'Local VPS changes before switching to master'
  git switch -C master origin/master
  git branch --set-upstream-to=origin/master master
  git config --local pull.ff only
)
```

Ez megőrzi a korábbi commitot egy backup ágban, a követett fájlok helyi
módosításait pedig stash-be menti. A forráskönyvtár ezután pontosan a távoli
`master` követett fájljait tartalmazza. A mentéseket nem pusholja fel. Ha egy
követetlen fájl akadályozza az átváltást, a Git megáll: ilyenkor előbb helyezd
biztonságba azt a fájlt, ne töröld a teljes könyvtárat.

### Későbbi frissítések és telepítés

```bash
(
  set -e
  cd ~/velyric-src
  git switch master
  git -c core.fileMode=false pull --ff-only origin master
  read -rsp 'Cloudflare Tunnel token: ' CLOUDFLARE_TUNNEL_TOKEN
  echo
  export CLOUDFLARE_TUNNEL_TOKEN
  bash ./infra/vps/setup.sh --domain velyric.com --mode sandbox
)
```

A tokent a rejtett bekérésnél add meg. A forrás frissítése önmagában nem
telepíti a változtatásokat: a `setup.sh` fordítja és indítja újra az alkalmazást.
A `/opt/velyric/app/.env` és az adatokat tároló Docker-volume-ok megmaradnak.
A telepítő újra beállítja a Tunnel szolgáltatását a megadott tokennel; a
hostname-ek útvonalai továbbra is a Cloudflare irányítópultján vannak.
