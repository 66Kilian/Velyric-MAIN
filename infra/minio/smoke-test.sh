#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="velyric-minio:source-7aac2a2-77f82e1"
CONTAINER_ID=""

cleanup() {
  if [[ -n "${CONTAINER_ID}" ]]; then
    docker rm -f "${CONTAINER_ID}" >/dev/null
  fi
}
trap cleanup EXIT

docker build -t "${IMAGE}" "${SCRIPT_DIR}"
MINIO_ROOT_USER="velyric-smoke"
MINIO_ROOT_PASSWORD="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
export MINIO_ROOT_USER MINIO_ROOT_PASSWORD
CONTAINER_ID="$(docker run -d --env MINIO_ROOT_USER --env MINIO_ROOT_PASSWORD "${IMAGE}")"

ready=false
for ((attempt = 0; attempt < 60; attempt++)); do
  if docker exec "${CONTAINER_ID}" wget -q -O /dev/null http://127.0.0.1:9000/minio/health/ready; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "${ready}" != true ]]; then
  echo 'MinIO did not become ready' >&2
  docker logs "${CONTAINER_ID}" >&2
  exit 1
fi

export MC_HOST_smoke="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@127.0.0.1:9000"
mc() { docker exec --env MC_HOST_smoke "${CONTAINER_ID}" mc "$@"; }
for purpose in knowledge artifacts recordings exports evidence transient; do
  mc mb --ignore-existing "smoke/velyric-local-${purpose}"
  mc anonymous set none "smoke/velyric-local-${purpose}"
done
mc ilm rule add --expire-days 1 smoke/velyric-local-transient
mc mb --ignore-existing smoke/velyric-local-knowledge
printf 'velyric-minio-smoke-test' | docker exec -i --env MC_HOST_smoke "${CONTAINER_ID}" \
  mc pipe smoke/velyric-local-knowledge/smoke.txt
[[ "$(mc cat smoke/velyric-local-knowledge/smoke.txt)" == 'velyric-minio-smoke-test' ]]
mc rm smoke/velyric-local-knowledge/smoke.txt
echo 'MinIO readiness, bucket initialization and object round trip passed.'