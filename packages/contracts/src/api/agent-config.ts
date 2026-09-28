import Type, { type Static } from 'typebox';

const E164_PATTERN = '^\\+[1-9][0-9]{6,14}$';
const HHMM_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
const TOOL_NAME_PATTERN = '^[a-z][a-z0-9_]{2,63}$';
const LABEL_PATTERN = '^[a-z0-9_-]{2,40}$';

const Percent = Type.Integer({ minimum: 0, maximum: 100 });
const Label = Type.String({ pattern: LABEL_PATTERN });
const closed = { additionalProperties: false } as const;

export const AGENT_CONFIG_SCHEMA_VERSION = 1;

export const LocaleSchema = Type.Union([
  Type.Literal('hu'),
  Type.Literal('de'),
  Type.Literal('en'),
]);

export const PersonaSchema = Type.Object(
  {
    warmth: Percent,
    formality: Percent,
    energy: Percent,
    pace: Percent,
    brevity: Percent,
    empathy: Percent,
    humor: Percent,
    assertiveness: Percent,
  },
  closed,
);

export const LanguageConfigSchema = Type.Object(
  {
    locale: LocaleSchema,
    greeting: Type.String({ minLength: 1, maxLength: 500 }),
    fallback: Type.String({ minLength: 1, maxLength: 500 }),
    closing: Type.String({ minLength: 1, maxLength: 500 }),
  },
  closed,
);

const DisclosureText = Type.String({ minLength: 10, maxLength: 400 });

export const DisclosureSchema = Type.Object(
  {
    version: Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}\\.[0-9]{1,3}$' }),
    texts: Type.Object(
      {
        hu: Type.Optional(DisclosureText),
        de: Type.Optional(DisclosureText),
        en: Type.Optional(DisclosureText),
      },
      closed,
    ),
  },
  closed,
);

export const SpecialistKindSchema = Type.Union([
  Type.Literal('RECEPTION_ROUTER'),
  Type.Literal('BOOKING'),
  Type.Literal('SUPPORT'),
  Type.Literal('SALES'),
  Type.Literal('BILLING'),
  Type.Literal('HANDOFF_COMPLIANCE'),
]);

export const SpecialistModelTierSchema = Type.Union([
  Type.Literal('ROUTINE'),
  Type.Literal('COMPLEX'),
  Type.Literal('ESCALATION'),
  Type.Literal('FRONTIER'),
]);

export const SpecialistSchema = Type.Object(
  {
    kind: SpecialistKindSchema,
    enabled: Type.Boolean(),
    tool_allowlist: Type.Array(Type.String({ pattern: TOOL_NAME_PATTERN }), {
      maxItems: 50,
      uniqueItems: true,
    }),
    max_tool_executions: Type.Integer({ minimum: 0, maximum: 50 }),
    model_tier: SpecialistModelTierSchema,
  },
  closed,
);

export const HandoffDestinationSchema = Type.Object(
  {
    label: Label,
    e164: Type.String({ pattern: E164_PATTERN }),
    description: Type.String({ minLength: 1, maxLength: 120 }),
  },
  closed,
);

export const DtmfBindingSchema = Type.Object(
  {
    sequence: Type.String({ pattern: '^[0-9*#]{1,4}$' }),
    action: Type.Union([
      Type.Literal('HUMAN_TRANSFER'),
      Type.Literal('BACK'),
      Type.Literal('REPEAT_MENU'),
    ]),
    destination_label: Type.Optional(Label),
  },
  closed,
);

export const HandoffSchema = Type.Object(
  {
    destinations: Type.Array(HandoffDestinationSchema, { maxItems: 20 }),
    default_destination_label: Type.Optional(Label),
    dtmf: Type.Array(DtmfBindingSchema, { maxItems: 12 }),
    warm_transfer: Type.Boolean(),
    failed_understandings_before_offer: Type.Integer({ minimum: 1, maximum: 5 }),
    no_answer_behavior: Type.Union([
      Type.Literal('RETURN_TO_AI'),
      Type.Literal('CALLBACK_REQUEST'),
      Type.Literal('ALTERNATE_QUEUE'),
    ]),
  },
  closed,
);

export const LimitsSchema = Type.Object(
  {
    max_call_duration_seconds: Type.Integer({ minimum: 60, maximum: 3600 }),
    max_tool_executions_per_call: Type.Integer({ minimum: 0, maximum: 100 }),
    max_spend_usd_micros_per_call: Type.Integer({ minimum: 0, maximum: 50_000_000 }),
    silence_timeout_seconds: Type.Integer({ minimum: 5, maximum: 60 }),
  },
  closed,
);

export const BusinessHoursEntrySchema = Type.Object(
  {
    iso_weekday: Type.Integer({ minimum: 1, maximum: 7 }),
    opens: Type.String({ pattern: HHMM_PATTERN }),
    closes: Type.String({ pattern: HHMM_PATTERN }),
  },
  closed,
);

export const AfterHoursSchema = Type.Object(
  {
    behavior: Type.Union([
      Type.Literal('TAKE_MESSAGE'),
      Type.Literal('CALLBACK_REQUEST'),
      Type.Literal('TRANSFER_ON_CALL'),
    ]),
    on_call_destination_label: Type.Optional(Label),
  },
  closed,
);

export const OverloadSchema = Type.Object(
  {
    policy: Type.Union([
      Type.Literal('SHORT_QUEUE'),
      Type.Literal('HUMAN_OVERFLOW'),
      Type.Literal('CALLBACK_REQUEST'),
      Type.Literal('VOICEMAIL'),
      Type.Literal('PAID_BURST'),
      Type.Literal('DEGRADED_MESSAGE'),
    ]),
    max_wait_seconds: Type.Integer({ minimum: 0, maximum: 300 }),
    overflow_destination_label: Type.Optional(Label),
  },
  closed,
);

export const PronunciationEntrySchema = Type.Object(
  {
    term: Type.String({ minLength: 1, maxLength: 80 }),
    spoken_as: Type.String({ minLength: 1, maxLength: 120 }),
    locale: LocaleSchema,
  },
  closed,
);

export const AgentConfigSchema = Type.Object(
  {
    schema_version: Type.Literal(AGENT_CONFIG_SCHEMA_VERSION),
    voice: Type.String({ pattern: '^[a-z0-9_-]{2,40}$' }),
    default_locale: LocaleSchema,
    persona: PersonaSchema,
    languages: Type.Array(LanguageConfigSchema, { minItems: 1, maxItems: 3 }),
    disclosure: DisclosureSchema,
    specialists: Type.Array(SpecialistSchema, { minItems: 1, maxItems: 6 }),
    handoff: HandoffSchema,
    limits: LimitsSchema,
    timezone: Type.String({ minLength: 3, maxLength: 64 }),
    business_hours: Type.Array(BusinessHoursEntrySchema, { maxItems: 21 }),
    after_hours: AfterHoursSchema,
    recording: Type.Object({ enabled: Type.Boolean() }, closed),
    overload: OverloadSchema,
    pronunciation: Type.Array(PronunciationEntrySchema, { maxItems: 200 }),
    model_routing: Type.Object(
      { complex_escalation_enabled: Type.Boolean(), premium_reasoning_enabled: Type.Boolean() },
      closed,
    ),
  },
  closed,
);

export type AgentConfig = Static<typeof AgentConfigSchema>;
export type AgentLocale = Static<typeof LocaleSchema>;
export type AgentSpecialistConfig = Static<typeof SpecialistSchema>;
