import type { AgentConfig } from '@velyric/contracts';
import { agentConfigFixture } from '@velyric/testkit';
import { describe, expect, it } from 'vitest';
import {
  evaluateToolExecution,
  type ToolExecutionRequest,
  type ToolPolicyFacts,
} from '../src/tool-policy.js';

const config: AgentConfig = agentConfigFixture({
  specialists: [
    {
      kind: 'RECEPTION_ROUTER',
      enabled: true,
      tool_allowlist: ['lookup_availability'],
      max_tool_executions: 2,
      model_tier: 'ROUTINE',
    },
    {
      kind: 'BOOKING',
      enabled: true,
      tool_allowlist: ['lookup_availability', 'create_booking', 'refund_deposit'],
      max_tool_executions: 3,
      model_tier: 'ROUTINE',
    },
    {
      kind: 'SALES',
      enabled: false,
      tool_allowlist: ['create_lead'],
      max_tool_executions: 3,
      model_tier: 'ROUTINE',
    },
    {
      kind: 'HANDOFF_COMPLIANCE',
      enabled: true,
      tool_allowlist: [],
      max_tool_executions: 0,
      model_tier: 'ROUTINE',
    },
  ],
});

const read: ToolPolicyFacts = {
  sideEffectClass: 'READ',
  confirmationPolicy: 'NONE',
  status: 'ACTIVE',
};
const write: ToolPolicyFacts = {
  sideEffectClass: 'WRITE',
  confirmationPolicy: 'CALLER_CONFIRMATION',
  status: 'ACTIVE',
};

function request(overrides: Partial<ToolExecutionRequest> = {}): ToolExecutionRequest {
  return {
    specialist: 'BOOKING',
    toolName: 'create_booking',
    conversationState: 'TOOL_EXECUTION',
    confirmation: { confirmedAt: '2026-09-14T10:00:00Z', turnSeq: 7 },
    verifiedIdentity: false,
    executionsInCall: 0,
    executionsBySpecialist: 0,
    ...overrides,
  };
}

function code(facts: ToolPolicyFacts | null, overrides: Partial<ToolExecutionRequest>): string {
  const decision = evaluateToolExecution(config, facts, request(overrides));
  return decision.allowed ? 'ALLOWED' : `${decision.errorCode}:${decision.reason}`;
}

describe('evaluateToolExecution', () => {
  it('allows confirmed writes in the tool execution state', () => {
    expect(code(write, {})).toBe('ALLOWED');
  });

  it('enforces specialist allowlists and tool status', () => {
    expect(code(write, { specialist: 'RECEPTION_ROUTER' })).toBe(
      'TOOL_NOT_ALLOWED:tool_not_in_allowlist',
    );
    expect(code(write, { specialist: 'SALES', toolName: 'create_lead' })).toBe(
      'TOOL_NOT_ALLOWED:specialist_not_enabled',
    );
    expect(code(write, { specialist: 'SUPPORT' })).toBe('TOOL_NOT_ALLOWED:specialist_not_enabled');
    expect(code(null, {})).toBe('TOOL_NOT_ALLOWED:tool_inactive');
    expect(code({ ...write, status: 'KILLED' }, {})).toBe('TOOL_NOT_ALLOWED:tool_inactive');
  });

  it('never lets the model skip the confirmation or compliance gates', () => {
    expect(code(write, { conversationState: 'ACTION_PREVIEW' })).toBe(
      'INVALID_STATE_TRANSITION:write_requires_tool_execution_state',
    );
    expect(code(write, { conversationState: 'GREETING' })).toBe(
      'INVALID_STATE_TRANSITION:write_requires_tool_execution_state',
    );
    expect(code(write, { confirmation: null })).toBe(
      'CONFIRMATION_REQUIRED:caller_confirmation_missing',
    );
    expect(code({ ...write, confirmationPolicy: 'HUMAN_APPROVAL' }, {})).toBe(
      'APPROVAL_REQUIRED:human_approval_required',
    );
    const verified = {
      ...write,
      confirmationPolicy: 'CALLER_CONFIRMATION_WITH_VERIFICATION' as const,
    };
    expect(code(verified, {})).toBe('STEP_UP_REQUIRED:identity_verification_missing');
    expect(code(verified, { verifiedIdentity: true })).toBe('ALLOWED');
    expect(code(verified, { verifiedIdentity: true, confirmation: null })).toBe(
      'CONFIRMATION_REQUIRED:caller_confirmation_missing',
    );
    expect(
      code(
        { ...write, sideEffectClass: 'HIGH_RISK_WRITE', confirmationPolicy: 'NONE' },
        { toolName: 'refund_deposit' },
      ),
    ).toBe('CONFIRMATION_REQUIRED:high_risk_write_requires_confirmation');
  });

  it('lets read tools run during discovery but not during greeting or after the call ends', () => {
    expect(
      code(read, {
        toolName: 'lookup_availability',
        conversationState: 'DISCOVERY',
        confirmation: null,
      }),
    ).toBe('ALLOWED');
    expect(code(read, { toolName: 'lookup_availability', conversationState: 'GREETING' })).toBe(
      'INVALID_STATE_TRANSITION:read_not_allowed_in_state',
    );
    expect(code(read, { toolName: 'lookup_availability', conversationState: 'END' })).toBe(
      'INVALID_STATE_TRANSITION:read_not_allowed_in_state',
    );
  });

  it('stops agent loops with per-call and per-specialist budgets', () => {
    expect(code(write, { executionsInCall: 10 })).toBe(
      'TOOL_BUDGET_EXCEEDED:call_budget_exhausted',
    );
    expect(code(write, { executionsBySpecialist: 3 })).toBe(
      'TOOL_BUDGET_EXCEEDED:specialist_budget_exhausted',
    );
    expect(code(write, { executionsInCall: 9, executionsBySpecialist: 2 })).toBe('ALLOWED');
  });
});
