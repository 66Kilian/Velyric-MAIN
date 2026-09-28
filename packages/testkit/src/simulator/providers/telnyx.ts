import { createHash } from 'node:crypto';
import type { ProviderModule, SimulatorContext } from '../context.js';
import { bearer, json, jsonBody, type Router, type SimRequest, type SimResponse } from '../http.js';

type TelnyxObject = Record<string, unknown>;
type NumberType = 'local' | 'national' | 'toll_free' | 'mobile';

interface RequirementType {
  readonly id: string;
  readonly name: string;
  readonly type: 'textual' | 'document' | 'address';
  readonly description: string;
}

interface Order {
  readonly object: TelnyxObject;
  readonly createdAtMs: number;
  readonly requiresReview: boolean;
}

const CALLING_CODES: Readonly<Record<string, string>> = {
  HU: '36',
  DE: '49',
  AT: '43',
  SK: '421',
  RO: '40',
};
const PREFIXES: Readonly<Record<NumberType, Readonly<Record<string, string>>>> = {
  local: { HU: '1', DE: '30', AT: '1', SK: '2', RO: '21' },
  national: { HU: '21', DE: '32', AT: '720', SK: '850', RO: '31' },
  toll_free: { HU: '80', DE: '800', AT: '800', SK: '800', RO: '800' },
  mobile: { HU: '70', DE: '151', AT: '660', SK: '905', RO: '72' },
};
const SUBSCRIBER_DIGITS: Readonly<Record<NumberType, number>> = {
  local: 7,
  national: 6,
  toll_free: 6,
  mobile: 7,
};

function telnyxError(status: number, code: string, title: string, detail: string): SimResponse {
  return json(status, { errors: [{ code, title, detail }] });
}

function isNumberType(value: unknown): value is NumberType {
  return value === 'local' || value === 'national' || value === 'toll_free' || value === 'mobile';
}

export class TelnyxSimulator implements ProviderModule {
  readonly #context: SimulatorContext;
  readonly #reserved = new Map<string, string>();
  readonly #ordered = new Set<string>();
  readonly #soldOut = new Set<string>();
  readonly #groups = new Map<string, TelnyxObject>();
  readonly #documents = new Map<string, TelnyxObject>();
  readonly #addresses = new Map<string, TelnyxObject>();
  readonly #reservations = new Map<string, TelnyxObject>();
  readonly #messages: TelnyxObject[] = [];
  readonly #orders = new Map<string, Order>();
  #decision: 'approve' | 'decline' = 'approve';
  #approvalMs: number;

  constructor(context: SimulatorContext) {
    this.#context = context;
    this.#approvalMs = context.config.telnyxOrderApprovalMs;
  }

  snapshot(): Record<string, number> {
    return {
      reservations: this.#reservations.size,
      requirement_groups: this.#groups.size,
      documents: this.#documents.size,
      orders: this.#orders.size,
      messages: this.#messages.length,
    };
  }

