#!/usr/bin/env bash
set -Eeuo pipefail

NODE_VERSION="22.20.0"
PNPM_VERSION="11.24.0"
UV_VERSION="0.12.0"
PYTHON_VERSION="3.11"

DOMAIN=""
TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-}"
MODE="demo"
APP_USER="velyric"
BASE_DIR="/opt/velyric"
REPO_URL=""
BRANCH="master"
SKIP_FIREWALL="false"
SKIP_BUILD="false"
KEEP_TUNNEL="false"
SWAP_SIZE="auto"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

log() { printf '\033[1;35m[velyric]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[velyric]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[velyric]\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

usage() {
  cat <<'USAGE'
Usage: sudo bash ./infra/vps/setup.sh --domain example.com [--tunnel-token <token> | --keep-tunnel] [options]

No inbound port is opened for web/API/voice traffic: cloudflared connects out to
Cloudflare and Cloudflare routes the public hostnames to this host over that
connection. Only SSH stays reachable directly. See infra/vps/README.md for the
one-time Cloudflare Tunnel setup that produces --tunnel-token.

Options:
  --domain <domain>      Public domain. In the Cloudflare Tunnel's Public Hostname
                         tab, route <domain>, api.<domain>, voice.<domain> and
                         sim.<domain> to this host (see infra/vps/README.md).
  --tunnel-token <token> Token for a Cloudflare Tunnel already created in the
                         Zero Trust dashboard (Networks > Tunnels > Create a
                         tunnel > Cloudflared). Can also be set via the
                         CLOUDFLARE_TUNNEL_TOKEN environment variable.
  --mode demo|sandbox    demo: every provider runs against the bundled provider simulator.
                         sandbox: each provider whose credentials are present in the
                         environment of this script uses its real sandbox; the rest stay on
                         the simulator (variable names as in .env.example).
  --repo <git-url>       Clone this repository instead of copying the checkout that contains
                         this script.
  --branch <name>        Branch to deploy when --repo is used (default: master).
  --base-dir <path>      Installation root (default: /opt/velyric).
  --swap <size|none>     Swap file size, e.g. 8G (default: auto when RAM < 8 GiB).
  --skip-firewall        Do not configure ufw and fail2ban.
  --skip-build           Reuse existing build outputs (configuration and restart only).
  --keep-tunnel          Reuse the active cloudflared service; no tunnel token required.
  -h, --help             Show this help.

Sandbox example:
  sudo VELYRIC_STRIPE_SECRET_KEY_SECRET=sk_test_... \
       VELYRIC_STRIPE_WEBHOOK_SIGNING_SECRET=whsec_... ./infra/vps/setup.sh --domain example.com \
       --tunnel-token eyJhIjoi... --mode sandbox
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --tunnel-token) TUNNEL_TOKEN="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --repo) REPO_URL="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --base-dir) BASE_DIR="${2:-}"; shift 2 ;;
    --swap) SWAP_SIZE="${2:-}"; shift 2 ;;
    --skip-firewall) SKIP_FIREWALL="true"; shift ;;
    --skip-build) SKIP_BUILD="true"; shift ;;
    --keep-tunnel) KEEP_TUNNEL="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" 64 ;;
  esac
done

APP_DIR="${BASE_DIR}/app"
ENV_FILE="${APP_DIR}/.env"
BACKUP_DIR="/var/backups/velyric"
NODE_BIN="/usr/local/bin/node"

[[ "${EUID}" -eq 0 ]] || die "run as root (sudo)" 77
[[ "${DOMAIN}" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "--domain must be a lowercase DNS name" 64
if [[ "${KEEP_TUNNEL}" == "true" ]]; then
  systemctl is-active --quiet cloudflared || die "--keep-tunnel requires an active cloudflared service" 69
else
  [[ -n "${TUNNEL_TOKEN}" ]] || die "--tunnel-token (or CLOUDFLARE_TUNNEL_TOKEN) is required; see infra/vps/README.md" 64
fi
[[ "${MODE}" == "demo" || "${MODE}" == "sandbox" ]] || die "--mode must be demo or sandbox" 64

# Also serialize manual installs against automated deployments on this VPS.
exec 9>/run/lock/velyric-setup.lock
flock -n 9 || die "another Velyric installation is already running" 75

. /etc/os-release
case "${ID}" in
  ubuntu|debian) ;;
  *) die "supported operating systems: Ubuntu 22.04/24.04, Debian 12 (found ${ID})" 69 ;;
