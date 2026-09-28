#!/usr/bin/env node
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const examplePath = `${repoRoot}.env.example`;
const envPath = `${repoRoot}.env`;
const SERVICE_KEY_IDS = [
  'control-api-local',
  'voice-runtime-local',
  'document-worker-local',
  'eval-runner-local',
];

function password() {
  return randomBytes(24).toString('base64url');
}

function key32() {
  return randomBytes(32).toString('base64');
}

function quote(value) {
  if (!/[\s"'#\\]/.test(value)) {
    return value;
  }
  if (!value.includes("'") && !value.includes('\n')) {
    return `'${value}'`;
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

function generatedValues(existing) {
  const pick = (name, create) => (existing[name] ? existing[name] : create());
  const postgres = pick('VELYRIC_LOCAL_POSTGRES_PASSWORD', password);
  const app = pick('VELYRIC_LOCAL_APP_PASSWORD', password);
  const readonly = pick('VELYRIC_LOCAL_READONLY_PASSWORD', password);
  const redis = pick('VELYRIC_LOCAL_REDIS_PASSWORD', password);
  const minio = pick('VELYRIC_LOCAL_MINIO_PASSWORD', password);
  const sessionSigningKey = pick('VELYRIC_SESSION_SIGNING_KEY_SECRET', () =>
    randomBytes(36).toString('base64url'),
  );
  let signingKey = existing['VELYRIC_SERVICE_SIGNING_KEY_SECRET'];
  let jwks = existing['VELYRIC_SERVICE_JWKS_SECRET'];
  if (!signingKey || !jwks) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    signingKey = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const jwk = publicKey.export({ format: 'jwk' });
    jwks = JSON.stringify({
      keys: SERVICE_KEY_IDS.map((kid) => ({ ...jwk, kid, alg: 'EdDSA', use: 'sig' })),
    });
  }
  const redisUrl = `redis://velyric:${redis}@127.0.0.1:56379`;
  const databaseUrl = `postgres://velyric_local:${app}@127.0.0.1:55432/velyric`;
  return {
    VELYRIC_LOCAL_POSTGRES_PASSWORD: postgres,
    VELYRIC_LOCAL_APP_PASSWORD: app,
    VELYRIC_LOCAL_READONLY_PASSWORD: readonly,
    VELYRIC_LOCAL_REDIS_PASSWORD: redis,
    VELYRIC_LOCAL_MINIO_PASSWORD: minio,
    VELYRIC_DATABASE_MIGRATOR_URL: `postgres://postgres:${postgres}@127.0.0.1:55432/velyric`,
    VELYRIC_DATABASE_URL_SECRET: databaseUrl,
    VELYRIC_REDIS_URL_SECRET: redisUrl,
    VELYRIC_REDIS_URL: redisUrl,
    AWS_SECRET_ACCESS_KEY: minio,
    VELYRIC_SERVICE_SIGNING_KEY_SECRET: signingKey,
    VELYRIC_SERVICE_SIGNING_KEY: signingKey,
    VELYRIC_SERVICE_JWKS_SECRET: jwks,
    VELYRIC_SERVICE_JWKS: jwks,
    VELYRIC_SESSION_SIGNING_KEY_SECRET: sessionSigningKey,
    CONTROL_API_CURSOR_KEY_SECRET: pick('CONTROL_API_CURSOR_KEY_SECRET', key32),
    CONTROL_API_API_KEY_PEPPER_SECRET: pick('CONTROL_API_API_KEY_PEPPER_SECRET', key32),
    CONTROL_API_STATE_KEY_SECRET: pick('CONTROL_API_STATE_KEY_SECRET', key32),
    VELYRIC_LEGAL_ENTITY_NAME: pick('VELYRIC_LEGAL_ENTITY_NAME', () => 'Velyric Local Development'),
    VELYRIC_LEGAL_ENTITY_ADDRESS: pick(
      'VELYRIC_LEGAL_ENTITY_ADDRESS',
      () => 'Local development only',
    ),
    VELYRIC_LEGAL_ENTITY_REGISTRATION: pick(
      'VELYRIC_LEGAL_ENTITY_REGISTRATION',
      () => 'not registered',
    ),
    VELYRIC_LEGAL_ENTITY_TAX_NUMBER: pick(
      'VELYRIC_LEGAL_ENTITY_TAX_NUMBER',
      () => 'not registered',
    ),
    VELYRIC_PRIVACY_CONTACT_EMAIL: pick(
      'VELYRIC_PRIVACY_CONTACT_EMAIL',
      () => 'privacy@velyric.local',
    ),
    VELYRIC_SALES_CONTACT_EMAIL: pick('VELYRIC_SALES_CONTACT_EMAIL', () => 'sales@velyric.local'),
  };
}

const { values: options } = parseArgs({
  options: {
    set: { type: 'string', multiple: true, default: [] },
    'from-environment': { type: 'boolean', default: false },
    'env-name': { type: 'string', multiple: true, default: [] },
  },
  strict: true,
  allowPositionals: false,
});

const overrides = {};
for (const entry of options.set) {
  const separator = entry.indexOf('=');
  if (separator <= 0 || !/^[A-Z][A-Z0-9_]*$/.test(entry.slice(0, separator))) {
    process.stderr.write(`invalid --set value: ${entry.split('=')[0]}
`);
    process.exit(64);
  }
  overrides[entry.slice(0, separator)] = entry.slice(separator + 1);
}

const example = readFileSync(examplePath, 'utf8');
const existingText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const existing = existingText === '' ? {} : parseEnv(existingText);
if (options['from-environment']) {
  const names = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
  for (const name of [...names, ...options['env-name']]) {
    if (process.env[name] && overrides[name] === undefined) {
      overrides[name] = process.env[name];
    }
  }
}
Object.assign(existing, overrides);
const generated = generatedValues(existing);
const lines = [];
const written = new Set();
for (const line of example.split(/\r?\n/)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (match === null) {
    lines.push(line);
    continue;
  }
  const name = match[1];
  written.add(name);
  const value = existing[name] || generated[name] || match[2];
  lines.push(`${name}=${quote(value)}`);
}
const OBSOLETE = [/^VELYRIC_WORKOS_/, /^WEB_WORKOS_/, /^VELYRIC_PROVIDER_MODE_WORKOS$/, /^WEB_STAFF_ORGANIZATION_ID$/, /^WORKFLOW_WORKER_SMTP_URL$/, /^WORKFLOW_WORKER_SES_CONFIGURATION_SET$/];
for (const [name, value] of Object.entries(existing)) {
  if (!written.has(name) && !OBSOLETE.some((pattern) => pattern.test(name))) {
    lines.push(`${name}=${quote(value)}`);
  }
}
writeFileSync(envPath, `${lines.join('\n').trimEnd()}\n`, { mode: 0o600 });
process.stdout.write(`${existingText === '' ? 'created' : 'updated'} ${envPath}\n`);
