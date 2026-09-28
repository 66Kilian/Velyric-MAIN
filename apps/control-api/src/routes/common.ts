import Type from 'typebox';
import { pageLimit } from '../persistence.js';

export const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

export const Uuid = Type.String({ pattern: UUID_PATTERN });

export const IdParams = Type.Object({ id: Uuid }, { additionalProperties: false });

export const PageQuery = Type.Object(
  {
    limit: Type.Optional(Type.String({ pattern: '^[1-9][0-9]{0,2}$' })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  },
  { additionalProperties: false },
);

export function limitFromQuery(value: string | undefined): number {
  return pageLimit(value === undefined ? undefined : Number(value));
}

export function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function domainSubject(tenantId: string | null, eventType: string): string {
  return `domain.v1.${tenantId ?? 'platform'}.${eventType}`;
}