esac

case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) die "unsupported CPU architecture $(uname -m)" 69 ;;
esac

declare -A PROVIDER_CREDENTIALS=(
  [STRIPE]="VELYRIC_STRIPE_SECRET_KEY_SECRET VELYRIC_STRIPE_WEBHOOK_SIGNING_SECRET"
  [OPENAI]="VOICE_RUNTIME_OPENAI_API_KEY_SECRET VELYRIC_OPENAI_WEBHOOK_SECRET WORKFLOW_WORKER_OPENAI_ADMIN_KEY_SECRET"
  [TELNYX]="VELYRIC_TELNYX_API_KEY_SECRET VELYRIC_TELNYX_WEBHOOK_PUBLIC_KEY WORKFLOW_WORKER_TELNYX_CONNECTION_ID"
  [TWILIO]="VELYRIC_TWILIO_AUTH_TOKEN_SECRET"
  [BILLINGO]="VELYRIC_BILLINGO_API_KEY_SECRET WORKFLOW_WORKER_BILLINGO_BLOCK_ID"
  [GOOGLE]="CONTROL_API_GOOGLE_OAUTH_CLIENT_SECRET CONNECTOR_WORKER_GOOGLE_OAUTH_CLIENT_SECRET WORKFLOW_WORKER_GOOGLE_OAUTH_CLIENT_SECRET"
  [MICROSOFT]="CONTROL_API_MICROSOFT_OAUTH_CLIENT_SECRET CONNECTOR_WORKER_MICROSOFT_OAUTH_CLIENT_SECRET"
)
env_file_value() {
  local name="$1"
  [[ -f "${ENV_FILE}" ]] || return 0
  sed -n "s/^${name}=//p" "${ENV_FILE}" | tail -n1 | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}

declare -A PROVIDER_MODE=([AWS_SES]="simulator")
declare -A PROVIDER_MODE_PINNED=([AWS_SES]="true")
for provider in "${!PROVIDER_CREDENTIALS[@]}"; do
  if [[ "${MODE}" == "demo" ]]; then
    PROVIDER_MODE[${provider}]="simulator"
    PROVIDER_MODE_PINNED[${provider}]="true"
    continue
  fi
  complete="true"
  for name in ${PROVIDER_CREDENTIALS[${provider}]}; do
    [[ -n "${!name:-}" ]] || complete="false"
  done
  if [[ "${complete}" == "true" ]]; then
    PROVIDER_MODE[${provider}]="sandbox"
    PROVIDER_MODE_PINNED[${provider}]="true"
  else
    # Credentials were not passed to this invocation. Guess the mode from the
    # deployed .env only for logging; leave PROVIDER_MODE_PINNED false so
    # write_env() does NOT force-write this value back — whatever is already
    # in .env (hand-edited or from an earlier sandbox run) stays untouched,
    # decided by env-local.mjs's own (CRLF-safe) parser instead of this guess.
    if [[ "$(env_file_value "VELYRIC_PROVIDER_MODE_${provider}")" == "sandbox" ]]; then
      PROVIDER_MODE[${provider}]="sandbox"
    else
      PROVIDER_MODE[${provider}]="simulator"
    fi
    PROVIDER_MODE_PINNED[${provider}]="false"
  fi
done
if [[ "${MODE}" == "sandbox" && "${PROVIDER_MODE[STRIPE]}" == "simulator" ]]; then
  warn "sandbox mode was requested but no complete Stripe credentials were found; Stripe stays on the simulator"
fi

run_as_app() {
  sudo -u "${APP_USER}" -H env \
    PATH="${BASE_DIR}/.cargo/bin:${BASE_DIR}/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    CARGO_HOME="${BASE_DIR}/.cargo" RUSTUP_HOME="${BASE_DIR}/.rustup" \
    COREPACK_HOME="${BASE_DIR}/.cache/corepack" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME="${BASE_DIR}/.local/share/pnpm" UV_CACHE_DIR="${BASE_DIR}/.cache/uv" \
    NEXT_TELEMETRY_DISABLED=1 CI=true \
    bash -Eeuo pipefail -c "cd '${APP_DIR}' && $*"
}

