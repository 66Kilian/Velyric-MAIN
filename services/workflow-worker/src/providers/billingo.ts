import { classifyHttpFailure, classifyTransportFailure, ProviderCallError } from './errors.js';

export type BillingoTaxType = 'HAS_TAX_NUMBER' | 'NO_TAX_NUMBER' | 'FOREIGN';
export type BillingoLanguage = 'hu' | 'de' | 'en';

export interface BillingoPartnerInput {
  readonly name: string;
  readonly countryCode: string;
  readonly postCode: string;
  readonly city: string;
  readonly address: string;
  readonly emails: readonly string[];
  readonly taxCode: string | null;
  readonly taxType: BillingoTaxType;
}

export interface BillingoInvoiceItem {
  readonly name: string;
  readonly netUnitPrice: number;
  readonly quantity: number;
  readonly unit: string;
  readonly vat: string;
}

export interface BillingoInvoiceInput {
  readonly partnerId: number;
  readonly blockId: number;
  readonly fulfillmentDate: string;
  readonly dueDate: string;
  readonly language: BillingoLanguage;
  readonly currency: string;
  readonly items: readonly BillingoInvoiceItem[];
  readonly comment: string;
  readonly orderNumber: string;
}

export interface BillingoDocument {
  readonly id: number;
  readonly invoiceNumber: string;
}

export interface BillingoApi {
  createPartner(input: BillingoPartnerInput): Promise<number>;
  createInvoice(input: BillingoInvoiceInput): Promise<BillingoDocument>;
  sendInvoice(documentId: number, emails: readonly string[]): Promise<void>;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class HttpBillingoApi implements BillingoApi {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(
    apiKey: string,
    baseUrl = 'https://api.billingo.hu/v3',
    fetchImpl: typeof fetch = fetch,
  ) {
    if (apiKey.length === 0) {
      throw new RangeError('a Billingo API key is required');
    }
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#fetch = fetchImpl;
  }

  async #request(
    method: 'POST',
    path: string,
    body: unknown,
    mutating: boolean,
  ): Promise<Readonly<Record<string, unknown>>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          'x-api-key': this.#apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw classifyTransportFailure('billingo', error, mutating);
    }
    const text = await response.text();
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      const error = asRecord(asRecord(parsed)['error']);
      const message =
        typeof error['message'] === 'string'
          ? error['message'].slice(0, 300)
          : `Billingo responded with HTTP ${String(response.status)}`;
      throw classifyHttpFailure(
        'billingo',
        response.status,
        `billingo_http_${String(response.status)}`,
        message,
        mutating,
      );
    }
    return asRecord(parsed);
  }

  async createPartner(input: BillingoPartnerInput): Promise<number> {
    const body = {
      name: input.name,
      address: {
        country_code: input.countryCode,
        post_code: input.postCode,
        city: input.city,
        address: input.address,
      },
      emails: input.emails,
      taxcode: input.taxCode ?? '',
      tax_type: input.taxType,
    };
    const partner = await this.#request('POST', '/partners', body, true);
    const id = partner['id'];
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      throw new ProviderCallError(
        'billingo',
        'malformed_response',
        'Billingo partner response has no id',
        { retryable: false, outcomeUnknown: true },
      );
    }
    return id;
  }

  async createInvoice(input: BillingoInvoiceInput): Promise<BillingoDocument> {
    const body = {
      partner_id: input.partnerId,
      block_id: input.blockId,
      type: 'invoice',
      fulfillment_date: input.fulfillmentDate,
      due_date: input.dueDate,
      payment_method: 'online_bankcard',
      language: input.language,
      currency: input.currency,
      conversion_rate: 1,
      electronic: true,
      paid: true,
      comment: input.comment,
      items: input.items.map((item) => ({
        name: item.name,
        unit_price: item.netUnitPrice,
        unit_price_type: 'net',
        quantity: item.quantity,
        unit: item.unit,
        vat: item.vat,
      })),
      settings: { round: 'none', order_number: input.orderNumber },
    };
    const document = await this.#request('POST', '/documents', body, true);
    const id = document['id'];
    const invoiceNumber = document['invoice_number'];
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      typeof invoiceNumber !== 'string' ||
      invoiceNumber === ''
    ) {
      throw new ProviderCallError(
        'billingo',
        'malformed_response',
        'Billingo document response is incomplete',
        { retryable: false, outcomeUnknown: true },
      );
    }
    return { id, invoiceNumber };
  }

  async sendInvoice(documentId: number, emails: readonly string[]): Promise<void> {
    await this.#request('POST', `/documents/${String(documentId)}/send`, { emails }, false);
  }
}

const EU_COUNTRIES = new Set([
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
]);

export interface TaxProfile {
  readonly customerType: 'BUSINESS' | 'INDIVIDUAL';
  readonly country: string;
  readonly huTaxNumber: string | null;
  readonly euVatId: string | null;
}

export function billingoTaxTreatment(profile: TaxProfile): {
  readonly vat: string;
  readonly taxType: BillingoTaxType;
  readonly taxCode: string | null;
} {
  if (profile.country === 'HU') {
    return profile.customerType === 'BUSINESS' && profile.huTaxNumber !== null
      ? { vat: '27%', taxType: 'HAS_TAX_NUMBER', taxCode: profile.huTaxNumber }
      : { vat: '27%', taxType: 'NO_TAX_NUMBER', taxCode: null };
  }
  if (EU_COUNTRIES.has(profile.country)) {
    return profile.customerType === 'BUSINESS' && profile.euVatId !== null
      ? { vat: 'EUFAD37', taxType: 'FOREIGN', taxCode: profile.euVatId }
      : { vat: '27%', taxType: 'NO_TAX_NUMBER', taxCode: null };
  }
  return {
    vat: 'HO',
    taxType: profile.customerType === 'BUSINESS' ? 'FOREIGN' : 'NO_TAX_NUMBER',
    taxCode: profile.customerType === 'BUSINESS' ? profile.euVatId : null,
  };
}
