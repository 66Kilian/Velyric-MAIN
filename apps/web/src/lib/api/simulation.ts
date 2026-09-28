export const SCENARIO_CLASSES = [
  'HAPPY_PATH',
  'CONVERSATION_STRESS',
  'TOOL_FAILURE',
  'SECURITY',
  'AUDIO_STRESS',
  'CONCURRENCY',
] as const;
export type ScenarioClass = (typeof SCENARIO_CLASSES)[number];

export const ASSERTION_TYPES = [
  'OUTCOME_IN',
  'INTENT_IS',
  'TOOL_CALLED',
  'TOOL_NOT_CALLED',
  'TRANSFERRED',
  'NOT_TRANSFERRED',
  'PHRASE_PRESENT',
  'PHRASE_ABSENT',
  'MAX_AGENT_TURNS',
] as const;
export type AssertionType = (typeof ASSERTION_TYPES)[number];

export type ScenarioAssertion =
  | { readonly type: 'OUTCOME_IN'; readonly values: readonly string[] }
  | { readonly type: 'INTENT_IS'; readonly value: string }
  | { readonly type: 'TOOL_CALLED' | 'TOOL_NOT_CALLED'; readonly tool: string }
  | { readonly type: 'TRANSFERRED' | 'NOT_TRANSFERRED' }
  | { readonly type: 'PHRASE_PRESENT' | 'PHRASE_ABSENT'; readonly phrase: string }
  | { readonly type: 'MAX_AGENT_TURNS'; readonly value: number };

export interface ToolFixture {
  readonly tool: string;
  readonly response?: Readonly<Record<string, unknown>>;
  readonly error_code?: string;
  readonly latency_ms?: number;
}

export interface ScenarioDefinition {
  readonly caller_goal: string;
  readonly caller_persona?: string;
  readonly opening_line: string;
  readonly caller_facts: Readonly<Record<string, string>>;
  readonly max_turns: number;
  readonly tool_fixtures?: readonly ToolFixture[];
}

export interface SimulationScenario {
  readonly id: string;
  readonly suite_id: string;
  readonly scenario_key: string;
  readonly scenario_class: ScenarioClass;
  readonly language: 'hu' | 'de' | 'en';
  readonly definition: ScenarioDefinition;
  readonly deterministic_assertions: readonly ScenarioAssertion[];
  readonly seed: number;
  readonly active: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SimulationSuite {
  readonly id: string;
  readonly agent_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly is_release_gate: boolean;
  readonly min_pass_ratio: number;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly scenarios?: readonly SimulationScenario[];
}

export interface ScenarioRunResult {
  readonly scenario_id: string;
  readonly verdict: 'PASSED' | 'FAILED' | 'ERRORED';
  readonly score: number;
  readonly failed_assertions: readonly string[];
  readonly turns: number;
  readonly duration_ms: number;
  readonly tools_called: readonly string[];
  readonly outcome?: string;
  readonly intent?: string;
  readonly judge_notes?: string;
  readonly error_code?: string;
}

export type RunStatus = 'QUEUED' | 'RUNNING' | 'PASSED' | 'FAILED' | 'ERRORED' | 'CANCELED';

export interface SimulationRun {
  readonly id: string;
  readonly suite_id: string;
  readonly agent_version_id: string;
  readonly status: RunStatus;
  readonly seed: number;
  readonly model_versions: Readonly<Record<string, string>>;
  readonly rubric_version: string;
  readonly tool_fixture_version: string;
  readonly passed_count: number;
  readonly failed_count: number;
  readonly errored_count: number;
  readonly scores: {
    readonly pass_ratio?: number;
    readonly min_pass_ratio?: number;
    readonly results?: readonly ScenarioRunResult[];
    readonly error_code?: string;
  } | null;
  readonly gate_passed: boolean | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly created_at: string;
  readonly previous_run?: SimulationRun | null;
}

export const RUN_ACTIVE: ReadonlySet<string> = new Set(['QUEUED', 'RUNNING']);