compose() {
  docker compose --project-name velyric --env-file "${ENV_FILE}" -f "${APP_DIR}/infra/docker/compose.dev.yml" "$@"
}

install_base_packages() {
  log "installing base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q --no-install-recommends \
    ca-certificates curl gnupg git rsync jq unzip xz-utils sudo \
    build-essential pkg-config libssl-dev \
    tesseract-ocr tesseract-ocr-hun tesseract-ocr-deu tesseract-ocr-eng \
    ufw fail2ban debian-keyring debian-archive-keyring apt-transport-https
}

configure_swap() {
  local memory_kib swap_kib
  memory_kib="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  swap_kib="$(awk '/SwapTotal/ {print $2}' /proc/meminfo)"
  if [[ "${SWAP_SIZE}" == "none" || "${swap_kib}" -gt 0 ]]; then
    return
  fi
  if [[ "${SWAP_SIZE}" == "auto" ]]; then
    [[ "${memory_kib}" -lt 8000000 ]] || return
    SWAP_SIZE="8G"
  fi
  log "creating ${SWAP_SIZE} swap file for the Rust and Next.js builds"
  fallocate -l "${SWAP_SIZE}" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "docker already installed: $(docker --version)"
  else
    log "installing Docker Engine and the compose plugin"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -q
    apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  mkdir -p /etc/docker
  if [[ ! -f /etc/docker/daemon.json ]]; then
    cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true
}
JSON
    systemctl restart docker
  fi
  systemctl enable --now docker >/dev/null
}

install_node() {
  if [[ -x "${NODE_BIN}" && "$(${NODE_BIN} --version)" == "v${NODE_VERSION}" ]]; then
    log "node v${NODE_VERSION} already installed"
  else
    log "installing Node.js v${NODE_VERSION}"
    local tmp archive
    tmp="$(mktemp -d)"
    archive="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "${tmp}/${archive}"
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "${tmp}/SHASUMS256.txt"
    (cd "${tmp}" && grep " ${archive}\$" SHASUMS256.txt | sha256sum -c -) || die "Node.js checksum verification failed" 70
    rm -rf "/usr/local/lib/nodejs-v${NODE_VERSION}"
    mkdir -p "/usr/local/lib/nodejs-v${NODE_VERSION}"
    tar -xJf "${tmp}/${archive}" -C "/usr/local/lib/nodejs-v${NODE_VERSION}" --strip-components=1
    for binary in node npm npx corepack; do
      ln -sf "/usr/local/lib/nodejs-v${NODE_VERSION}/bin/${binary}" "/usr/local/bin/${binary}"
    done
    rm -rf "${tmp}"
  fi
}

install_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    log "cloudflared already installed: $(cloudflared --version)"
    return
  fi
  log "installing cloudflared"
  local arch
  case "$(uname -m)" in
    x86_64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) die "unsupported CPU architecture $(uname -m) for cloudflared" 69 ;;
  esac
  local release_json selected asset_url asset_digest tmp binary
  release_json="$(curl -fsSL -H 'Accept: application/vnd.github+json' \
    https://api.github.com/repos/cloudflare/cloudflared/releases/latest)" \
    || die "could not reach the GitHub API to resolve the latest cloudflared release" 70
  selected="$(printf '%s' "${release_json}" | jq -r --arg arch "${arch}" '
    [.assets[] | select(
        (.name | test("linux-" + $arch + "$"))
        and ((.name | test("fips"; "i")) | not)
      )] | .[0] | "\(.browser_download_url // "")\t\(.digest // "")"
  ')"
  asset_url="${selected%%$'\t'*}"
  asset_digest="${selected#*$'\t'}"
  [[ -n "${asset_url}" ]] || die "could not find a linux ${arch} cloudflared binary in the latest GitHub release" 70
  tmp="$(mktemp -d)"
  binary="${tmp}/cloudflared"
  curl -fsSL "${asset_url}" -o "${binary}"
  if [[ "${asset_digest}" == sha256:* ]]; then
    echo "${asset_digest#sha256:}  ${binary}" | sha256sum -c - || die "cloudflared checksum verification failed" 70
  else
    warn "GitHub did not report a digest for the cloudflared asset; downloaded over HTTPS without a checksum"
  fi
  install -m 0755 "${binary}" /usr/local/bin/cloudflared
  rm -rf "${tmp}"
}

