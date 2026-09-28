import type {
  BillingoApi,
  BillingoDocument,
  BillingoInvoiceInput,
  BillingoPartnerInput,
} from '../../src/providers/billingo.js';
import type { EmailSender, OutgoingEmail } from '../../src/providers/email.js';
import type {
  OpenAiProjectAdmin,
  ServiceAccountCredential,
} from '../../src/providers/openai-admin.js';
import type { BillingGateway, PaidInvoice, SubscriptionState } from '../../src/providers/stripe.js';
import type {
  AvailableNumber,
  CarrierAddress,
  CarrierNumberOrder,
  CarrierRequirement,
  CarrierRequirementValue,
  PhoneCarrier,
} from '../../src/providers/telnyx.js';

type Failure = Error | null;

let invoiceSequence = 0;

export class FakeBillingo implements BillingoApi {
  readonly partners: BillingoPartnerInput[] = [];
  readonly invoices: BillingoInvoiceInput[] = [];
  readonly sent: { readonly documentId: number; readonly emails: readonly string[] }[] = [];
  createInvoiceFailure: Failure = null;
  sendFailure: Failure = null;
  #nextId = 9000;

  createPartner(input: BillingoPartnerInput): Promise<number> {
    this.partners.push(input);
    this.#nextId += 1;
    return Promise.resolve(this.#nextId);
  }

  createInvoice(input: BillingoInvoiceInput): Promise<BillingoDocument> {
    if (this.createInvoiceFailure !== null) {
      return Promise.reject(this.createInvoiceFailure);
    }
    this.invoices.push(input);
    this.#nextId += 1;
    invoiceSequence += 1;
    return Promise.resolve({
      id: this.#nextId,
      invoiceNumber: `VLY-2026-${String(invoiceSequence).padStart(5, '0')}`,
    });
  }

  sendInvoice(documentId: number, emails: readonly string[]): Promise<void> {
    if (this.sendFailure !== null) {
      return Promise.reject(this.sendFailure);
    }
    this.sent.push({ documentId, emails });
    return Promise.resolve();
  }
}

export class FakeBillingGateway implements BillingGateway {
  readonly invoices = new Map<string, PaidInvoice>();
  readonly subscriptions = new Map<string, SubscriptionState>();

  retrieveInvoice(invoiceId: string): Promise<PaidInvoice> {
    const invoice = this.invoices.get(invoiceId);
    return invoice === undefined
      ? Promise.reject(new Error(`unknown invoice ${invoiceId}`))
      : Promise.resolve(invoice);
  }

  retrieveSubscription(subscriptionId: string): Promise<SubscriptionState> {
    const subscription = this.subscriptions.get(subscriptionId);
    return subscription === undefined
      ? Promise.reject(new Error(`unknown subscription ${subscriptionId}`))
      : Promise.resolve(subscription);
  }
}

export class FakeEmail implements EmailSender {
  readonly provider = 'smtp' as const;
  readonly messages: OutgoingEmail[] = [];

  send(email: OutgoingEmail): Promise<string> {
    this.messages.push(email);
    return Promise.resolve(`message-${String(this.messages.length)}`);
  }
}

export class FakeOpenAi implements OpenAiProjectAdmin {
  readonly projects = new Map<string, string>();
  readonly archived: string[] = [];
  readonly spendLimits = new Map<string, number>();
  readonly serviceAccounts = new Map<string, string>();
  #counter = 0;

  findProjectByName(name: string): Promise<string | null> {
    return Promise.resolve(this.projects.get(name) ?? null);
  }

  createProject(name: string): Promise<string> {
    this.#counter += 1;
    const id = `proj_${String(this.#counter)}`;
    this.projects.set(name, id);
    return Promise.resolve(id);
  }

  setMonthlySpendLimit(projectId: string, usd: number): Promise<void> {
    this.spendLimits.set(projectId, usd);
    return Promise.resolve();
  }

  findServiceAccount(projectId: string, name: string): Promise<string | null> {
    return Promise.resolve(this.serviceAccounts.get(`${projectId}:${name}`) ?? null);
  }

