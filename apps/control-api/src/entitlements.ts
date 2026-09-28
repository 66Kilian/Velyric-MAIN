import type { FeatureKey } from '@velyric/contracts';
import { ApiError } from './errors.js';
import type { Trx } from './persistence.js';

export async function activeFeatures(trx: Trx, now: Date): Promise<ReadonlySet<string>> {
  const snapshot = await trx
    .selectFrom('entitlement_snapshots')
    .select(['features'])
    .where('effective_from', '<=', now)
    .orderBy('version', 'desc')
    .limit(1)
    .executeTakeFirst();
  const features = snapshot?.features;
  return new Set(
    Array.isArray(features)
      ? features.filter((feature): feature is string => typeof feature === 'string')
      : [],
  );
}

export async function requireFeature(trx: Trx, feature: FeatureKey, now: Date): Promise<void> {
  if (!(await activeFeatures(trx, now)).has(feature)) {
    throw new ApiError('ENTITLEMENT_REQUIRED', { feature });
  }
}