create_app_user() {
  if ! id -u "${APP_USER}" >/dev/null 2>&1; then
    log "creating system user ${APP_USER}"
    useradd --system --create-home --home-dir "${BASE_DIR}" --shell /bin/bash "${APP_USER}"
  fi
  install -d -o "${APP_USER}" -g "${APP_USER}" -m 0750 "${BASE_DIR}" "${BASE_DIR}/.cache" "${BASE_DIR}/.local"
  install -d -o root -g root -m 0700 "${BACKUP_DIR}"
}

sync_source() {
  if [[ -n "${REPO_URL}" ]]; then
    if [[ -d "${APP_DIR}/.git" ]]; then
      log "updating ${APP_DIR} from ${REPO_URL} (${BRANCH})"
      run_as_app "git fetch --prune origin '${BRANCH}' && git checkout '${BRANCH}' && git reset --hard 'origin/${BRANCH}'"
    else
      log "cloning ${REPO_URL} (${BRANCH})"
      sudo -u "${APP_USER}" -H git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
    fi
  else
    [[ -f "${SOURCE_DIR}/pnpm-workspace.yaml" ]] || die "run this script from a Velyric checkout or pass --repo" 66
    if [[ "${SOURCE_DIR}" != "${APP_DIR}" ]]; then
      log "copying ${SOURCE_DIR} to ${APP_DIR}"
      install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_DIR}"
      rsync -a --delete \
        --exclude '.git/' --exclude 'node_modules/' --exclude 'target/' --exclude '.venv/' \
        --exclude '.next/' --exclude 'dist/' --exclude '.env' --exclude '.local/' \
        --exclude 'test-results/' --exclude 'playwright-report/' --exclude '*.docx' \
        "${SOURCE_DIR}/" "${APP_DIR}/"
    fi
  fi
  chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
}

install_toolchains() {
  log "enabling pnpm ${PNPM_VERSION} through corepack"
  run_as_app "mkdir -p '${BASE_DIR}/.local/bin' && corepack enable --install-directory '${BASE_DIR}/.local/bin' && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm --version"

  if [[ ! -x "${BASE_DIR}/.cargo/bin/rustup" ]]; then
    log "installing rustup"
    run_as_app "curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none"
  fi
  log "installing the Rust toolchain pinned in rust-toolchain.toml"
  run_as_app "rustup show active-toolchain || rustup toolchain install"

  if [[ ! -x "${BASE_DIR}/.local/bin/uv" || "$(run_as_app 'uv --version' | awk '{print $2}')" != "${UV_VERSION}" ]]; then
    log "installing uv ${UV_VERSION}"
    run_as_app "curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | env UV_INSTALL_DIR='${BASE_DIR}/.local/bin' INSTALLER_NO_MODIFY_PATH=1 sh"
  fi
  run_as_app "uv python install ${PYTHON_VERSION}"
}