  register(api: Router, control: Router): void {
    const base = '/telnyx/v2';
    api.add('GET', `${base}/available_phone_numbers`, (request) =>
      this.#auth(request, () => this.#available(request)),
    );
    api.add('POST', `${base}/messages`, (request) =>
      this.#auth(request, () => this.#sendMessage(request)),
    );
    api.add('POST', `${base}/number_reservations`, (request) =>
      this.#auth(request, () => this.#reserve(request)),
    );
    api.add('GET', `${base}/requirements`, (request) =>
      this.#auth(request, () => this.#requirements(request)),
    );
    api.add('POST', `${base}/requirement_groups`, (request) =>
      this.#auth(request, () => this.#createGroup(request)),
    );
    api.add('POST', `${base}/documents`, (request) =>
      this.#auth(request, () => this.#uploadDocument(request)),
    );
    api.add('POST', `${base}/addresses`, (request) =>
      this.#auth(request, () => this.#createAddress(request)),
    );
    api.add('GET', `${base}/number_orders`, (request) =>
      this.#auth(request, () => this.#listOrders(request)),
    );
    api.add('POST', `${base}/number_orders`, (request) =>
      this.#auth(request, () => this.#createOrder(request)),
    );
    api.add('GET', `${base}/number_orders/:id`, (request) =>
      this.#auth(request, () => {
        const order = this.#orders.get(request.params['id'] ?? '');
        return order === undefined
          ? telnyxError(404, '10005', 'Resource not found', 'The number order does not exist.')
          : json(200, { data: this.#advance(order) });
      }),
    );

    control.add('GET', '/_control/telnyx/messages', () =>
      json(200, { data: this.#messages.slice(-100) }),
    );
    control.add('POST', '/_control/telnyx/regulatory', (request) => {
      const body = jsonBody(request);
      if (body['decision'] !== 'approve' && body['decision'] !== 'decline') {
        return json(400, { error: 'decision must be approve or decline' });
      }
      this.#decision = body['decision'];
      if (typeof body['approval_ms'] === 'number' && body['approval_ms'] >= 0) {
        this.#approvalMs = Math.min(body['approval_ms'], 3_600_000);
      }
      return json(200, { decision: this.#decision, approval_ms: this.#approvalMs });
    });
    control.add('POST', '/_control/telnyx/inventory', (request) => {
      const body = jsonBody(request);
      if (
        typeof body['country'] !== 'string' ||
        !isNumberType(body['number_type']) ||
        typeof body['available'] !== 'boolean'
      ) {
        return json(400, { error: 'country, number_type and available are required' });
      }
      const key = `${body['country'].toUpperCase()}:${body['number_type']}`;
      if (body['available']) {
        this.#soldOut.delete(key);
      } else {
        this.#soldOut.add(key);
      }
      return json(200, { key, available: body['available'] });
    });
  }

  #auth(request: SimRequest, next: () => SimResponse): SimResponse {
    return bearer(request) === this.#context.config.credentials.telnyxApiKey
      ? next()
      : telnyxError(401, '10009', 'Authentication failed', 'The API key is invalid.');
  }

  #inventory(country: string, numberType: NumberType): string[] {
    return this.#soldOut.has(`${country}:${numberType}`) ? [] : this.#catalog(country, numberType);
  }

  #catalog(country: string, numberType: NumberType): string[] {
    const code = CALLING_CODES[country];
    const prefix = PREFIXES[numberType][country];
    if (code === undefined || prefix === undefined) {
      return [];
    }
    const digits = SUBSCRIBER_DIGITS[numberType];
    return Array.from({ length: 25 }, (_, index) => {
      const hash = createHash('sha256')
        .update(`${this.#context.config.seed}:${country}:${numberType}:${String(index)}`)
        .digest();
      const subscriber = String(hash.readUInt32BE(0) % 10 ** digits).padStart(digits, '0');
      return `+${code}${prefix}${subscriber}`;
    });
  }

  #numberTypeOf(
    e164: string,
  ): { readonly country: string; readonly numberType: NumberType } | null {
    for (const country of Object.keys(CALLING_CODES)) {
      for (const numberType of ['local', 'national', 'toll_free', 'mobile'] as const) {
        if (this.#catalog(country, numberType).includes(e164)) {
          return { country, numberType };
        }
      }
    }
    return null;
  }

