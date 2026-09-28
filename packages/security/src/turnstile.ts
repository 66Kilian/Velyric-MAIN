const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5_000;

export interface TurnstileVerifyInput {
  readonly secretKey: string;
  readonly token: string;
  readonly remoteIp: string | null;
}

export interface TurnstileVerifyResult {
  readonly success: boolean;
  readonly errorCodes: readonly string[];
}

/**
 * Calls Cloudflare's siteverify endpoint. The endpoint is a fixed, trusted
 * Cloudflare host (not user-configurable), so this does not go through the
 * egress SSRF policy used for tenant-supplied hosts like SMTP or webhooks.
 */
export async function verifyTurnstile(
  input: TurnstileVerifyInput,
  fetchImpl: typeof fetch = fetch,
): Promise<TurnstileVerifyResult> {
  const body = new URLSearchParams({ secret: input.secretKey, response: input.token });
  if (input.remoteIp !== null) {
    body.set('remoteip', input.remoteIp);
  }
  let response: Response;
  try {
    response = await fetchImpl(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { success: false, errorCodes: ['network_error'] };
  }
  if (!response.ok) {
    return { success: false, errorCodes: [`http_${String(response.status)}`] };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { success: false, errorCodes: ['malformed_response'] };
  }
  const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
  const errorCodes = Array.isArray(record['error-codes'])
    ? record['error-codes'].filter((code): code is string => typeof code === 'string')
    : [];
  return { success: record['success'] === true, errorCodes };
}
