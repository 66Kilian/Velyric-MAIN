import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const available = spawnSync(bash, ['--version'], { encoding: 'utf8' }).status === 0;
const script = fileURLToPath(new URL('../../infra/vps/deploy-from-actions.sh', import.meta.url));
const sha = 'a'.repeat(40);
let directory;

function stub(name, body) {
  writeFileSync(join(directory, name), `#!/usr/bin/env bash\nset -e\n${body}\n`, { mode: 0o755 });
}

function run(overrides = {}) {
  return spawnSync(
    bash,
    ['-c', 'export PATH="$(cd "$1" && pwd):$PATH"; exec bash "$2"', '--', directory, script],
    {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        TEST_LOG: join(directory, 'calls.log'),
        TEST_SHA: sha,
        VPS_SSH_HOST: 'vps.example.com',
        VPS_SSH_USER: 'root',
        VPS_SSH_PORT: '2222',
        VPS_SSH_PASSWORD: 'synthetic-password-$; with spaces',
        VPS_SSH_KNOWN_HOSTS: '[vps.example.com]:2222 ssh-ed25519 synthetic-host-key',
        VPS_DOMAIN: 'velyric.com',
        VPS_MODE: 'sandbox',
        GITHUB_SHA: sha,
        ...overrides,
      },
    },
  );
}

function calls() {
  const file = join(directory, 'calls.log');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

describe('VPS SSH deployment', { skip: !available }, () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'velyric-deploy-test-'));
    stub('git', 'if [[ "$1" == rev-parse ]]; then echo "$TEST_SHA"; else echo archive; fi');
    stub('ssh-keygen', 'exit "${TEST_HOST_EXIT:-0}"');
    stub('sshpass', '[[ "$1" == -e && "$SSHPASS" == "$VPS_SSH_PASSWORD" ]]; shift; exec "$@"');
    stub('scp', 'echo "scp $*" >> "$TEST_LOG"; exit "${TEST_UPLOAD_EXIT:-0}"');
    stub(
      'ssh',
      `echo "ssh $*" >> "$TEST_LOG"
case "$*" in
  *mktemp*) if [[ "${'${TEST_LOGIN_EXIT:-0}'}" != 0 ]]; then exit "$TEST_LOGIN_EXIT"; fi; echo '/tmp/velyric-upload.Ab1234' ;;
  *'sudo -n bash'*) cat >/dev/null; exit "${'${TEST_DEPLOY_EXIT:-0}'}" ;;
esac`,
    );
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));

  it('ships the selected commit with strict host verification and cleans up', () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const log = calls();
    assert.match(log, /StrictHostKeyChecking=yes/);
    assert.match(log, /Port=2222/);
    assert.match(log, /PubkeyAuthentication=no/);
    assert.match(log, /PreferredAuthentications=password,keyboard-interactive/);
    assert.match(log, /sudo -n bash -s -- '\/tmp\/velyric-upload\.Ab1234'/);
    assert.ok(log.includes(sha));
    assert.match(log, /rm -rf -- '\/tmp\/velyric-upload\.Ab1234'/);
    assert.ok(!log.includes('synthetic-password'));
    const hostsPath = /UserKnownHostsFile=([^\n]+?) -o GlobalKnownHostsFile=/.exec(log)?.[1];
    assert.ok(hostsPath);
    // Ask the same shell to resolve its temporary path on Windows as well.
    assert.equal(spawnSync(bash, ['-c', 'test ! -e "$1"', '--', hostsPath]).status, 0);
  });

  it('propagates a failed remote setup while still cleaning up', () => {
    const result = run({ TEST_DEPLOY_EXIT: '37' });
    assert.equal(result.status, 37, result.stderr);
    assert.match(calls(), /rm -rf/);
  });

  it('does not start a deployment if upload fails', () => {
    const result = run({ TEST_UPLOAD_EXIT: '23' });
    assert.equal(result.status, 23, result.stderr);
    assert.ok(!calls().includes('sudo -n bash'));
    assert.match(calls(), /rm -rf/);
  });

  it('stops on a failed SSH login without uploading or running setup', () => {
    const result = run({ TEST_LOGIN_EXIT: '5' });
    assert.equal(result.status, 5, result.stderr);
    assert.ok(!calls().includes('scp '));
    assert.ok(!calls().includes('sudo -n bash'));
    assert.ok(!`${result.stdout}${result.stderr}${calls()}`.includes('synthetic-password'));
  });

  it('rejects missing pinned host keys before connecting', () => {
    assert.equal(run({ TEST_HOST_EXIT: '1' }).status, 64);
    assert.equal(calls(), '');
  });

  for (const overrides of [
    { VPS_SSH_HOST: 'host;id' },
    { VPS_SSH_USER: '-oProxyCommand=sh' },
    { VPS_SSH_PORT: '65536' },
    { VPS_DOMAIN: 'example.com;id' },
    { VPS_MODE: 'sandbox;id' },
    { VPS_SSH_PASSWORD: '' },
    { GITHUB_SHA: 'b'.repeat(40) },
  ]) {
    it(`rejects invalid configuration: ${Object.keys(overrides)[0]}`, () => {
      assert.equal(run(overrides).status, 64);
      assert.equal(calls(), '');
    });
  }
});

describe('VPS setup automation behavior', { skip: !available }, () => {
  const setup = readFileSync(
    fileURLToPath(new URL('../../infra/vps/setup.sh', import.meta.url)),
    'utf8',
  ).replaceAll('\r\n', '\n');

  function runFunction(name, endMarker, harness, env = {}) {
    const start = setup.indexOf(`\n${name}() {`);
    const end = setup.indexOf(endMarker, start + 1);
    assert.ok(start >= 0 && end > start);
    return spawnSync(bash, ['-s'], {
      input: `set -Eeuo pipefail\n${harness}\n${setup.slice(start, end)}\n${name}\n`,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, ...env },
    });
  }

  const tunnelHarness = `
KEEP_TUNNEL=true
log() { echo "$*"; }
die() { echo "$1" >&2; exit "${'${2:-1}'}"; }
systemctl() { return "${'${TEST_SYSTEMCTL_EXIT:-0}'}"; }
cloudflared() { echo 'unexpected tunnel reinstallation' >&2; exit 99; }
`;

  it('reuses an active tunnel without needing a token or reinstalling it', () => {
    const result = runFunction('configure_tunnel', '\nconfigure_firewall()', tunnelHarness);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /keeping the existing Cloudflare Tunnel/);
  });

  it('fails when the preserved tunnel stops running', () => {
    const result = runFunction('configure_tunnel', '\nconfigure_firewall()', tunnelHarness, {
      TEST_SYSTEMCTL_EXIT: '3',
    });
    assert.equal(result.status, 69);
  });

  it('reports failed service health checks as a failed deployment', () => {
    const result = runFunction(
      'main',
      '\nmain\n',
      `
for step in install_base_packages configure_swap install_docker install_node install_cloudflared create_app_user sync_source install_toolchains write_env start_infrastructure build_application migrate_database configure_tunnel install_services configure_firewall configure_backups; do
  eval "$step() { :; }"
done
verify_services() { return 1; }
log() { echo "$*"; }
warn() { echo "$*" >&2; }
die() { echo "$1" >&2; exit "${'${2:-1}'}"; }
`,
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /some services are unhealthy/);
    assert.ok(!result.stdout.includes('Velyric is running'));
  });
});
