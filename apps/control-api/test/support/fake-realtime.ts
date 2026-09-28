import { ApiError } from '../../src/errors.js';
import {
  ModelUnavailableError,
  type RealtimeSessionClient,
  type RealtimeSessionInput,
  type RealtimeSessionResult,
} from '../../src/routes/voice-test.js';

export class FakeRealtimeSessions implements RealtimeSessionClient {
  readonly calls: RealtimeSessionInput[] = [];
  unavailableModels = new Set<string>();
  failure: 'none' | 'provider' = 'none';
  #counter = 0;

  create(input: RealtimeSessionInput): Promise<RealtimeSessionResult> {
    this.calls.push(input);
    if (this.unavailableModels.has(input.model)) {
      return Promise.reject(new ModelUnavailableError(input.model));
    }
    if (this.failure === 'provider') {
      return Promise.reject(new ApiError('PROVIDER_UNAVAILABLE', { reason: 'openai_http_500' }));
    }
    this.#counter += 1;
    return Promise.resolve({
      value: `ek_test${String(this.#counter).padStart(6, '0')}`,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      model: input.model,
    });
  }
}
