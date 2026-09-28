import type {
  IdentityExchangeInput,
  IdentityExchangeResult,
  OAuthProvider,
  OAuthTokenClient,
  RefreshResult,
  TokenExchangeInput,
  TokenExchangeResult,
} from '../../src/integrations/oauth.js';
import { OAuthExchangeError } from '../../src/integrations/oauth.js';

export class FakeOAuthTokenClient implements OAuthTokenClient {
  readonly exchanges: TokenExchangeInput[] = [];
  readonly identityExchanges: IdentityExchangeInput[] = [];
  respond: (input: TokenExchangeInput) => TokenExchangeResult | OAuthExchangeError = (input) => ({
    refreshToken: `refresh-${input.code}`,
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'],
    accountRef: 'clinic@example.com',
  });
  respondToRefresh: (
    provider: OAuthProvider,
    refreshToken: string,
  ) => RefreshResult | OAuthExchangeError = () => ({
    accessToken: 'fake-access-token',
    expiresInSeconds: 3_600,
  });
  respondToIdentity: (input: IdentityExchangeInput) => IdentityExchangeResult | OAuthExchangeError =
    () => ({
      email: 'clinic@example.com',
    });

  exchange(input: TokenExchangeInput): Promise<TokenExchangeResult> {
    this.exchanges.push(input);
    const outcome = this.respond(input);
    return outcome instanceof OAuthExchangeError
      ? Promise.reject(outcome)
      : Promise.resolve(outcome);
  }

  refresh(provider: OAuthProvider, refreshToken: string): Promise<RefreshResult> {
    const outcome = this.respondToRefresh(provider, refreshToken);
    return outcome instanceof OAuthExchangeError
      ? Promise.reject(outcome)
      : Promise.resolve(outcome);
  }

  exchangeIdentity(input: IdentityExchangeInput): Promise<IdentityExchangeResult> {
    this.identityExchanges.push(input);
    const outcome = this.respondToIdentity(input);
    return outcome instanceof OAuthExchangeError
      ? Promise.reject(outcome)
      : Promise.resolve(outcome);
  }
}
