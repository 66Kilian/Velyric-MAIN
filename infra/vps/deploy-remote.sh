#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() { printf '[deploy] %s\n' "$*" >&2; exit 64; }
[[ "${EUID}" -eq 0 ]] || fail 'Deployment requires root or passwordless sudo.'
[[ $# -eq 4 ]] || fail 'Expected upload directory, commit, domain and mode.'
UPLOAD_DIR="$1"
COMMIT="$2"
DOMAIN="$3"
MODE="$4"
[[ "${UPLOAD_DIR}" =~ ^/tmp/velyric-upload\.[a-zA-Z0-9]{6}$ ]] || fail 'Invalid upload directory.'
[[ -d "${UPLOAD_DIR}" && ! -L "${UPLOAD_DIR}" && -f "${UPLOAD_DIR}/source.tar.gz" ]] || fail 'Source archive is missing.'
[[ "${COMMIT}" =~ ^[a-f0-9]{40}$ ]] || fail 'Invalid commit.'
[[ "${DOMAIN}" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || fail 'Invalid domain.'
[[ "${MODE}" == sandbox || "${MODE}" == demo ]] || fail 'Invalid mode.'
[[ -f /opt/velyric/app/.env ]] || fail 'Run the initial VPS setup first; /opt/velyric/app/.env is missing.'
systemctl is-active --quiet cloudflared || fail 'The existing Cloudflare Tunnel must be active.'

RELEASE_DIR="$(mktemp -d /tmp/velyric-release.XXXXXX)"
cleanup() { rm -rf -- "${RELEASE_DIR}"; }
trap cleanup EXIT
SOURCE_DIR="${RELEASE_DIR}/source"
install -d -m 0755 "${SOURCE_DIR}"
(
  # Preserve readable source/config files for the non-root service/container users.
  umask 022
  tar --extract --gzip --file "${UPLOAD_DIR}/source.tar.gz" --directory "${SOURCE_DIR}" \
    --no-same-owner --no-same-permissions
)
[[ -f "${SOURCE_DIR}/infra/vps/setup.sh" && -f "${SOURCE_DIR}/pnpm-workspace.yaml" ]] || fail 'Archive is not a Velyric checkout.'

(
  umask 022
  bash "${SOURCE_DIR}/infra/vps/setup.sh" --domain "${DOMAIN}" --mode "${MODE}" --keep-tunnel
)
printf '%s\n' "${COMMIT}" > /opt/velyric/deployed-commit
printf '[deploy] Successfully deployed and verified commit %s\n' "${COMMIT}"
