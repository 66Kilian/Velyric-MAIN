import OpenAI from 'openai';
import { ProviderCallError } from './errors.js';

export interface ServiceAccountCredential {
  readonly serviceAccountId: string;
  readonly apiKeyId: string;
  readonly apiKey: string;
}

export interface OpenAiProjectAdmin {
  findProjectByName(name: string): Promise<string | null>;
  createProject(name: string): Promise<string>;
  setMonthlySpendLimit(projectId: string, usd: number): Promise<void>;
  findServiceAccount(projectId: string, name: string): Promise<string | null>;
  createServiceAccount(
    projectId: string,
    name: string,
  ): Promise<{
    readonly serviceAccountId: string;
    readonly credential: ServiceAccountCredential | null;
  }>;
  createServiceAccountKey(
    projectId: string,
    serviceAccountId: string,
    name: string,
  ): Promise<ServiceAccountCredential>;
  archiveProject(projectId: string): Promise<void>;
}

function wrap(error: unknown, operation: string, mutating: boolean): ProviderCallError {
  if (error instanceof OpenAI.APIError) {
    const status = typeof error.status === 'number' ? error.status : 0;
    const retryable = status === 0 || status === 429 || status >= 500;
    return new ProviderCallError(
      'openai',
      typeof error.code === 'string' ? error.code : `openai_http_${String(status)}`,
      `${operation} failed`,
      {
        retryable,
        outcomeUnknown: mutating && (status === 0 || status >= 500),
        httpStatus: status === 0 ? null : status,
        cause: error,
      },
    );
  }
  return new ProviderCallError('openai', 'network_error', `${operation} failed`, {
    retryable: true,
    outcomeUnknown: mutating,
    cause: error,
  });
}

export class OpenAiSdkProjectAdmin implements OpenAiProjectAdmin {
  readonly #client: OpenAI;

  constructor(adminKey: string, baseURL?: string) {
    if (adminKey === '') {
      throw new RangeError('an OpenAI admin key is required');
    }
    this.#client = new OpenAI({
      adminAPIKey: adminKey,
      apiKey: null,
      maxRetries: 2,
      timeout: 20_000,
      ...(baseURL === undefined ? {} : { baseURL }),
    });
  }

  async findProjectByName(name: string): Promise<string | null> {
    try {
      for await (const project of this.#client.admin.organization.projects.list({ limit: 100 })) {
        if (project.name === name && (project.archived_at ?? null) === null) {
          return project.id;
        }
      }
      return null;
    } catch (error) {
      throw wrap(error, 'project lookup', false);
    }
  }

  async createProject(name: string): Promise<string> {
    try {
      return (await this.#client.admin.organization.projects.create({ name })).id;
    } catch (error) {
      throw wrap(error, 'project creation', true);
    }
  }

  async setMonthlySpendLimit(projectId: string, usd: number): Promise<void> {
    try {
      await this.#client.admin.organization.projects.spendLimit.update(projectId, {
        currency: 'USD',
        interval: 'month',
        threshold_amount: usd,
      });
    } catch (error) {
      throw wrap(error, 'spend limit update', false);
    }
  }

  async findServiceAccount(projectId: string, name: string): Promise<string | null> {
    try {
      for await (const account of this.#client.admin.organization.projects.serviceAccounts.list(
        projectId,
        { limit: 100 },
      )) {
        if (account.name === name) {
          return account.id;
        }
      }
      return null;
    } catch (error) {
      throw wrap(error, 'service account lookup', false);
    }
  }

  async createServiceAccount(
    projectId: string,
    name: string,
  ): Promise<{
    readonly serviceAccountId: string;
    readonly credential: ServiceAccountCredential | null;
  }> {
    try {
      const created = await this.#client.admin.organization.projects.serviceAccounts.create(
        projectId,
        { name },
      );
      return {
        serviceAccountId: created.id,
        credential:
          created.api_key === null
            ? null
            : {
                serviceAccountId: created.id,
                apiKeyId: created.api_key.id,
                apiKey: created.api_key.value,
              },
      };
    } catch (error) {
      throw wrap(error, 'service account creation', true);
    }
  }

  async createServiceAccountKey(
    projectId: string,
    serviceAccountId: string,
    name: string,
  ): Promise<ServiceAccountCredential> {
    try {
      const key = await this.#client.admin.organization.projects.serviceAccounts.apiKeys.create(
        serviceAccountId,
        { project_id: projectId, name },
      );
      return { serviceAccountId, apiKeyId: key.id, apiKey: key.value };
    } catch (error) {
      throw wrap(error, 'service account key creation', true);
    }
  }

  async archiveProject(projectId: string): Promise<void> {
    try {
      await this.#client.admin.organization.projects.archive(projectId);
    } catch (error) {
      throw wrap(error, 'project archive', false);
    }
  }
}
