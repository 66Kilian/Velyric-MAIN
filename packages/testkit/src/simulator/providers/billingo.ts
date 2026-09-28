import type { ProviderModule, SimulatorContext } from '../context.js';
import { header, json, jsonBody, type Router, type SimRequest, type SimResponse } from '../http.js';

type BillingoObject = Record<string, unknown>;

function billingoError(status: number, message: string): SimResponse {
  return json(status, { error: { message } });
}

export class BillingoSimulator implements ProviderModule {
  readonly #context: SimulatorContext;
  readonly #partners = new Map<number, BillingoObject>();
  readonly #documents = new Map<number, BillingoObject>();
  readonly #sent: { readonly documentId: number; readonly emails: readonly string[] }[] = [];

  constructor(context: SimulatorContext) {
    this.#context = context;
  }

  snapshot(): Record<string, number> {
    return {
      partners: this.#partners.size,
      documents: this.#documents.size,
      sent: this.#sent.length,
    };
  }

  register(api: Router, control: Router): void {
    const base = '/billingo/v3';
    api.add('POST', `${base}/partners`, (request) =>
      this.#auth(request, () => this.#createPartner(request)),
    );
    api.add('POST', `${base}/documents`, (request) =>
      this.#auth(request, () => this.#createDocument(request)),
    );
    api.add('GET', `${base}/documents/:id`, (request) =>
      this.#auth(request, () => {
        const document = this.#documents.get(Number(request.params['id']));
        return document === undefined
          ? billingoError(404, 'Document not found.')
          : json(200, document);
      }),
    );
    api.add('POST', `${base}/documents/:id/send`, (request) =>
      this.#auth(request, () => this.#send(request)),
    );
    control.add('GET', '/_control/billingo/documents', () =>
      json(200, { data: [...this.#documents.values()], sent: this.#sent }),
    );
  }

  #auth(request: SimRequest, next: () => SimResponse): SimResponse {
    return header(request, 'x-api-key') === this.#context.config.credentials.billingoApiKey
      ? next()
      : billingoError(401, 'Invalid API key.');
  }

  #createPartner(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const address =
      typeof body['address'] === 'object' && body['address'] !== null
        ? (body['address'] as BillingoObject)
        : null;
    if (
      typeof body['name'] !== 'string' ||
      body['name'].trim() === '' ||
      address === null ||
      typeof address['country_code'] !== 'string'
    ) {
      return billingoError(422, 'The name and address.country_code fields are required.');
    }
    if (
      address['country_code'] === 'HU' &&
      body['taxcode'] !== '' &&
      typeof body['taxcode'] === 'string' &&
      !/^\d{8}-\d-\d{2}$/.test(body['taxcode'])
    ) {
      return billingoError(422, 'The taxcode format is invalid.');
    }
    const id = this.#context.ids.sequence('billingo_partner') + 1000;
    const partner = { id, ...body };
    this.#partners.set(id, partner);
    return json(201, partner);
  }

  #createDocument(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const partnerId = body['partner_id'];
    const items = Array.isArray(body['items']) ? body['items'] : [];
    if (typeof partnerId !== 'number' || !this.#partners.has(partnerId)) {
      return billingoError(422, 'The selected partner id is invalid.');
    }
    if (typeof body['block_id'] !== 'number' || items.length === 0) {
      return billingoError(422, 'The block_id and items fields are required.');
    }
    const sequence = this.#context.ids.sequence('billingo_document');
    const id = 50_000 + sequence;
    const year = this.#context.now().getUTCFullYear();
    const document = {
      id,
      invoice_number: `VLY-${String(year)}-${String(sequence).padStart(6, '0')}`,
      type: body['type'] ?? 'invoice',
      payment_status: body['paid'] === true ? 'paid' : 'outstanding',
      created_at: this.#context.now().toISOString(),
      ...body,
    };
    this.#documents.set(id, document);
    return json(201, document);
  }

  #send(request: SimRequest): SimResponse {
    const documentId = Number(request.params['id']);
    if (!this.#documents.has(documentId)) {
      return billingoError(404, 'Document not found.');
    }
    const emails = jsonBody(request)['emails'];
    if (
      !Array.isArray(emails) ||
      emails.length === 0 ||
      !emails.every((email) => typeof email === 'string' && email.includes('@'))
    ) {
      return billingoError(422, 'At least one valid email address is required.');
    }
    this.#sent.push({ documentId, emails: emails as string[] });
    return json(200, { emails });
  }
}
