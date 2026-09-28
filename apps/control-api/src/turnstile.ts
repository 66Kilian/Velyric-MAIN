import { verifyTurnstile } from '@velyric/security';

export interface TurnstileVerifier {
  readonly enabled: boolean;
  verify(token: string, remoteIp: string | null): Promise<boolean>;
}

/** Real verifier used when VELYRIC_TURNSTILE_SECRET(_ARN) is configured. */
export class CloudflareTurnstileVerifier implements TurnstileVerifier {
  readonly enabled = true;
  readonly #secretKey: string;

  constructor(secretKey: string) {
    this.#secretKey = secretKey;
  }

  async verify(token: string, remoteIp: string | null): Promise<boolean> {
    const result = await verifyTurnstile({ secretKey: this.#secretKey, token, remoteIp });
    return result.success;
  }
}

/** No-op verifier used while the feature has no secret configured. */
export class DisabledTurnstileVerifier implements TurnstileVerifier {
  readonly enabled = false;

  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

export function createTurnstileVerifier(secretKey: string | null): TurnstileVerifier {
  return secretKey === null
    ? new DisabledTurnstileVerifier()
    : new CloudflareTurnstileVerifier(secretKey);
}
