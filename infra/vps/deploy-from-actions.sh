#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

fail() { printf '[deploy] %s\n' "$*" >&2; exit 64; }
for name in VPS_SSH_HOST VPS_SSH_USER VPS_SSH_PASSWORD VPS_SSH_KNOWN_HOSTS GITHUB_SHA; do
  [[ -n "${!name:-}" ]] || fail "Missing ${name}; configure the repository Actions secrets."
done
[[ "${VPS_SSH_HOST}" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || fail 'VPS_SSH_HOST must be a hostname or IPv4 address.'
[[ "${VPS_SSH_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]] || fail 'Invalid VPS_SSH_USER.'
VPS_SSH_PORT="${VPS_SSH_PORT:-22}"
[[ "${VPS_SSH_PORT}" =~ ^[1-9][0-9]{0,4}$ ]] && ((VPS_SSH_PORT <= 65535)) || fail 'Invalid VPS_SSH_PORT.'
VPS_DOMAIN="${VPS_DOMAIN:-velyric.com}"
[[ "${VPS_DOMAIN}" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || fail 'Invalid VPS_DOMAIN.'
VPS_MODE="${VPS_MODE:-sandbox}"
[[ "${VPS_MODE}" == sandbox || "${VPS_MODE}" == demo ]] || fail 'VPS_MODE must be sandbox or demo.'
[[ "${GITHUB_SHA}" =~ ^[a-f0-9]{40}$ ]] || fail 'Invalid deployment commit.'
[[ "$(git rev-parse HEAD)" == "${GITHUB_SHA}" ]] || fail 'Checkout does not match the deployment commit.'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_DIR="$(mktemp -d)"
REMOTE_DIR=""
DESTINATION="${VPS_SSH_USER}@${VPS_SSH_HOST}"
SSH_OPTIONS=(
  -F /dev/null
  -o "Port=${VPS_SSH_PORT}" -o BatchMode=no -o PubkeyAuthentication=no
  -o PreferredAuthentications=password,keyboard-interactive -o NumberOfPasswordPrompts=1
  -o IdentityAgent=none -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=${TASK_DIR}/known_hosts" -o GlobalKnownHostsFile=/dev/null
  -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6
)
password_ssh() { SSHPASS="${VPS_SSH_PASSWORD}" sshpass -e "$@"; }
cleanup() {
  local result=$?
  if [[ "${REMOTE_DIR}" =~ ^/tmp/velyric-upload\.[a-zA-Z0-9]{6}$ ]]; then
    password_ssh ssh "${SSH_OPTIONS[@]}" "${DESTINATION}" "rm -rf -- '${REMOTE_DIR}'" </dev/null \
      || printf '[deploy] Could not remove temporary upload directory.\n' >&2
  fi
  rm -rf -- "${TASK_DIR}"
  exit "${result}"
}
trap cleanup EXIT

printf '%s\n' "${VPS_SSH_KNOWN_HOSTS}" > "${TASK_DIR}/known_hosts"
unset VPS_SSH_KNOWN_HOSTS
HOST_LOOKUP="${VPS_SSH_HOST}"
if [[ "${VPS_SSH_PORT}" != 22 ]]; then HOST_LOOKUP="[${VPS_SSH_HOST}]:${VPS_SSH_PORT}"; fi
ssh-keygen -F "${HOST_LOOKUP}" -f "${TASK_DIR}/known_hosts" >/dev/null \
  || fail 'VPS_SSH_KNOWN_HOSTS has no entry for this host and port.'

# Only committed files are shipped: no .env, SSH keys, node_modules or local edits.
git archive --format=tar.gz "${GITHUB_SHA}" > "${TASK_DIR}/source.tar.gz"
REMOTE_DIR="$(password_ssh ssh "${SSH_OPTIONS[@]}" "${DESTINATION}" 'umask 077; mktemp -d /tmp/velyric-upload.XXXXXX')"
[[ "${REMOTE_DIR}" =~ ^/tmp/velyric-upload\.[a-zA-Z0-9]{6}$ ]] || fail 'Unexpected remote temporary directory.'
password_ssh scp "${SSH_OPTIONS[@]}" "${TASK_DIR}/source.tar.gz" "${DESTINATION}:${REMOTE_DIR}/source.tar.gz"
printf '[deploy] Installing commit %s\n' "${GITHUB_SHA}"
password_ssh ssh "${SSH_OPTIONS[@]}" "${DESTINATION}" \
  "sudo -n bash -s -- '${REMOTE_DIR}' '${GITHUB_SHA}' '${VPS_DOMAIN}' '${VPS_MODE}'" \
  < "${SCRIPT_DIR}/deploy-remote.sh"