  createServiceAccount(
    projectId: string,
    name: string,
  ): Promise<{
    readonly serviceAccountId: string;
    readonly credential: ServiceAccountCredential | null;
  }> {
    this.#counter += 1;
    const serviceAccountId = `svc_acct_${String(this.#counter)}`;
    this.serviceAccounts.set(`${projectId}:${name}`, serviceAccountId);
    return Promise.resolve({
      serviceAccountId,
      credential: {
        serviceAccountId,
        apiKeyId: `key_${String(this.#counter)}`,
        apiKey: `sk-svcacct-test-${String(this.#counter)}`,
      },
    });
  }

  createServiceAccountKey(
    _projectId: string,
    serviceAccountId: string,
  ): Promise<ServiceAccountCredential> {
    this.#counter += 1;
    return Promise.resolve({
      serviceAccountId,
      apiKeyId: `key_${String(this.#counter)}`,
      apiKey: `sk-svcacct-test-${String(this.#counter)}`,
    });
  }

  archiveProject(projectId: string): Promise<void> {
    this.archived.push(projectId);
    return Promise.resolve();
  }
}

export class FakeCarrier implements PhoneCarrier {
  available: AvailableNumber[] = [{ e164: '+3612345678', numberType: 'local' }];
  requirementList: CarrierRequirement[] = [];
  readonly orders = new Map<string, CarrierNumberOrder & { readonly reference: string }>();
  readonly reservations: string[] = [];
  readonly documents: {
    readonly filename: string;
    readonly bytes: number;
    readonly reference: string;
  }[] = [];
  readonly addresses: CarrierAddress[] = [];
  readonly requirementGroups: {
    readonly reference: string;
    readonly values: readonly CarrierRequirementValue[];
  }[] = [];
  requirementGroupFailure: Error | null = null;
  readonly messages: { readonly from: string; readonly to: string; readonly text: string }[] = [];
  #counter = 0;

  sendSms(from: string, to: string, text: string): Promise<string> {
    this.messages.push({ from, to, text });
    return Promise.resolve(`msg-${String(this.messages.length)}`);
  }

  uploadDocument(
    filename: string,
    contentBase64: string,
    customerReference: string,
  ): Promise<string> {
    this.documents.push({
      filename,
      bytes: Buffer.from(contentBase64, 'base64').length,
      reference: customerReference,
    });
    return Promise.resolve(`doc_${String(this.documents.length)}`);
  }

  createAddress(address: CarrierAddress): Promise<string> {
    this.addresses.push(address);
    return Promise.resolve(`addr_${String(this.addresses.length)}`);
  }

  searchAvailable(
    _country: string,
    numberType: AvailableNumber['numberType'],
  ): Promise<readonly AvailableNumber[]> {
    return Promise.resolve(this.available.filter((number) => number.numberType === numberType));
  }

  reserve(
    e164: string,
  ): Promise<{ readonly reservationId: string; readonly expiresAt: string | null }> {
    this.reservations.push(e164);
    return Promise.resolve({
      reservationId: `res_${String(this.reservations.length)}`,
      expiresAt: null,
    });
  }

  requirements(): Promise<readonly CarrierRequirement[]> {
    return Promise.resolve(this.requirementList);
  }

  createRequirementGroup(
    _country: string,
    _numberType: AvailableNumber['numberType'],
    customerReference: string,
    values: readonly CarrierRequirementValue[],
  ): Promise<string> {
    if (this.requirementGroupFailure !== null) {
      return Promise.reject(this.requirementGroupFailure);
    }
    this.requirementGroups.push({ reference: customerReference, values });
    return Promise.resolve(`rg_${String(this.requirementGroups.length)}`);
  }

  findOrderByReference(customerReference: string): Promise<CarrierNumberOrder | null> {
    return Promise.resolve(
      [...this.orders.values()].find((order) => order.reference === customerReference) ?? null,
    );
  }

  createOrder(
    _e164: string,
    _connectionId: string,
    customerReference: string,
  ): Promise<CarrierNumberOrder> {
    this.#counter += 1;
    const order = {
      orderId: `order_${String(this.#counter)}`,
      status: 'pending' as const,
      requirementsStatus: null,
      reference: customerReference,
    };
    this.orders.set(order.orderId, order);
    return Promise.resolve(order);
  }

  retrieveOrder(orderId: string): Promise<CarrierNumberOrder> {
    const order = this.orders.get(orderId);
    return order === undefined
      ? Promise.reject(new Error(`unknown order ${orderId}`))
      : Promise.resolve(order);
  }

  complete(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order !== undefined) {
      this.orders.set(orderId, { ...order, status: 'success' });
    }
  }
}
