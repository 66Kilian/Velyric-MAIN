import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

export type WebhookVerificationCode =
  'WEBHOOK_SIGNATURE_INVALID' | 'WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE';

export class WebhookVerificationError extends Error {
  readonly code: WebhookVerificationCode;

  constructor(code: WebhookVerificationCode, message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.code = code;
  }
}

export interface TimestampOptions {
  readonly toleranceSeconds?: number;
  readonly nowSeconds?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

function toBuffer(payload: string | Uint8Array): Buffer {
  return typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function assertTimestamp(timestampSeconds: number, options: TimestampOptions): void {
  if (!Number.isInteger(timestampSeconds) || timestampSeconds <= 0) {
    throw new WebhookVerificationError(
      'WEBHOOK_SIGNATURE_INVALID',
      'webhook timestamp is malformed',
    );
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestampSeconds) > tolerance) {
    throw new WebhookVerificationError(
      'WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE',
      'webhook timestamp is outside the tolerance window',
    );
  }
}

export function computeStripeSignature(
  payload: string | Uint8Array,
  secret: string,
  timestampSeconds: number,
): string {
  return createHmac('sha256', secret)
    .update(`${String(timestampSeconds)}.`)
    .update(toBuffer(payload))
    .digest('hex');
}

export function stripeSignatureHeader(
  payload: string | Uint8Array,
  secret: string,
  timestampSeconds: number,
): string {
  return `t=${String(timestampSeconds)},v1=${computeStripeSignature(payload, secret, timestampSeconds)}`;
}

export function verifyStripeSignature(
  payload: string | Uint8Array,
  header: string | undefined,
  secrets: readonly string[],
  options: TimestampOptions = {},
): void {
  if (header === undefined || header.length === 0 || header.length > 4096) {
    throw new WebhookVerificationError(
      'WEBHOOK_SIGNATURE_INVALID',
      'missing Stripe-Signature header',
    );
  }
  let timestamp = Number.NaN;
  const signatures: Buffer[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') {
      timestamp = Number(value);
    } else if (key === 'v1' && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(Buffer.from(value, 'hex'));
    }
  }
  if (!Number.isFinite(timestamp) || signatures.length === 0) {
    throw new WebhookVerificationError(
      'WEBHOOK_SIGNATURE_INVALID',
      'malformed Stripe-Signature header',
    );
  }
  const matched = secrets.some((secret) => {
    const expected = Buffer.from(computeStripeSignature(payload, secret, timestamp), 'hex');
    return signatures.some((candidate) => safeEqual(candidate, expected));
  });
  if (!matched) {
    throw new WebhookVerificationError('WEBHOOK_SIGNATURE_INVALID', 'Stripe signature mismatch');
  }
  assertTimestamp(timestamp, options);
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function ed25519PublicKeyFromBase64(
  publicKeyBase64: string,
): ReturnType<typeof createPublicKey> {
  const raw = Buffer.from(publicKeyBase64, 'base64');
  if (raw.length !== 32) {
    throw new WebhookVerificationError(
      'WEBHOOK_SIGNATURE_INVALID',
      'Telnyx public key must be 32 raw bytes',
    );
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export function verifyTelnyxSignature(
  payload: string | Uint8Array,
  signatureBase64: string | undefined,
  timestampHeader: string | undefined,
  publicKeyBase64: string,
  options: TimestampOptions = {},
): void {
  if (signatureBase64 === undefined || timestampHeader === undefined) {
    throw new WebhookVerificationError(
      'WEBHOOK_SIGNATURE_INVALID',
      'missing Telnyx signature headers',
    );
  }
  const signature = Buffer.from(signatureBase64, 'base64');
  const timestamp = Number(timestampHeader);
  const signed = Buffer.concat([Buffer.from(`${timestampHeader}|`, 'utf8'), toBuffer(payload)]);
  const valid =
    signature.length === 64 &&
    verifySignature(null, signed, ed25519PublicKeyFromBase64(publicKeyBase64), signature);
  if (!valid) {
    throw new WebhookVerificationError('WEBHOOK_SIGNATURE_INVALID', 'Telnyx signature mismatch');
  }
  assertTimestamp(timestamp, options);
}

export function computeTwilioSignature(
  url: string,
  params: Readonly<Record<string, string>>,
  authToken: string,
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((accumulator, key) => `${accumulator}${key}${params[key] ?? ''}`, url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function verifyTwilioSignature(
  url: string,
  params: Readonly<Record<string, string>>,
  signature: string | undefined,
  authToken: string,
  rawJsonBody?: string,
): void {
  if (signature === undefined) {
    throw new WebhookVerificationError(
      'WEBHOOK_SIGNATURE_INVALID',
      'missing X-Twilio-Signature header',
    );
  }
  const provided = Buffer.from(signature, 'base64');
  if (rawJsonBody !== undefined) {
    const bodyHash = new URL(url).searchParams.get('bodySHA256');
    const actualHash = createHash('sha256').update(rawJsonBody, 'utf8').digest('hex');
    if (
      bodyHash === null ||
      !safeEqual(Buffer.from(bodyHash, 'utf8'), Buffer.from(actualHash, 'utf8'))
    ) {
      throw new WebhookVerificationError('WEBHOOK_SIGNATURE_INVALID', 'Twilio body hash mismatch');
    }
    if (!safeEqual(provided, Buffer.from(computeTwilioSignature(url, {}, authToken), 'base64'))) {
      throw new WebhookVerificationError('WEBHOOK_SIGNATURE_INVALID', 'Twilio signature mismatch');
    }
    return;
  }
  const candidates = [url];
  const parsed = new URL(url);
  if (parsed.port === '') {
    const withPort = new URL(url);
    withPort.port = parsed.protocol === 'https:' ? '443' : '80';
    candidates.push(withPort.href.replace(/:(443|80)\//, `:${withPort.port}/`));
  } else if (
    (parsed.protocol === 'https:' && parsed.port === '443') ||
    (parsed.protocol === 'http:' && parsed.port === '80')
  ) {
    candidates.push(url.replace(`:${parsed.port}`, ''));
  }
  const matched = candidates.some((candidate) =>
    safeEqual(
      provided,
      Buffer.from(computeTwilioSignature(candidate, params, authToken), 'base64'),
    ),
  );
  if (!matched) {
    throw new WebhookVerificationError('WEBHOOK_SIGNATURE_INVALID', 'Twilio signature mismatch');
  }
}

export interface StandardWebhookHeaders {
  readonly id: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
}

function standardWebhookKey(secret: string): Buffer {
  const encoded = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 24) {
    throw new WebhookVerificationError('WEBHOOK_SIGNATURE_INVALID', 'webhook secret is too short');
  }
  return key;
}

export function computeStandardWebhookSignature(
  payload: string | Uint8Array,
  id: string,
  timestampSeconds: number,
  secret: string,
): string {
  const digest = createHmac('sha256', standardWebhookKey(secret))
    .update(`${id}.${String(timestampSeconds)}.`)
    .update(toBuffer(payload))
    .digest('base64');
  return `v1,${digest}`;
}

export function verifyStandardWebhook(
  payload: string | Uint8Array,
  headers: StandardWebhookHeaders,
  secrets: readonly string[],
  options: TimestampOptions = {},
): void {
  const { id, timestamp, signature } = headers;
  if (
    id === undefined ||
    timestamp === undefined ||
    signature === undefined ||
    !/^[\w.:-]{1,255}$/.test(id)
  ) {
    throw new WebhookVerificationError(
      'WEBHOOK_SIGNATURE_INVALID',
      'missing webhook-id, webhook-timestamp or webhook-signature',
    );
  }
  const timestampSeconds = Number(timestamp);
  const provided = signature
    .split(' ')
    .map((entry) => entry.split(','))
    .filter((pair): pair is [string, string] => pair.length === 2 && pair[0] === 'v1')
    .map(([, value]) => Buffer.from(value, 'base64'));
  const matched = secrets.some((secret) => {
    const expected = Buffer.from(
      computeStandardWebhookSignature(payload, id, timestampSeconds, secret).slice(3),
      'base64',
    );
    return provided.some((candidate) => safeEqual(candidate, expected));
  });
  if (!matched) {
    throw new WebhookVerificationError('WEBHOOK_SIGNATURE_INVALID', 'webhook signature mismatch');
  }
  assertTimestamp(timestampSeconds, options);
}