  #requirementTypes(country: string, numberType: NumberType): RequirementType[] {
    if (numberType === 'mobile' || CALLING_CODES[country] === undefined) {
      return [];
    }
    const prefix = `${country.toLowerCase()}-${numberType}`;
    const types: RequirementType[] = [
      {
        id: `req-${prefix}-address`,
        name: 'Business address in country',
        type: 'address',
        description: 'Registered business address in the number country.',
      },
      {
        id: `req-${prefix}-registration`,
        name: 'Company registration extract',
        type: 'document',
        description: 'Official company registration document not older than 3 months.',
      },
    ];
    if (numberType !== 'toll_free') {
      types.push({
        id: `req-${prefix}-contact`,
        name: 'Contact person full name',
        type: 'textual',
        description: 'Name of the person responsible for the number.',
      });
    }
    return types;
  }

  #available(request: SimRequest): SimResponse {
    const country = (request.query.get('filter[country_code]') ?? '').toUpperCase();
    const numberType = request.query.get('filter[phone_number_type]');
    if (!/^[A-Z]{2}$/.test(country) || !isNumberType(numberType)) {
      return telnyxError(
        422,
        '10015',
        'Invalid filter',
        'filter[country_code] and filter[phone_number_type] are required.',
      );
    }
    const limit = Math.min(Number(request.query.get('filter[limit]') ?? '10') || 10, 25);
    const data = this.#inventory(country, numberType)
      .filter((e164) => !this.#reserved.has(e164) && !this.#ordered.has(e164))
      .slice(0, limit)
      .map((e164) => ({
        record_type: 'available_phone_number',
        phone_number: e164,
        vanity_format: null,
        best_effort: false,
        quickship: true,
        reservable: true,
        region_information: [{ region_type: 'country_code', region_name: country }],
        cost_information: { upfront_cost: '1.00', monthly_cost: '1.00', currency: 'USD' },
        features: [{ name: 'voice' }, { name: 'sms' }],
      }));
    return json(200, { data, metadata: { total_results: data.length, best_effort_results: 0 } });
  }

  #sendMessage(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const from = body['from'];
    const to = body['to'];
    const text = body['text'];
    if (
      typeof from !== 'string' ||
      typeof to !== 'string' ||
      !/^\+[1-9][0-9]{6,14}$/.test(to) ||
      typeof text !== 'string' ||
      text.length === 0
    ) {
      return telnyxError(422, '40001', 'Invalid parameters', 'from, to and text are required.');
    }
    const message: TelnyxObject = {
      id: this.#context.ids.uuid('telnyx_message'),
      record_type: 'message',
      direction: 'outbound',
      type: 'SMS',
      from: { phone_number: from },
      to: [{ phone_number: to, status: 'queued' }],
      text,
      parts: Math.max(1, Math.ceil(text.length / 153)),
      created_at: new Date().toISOString(),
    };
    this.#messages.push(message);
    if (this.#messages.length > 1000) {
      this.#messages.shift();
    }
    return json(200, { data: message });
  }

  #reserve(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const numbers = Array.isArray(body['phone_numbers'])
      ? (body['phone_numbers'] as TelnyxObject[])
      : [];
    const e164 = numbers[0]?.['phone_number'];
    if (typeof e164 !== 'string' || numbers.length !== 1) {
      return telnyxError(
        422,
        '10015',
        'Invalid parameter',
        'Exactly one phone number must be reserved.',
      );
    }
    const owner = this.#reserved.get(e164);
    const known = this.#numberTypeOf(e164);
    if (
      known === null ||
      !this.#inventory(known.country, known.numberType).includes(e164) ||
      this.#ordered.has(e164) ||
      (owner !== undefined && owner !== body['customer_reference'])
    ) {
      return telnyxError(
        422,
        '10032',
        'Phone number not available',
        `${e164} is not available for reservation.`,
      );
    }
    this.#reserved.set(
      e164,
      typeof body['customer_reference'] === 'string' ? body['customer_reference'] : '',
    );
    const now = this.#context.now();
    const reservation: TelnyxObject = {
      id: this.#context.ids.uuid('telnyx_reservation'),
      record_type: 'number_reservation',
      status: 'success',
      customer_reference: body['customer_reference'] ?? null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      phone_numbers: [
        {
          id: this.#context.ids.uuid('telnyx_reservation_number'),
          record_type: 'reserved_phone_number',
          phone_number: e164,
          status: 'success',
          expired_at: new Date(now.getTime() + 30 * 60_000).toISOString(),
        },
      ],
    };
    this.#reservations.set(String(reservation['id']), reservation);
    return json(200, { data: reservation });
  }

  #requirements(request: SimRequest): SimResponse {
    const country = (request.query.get('filter[country_code]') ?? '').toUpperCase();
    const numberType = request.query.get('filter[phone_number_type]');
    if (!/^[A-Z]{2}$/.test(country) || !isNumberType(numberType)) {
      return telnyxError(
        422,
        '10015',
        'Invalid filter',
        'filter[country_code] and filter[phone_number_type] are required.',
      );
    }
    const types = this.#requirementTypes(country, numberType);
    const data =
      types.length === 0
        ? []
        : [
            {
              id: this.#context.ids.uuid(`telnyx_requirement_${country}_${numberType}`),
              record_type: 'requirement',
              country_code: country,
              phone_number_type: numberType,
              action: request.query.get('filter[action]') ?? 'ordering',
              locality: null,
              requirements_types: types,
              requirement_types: types,
            },
          ];
    return json(200, {
      data,
      meta: { page_number: 1, page_size: 20, total_pages: 1, total_results: data.length },
    });
  }

  #createGroup(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const country =
      typeof body['country_code'] === 'string' ? body['country_code'].toUpperCase() : '';
    const numberType = body['phone_number_type'];
    if (!isNumberType(numberType)) {
      return telnyxError(422, '10015', 'Invalid parameter', 'phone_number_type is invalid.');
    }
    const expected = this.#requirementTypes(country, numberType);
    const provided = Array.isArray(body['regulatory_requirements'])
      ? (body['regulatory_requirements'] as TelnyxObject[])
      : [];
    const missing = expected.filter(
      (type) =>
        !provided.some(
          (entry) =>
            entry['requirement_id'] === type.id &&
            typeof entry['field_value'] === 'string' &&
            entry['field_value'] !== '',
        ),
    );
    if (missing.length > 0) {
      return telnyxError(
        422,
        '10015',
        'Missing regulatory requirements',
        `Missing values for ${missing.map((type) => type.id).join(', ')}.`,
      );
    }
    for (const entry of provided) {
      const type = expected.find((candidate) => candidate.id === entry['requirement_id']);
      const value = String(entry['field_value']);
      if (type?.type === 'document' && !this.#documents.has(value)) {
        return telnyxError(422, '10015', 'Invalid document', `Document ${value} does not exist.`);
      }
      if (type?.type === 'address' && !this.#addresses.has(value)) {
        return telnyxError(422, '10015', 'Invalid address', `Address ${value} does not exist.`);
      }
    }
    const now = this.#context.now().toISOString();
    const group: TelnyxObject = {
      id: this.#context.ids.uuid('telnyx_requirement_group'),
      record_type: 'requirement_group',
      country_code: country,
      phone_number_type: numberType,
      action: body['action'] ?? 'ordering',
      customer_reference: body['customer_reference'] ?? null,
      status: 'pending-approval',
      regulatory_requirements: provided.map((entry) => ({ ...entry, status: 'pending-approval' })),
      created_at: now,
      updated_at: now,
    };
    this.#groups.set(String(group['id']), group);
    return json(200, group);
  }

  #uploadDocument(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const filename = body['filename'];
    const file = body['file'];
    if (
      typeof filename !== 'string' ||
      filename.trim() === '' ||
      typeof file !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(file)
    ) {
      return telnyxError(
        422,
        '10015',
        'Invalid document',
        'filename and base64 file content are required.',
      );
    }
    const content = Buffer.from(file, 'base64');
    if (content.length === 0 || content.length > 10 * 1024 * 1024) {
      return telnyxError(
        422,
        '10015',
        'Invalid document',
        'Documents must be between 1 byte and 10 MB.',
      );
    }
    const document: TelnyxObject = {
      id: this.#context.ids.uuid('telnyx_document'),
      record_type: 'document',
      filename,
      status: 'pending',
      content_type: filename.toLowerCase().endsWith('.pdf')
        ? 'application/pdf'
        : 'application/octet-stream',
      size: { amount: content.length, unit: 'bytes' },
      sha256: createHash('sha256').update(content).digest('hex'),
      customer_reference: body['customer_reference'] ?? null,
      created_at: this.#context.now().toISOString(),
    };
    this.#documents.set(String(document['id']), document);
    return json(200, { data: document });
  }

  #createAddress(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const required = ['street_address', 'locality', 'country_code'];
    const missing = required.filter(
      (field) => typeof body[field] !== 'string' || body[field] === '',
    );
    const named =
      typeof body['business_name'] === 'string' ||
      (typeof body['first_name'] === 'string' && typeof body['last_name'] === 'string');
    if (missing.length > 0 || !named) {
      return telnyxError(
        422,
        '10015',
        'Invalid address',
        `Missing ${[...missing, ...(named ? [] : ['business_name'])].join(', ')}.`,
      );
    }
    const address: TelnyxObject = {
      ...body,
      id: this.#context.ids.uuid('telnyx_address'),
      record_type: 'address',
      address_book: false,
      validate_address: true,
      created_at: this.#context.now().toISOString(),
    };
    this.#addresses.set(String(address['id']), address);
    return json(200, { data: address });
  }

  #advance(order: Order): TelnyxObject {
    const object = order.object as Record<string, unknown>;
    const numbers = object['phone_numbers'] as Record<string, unknown>[];
    if (
      object['status'] === 'pending' &&
      this.#context.now().getTime() - order.createdAtMs >= this.#approvalMs
    ) {
      const declined = order.requiresReview && this.#decision === 'decline';
      object['status'] = declined ? 'failure' : 'success';
      object['updated_at'] = this.#context.now().toISOString();
      for (const number of numbers) {
        number['status'] = declined ? 'failure' : 'success';
        number['requirements_met'] = !declined;
        number['requirements_status'] = declined ? 'requirement-info-exception' : 'approved';
        if (declined) {
          this.#ordered.delete(String(number['phone_number']));
        }
      }
    }
    return object;
  }

  #listOrders(request: SimRequest): SimResponse {
    const reference = request.query.get('filter[customer_reference]');
    const data = [...this.#orders.values()]
      .map((order) => this.#advance(order))
      .filter((order) => reference === null || order['customer_reference'] === reference);
    return json(200, {
      data,
      meta: { page_number: 1, page_size: 20, total_pages: 1, total_results: data.length },
    });
  }

  #createOrder(request: SimRequest): SimResponse {
    const body = jsonBody(request);
    const numbers = Array.isArray(body['phone_numbers'])
      ? (body['phone_numbers'] as TelnyxObject[])
      : [];
    const first = numbers[0];
    const e164 = first?.['phone_number'];
    if (
      typeof body['connection_id'] !== 'string' ||
      typeof e164 !== 'string' ||
      numbers.length !== 1
    ) {
      return telnyxError(
        422,
        '10015',
        'Invalid parameter',
        'connection_id and exactly one phone number are required.',
      );
    }
    const known = this.#numberTypeOf(e164);
    const reservedBy = this.#reserved.get(e164);
    if (
      known === null ||
      this.#ordered.has(e164) ||
      (reservedBy !== undefined && reservedBy !== body['customer_reference'])
    ) {
      return telnyxError(422, '10032', 'Phone number not available', `${e164} cannot be ordered.`);
    }
    const requirementTypes = this.#requirementTypes(known.country, known.numberType);
    const groupId = first?.['requirement_group_id'];
    if (
      requirementTypes.length > 0 &&
      (typeof groupId !== 'string' || !this.#groups.has(groupId))
    ) {
      return telnyxError(
        422,
        '10038',
        'Regulatory requirements missing',
        'A requirement_group_id is required for this number.',
      );
    }
    this.#ordered.add(e164);
    this.#reserved.delete(e164);
    const now = this.#context.now();
    const requiresReview = requirementTypes.length > 0;
    const object: TelnyxObject = {
      id: this.#context.ids.uuid('telnyx_number_order'),
      record_type: 'number_order',
      status: 'pending',
      connection_id: body['connection_id'],
      customer_reference: body['customer_reference'] ?? null,
      phone_numbers_count: 1,
      requirements_met: !requiresReview,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      phone_numbers: [
        {
          id: this.#context.ids.uuid('telnyx_order_number'),
          record_type: 'number_order_phone_number',
          phone_number: e164,
          country_code: known.country,
          phone_number_type: known.numberType,
          regulatory_group_id: groupId ?? null,
          status: 'pending',
          requirements_met: !requiresReview,
          requirements_status: requiresReview ? 'requirement-info-under-review' : 'pending',
        },
      ],
    };
    const order = { object, createdAtMs: now.getTime(), requiresReview };
    this.#orders.set(String(object['id']), order);
    return json(200, { data: this.#advance(order) });
  }
}
