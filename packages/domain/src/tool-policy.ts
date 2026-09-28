import type {
  AgentConfig,
  ConversationState,
  ToolConfirmationPolicy,
  ToolSideEffectClass,
} from '@velyric/contracts';

export interface ToolPolicyFacts {
  readonly sideEffectClass: ToolSideEffectClass;
  readonly confirmationPolicy: ToolConfirmationPolicy;
  readonly status: 'ACTIVE' | 'DISABLED' | 'KILLED';
}

export interface ToolExecutionRequest {
  readonly specialist: string;
  readonly toolName: string;
  readonly conversationState: ConversationState;
  readonly confirmation: { readonly confirmedAt: string; readonly turnSeq: number } | null;
  readonly verifiedIdentity: boolean;
  readonly executionsInCall: number;
  readonly executionsBySpecialist: number;
}

export type ToolPolicyErrorCode =
  | 'TOOL_NOT_ALLOWED'
  | 'CONFIRMATION_REQUIRED'
  | 'APPROVAL_REQUIRED'
  | 'STEP_UP_REQUIRED'
  | 'TOOL_BUDGET_EXCEEDED'
  | 'INVALID_STATE_TRANSITION';

export type ToolPolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly errorCode: ToolPolicyErrorCode; readonly reason: string };

const READ_STATES: ReadonlySet<ConversationState> = new Set([
  'DISCOVERY',
  'IDENTITY',
  'ACTION_PREVIEW',
  'CONFIRMATION_GATE',
  'TOOL_EXECUTION',
  'RESULT_CONFIRMATION',
  'FOLLOW_UP',
]);

function deny(errorCode: ToolPolicyErrorCode, reason: string): ToolPolicyDecision {
  return { allowed: false, errorCode, reason };
}

export function evaluateToolExecution(
  config: AgentConfig,
  facts: ToolPolicyFacts | null,
  request: ToolExecutionRequest,
): ToolPolicyDecision {
  const specialist = config.specialists.find((candidate) => candidate.kind === request.specialist);
  if (specialist === undefined || !specialist.enabled) {
    return deny('TOOL_NOT_ALLOWED', 'specialist_not_enabled');
  }
  if (!specialist.tool_allowlist.includes(request.toolName)) {
    return deny('TOOL_NOT_ALLOWED', 'tool_not_in_allowlist');
  }
  if (facts === null || facts.status !== 'ACTIVE') {
    return deny('TOOL_NOT_ALLOWED', 'tool_inactive');
  }
  if (request.executionsInCall >= config.limits.max_tool_executions_per_call) {
    return deny('TOOL_BUDGET_EXCEEDED', 'call_budget_exhausted');
  }
  if (request.executionsBySpecialist >= specialist.max_tool_executions) {
    return deny('TOOL_BUDGET_EXCEEDED', 'specialist_budget_exhausted');
  }
  if (facts.sideEffectClass === 'READ') {
    return READ_STATES.has(request.conversationState)
      ? { allowed: true }
      : deny('INVALID_STATE_TRANSITION', 'read_not_allowed_in_state');
  }
  if (request.conversationState !== 'TOOL_EXECUTION') {
    return deny('INVALID_STATE_TRANSITION', 'write_requires_tool_execution_state');
  }
  switch (facts.confirmationPolicy) {
    case 'HUMAN_APPROVAL':
      return deny('APPROVAL_REQUIRED', 'human_approval_required');
    case 'CALLER_CONFIRMATION_WITH_VERIFICATION':
      if (request.confirmation === null) {
        return deny('CONFIRMATION_REQUIRED', 'caller_confirmation_missing');
      }
      return request.verifiedIdentity
        ? { allowed: true }
        : deny('STEP_UP_REQUIRED', 'identity_verification_missing');
    case 'CALLER_CONFIRMATION':
      return request.confirmation === null
        ? deny('CONFIRMATION_REQUIRED', 'caller_confirmation_missing')
        : { allowed: true };
    case 'NONE':
      return facts.sideEffectClass === 'HIGH_RISK_WRITE'
        ? deny('CONFIRMATION_REQUIRED', 'high_risk_write_requires_confirmation')
        : { allowed: true };
  }
}
