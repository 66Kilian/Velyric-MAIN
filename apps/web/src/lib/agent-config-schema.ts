import { z } from 'zod';

const percent = z.number().int().min(0).max(100);
const label = z.string().regex(/^[a-z0-9_-]{2,40}$/);
const locale = z.enum(['hu', 'de', 'en']);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const disclosureText = z.string().min(10).max(400);

export const agentConfigSchema = z
  .object({
    schema_version: z.literal(1),
    voice: z.string().regex(/^[a-z0-9_-]{2,40}$/),
    default_locale: locale,
    persona: z
      .object({
        warmth: percent,
        formality: percent,
        energy: percent,
        pace: percent,
        brevity: percent,
        empathy: percent,
        humor: percent,
        assertiveness: percent,
      })
      .strict(),
    languages: z
      .array(
        z
          .object({
            locale,
            greeting: z.string().min(1).max(500),
            fallback: z.string().min(1).max(500),
            closing: z.string().min(1).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(3),
    disclosure: z
      .object({
        version: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]{1,3}$/),
        texts: z
          .object({
            hu: disclosureText.optional(),
            de: disclosureText.optional(),
            en: disclosureText.optional(),
          })
          .strict(),
      })
      .strict(),
    specialists: z
      .array(
        z
          .object({
            kind: z.enum([
              'RECEPTION_ROUTER',
              'BOOKING',
              'SUPPORT',
              'SALES',
              'BILLING',
              'HANDOFF_COMPLIANCE',
            ]),
            enabled: z.boolean(),
            tool_allowlist: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,63}$/)).max(50),
            max_tool_executions: z.number().int().min(0).max(50),
            model_tier: z.enum(['ROUTINE', 'COMPLEX', 'ESCALATION', 'FRONTIER']),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    handoff: z
      .object({
        destinations: z
          .array(
            z
              .object({
                label,
                e164: z.string().regex(/^\+[1-9][0-9]{6,14}$/),
                description: z.string().min(1).max(120),
              })
              .strict(),
          )
          .max(20),
        default_destination_label: label.optional(),
        dtmf: z
          .array(
            z
              .object({
                sequence: z.string().regex(/^[0-9*#]{1,4}$/),
                action: z.enum(['HUMAN_TRANSFER', 'BACK', 'REPEAT_MENU']),
                destination_label: label.optional(),
              })
              .strict(),
          )
          .max(12),
        warm_transfer: z.boolean(),
        failed_understandings_before_offer: z.number().int().min(1).max(5),
        no_answer_behavior: z.enum(['RETURN_TO_AI', 'CALLBACK_REQUEST', 'ALTERNATE_QUEUE']),
      })
      .strict(),
    limits: z
      .object({
        max_call_duration_seconds: z.number().int().min(60).max(3600),
        max_tool_executions_per_call: z.number().int().min(0).max(100),
        max_spend_usd_micros_per_call: z.number().int().min(0).max(50_000_000),
        silence_timeout_seconds: z.number().int().min(5).max(60),
      })
      .strict(),
    timezone: z.string().min(3).max(64),
    business_hours: z
      .array(
        z
          .object({ iso_weekday: z.number().int().min(1).max(7), opens: hhmm, closes: hhmm })
          .strict(),
      )
      .max(21),
    after_hours: z
      .object({
        behavior: z.enum(['TAKE_MESSAGE', 'CALLBACK_REQUEST', 'TRANSFER_ON_CALL']),
        on_call_destination_label: label.optional(),
      })
      .strict(),
    recording: z.object({ enabled: z.boolean() }).strict(),
    overload: z
      .object({
        policy: z.enum([
          'SHORT_QUEUE',
          'HUMAN_OVERFLOW',
          'CALLBACK_REQUEST',
          'VOICEMAIL',
          'PAID_BURST',
          'DEGRADED_MESSAGE',
        ]),
        max_wait_seconds: z.number().int().min(0).max(300),
        overflow_destination_label: label.optional(),
      })
      .strict(),
    pronunciation: z
      .array(
        z
          .object({
            term: z.string().min(1).max(80),
            spoken_as: z.string().min(1).max(120),
            locale,
          })
          .strict(),
      )
      .max(200),
    model_routing: z
      .object({ complex_escalation_enabled: z.boolean(), premium_reasoning_enabled: z.boolean() })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    const locales = config.languages.map((language) => language.locale);
    if (new Set(locales).size !== locales.length) {
      context.addIssue({ code: 'custom', path: ['languages'], message: 'unique_locale' });
    }
    if (!locales.includes(config.default_locale)) {
      context.addIssue({
        code: 'custom',
        path: ['default_locale'],
        message: 'must_be_configured_language',
      });
    }
    for (const entry of locales) {
      if (config.disclosure.texts[entry] === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['disclosure', 'texts', entry],
          message: 'required_for_configured_language',
        });
      }
    }
    if (!config.specialists.some((specialist) => specialist.kind === 'RECEPTION_ROUTER')) {
      context.addIssue({
        code: 'custom',
        path: ['specialists'],
        message: 'reception_router_required',
      });
    }
    const labels = new Set(config.handoff.destinations.map((destination) => destination.label));
    if (labels.size !== config.handoff.destinations.length) {
      context.addIssue({
        code: 'custom',
        path: ['handoff', 'destinations'],
        message: 'unique_label',
      });
    }
    const known = (value: string | undefined) => value === undefined || labels.has(value);
    if (!known(config.handoff.default_destination_label)) {
      context.addIssue({
        code: 'custom',
        path: ['handoff', 'default_destination_label'],
        message: 'unknown_destination',
      });
    }
    if (
      config.after_hours.behavior === 'TRANSFER_ON_CALL' &&
      (config.after_hours.on_call_destination_label === undefined ||
        !labels.has(config.after_hours.on_call_destination_label))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['after_hours', 'on_call_destination_label'],
        message: 'unknown_destination',
      });
    }
    if (
      config.overload.policy === 'HUMAN_OVERFLOW' &&
      (config.overload.overflow_destination_label === undefined ||
        !labels.has(config.overload.overflow_destination_label))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['overload', 'overflow_destination_label'],
        message: 'unknown_destination',
      });
    }
    if (config.overload.policy === 'SHORT_QUEUE' && config.overload.max_wait_seconds === 0) {
      context.addIssue({
        code: 'custom',
        path: ['overload', 'max_wait_seconds'],
        message: 'queue_requires_wait',
      });
    }
    config.specialists.forEach((specialist, index) => {
      if (specialist.max_tool_executions > config.limits.max_tool_executions_per_call) {
        context.addIssue({
          code: 'custom',
          path: ['specialists', index, 'max_tool_executions'],
          message: 'exceeds_call_limit',
        });
      }
    });
    config.business_hours.forEach((entry, index) => {
      if (entry.closes <= entry.opens) {
        context.addIssue({
          code: 'custom',
          path: ['business_hours', index],
          message: 'closes_after_opens',
        });
      }
    });
  });

export type AgentConfigForm = z.infer<typeof agentConfigSchema>;
