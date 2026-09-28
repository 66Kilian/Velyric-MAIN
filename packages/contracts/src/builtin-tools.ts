import type { ToolConfirmationPolicy, ToolSideEffectClass } from './enums.js';

export interface BuiltInToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly sideEffectClass: ToolSideEffectClass;
  readonly confirmationPolicy: ToolConfirmationPolicy;
  readonly idempotencySupported: boolean;
  readonly timeoutMs: number;
  readonly executor: 'CONNECTOR_WORKER' | 'VOICE_RUNTIME';
}

export const BUILT_IN_TOOL_CATALOG_VERSION = 2;
export const KNOWLEDGE_SEARCH_TOOL = 'search_knowledge';

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const LOCAL_DATE = '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$';
const REFERENCE = '^[0-9A-Fa-f]{8}$';
const E164 = '^\\+[1-9][0-9]{6,14}$';

const bookingSummary = {
  type: 'object',
  properties: {
    booking_id: { type: 'string' },
    reference: { type: 'string' },
    status: { type: 'string' },
    starts_at: { type: 'string' },
    ends_at: { type: 'string' },
    local_start: { type: 'string' },
    timezone: { type: 'string' },
    party_size: { type: 'integer' },
    calendar_sync: { type: 'string' },
    replayed: { type: 'boolean' },
  },
  required: ['booking_id', 'reference', 'status', 'local_start'],
  additionalProperties: true,
} as const;

export const BUILT_IN_TOOLS: readonly BuiltInToolDefinition[] = Object.freeze([
  {
    name: 'list_services',
    description:
      'List the bookable services of the practice with their ids, names and durations. Call this before checking availability.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string', pattern: UUID },
        query: { type: 'string', minLength: 1, maxLength: 100 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        services: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              service_id: { type: 'string' },
              name: { type: 'string' },
              duration_minutes: { type: 'integer' },
              location_id: { type: 'string' },
              location_name: { type: 'string' },
            },
            required: ['service_id', 'name', 'duration_minutes'],
            additionalProperties: true,
          },
        },
      },
      required: ['services'],
      additionalProperties: true,
    },
    sideEffectClass: 'READ',
    confirmationPolicy: 'NONE',
    idempotencySupported: true,
    timeoutMs: 3000,
    executor: 'CONNECTOR_WORKER',
  },
  {
    name: 'check_availability',
    description:
      'Find free appointment slots for a service within a date range of at most 14 days in the practice time zone.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', pattern: UUID },
        date_from: { type: 'string', pattern: LOCAL_DATE },
        date_to: { type: 'string', pattern: LOCAL_DATE },
        time_of_day: { enum: ['MORNING', 'AFTERNOON', 'EVENING'] },
        max_results: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['service_id', 'date_from'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        timezone: { type: 'string' },
        slots: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slot_id: { type: 'string' },
              local_start: { type: 'string' },
              starts_at: { type: 'string' },
            },
            required: ['slot_id', 'local_start'],
            additionalProperties: true,
          },
        },
      },
      required: ['slots'],
      additionalProperties: true,
    },
    sideEffectClass: 'READ',
    confirmationPolicy: 'NONE',
    idempotencySupported: true,
    timeoutMs: 5000,
    executor: 'CONNECTOR_WORKER',
  },
  {
    name: 'create_booking',
    description:
      'Book one slot returned by check_availability after the caller confirmed the summary. Before booking, ask whether the caller wants a confirmation by email and, if so, spell back and pass the email address. Pass the phone number only when the caller gives a different number than the one they are calling from.',
    inputSchema: {
      type: 'object',
      properties: {
        slot_id: { type: 'string', minLength: 10, maxLength: 200 },
        customer_name: { type: 'string', minLength: 1, maxLength: 120 },
        party_size: { type: 'integer', minimum: 1, maximum: 50 },
        note: { type: 'string', maxLength: 500 },
        customer_email: { type: 'string', format: 'email', minLength: 3, maxLength: 254 },
        customer_phone: { type: 'string', pattern: E164 },
      },
      required: ['slot_id', 'customer_name'],
      additionalProperties: false,
    },
    outputSchema: bookingSummary,
    sideEffectClass: 'WRITE',
    confirmationPolicy: 'CALLER_CONFIRMATION',
    idempotencySupported: true,
    timeoutMs: 8000,
    executor: 'CONNECTOR_WORKER',
  },
  {
    name: 'find_booking',
    description: 'Look up an existing booking by its 8 character reference or id.',
    inputSchema: {
      type: 'object',
      properties: {
        booking_id: { type: 'string', pattern: UUID },
        reference: { type: 'string', pattern: REFERENCE },
      },
      minProperties: 1,
      additionalProperties: false,
    },
    outputSchema: bookingSummary,
    sideEffectClass: 'READ',
    confirmationPolicy: 'NONE',
    idempotencySupported: true,
    timeoutMs: 3000,
    executor: 'CONNECTOR_WORKER',
  },
  {
    name: 'cancel_booking',
    description:
      'Cancel an existing booking after the caller confirmed which booking should be cancelled.',
    inputSchema: {
      type: 'object',
      properties: {
        booking_id: { type: 'string', pattern: UUID },
        reference: { type: 'string', pattern: REFERENCE },
        reason: { type: 'string', maxLength: 300 },
      },
      minProperties: 1,
      additionalProperties: false,
    },
    outputSchema: bookingSummary,
    sideEffectClass: 'WRITE',
    confirmationPolicy: 'CALLER_CONFIRMATION',
    idempotencySupported: true,
    timeoutMs: 8000,
    executor: 'CONNECTOR_WORKER',
  },
  {
    name: 'reschedule_booking',
    description:
      'Move an existing booking to a new slot returned by check_availability after the caller confirmed both the booking and the new time. The original booking is released.',
    inputSchema: {
      type: 'object',
      properties: {
        booking_id: { type: 'string', pattern: UUID },
        reference: { type: 'string', pattern: REFERENCE },
        slot_id: { type: 'string', minLength: 10, maxLength: 200 },
        party_size: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['slot_id'],
      minProperties: 2,
      additionalProperties: false,
    },
    outputSchema: bookingSummary,
    sideEffectClass: 'WRITE',
    confirmationPolicy: 'CALLER_CONFIRMATION',
    idempotencySupported: true,
    timeoutMs: 10000,
    executor: 'CONNECTOR_WORKER',
  },
  {
    name: KNOWLEDGE_SEARCH_TOOL,
    description:
      'Search the practice knowledge base (opening hours, prices, policies, directions, FAQ). Use the returned passages as the only source for factual answers.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 2, maxLength: 300 } },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source_title: { type: 'string' },
              content: { type: 'string' },
              freshness: { type: 'string' },
            },
            required: ['content'],
            additionalProperties: true,
          },
        },
      },
      required: ['results'],
      additionalProperties: true,
    },
    sideEffectClass: 'READ',
    confirmationPolicy: 'NONE',
    idempotencySupported: true,
    timeoutMs: 3000,
    executor: 'VOICE_RUNTIME',
  },
] satisfies readonly BuiltInToolDefinition[]);

export const BUILT_IN_TOOL_NAMES: ReadonlySet<string> = new Set(
  BUILT_IN_TOOLS.map((tool) => tool.name),
);
