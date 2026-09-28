import { describe, expect, it } from 'vitest';
import {
  CALLER_NOTIFICATION_TYPES,
  callerPlaceholders,
  defaultCallerTemplate,
  renderCallerEmail,
  unknownPlaceholders,
} from '../src/caller.js';
import type { NotificationLocale } from '../src/index.js';

const BRANDING = {
  businessName: 'Bistro <Test>',
  logoUrl: null,
  color: '#0F766E',
  footer: 'Main street 1\n+36 1 234 5678',
};

describe('guest email templates', () => {
  it('only uses known placeholders in every default template', () => {
    for (const type of CALLER_NOTIFICATION_TYPES) {
      for (const locale of ['hu', 'de', 'en'] as const satisfies readonly NotificationLocale[]) {
        const template = defaultCallerTemplate(type, locale);
        expect(unknownPlaceholders(type, template.subject, template.body)).toEqual([]);
      }
    }
  });

  it('reports placeholders that do not belong to the email type', () => {
    expect(
      unknownPlaceholders('CALLER_BOOKING_CANCELED', '{{previous_date}} {{caller_name}}'),
    ).toEqual(['previous_date']);
    expect(callerPlaceholders('CALLER_BOOKING_CHANGED')).toContain('previous_date');
  });

  it('fills placeholders, escapes guest-controlled text and drops missing values', () => {
    const rendered = renderCallerEmail({
      type: 'CALLER_BOOKING_CONFIRMATION',
      locale: 'en',
      template: {
        subject: 'Hi {{caller_name}}\n{{unknown_value}}',
        body: 'Table for {{party_size}}\n\n\n\nSee you <script>alert(1)</script>',
      },
      payload: { caller_name: 'Anna "A" <b>', party_size: '4' },
      branding: BRANDING,
      customized: true,
    });
    expect(rendered.subject).toBe('Hi Anna "A" <b>');
    expect(rendered.text).toBe(
      'Table for 4\n\nSee you <script>alert(1)</script>\n\n\n\nMain street 1\n+36 1 234 5678',
    );
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).toContain('Bistro &lt;Test&gt;');
    expect(rendered.html).toContain('border-top:4px solid #0F766E');
    expect(rendered.templateKey).toBe('caller_booking_confirmation.en.custom');
  });

  it('shows the logo when one is provided', () => {
    const rendered = renderCallerEmail({
      type: 'CALLER_WAITLIST_OFFER',
      locale: 'hu',
      template: defaultCallerTemplate('CALLER_WAITLIST_OFFER', 'hu'),
      payload: { business_name: 'Bistro' },
      branding: { ...BRANDING, logoUrl: 'cid:velyric-brand-logo' },
      customized: false,
    });
    expect(rendered.html).toContain('src="cid:velyric-brand-logo"');
    expect(rendered.templateKey).toBe('caller_waitlist_offer.hu');
  });
});
