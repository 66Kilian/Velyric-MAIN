import Telnyx from 'telnyx';
import { ProviderCallError } from './errors.js';

export type CarrierNumberType = 'local' | 'national' | 'mobile' | 'toll_free';

export interface AvailableNumber {
  readonly e164: string;
  readonly numberType: CarrierNumberType;
}

export interface CarrierRequirement {
  readonly requirementId: string;
  readonly name: string;
  readonly fieldType: 'TEXTUAL' | 'DOCUMENT' | 'ADDRESS' | 'ACTION';
}

export interface CarrierRequirementValue {
  readonly requirementId: string;
  readonly value: string;
}

export interface CarrierNumberOrder {
  readonly orderId: string;
  readonly status: 'pending' | 'success' | 'failure';
  readonly requirementsStatus: string | null;
}

export interface CarrierAddress {
  readonly businessName: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly streetAddress: string;
  readonly extendedAddress: string | null;
  readonly locality: string;
  readonly postalCode: string;
  readonly countryCode: string;
}

export interface PhoneCarrier {
  uploadDocument(
    filename: string,
    contentBase64: string,
    customerReference: string,
  ): Promise<string>;
  createAddress(address: CarrierAddress, customerReference: string): Promise<string>;
  searchAvailable(
    country: string,
    numberType: CarrierNumberType,
    limit: number,
  ): Promise<readonly AvailableNumber[]>;
  reserve(
    e164: string,
    customerReference: string,
  ): Promise<{ readonly reservationId: string; readonly expiresAt: string | null }>;
  requirements(
    country: string,
    numberType: CarrierNumberType,
  ): Promise<readonly CarrierRequirement[]>;
  createRequirementGroup(
    country: string,
    numberType: CarrierNumberType,
    customerReference: string,
    values: readonly CarrierRequirementValue[],
  ): Promise<string>;
  findOrderByReference(customerReference: string): Promise<CarrierNumberOrder | null>;
  createOrder(
    e164: string,
    connectionId: string,
    customerReference: string,
    requirementGroupId: string | null,
  ): Promise<CarrierNumberOrder>;
  retrieveOrder(orderId: string): Promise<CarrierNumberOrder>;
  sendSms(from: string, to: string, text: string): Promise<string>;
}

function wrap(error: unknown, operation: string, mutating: boolean): ProviderCallError {
  if (error instanceof Telnyx.APIError) {
    const status = typeof error.status === 'number' ? error.status : 0;
    return new ProviderCallError('telnyx', `telnyx_http_${String(status)}`, `${operation} failed`, {
      retryable: status === 0 || status === 429 || status >= 500,
      outcomeUnknown: mutating && (status === 0 || status >= 500),
      httpStatus: status === 0 ? null : status,
      cause: error,
    });
  }
  return new ProviderCallError('telnyx', 'network_error', `${operation} failed`, {
    retryable: true,
    outcomeUnknown: mutating,
    cause: error,
  });
}

const FIELD_TYPES: Readonly<Record<string, CarrierRequirement['fieldType']>> = {
  document: 'DOCUMENT',
  address: 'ADDRESS',
  textual: 'TEXTUAL',
  action: 'ACTION',
};
const REQUIREMENT_NUMBER_TYPES = new Set<CarrierNumberType>(['local', 'national', 'toll_free']);

interface OrderShape {
  readonly id?: string | undefined;
  readonly status?: string | undefined;
  readonly phone_numbers?:
    ReadonlyArray<{ readonly requirements_status?: string | undefined }> | undefined;
}

function toOrder(data: OrderShape | undefined, operation: string): CarrierNumberOrder {
  if (
    data?.id === undefined ||
    (data.status !== 'pending' && data.status !== 'success' && data.status !== 'failure')
  ) {
    throw new ProviderCallError(
      'telnyx',
      'malformed_response',
      `${operation} returned an incomplete order`,
      { retryable: false, outcomeUnknown: true },
    );
  }
  return {
    orderId: data.id,
    status: data.status,
    requirementsStatus: data.phone_numbers?.[0]?.requirements_status ?? null,
  };
}

export class TelnyxSdkCarrier implements PhoneCarrier {
  readonly #client: Telnyx;

