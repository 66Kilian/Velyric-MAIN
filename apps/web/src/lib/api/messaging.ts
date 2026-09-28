export type SmtpAuthMethod = 'PASSWORD' | 'GOOGLE_OAUTH';
export type SmtpSecurity = 'TLS' | 'STARTTLS' | 'NONE';
export type CallerNotificationType =
  | 'CALLER_BOOKING_CONFIRMATION'
  | 'CALLER_BOOKING_CHANGED'
  | 'CALLER_BOOKING_CANCELED'
  | 'CALLER_WAITLIST_OFFER';

export interface MessagingSettings {
  readonly sms_enabled: boolean;
  readonly sms_sender_label: string | null;
  readonly brand_color: string;
  readonly brand_footer: string | null;
  readonly brand_logo: string | null;
  readonly version: number;
}

export interface EmailSender {
  readonly id: string;
  readonly status: string;
  readonly auth_method: SmtpAuthMethod;
  readonly account: string | null;
  readonly host: string | null;
  readonly port: number | null;
  readonly security: SmtpSecurity | null;
  readonly username: string | null;
  readonly from_address: string | null;
  readonly from_name: string | null;
  readonly reply_to: string | null;
  readonly last_error_code: string | null;
  readonly last_health_check_at: string | null;
  readonly updated_at: string;
}

export interface EmailTemplate {
  readonly notification_type: CallerNotificationType;
  readonly locale: 'hu' | 'de' | 'en';
  readonly subject: string;
  readonly body: string;
  readonly default_subject: string;
  readonly default_body: string;
  readonly customized: boolean;
  readonly placeholders: readonly string[];
  readonly version: number;
  readonly updated_at: string | null;
}

export interface EmailPreview {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export const GMAIL_DEFAULTS = {
  host: 'smtp.gmail.com',
  port: 465,
  security: 'TLS',
} as const;

export const CALLER_TEMPLATE_ORDER: readonly CallerNotificationType[] = [
  'CALLER_BOOKING_CONFIRMATION',
  'CALLER_BOOKING_CHANGED',
  'CALLER_BOOKING_CANCELED',
  'CALLER_WAITLIST_OFFER',
];

export const TEMPLATE_LOCALES: readonly ('hu' | 'de' | 'en')[] = ['hu', 'de', 'en'];
