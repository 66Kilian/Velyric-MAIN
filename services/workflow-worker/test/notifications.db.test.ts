import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createNotificationActivity } from '../src/activities/notifications.js';
import { seedBillingProfile, seedTenant, testDependencies, useTestDatabase } from './support/db.js';

const database = useTestDatabase();
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

describe('notification activity', () => {
  it('delivers invitations to the invited address instead of the billing contact and never twice', async () => {
    const tenantId = await seedTenant(database().admin, { locale: 'en' });
    await seedBillingProfile(database().admin, tenantId);
    const invited = await database().admin.query<{ id: string }>(
      `INSERT INTO app.memberships (tenant_id, invited_email, role, status, invitation_expires_at) VALUES ($1, 'New.Operator@Example.test', 'OPERATOR', 'INVITED', now() + interval '7 days') RETURNING id`,
      [tenantId],
    );
    const membershipId = invited.rows[0]?.id ?? '';
    const { deps, providers } = testDependencies(database(), new Date('2026-09-14T08:00:00Z'));
    const notify = createNotificationActivity(deps);
    const input = {
      tenantId,
      type: 'SECURITY_MEMBER_INVITED',
      dedupeKey: `invite:${membershipId}:1`,
      recipientMembershipId: membershipId,
      payload: {
        workspace_name: 'Demo Clinic',
        inviter_name: 'Anna Kiss',
        role_label: 'Operator',
        expires_at: '2026-09-21 10:00',
        accept_url: `https://app.velyric.test/hu/invite/${tenantId}/${membershipId}`,
      },
      traceId: TRACE,
    };
    expect(await notify(input)).toEqual({ status: 'SENT' });
    expect(await notify(input)).toEqual({ status: 'ALREADY_SENT' });
    expect(providers.email.messages.map((message) => message.to)).toEqual([
      'new.operator@example.test',
    ]);
    expect(providers.email.messages[0]?.subject).toBe(
      'You were invited to the Demo Clinic Velyric workspace',
    );

    await database().admin.query(`UPDATE app.memberships SET status = 'REMOVED' WHERE id = $1`, [
      membershipId,
    ]);
    expect(await notify({ ...input, dedupeKey: `invite:${membershipId}:2` })).toEqual({
      status: 'SUPPRESSED',
    });
    expect(
      await notify({ ...input, dedupeKey: 'invite:unknown', recipientMembershipId: randomUUID() }),
    ).toEqual({ status: 'SUPPRESSED' });
    expect(providers.email.messages).toHaveLength(1);
  });
});
