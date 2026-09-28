import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDatabase, type DB } from '@velyric/db';
import { LocalVaultTenantSecrets } from '@velyric/tenant-secrets';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, inject } from 'vitest';
import type { ActivityDependencies } from '../../src/activities/support.js';
import { FakeBillingGateway, FakeBillingo, FakeCarrier, FakeEmail, FakeOpenAi } from './fakes.js';
import './provided.js';

export interface TestDatabase {
  readonly db: Kysely<DB>;
  readonly admin: pg.Pool;
  readonly vaultDir: string;
}

function connectionString(database: string): string {
  const provided = inject('workflowWorkerDb');
  return `postgres://${encodeURIComponent(provided.user)}:${encodeURIComponent(provided.password)}@${provided.host}:${String(provided.port)}/${database}`;
}

export function useTestDatabase(): () => TestDatabase {
  let database: TestDatabase | undefined;
  const name = `workflow_worker_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    const provided = inject('workflowWorkerDb');
    const root = new pg.Client({ connectionString: connectionString('postgres') });
    await root.connect();
    try {
      await root.query(
        `CREATE DATABASE ${root.escapeIdentifier(name)} TEMPLATE ${root.escapeIdentifier(provided.template)}`,
      );
    } finally {
      await root.end();
    }
    database = {
      db: createDatabase<DB>({
        connectionString: connectionString(name),
        applicationName: 'workflow-worker-test',
        assumeRole: 'velyric_app',
        maxConnections: 8,
      }),
      admin: new pg.Pool({
        connectionString: connectionString(name),
        max: 4,
        options: '-c search_path=app,public',
      }),
      vaultDir: mkdtempSync(path.join(tmpdir(), 'velyric-workflow-vault-')),
    };
  });
  afterAll(async () => {
    await database?.db.destroy();
    await database?.admin.end();
    if (database !== undefined) {
      rmSync(database.vaultDir, { recursive: true, force: true });
    }
  });
  return () => {
    if (database === undefined) {
      throw new Error('test database is not initialised');
    }
    return database;
  };
}

export interface TestProviders {
  readonly openai: FakeOpenAi;
  readonly carrier: FakeCarrier;
  readonly billingo: FakeBillingo;
  readonly billing: FakeBillingGateway;
  readonly email: FakeEmail;
}

export function testDependencies(
  database: TestDatabase,
  now: Date,
): { readonly deps: ActivityDependencies; readonly providers: TestProviders } {
  const providers: TestProviders = {
    openai: new FakeOpenAi(),
    carrier: new FakeCarrier(),
    billingo: new FakeBillingo(),
    billing: new FakeBillingGateway(),
    email: new FakeEmail(),
  };
  const silent = (): void => undefined;
  return {
    providers,
    deps: {
      db: database.db,
      secrets: new LocalVaultTenantSecrets(database.vaultDir),
      ...providers,
      tenantEmail: {
        environment: 'ci',
        resolver: (hostname: string) =>
          Promise.resolve([{ address: '127.0.0.1', family: 4 as const, hostname }]),
        google: null,
      },
      settings: {
        environment: 'ci',
        webOrigin: 'https://app.velyric.test',
        telnyxConnectionId: 'connection-1',
        billingoBlockId: 42,
        openAiMonthlySpendLimitUsd: { START: 150 },
      },
      now: () => now,
      logger: { info: silent, warn: silent, error: silent },
    },
  };
}

export async function seedTenant(
  admin: pg.Pool,
  options: { readonly locale?: string } = {},
): Promise<string> {
  const slug = `tenant-${randomUUID().slice(0, 12)}`;
  const result = await admin.query<{ id: string }>(
    `INSERT INTO app.tenants (legal_name, display_name, slug, default_locale) VALUES ('Demo Rendelő Kft.', 'Demo Rendelő', $1, $2) RETURNING id`,
    [slug, options.locale ?? 'hu'],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('tenant insert returned no row');
  }
  return row.id;
}

export async function seedBillingProfile(
  admin: pg.Pool,
  tenantId: string,
  options: { readonly partnerId?: number } = {},
): Promise<string> {
  const result = await admin.query<{ id: string }>(
    `INSERT INTO app.billing_profiles (tenant_id, customer_type, legal_name, country, postal_code, city, address_line1, billing_email, hu_tax_number, billingo_partner_id)
     VALUES ($1, 'BUSINESS', 'Demo Rendelő Kft.', 'HU', '1051', 'Budapest', 'Nádor utca 7.', 'szamla@demo-rendelo.hu', '12345678-2-41', $2) RETURNING id`,
    [tenantId, options.partnerId ?? null],
  );
  return result.rows[0]?.id ?? '';
}

export interface SeededPhoneOrder {
  readonly tenantId: string;
  readonly workflowRowId: string;
  readonly temporalWorkflowId: string;
  readonly phoneOrderId: string;
  readonly requirementIds: {
    readonly text: string;
    readonly document: string;
    readonly address: string;
  };
}

export async function seedKycPhoneOrder(admin: pg.Pool): Promise<SeededPhoneOrder> {
  const tenantId = await seedTenant(admin);
  const profileId = await seedBillingProfile(admin, tenantId);
  const user = await admin.query<{ id: string }>(
    `INSERT INTO app.users (auth_subject, email) VALUES ($1, 'owner@demo-rendelo.hu') RETURNING id`,
    [`user_${randomUUID()}`],
  );
  const orderId = randomUUID();
  await admin.query(
    `INSERT INTO app.checkout_orders (id, tenant_id, billing_profile_id, created_by_user_id, status, plan_code, pricing_version, market, currency, subtotal_minor, tax_minor, total_minor, terms_version, idempotency_key, expires_at, paid_at)
     VALUES ($1, $2, $3, $4, 'PAID', 'START', '2026-09', 'HU', 'HUF', 3000000, 810000, 3810000, '2026-09-01', $5, now() + interval '1 day', now())`,
    [orderId, tenantId, profileId, user.rows[0]?.id, `checkout:${orderId}`],
  );
  const temporalWorkflowId = `provisioning:${orderId}`;
  const workflow = await admin.query<{ id: string }>(
    `INSERT INTO app.provisioning_workflows (tenant_id, order_id, temporal_workflow_id, state, blocking_reason) VALUES ($1, $2, $3, 'WAITING_FOR_CUSTOMER', 'regulatory_details_required') RETURNING id`,
    [tenantId, orderId, temporalWorkflowId],
  );
  const workflowRowId = workflow.rows[0]?.id ?? '';
  const order = await admin.query<{ id: string }>(
    `INSERT INTO app.phone_orders (tenant_id, workflow_id, provider, provider_reservation_id, e164, country, number_type, status, requirements_status, inventory_checked_at, idempotency_key)
     VALUES ($1, $2, 'telnyx', $3, '+3612345678', 'HU', 'LOCAL', 'KYC_REQUIRED', 'REQUIRED', now(), $4) RETURNING id`,
    [tenantId, workflowRowId, `res_${randomUUID()}`, `provisioning:${orderId}:phone_reservation`],
  );
  const phoneOrderId = order.rows[0]?.id ?? '';
  const requirement = async (providerId: string, fieldType: string): Promise<string> => {
    const row = await admin.query<{ id: string }>(
      `INSERT INTO app.kyc_requirements (tenant_id, phone_order_id, provider_requirement_id, field_type, label_key) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        tenantId,
        phoneOrderId,
        providerId,
        fieldType,
        `carrier.requirement.${fieldType.toLowerCase()}`,
      ],
    );
    return row.rows[0]?.id ?? '';
  };
  return {
    tenantId,
    workflowRowId,
    temporalWorkflowId,
    phoneOrderId,
    requirementIds: {
      text: await requirement('req-company-registration', 'TEXTUAL'),
      document: await requirement('req-proof-of-address', 'DOCUMENT'),
      address: await requirement('req-local-address', 'ADDRESS'),
    },
  };
}
