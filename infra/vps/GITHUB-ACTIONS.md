# Automatikus VPS-frissítés GitHub Actionsből

A `Deploy VPS` workflow minden `master` push után elindul. A pontos commitot
küldi fel SSH-n, majd a VPS-en ugyanazt a `setup.sh` telepítőt futtatja: függőségek,
MinIO-build, teljes alkalmazásbuild, adatbázis-migrációk, szolgáltatások újraindítása
és állapotellenőrzés. Alapértelmezett domain: `velyric.com`, mód: `sandbox`.

A `.env` és a tárhely-volume-ok megmaradnak. A már működő Cloudflare Tunnel
változatlanul fut, ezért **Tunnel-token nem kell a GitHubhoz**. Az első telepítést
előbb kézzel kell elvégezni; az automatizmus a `/opt/velyric` telepítést frissíti.

## 1. Jelszavas SSH-hozzáférés

A workflow SSH-jelszóval lép be; privát kulcsot nem kell létrehozni vagy megadni.
Az SSH-felhasználó lehet a már használt `root`, vagy olyan felhasználó, amely jelszó nélkül futtathatja
a teljes telepítőt `sudo`-val. A telepítő rendszerszolgáltatásokat és csomagokat
kezel, ezért rendszergazdai jogosultság szükséges.

A szerveren a megadott felhasználó jelszavas SSH-belépésének már működnie kell.
Ezt a saját géped termináljából tudod kipróbálni (az IP-címet és portot cseréld ki):

```bash
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive -p 22 root@VPS_IP
```

A workflow nem módosítja az SSH-szerver belépési szabályait. Interaktív
kétlépcsős jóváhagyást vagy kötelező jelszócserét nem tud elvégezni.

## 2. GitHub Secrets

Nyisd meg a tárolóban:
**Settings → Environments → VPS → Add environment secret**.
A workflow a `VPS` környezetet használja. Az alábbi értékeket ide add meg;
a korábban repository secretként felvett értékek is használhatók.

| Secret                | Tartalom                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `VPS_SSH_HOST`        | A VPS publikus IPv4-címe vagy közvetlen SSH-hostneve. Ne a Cloudflare-rel proxyzott webcímet add meg. |
| `VPS_SSH_USER`        | A fenti beállításhoz `root`.                                                                          |
| `VPS_SSH_PORT`        | Az SSH-port; kihagyva `22`.                                                                           |
| `VPS_SSH_PASSWORD`    | A megadott SSH-felhasználó jelszava.                                                                  |
| `VPS_SSH_KNOWN_HOSTS` | A szerver ellenőrzött nyilvános SSH-hostkulcsa, az alábbi formátumban.                                |

A jelszót közvetlenül a GitHub secret mezőjébe írd; ne tedd a repóba vagy
beszélgetésbe. Az automatizmus környezeti változón keresztül adja át az SSH-nak.

A hostkulcs a VPS-en:

```bash
cat /etc/ssh/ssh_host_ed25519_key.pub
```

Ez a szerver nyilvános azonosítója, amellyel a GitHub ellenőrzi, hogy a te
VPS-edhez kapcsolódik. Nem belépési privát kulcs; a belépés jelszavas marad.

Ebből a `VPS_SSH_KNOWN_HOSTS` egyetlen sora a 22-es porthoz:

```text
VPS_IP ssh-ed25519 A_SZERVENT_OLVASOTT_NYILVANOS_HOSTKULCS
```

Például 2222-es SSH-portnál:

```text
[VPS_IP]:2222 ssh-ed25519 A_SZERVENT_OLVASOTT_NYILVANOS_HOSTKULCS
```

A `VPS_IP` helyére pontosan a `VPS_SSH_HOST` értékét írd. Az `ssh-ed25519` utáni
kulcsot a fenti szerveroldali fájlból másold. A hostkulcs ellenőrzését a workflow
nem kapcsolja ki, és futás közben nem fogad el automatikusan ismeretlen szervert.
Az SSH-portnak elérhetőnek kell lennie a GitHub futtatógépeiről.

## 3. Opcionális Variables

Ugyanott az **Environment variables** résznél:

| Változó      | Alapérték                         |
| ------------ | --------------------------------- |
| `VPS_DOMAIN` | `velyric.com`                     |
| `VPS_MODE`   | `sandbox` (`demo` is választható) |

A szolgáltatói kulcsok továbbra is a VPS meglévő `/opt/velyric/app/.env` fájljában
vannak. `sandbox` módban a telepítő megőrzi a már beállított szolgáltatói módokat.

## 4. Első indítás és későbbi frissítések

A secrets kitöltése után: **Actions → Deploy VPS → Run workflow → master**.
Ezt követően minden `master` push automatikusan frissíti a VPS-t.
A konfiguráció nélkül indult korábbi futás hiányzó secretet jelez; a beállítás
után indíts új futást.

A telepítés közvetlenül a push után indul, a külön CI-workflow-val párhuzamosan.
Egyszerre egy automatikus telepítés futhat. Új push nem szakítja félbe a folyamatban
lévőt; a várakozó, már elavult commitok kimaradnak. A telepítő szerveroldali zárral
az egyidejű kézi telepítést is kizárja.

A GitHub csak a commitban követett fájlokat küldi fel. A VPS-en nem kell GitHub-
hozzáférési tokent beállítani, és a `~/velyric-src` kézi checkoutját nem módosítja.
A ténylegesen futó telepítés továbbra is a `/opt/velyric/app` könyvtárban van.

Az utolsó sikeres automatikus telepítés commitja:

```bash
cat /opt/velyric/deployed-commit
```

Az Actions naplójában látszik a teljes telepítés. Hibás SSH-belépés, sikertelen
build/migráció vagy egészségellenőrzés esetén a futás hibás státusszal zárul.
A telepítés a meglévő, helyben frissítő folyamatot használja: újraindításkor rövid
kiesés lehet, és sikertelen frissítés esetén nincs automatikus visszaállítás.

## Hibaelhárítás

- `Missing VPS_...`: hiányzik egy repository secret, vagy más néven lett felvéve.
- `Host key verification failed`: ellenőrizd a hostnevet, portot és hostkulcsot a szerveren.
- `Permission denied` vagy `sshpass` 5-ös hibakód: ellenőrizd a felhasználónevet, jelszót és azt, hogy a szerver engedélyezi-e ennek a felhasználónak a jelszavas SSH-belépést.
- `sudo: a password is required`: a felhasználónak nincs megfelelő, jelszó nélküli jogosultsága; a korábbi rootos telepítéshez használd a `root` SSH-felhasználót.
- `another Velyric installation is already running`: várd meg a már futó telepítést, majd indíts új workflow-t.
- `some services are unhealthy`: az Actions naplója jelzi az érintett szolgáltatást; a VPS-en a `journalctl -u velyric-SZOLGALTATAS -n 100 --no-pager` mutatja a részleteket.
