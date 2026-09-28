import { classifySmtpError } from '@velyric/notifications/smtp';
import nodemailer, { type Transporter } from 'nodemailer';
import { ProviderCallError } from './errors.js';

export interface EmailAddress {
  readonly name: string;
  readonly address: string;
}

export interface InlineImage {
  readonly cid: string;
  readonly filename: string;
  readonly content: Buffer;
  readonly contentType: string;
}

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly idempotencyKey: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly inlineImages?: readonly InlineImage[];
}

export interface EmailSender {
  readonly provider: 'smtp';
  send(email: OutgoingEmail): Promise<string>;
}

export class SmtpEmailSender implements EmailSender {
  readonly provider = 'smtp' as const;
  readonly #transport: Transporter;
  readonly #from: string | EmailAddress;
  readonly #replyTo: string | null;

  constructor(
    transport: string | Transporter,
    from: string | EmailAddress,
    replyTo: string | null = null,
  ) {
    this.#transport =
      typeof transport === 'string' ? nodemailer.createTransport(transport) : transport;
    this.#from = from;
    this.#replyTo = replyTo;
  }

  async send(email: OutgoingEmail): Promise<string> {
    try {
      const info = await this.#transport.sendMail({
        from: this.#from,
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
        ...(this.#replyTo === null ? {} : { replyTo: this.#replyTo }),
        ...(email.inlineImages === undefined || email.inlineImages.length === 0
          ? {}
          : {
              attachments: email.inlineImages.map((image) => ({
                cid: image.cid,
                filename: image.filename,
                content: image.content,
                contentType: image.contentType,
                contentDisposition: 'inline' as const,
              })),
            }),
        headers: { 'X-Velyric-Notification': email.idempotencyKey },
      });
      return info.messageId;
    } catch (error) {
      const classified = classifySmtpError(error);
      throw new ProviderCallError('smtp', classified.code, classified.message, {
        retryable: !classified.permanent,
        outcomeUnknown:
          classified.code === 'connection_failed' || classified.code === 'send_failed',
        cause: error,
      });
    }
  }

  close(): void {
    this.#transport.close();
  }
}
