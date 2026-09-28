import { identityHash, normalizeIdentity, type IdentityType } from '@velyric/db';
import type { Trx } from '../persistence.js';

export { identityHash, normalizeIdentity, type IdentityType };

const MAX_MERGE_HOPS = 8;

export async function canonicalProfileId(trx: Trx, profileId: string): Promise<string> {
  let current = profileId;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
    const row = await trx
      .selectFrom('caller_profiles')
      .select(['merged_into_profile_id'])
      .where('id', '=', current)
      .executeTakeFirst();
    if (row?.merged_into_profile_id === null || row?.merged_into_profile_id === undefined) {
      return current;
    }
    current = row.merged_into_profile_id;
  }
  return current;
}

export async function resolvePhoneProfile(
  trx: Trx,
  input: {
    readonly tenantId: string;
    readonly e164: string;
    readonly locationId: string | null;
    readonly at: Date;
  },
): Promise<string> {
  const normalized = normalizeIdentity('PHONE', input.e164);
  const existing = await trx
    .selectFrom('person_identities')
    .select(['id', 'person_id'])
    .where('identity_type', '=', 'PHONE')
    .where('normalized_value', '=', normalized)
    .executeTakeFirst();
  if (existing !== undefined) {
    const profileId = await canonicalProfileId(trx, existing.person_id);
    await trx
      .updateTable('person_identities')
      .set({ last_confirmed_at: input.at, updated_at: input.at })
      .where('id', '=', existing.id)
      .execute();
    await trx
      .updateTable('caller_profiles')
      .set({ last_interaction_at: input.at, updated_at: input.at })
      .where('id', '=', profileId)
      .execute();
    return profileId;
  }
  const profile = await trx
    .insertInto('caller_profiles')
    .values({ tenant_id: input.tenantId, last_interaction_at: input.at })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  const inserted = await trx
    .insertInto('person_identities')
    .values({
      tenant_id: input.tenantId,
      person_id: profile.id,
      location_id: input.locationId,
      identity_type: 'PHONE',
      normalized_value: normalized,
      value_hash: identityHash(input.tenantId, 'PHONE', normalized),
      verification_state: 'OBSERVED',
      source: 'CALLER_ID',
      confidence: '0.600',
      last_confirmed_at: input.at,
    })
    .onConflict((conflict) =>
      conflict.columns(['tenant_id', 'identity_type', 'normalized_value']).doNothing(),
    )
    .returning(['person_id'])
    .executeTakeFirst();
  if (inserted !== undefined) {
    return profile.id;
  }
  await trx.deleteFrom('caller_profiles').where('id', '=', profile.id).execute();
  const winner = await trx
    .selectFrom('person_identities')
    .select(['person_id'])
    .where('identity_type', '=', 'PHONE')
    .where('normalized_value', '=', normalized)
    .executeTakeFirstOrThrow();
  return canonicalProfileId(trx, winner.person_id);
}