  constructor(apiKey: string, baseURL?: string) {
    if (apiKey.length === 0) {
      throw new RangeError('a Telnyx API key is required');
    }
    this.#client = new Telnyx({
      apiKey,
      maxRetries: 2,
      timeout: 20_000,
      ...(baseURL === undefined ? {} : { baseURL }),
    });
  }

  async searchAvailable(
    country: string,
    numberType: CarrierNumberType,
    limit: number,
  ): Promise<readonly AvailableNumber[]> {
    try {
      const response = await this.#client.availablePhoneNumbers.list({
        filter: {
          country_code: country,
          phone_number_type: numberType,
          features: ['voice'],
          reservable: true,
          exclude_held_numbers: true,
          limit,
        },
      });
      return (response.data ?? []).flatMap((entry) =>
        typeof entry.phone_number === 'string' && /^\+[1-9]\d{6,14}$/.test(entry.phone_number)
          ? [{ e164: entry.phone_number, numberType }]
          : [],
      );
    } catch (error) {
      throw wrap(error, 'number search', false);
    }
  }

  async sendSms(from: string, to: string, text: string): Promise<string> {
    try {
      const response = await this.#client.messages.send({ from, to, text, type: 'SMS' });
      const messageId = response.data?.id;
      if (messageId === undefined) {
        throw new ProviderCallError('telnyx', 'malformed_response', 'message send returned no id', {
          retryable: false,
          outcomeUnknown: true,
        });
      }
      return messageId;
    } catch (error) {
      if (error instanceof ProviderCallError) {
        throw error;
      }
      throw wrap(error, 'message send', true);
    }
  }

  async reserve(
    e164: string,
    customerReference: string,
  ): Promise<{ readonly reservationId: string; readonly expiresAt: string | null }> {
    try {
      const response = await this.#client.numberReservations.create({
        customer_reference: customerReference,
        phone_numbers: [{ phone_number: e164 }],
      });
      const reservation = response.data;
      if (reservation?.id === undefined || reservation.status === 'failure') {
        throw new ProviderCallError(
          'telnyx',
          'reservation_failed',
          'number reservation was not accepted',
          { retryable: false },
        );
      }
      return {
        reservationId: reservation.id,
        expiresAt: reservation.phone_numbers?.[0]?.expired_at ?? null,
      };
    } catch (error) {
      if (error instanceof ProviderCallError) {
        throw error;
      }
      throw wrap(error, 'number reservation', true);
    }
  }

  async requirements(
    country: string,
    numberType: CarrierNumberType,
  ): Promise<readonly CarrierRequirement[]> {
    if (!REQUIREMENT_NUMBER_TYPES.has(numberType)) {
      return [];
    }
    try {
      const found: CarrierRequirement[] = [];
      for await (const requirement of this.#client.requirements.list({
        filter: {
          country_code: country,
          phone_number_type: numberType as 'local' | 'national' | 'toll_free',
          action: 'ordering',
        },
      })) {
        for (const type of requirement.requirement_types ?? []) {
          if (type.id !== undefined && !found.some((entry) => entry.requirementId === type.id)) {
            found.push({
              requirementId: type.id,
              name: type.name ?? type.id,
              fieldType: FIELD_TYPES[type.type ?? 'textual'] ?? 'TEXTUAL',
            });
          }
        }
      }
      return found;
    } catch (error) {
      throw wrap(error, 'requirement lookup', false);
    }
  }

  async createRequirementGroup(
    country: string,
    numberType: CarrierNumberType,
    customerReference: string,
    values: readonly CarrierRequirementValue[],
  ): Promise<string> {
    try {
      const group = await this.#client.requirementGroups.create({
        action: 'ordering',
        country_code: country,
        phone_number_type: numberType,
        customer_reference: customerReference,
        regulatory_requirements: values.map((value) => ({
          requirement_id: value.requirementId,
          field_value: value.value,
        })),
      });
      if (group.id === undefined) {
        throw new ProviderCallError('telnyx', 'malformed_response', 'requirement group has no id', {
          retryable: false,
          outcomeUnknown: true,
        });
      }
      return group.id;
    } catch (error) {
      if (error instanceof ProviderCallError) {
        throw error;
      }
      throw wrap(error, 'requirement group creation', true);
    }
  }

  async uploadDocument(
    filename: string,
    contentBase64: string,
    customerReference: string,
  ): Promise<string> {
    try {
      const response = await this.#client.documents.uploadJson({
        document: { filename, file: contentBase64, customer_reference: customerReference },
      });
      const id = response.data?.id;
      if (id === undefined) {
        throw new ProviderCallError(
          'telnyx',
          'malformed_response',
          'document upload returned no id',
          { retryable: false, outcomeUnknown: true },
        );
      }
      return id;
    } catch (error) {
      if (error instanceof ProviderCallError) {
        throw error;
      }
      throw wrap(error, 'document upload', true);
    }
  }

  async createAddress(address: CarrierAddress, customerReference: string): Promise<string> {
    try {
      const response = await this.#client.addresses.create({
        business_name: address.businessName,
        first_name: address.firstName,
        last_name: address.lastName,
        street_address: address.streetAddress,
        locality: address.locality,
        postal_code: address.postalCode,
        country_code: address.countryCode,
        customer_reference: customerReference,
        ...(address.extendedAddress === null ? {} : { extended_address: address.extendedAddress }),
      });
      const id = response.data?.id;
      if (id === undefined) {
        throw new ProviderCallError(
          'telnyx',
          'malformed_response',
          'address creation returned no id',
          { retryable: false, outcomeUnknown: true },
        );
      }
      return id;
    } catch (error) {
      if (error instanceof ProviderCallError) {
        throw error;
      }
      throw wrap(error, 'address creation', true);
    }
  }

  async findOrderByReference(customerReference: string): Promise<CarrierNumberOrder | null> {
    try {
      for await (const order of this.#client.numberOrders.list({
        filter: { customer_reference: customerReference },
      })) {
        if (order.customer_reference === customerReference && order.id !== undefined) {
          return toOrder({ id: order.id, status: order.status }, 'number order lookup');
        }
      }
      return null;
    } catch (error) {
      if (error instanceof ProviderCallError) {
        throw error;
      }
      throw wrap(error, 'number order lookup', false);
    }
  }

  async createOrder(
    e164: string,
    connectionId: string,
    customerReference: string,
    requirementGroupId: string | null,
  ): Promise<CarrierNumberOrder> {
    try {
      const response = await this.#client.numberOrders.create({
        connection_id: connectionId,
        customer_reference: customerReference,
        phone_numbers: [
          {
            phone_number: e164,
            ...(requirementGroupId === null ? {} : { requirement_group_id: requirementGroupId }),
          },
        ],
      });
      return toOrder(response.data, 'number order creation');
    } catch (error) {
      if (error instanceof ProviderCallError) {
        throw error;
      }
      throw wrap(error, 'number order creation', true);
    }
  }

  async retrieveOrder(orderId: string): Promise<CarrierNumberOrder> {
    try {
      return toOrder(
        (await this.#client.numberOrders.retrieve(orderId)).data,
        'number order retrieval',
      );
    } catch (error) {
      if (error instanceof ProviderCallError) {
        throw error;
      }
      throw wrap(error, 'number order retrieval', false);
    }
  }
}
