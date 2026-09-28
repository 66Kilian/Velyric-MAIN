import type { TurnstileVerifier } from '../../src/turnstile.js';

/** Disabled by default so existing tests need no token; flip `enabled` to opt in. */
export class FakeTurnstileVerifier implements TurnstileVerifier {
  enabled = false;
  respond: (token: string, remoteIp: string | null) => boolean = () => true;
  readonly calls: { readonly token: string; readonly remoteIp: string | null }[] = [];

  verify(token: string, remoteIp: string | null): Promise<boolean> {
    this.calls.push({ token, remoteIp });
    return Promise.resolve(this.respond(token, remoteIp));
  }
}