write_env() {
  log "writing ${ENV_FILE}"
  local sets=(
    "--set" "VELYRIC_ENV=local"
    "--set" "VELYRIC_PUBLIC_WEB_ORIGIN=https://${DOMAIN}"
    "--set" "VELYRIC_PUBLIC_API_ORIGIN=https://api.${DOMAIN}"
    "--set" "CONTROL_API_CORS_ALLOWED_ORIGINS=https://${DOMAIN}"
    "--set" "VELYRIC_LOG_LEVEL=info"
  )
  sets+=(
    "--set" "VELYRIC_PROVIDER_SIMULATOR_URL=https://sim.${DOMAIN}"
    "--set" "VELYRIC_PROVIDER_SIMULATOR_PUBLIC_URL=https://sim.${DOMAIN}"
    "--set" "VELYRIC_PROVIDER_SIMULATOR_HOST=127.0.0.1"
  )
  local provider
  for provider in "${!PROVIDER_MODE[@]}"; do
    if [[ "${PROVIDER_MODE_PINNED[${provider}]:-false}" == "true" ]]; then
      sets+=("--set" "VELYRIC_PROVIDER_MODE_${provider}=${PROVIDER_MODE[${provider}]}")
    fi
    log "provider ${provider}: ${PROVIDER_MODE[${provider}]}"
  done
  local names=() name
  while IFS='=' read -r name _; do
    names+=("${name}")
  done < <(grep -E '^[A-Z][A-Z0-9_]*=' "${APP_DIR}/.env.example")
  for provider in "${!PROVIDER_CREDENTIALS[@]}"; do
    for name in ${PROVIDER_CREDENTIALS[${provider}]}; do
      names+=("${name}")
    done
  done
  local preserved=()
  for name in "${names[@]}"; do
    if [[ -n "${!name:-}" ]]; then
      export "${name}"
      preserved+=("${name}")
    fi
  done
  local extra=()
  for provider in GOOGLE MICROSOFT; do
    if [[ "${PROVIDER_MODE[${provider}]}" == "sandbox" ]]; then
      for name in ${PROVIDER_CREDENTIALS[${provider}]}; do
        extra+=("--env-name" "${name}")
      done
    fi
  done
  if [[ -z "${VELYRIC_LEGAL_ENTITY_NAME:-}" ]]; then
    warn "VELYRIC_LEGAL_ENTITY_* were not provided; legal pages show development placeholders until you set them in ${ENV_FILE}"
  fi
  local preserve_flag=()
  if [[ ${#preserved[@]} -gt 0 ]]; then
    preserve_flag=("--preserve-env=$(IFS=,; echo "${preserved[*]}")")
  fi
  sudo -u "${APP_USER}" -H "${preserve_flag[@]}" "${NODE_BIN}" "${APP_DIR}/scripts/env-local.mjs" \
    --from-environment "${sets[@]}" "${extra[@]}"
  chown "${APP_USER}:${APP_USER}" "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
}

start_infrastructure() {
  log "starting PostgreSQL+pgvector, Redis, NATS JetStream, Temporal, MinIO (S3), Mailpit, ClamAV and the OTel collector"
  compose pull --quiet --ignore-buildable
  log "building MinIO and its client from pinned upstream sources (first build can take several minutes)"
  compose build minio
  compose up --detach --no-build --pull never --wait --wait-timeout 1200 postgres redis nats temporal minio mailpit clamav otel-collector
  compose run --rm --no-deps --pull never minio-init
}

build_application() {
  if [[ "${SKIP_BUILD}" == "true" ]]; then
    log "skipping build"
    return
  fi
  log "installing JavaScript dependencies"
  run_as_app "pnpm install --frozen-lockfile"
  log "building TypeScript packages and the web app"
  run_as_app "'${NODE_BIN}' scripts/with-env.mjs .env pnpm run build:ts"
  run_as_app "rm -rf apps/web/.next/standalone/apps/web/.next/static apps/web/.next/standalone/apps/web/public && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static && cp -r apps/web/public apps/web/.next/standalone/apps/web/public"
  log "building Rust services (release)"
  run_as_app "cargo build --release --locked -p velyric-voice-runtime -p velyric-metering-worker"
  log "installing Python services"
  run_as_app "uv sync --all-packages --frozen --no-dev"
}

migrate_database() {
  log "applying database migrations"
  run_as_app "'${NODE_BIN}' scripts/with-env.mjs .env '${NODE_BIN}' packages/db/dist/cli.js migrate"
  run_as_app "'${NODE_BIN}' scripts/with-env.mjs .env '${NODE_BIN}' packages/db/dist/cli.js verify"
  if [[ "${PROVIDER_MODE[STRIPE]}" == "simulator" ]]; then
    log "seeding the simulator price book"
    run_as_app "'${NODE_BIN}' scripts/with-env.mjs .env '${NODE_BIN}' packages/db/dist/cli.js seed"
  fi
}

write_unit() {
  local name="$1" description="$2" workdir="$3" exec_start="$4" extra="${5:-}"
  cat > "/etc/systemd/system/velyric-${name}.service" <<UNIT
[Unit]
Description=Velyric ${description}
After=network-online.target velyric-infra.service
Wants=network-online.target
Requires=velyric-infra.service
PartOf=velyric.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${workdir}
Environment=NODE_ENV=production
Environment=PATH=${BASE_DIR}/.local/bin:/usr/local/bin:/usr/bin:/bin
${extra}
ExecStart=${NODE_BIN} ${APP_DIR}/scripts/with-env.mjs ${ENV_FILE} ${exec_start}
Restart=always
RestartSec=5
TimeoutStopSec=120
KillSignal=SIGTERM
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${BASE_DIR}

[Install]
WantedBy=velyric.target
UNIT
}

install_services() {
  log "installing systemd units"
  cat > /etc/systemd/system/velyric.target <<'UNIT'
[Unit]
Description=Velyric platform
Wants=network-online.target
After=network-online.target

[Install]
WantedBy=multi-user.target
UNIT

  cat > /etc/systemd/system/velyric-infra.service <<UNIT
[Unit]
Description=Velyric data services (docker compose)
Requires=docker.service
After=docker.service network-online.target
PartOf=velyric.target

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/docker compose --project-name velyric --env-file ${ENV_FILE} -f ${APP_DIR}/infra/docker/compose.dev.yml up --detach --no-build --pull never --wait --wait-timeout 1200 postgres redis nats temporal minio mailpit clamav otel-collector
ExecStop=/usr/bin/docker compose --project-name velyric --env-file ${ENV_FILE} -f ${APP_DIR}/infra/docker/compose.dev.yml stop
TimeoutStartSec=1500

[Install]
WantedBy=velyric.target
UNIT

  local services=(control-api web workflow-worker connector-worker voice-runtime metering-worker document-worker eval-runner)
  write_unit control-api "control API" "${APP_DIR}" "${NODE_BIN} apps/control-api/dist/main.js"
  write_unit web "web app" "${APP_DIR}/apps/web/.next/standalone/apps/web" "${NODE_BIN} server.js" \
    $'Environment=PORT=3000\nEnvironment=HOSTNAME=127.0.0.1'
  write_unit workflow-worker "workflow worker" "${APP_DIR}" "${NODE_BIN} services/workflow-worker/dist/main.js"
  write_unit connector-worker "connector worker" "${APP_DIR}" "${NODE_BIN} services/connector-worker/dist/main.js"
  write_unit voice-runtime "voice runtime" "${APP_DIR}" "${APP_DIR}/target/release/velyric-voice-runtime"
  write_unit metering-worker "metering worker" "${APP_DIR}" "${APP_DIR}/target/release/velyric-metering-worker"
  write_unit document-worker "document worker" "${APP_DIR}" "${APP_DIR}/.venv/bin/velyric-document-worker"
  write_unit eval-runner "eval runner" "${APP_DIR}" "${APP_DIR}/.venv/bin/velyric-eval-runner"
  write_unit provider-simulator "provider simulator" "${APP_DIR}" "${NODE_BIN} packages/testkit/dist/simulator/bin.js"
  services=(provider-simulator "${services[@]}")

  systemctl daemon-reload
  systemctl enable velyric.target velyric-infra.service >/dev/null
  for service in "${services[@]}"; do
    systemctl enable "velyric-${service}.service" >/dev/null
  done
  systemctl start velyric-infra.service
  for service in "${services[@]}"; do
    systemctl restart "velyric-${service}.service"
  done
}

configure_tunnel() {
  if [[ "${KEEP_TUNNEL}" == "true" ]]; then
    systemctl is-active --quiet cloudflared || die "the existing cloudflared service is no longer active" 69
    log "keeping the existing Cloudflare Tunnel service"
    return
  fi
  log "installing the Cloudflare Tunnel as a system service (no inbound web/API/voice port is opened)"
  cloudflared service uninstall >/dev/null 2>&1 || true
  cloudflared service install "${TUNNEL_TOKEN}"
  systemctl enable --now cloudflared >/dev/null
  local attempts=30
  until systemctl is-active --quiet cloudflared; do
    attempts=$((attempts - 1))
    [[ "${attempts}" -gt 0 ]] || { warn "cloudflared did not start; check: journalctl -u cloudflared -n 100"; return 1; }
    sleep 2
  done
  log "cloudflared connected; hostname routing for ${DOMAIN} is managed in the Cloudflare Zero Trust dashboard"
}

configure_firewall() {
  if [[ "${SKIP_FIREWALL}" == "true" ]]; then
    return
  fi
  log "configuring ufw (SSH only — no inbound port for web/API/voice traffic) and fail2ban"
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  local port
  for port in $(ss -Htlnp 2>/dev/null | awk '/sshd/ {n = split($4, parts, ":"); print parts[n]}' | sort -u); do
    ufw allow "${port}/tcp" >/dev/null
  done
  ufw allow OpenSSH >/dev/null
  ufw --force enable >/dev/null
  systemctl enable --now fail2ban >/dev/null
}

configure_backups() {
  log "installing the daily PostgreSQL and object storage backup timer"
  cat > /usr/local/sbin/velyric-backup <<BACKUP
#!/usr/bin/env bash
set -Eeuo pipefail
stamp="\$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
/usr/bin/docker compose --project-name velyric --env-file ${ENV_FILE} -f ${APP_DIR}/infra/docker/compose.dev.yml \
  exec -T postgres pg_dump -U postgres --format=custom velyric > "${BACKUP_DIR}/velyric-\${stamp}.dump"
/usr/bin/docker run --rm -v velyric_minio-data:/data:ro -v ${BACKUP_DIR}:/backup alpine:3.22 \
  tar -czf "/backup/minio-\${stamp}.tar.gz" -C /data .
find ${BACKUP_DIR} -type f \( -name 'velyric-*.dump' -o -name 'minio-*.tar.gz' \) -mtime +14 -delete
BACKUP
  chmod 0750 /usr/local/sbin/velyric-backup
  cat > /etc/systemd/system/velyric-backup.service <<'UNIT'
[Unit]
Description=Velyric backup
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/velyric-backup
UNIT
  cat > /etc/systemd/system/velyric-backup.timer <<'UNIT'
[Unit]
Description=Daily Velyric backup

[Timer]
OnCalendar=*-*-* 02:30:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now velyric-backup.timer >/dev/null
}

wait_for() {
  local name="$1" url="$2" attempts=90
  until curl -fsS --max-time 3 "${url}" >/dev/null 2>&1; do
    attempts=$((attempts - 1))
    if [[ "${attempts}" -le 0 ]]; then
      warn "${name} did not become healthy; inspect with: journalctl -u velyric-${name} -n 200"
      return 1
    fi
    sleep 2
  done
  log "${name} is healthy"
}

verify_services() {
  local failed=0
  wait_for provider-simulator "http://127.0.0.1:4010/_control/health" || failed=1
  wait_for control-api "http://127.0.0.1:4001/healthz/ready" || failed=1
  wait_for web "http://127.0.0.1:3000/api/healthz/live" || failed=1
  wait_for workflow-worker "http://127.0.0.1:7200/healthz/live" || failed=1
  wait_for connector-worker "http://127.0.0.1:7300/healthz/live" || failed=1
  wait_for voice-runtime "http://127.0.0.1:7001/healthz/live" || failed=1
  wait_for metering-worker "http://127.0.0.1:7100/healthz/live" || failed=1
  wait_for document-worker "http://127.0.0.1:7400/healthz/live" || failed=1
  wait_for eval-runner "http://127.0.0.1:7500/healthz/live" || failed=1
  return "${failed}"
}

main() {
  install_base_packages
  configure_swap
  install_docker
  install_node
  install_cloudflared
  create_app_user
  sync_source
  install_toolchains
  write_env
  start_infrastructure
  build_application
  migrate_database
  configure_tunnel
  install_services
  configure_firewall
  configure_backups
  if verify_services; then
    log "Velyric is running"
  else
    die "setup finished but some services are unhealthy" 1
  fi
  cat <<SUMMARY

  Web app:          https://${DOMAIN}  (via Cloudflare Tunnel — no inbound port opened)
  Public API:       https://api.${DOMAIN}
  Voice webhooks:   https://voice.${DOMAIN}
  Simulator:        https://sim.${DOMAIN}  (put this behind a Cloudflare Access policy — see infra/vps/README.md)
  Hostname routing: configured in the Cloudflare Zero Trust dashboard, not on this host
  Environment file: ${ENV_FILE} (mode 0600, owner ${APP_USER})
  Backups:          ${BACKUP_DIR} (daily 02:30 UTC, 14 days)
  Private consoles (SSH tunnel): MinIO 127.0.0.1:59001, Mailpit 127.0.0.1:58025, Temporal UI 127.0.0.1:58233

  Status:   systemctl list-units 'velyric-*' 'cloudflared'
  Logs:     journalctl -u velyric-control-api -f
  Update:   sudo ${APP_DIR}/infra/vps/setup.sh --domain ${DOMAIN} --tunnel-token \$CLOUDFLARE_TUNNEL_TOKEN --mode ${MODE}$( [[ -n "${REPO_URL}" ]] && echo " --repo ${REPO_URL} --branch ${BRANCH}" )
SUMMARY
}

main
