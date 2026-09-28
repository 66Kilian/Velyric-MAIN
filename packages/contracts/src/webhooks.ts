import type { EventType } from './enums.js';

export const OUTBOUND_WEBHOOK_EVENT_TYPES = [
  'call.started',
  'call.ended',
  'booking.created',
  'booking.changed',
  'booking.canceled',
  'waitlist.slot_released',
  'contact.merged',
  'privacy.request_created',
  'agent_version.published',
  'agent_version.rolled_back',
  'knowledge.ingestion_completed',
  'knowledge.ingestion_failed',
  'integration.auth_expired',
  'phone_number.status_changed',
  'quality.scored',
  'simulation.run_completed',
] as const satisfies readonly EventType[];

export type OutboundWebhookEventType = (typeof OUTBOUND_WEBHOOK_EVENT_TYPES)[number];

export const OUTBOUND_WEBHOOK_TEST_EVENT = 'webhook.test';
export const OUTBOUND_WEBHOOK_SIGNATURE_HEADER = 'velyric-signature';
export const OUTBOUND_WEBHOOK_MAX_ENDPOINTS = 10;
export const OUTBOUND_WEBHOOK_MAX_ATTEMPTS = 8;
export const OUTBOUND_WEBHOOK_TIMEOUT_MS = 10_000;

export function isOutboundWebhookEventType(value: string): value is OutboundWebhookEventType {
  return (OUTBOUND_WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

export function outboundWebhookRetryDelaySeconds(attempt: number): number {
  const schedule = [30, 120, 600, 1800, 7200, 21_600, 43_200, 86_400];
  return schedule[Math.min(Math.max(attempt, 1), schedule.length) - 1] ?? 86_400;
}
