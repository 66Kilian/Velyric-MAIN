export const SIMULATED_PROVIDERS = [
  'workos',
  'stripe',
  'openai',
  'telnyx',
  'billingo',
  'google',
  'microsoft',
] as const;

export type SimulatedProvider = (typeof SIMULATED_PROVIDERS)[number];

export interface FaultRule {
  readonly id: string;
  readonly provider: SimulatedProvider;
  readonly method: string | null;
  readonly pathPrefix: string | null;
  readonly status: number | null;
  readonly latencyMs: number;
  readonly timeout: boolean;
  readonly errorCode: string | null;
  remaining: number | null;
}

export interface FaultInput {
  readonly provider: SimulatedProvider;
  readonly method?: string;
  readonly pathPrefix?: string;
  readonly status?: number;
  readonly latencyMs?: number;
  readonly timeout?: boolean;
  readonly errorCode?: string;
  readonly times?: number;
}

export function isSimulatedProvider(value: unknown): value is SimulatedProvider {
  return typeof value === 'string' && (SIMULATED_PROVIDERS as readonly string[]).includes(value);
}

export class FaultInjector {
  readonly #rules: FaultRule[] = [];
  #sequence = 0;

  add(input: FaultInput): FaultRule {
    if (input.status !== undefined && (input.status < 400 || input.status > 599)) {
      throw new RangeError('fault status must be an HTTP error status');
    }
    if (input.latencyMs !== undefined && (input.latencyMs < 0 || input.latencyMs > 120_000)) {
      throw new RangeError('fault latency must be between 0 and 120000 ms');
    }
    this.#sequence += 1;
    const rule: FaultRule = {
      id: `fault_${String(this.#sequence)}`,
      provider: input.provider,
      method: input.method?.toUpperCase() ?? null,
      pathPrefix: input.pathPrefix ?? null,
      status: input.status ?? null,
      latencyMs: input.latencyMs ?? 0,
      timeout: input.timeout ?? false,
      errorCode: input.errorCode ?? null,
      remaining: input.times ?? null,
    };
    this.#rules.push(rule);
    return rule;
  }

  clear(provider?: SimulatedProvider): number {
    const before = this.#rules.length;
    for (let index = this.#rules.length - 1; index >= 0; index -= 1) {
      if (provider === undefined || this.#rules[index]?.provider === provider) {
        this.#rules.splice(index, 1);
      }
    }
    return before - this.#rules.length;
  }

  list(): readonly FaultRule[] {
    return [...this.#rules];
  }

  take(provider: SimulatedProvider, method: string, path: string): FaultRule | null {
    const rule = this.#rules.find(
      (candidate) =>
        candidate.provider === provider &&
        (candidate.method === null || candidate.method === method) &&
        (candidate.pathPrefix === null || path.startsWith(candidate.pathPrefix)),
    );
    if (rule === undefined) {
      return null;
    }
    if (rule.remaining !== null) {
      rule.remaining -= 1;
      if (rule.remaining <= 0) {
        this.#rules.splice(this.#rules.indexOf(rule), 1);
      }
    }
    return rule;
  }
}
