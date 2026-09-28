export interface DiffEntry {
  readonly path: string;
  readonly kind: 'added' | 'removed' | 'changed';
  readonly before: unknown;
  readonly after: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function diffJson(before: unknown, after: unknown, path = ''): DiffEntry[] {
  if (Object.is(before, after)) {
    return [];
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => {
      const next = `${path}/${key}`;
      if (!(key in before)) {
        return [{ path: next, kind: 'added' as const, before: undefined, after: after[key] }];
      }
      if (!(key in after)) {
        return [{ path: next, kind: 'removed' as const, before: before[key], after: undefined }];
      }
      return diffJson(before[key], after[key], next);
    });
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    const entries: DiffEntry[] = [];
    for (let index = 0; index < length; index += 1) {
      const next = `${path}/${String(index)}`;
      if (index >= before.length) {
        entries.push({ path: next, kind: 'added', before: undefined, after: after[index] });
      } else if (index >= after.length) {
        entries.push({ path: next, kind: 'removed', before: before[index], after: undefined });
      } else {
        entries.push(...diffJson(before[index], after[index], next));
      }
    }
    return entries;
  }
  return [{ path: path === '' ? '/' : path, kind: 'changed', before, after }];
}

export function formatJsonValue(value: unknown): string {
  if (value === undefined) {
    return '–';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}
