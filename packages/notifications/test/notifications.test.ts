import { NotificationType } from '@velyric/contracts';
import { describe, expect, it } from 'vitest';
import {
  isTemplatedNotification,
  renderNotification,
  requiredPayloadKeys,
  type NotificationLocale,
} from '../src/index.js';

const SAMPLE: Readonly<Record<string, string>> = {
  plan_name: 'BUSINESS',
  renewal_date: '2026-10-01',
  amount_display: '69 900 Ft',
  grace_ends_at: '2026-10-03 23:59',
  billing_url: 'https://app.velyric.com/app/billing',
  action_url: 'https://app.velyric.com/app/onboarding',
  phone_number: '+36 1 234 5678',
  reason: 'documents_missing',
  invoice_number: 'VLY-2026-0001',
  billing_email: 'billing@example.com',
  workspace_name: 'Demo Rendelő',
  inviter_name: 'Kiss Anna',
  role_label: 'Operator',
  expires_at: '2026-09-21 10:00',
  accept_url: 'https://app.velyric.com/app/invitations/t/m',
  member_email: 'na***@example.com',
  actor_name: 'Kiss Anna',
  key_name: 'CRM sync',
  key_prefix: 'vk_live_abcd1234efgh',
  ticket_reference: 'VLY-1A2B3C4D',
  ticket_subject: 'A hívás megszakad',
  ticket_url: 'https://app.velyric.com/app/t/support/abc',
};

describe('notification templates', () => {
  it('renders every template in every locale with all placeholders resolved', () => {
    const types = Object.values(NotificationType).filter(isTemplatedNotification);
    expect(types.length).toBeGreaterThanOrEqual(20);
    for (const type of types) {
      for (const locale of ['hu', 'de', 'en'] as NotificationLocale[]) {
        const rendered = renderNotification(type, locale, SAMPLE);
        expect(rendered.subject.length).toBeGreaterThan(5);
        expect(rendered.text).not.toContain('{{');
        expect(rendered.html).toContain(`lang="${locale}"`);
        expect(rendered.templateKey).toBe(`${type.toLowerCase()}.${locale}`);
      }
    }
  });

  it('escapes payload values in HTML and reports missing keys', () => {
    const rendered = renderNotification('PROVISIONING_DELAYED', 'en', {
      reason: '<script>alert(1)</script>',
    });
    expect(rendered.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered.html).not.toContain('<script>');
    expect(() => renderNotification('RENEWAL_REMINDER_5D', 'hu', { plan_name: 'START' })).toThrow(
      'amount_display, billing_url, renewal_date',
    );
    expect(() =>
      renderNotification('TEST_CALL_READY', 'de', {
        phone_number: '+49 30 1234',
        action_url: 'javascript:alert(1)',
      }),
    ).toThrow('action_url');
    expect(requiredPayloadKeys('GRACE_PERIOD_REMINDER')).toEqual(['billing_url', 'grace_ends_at']);
    expect(isTemplatedNotification('SPEND_CAP_REACHED')).toBe(false);
  });
});
