export function sanitizeReturnTo(value: string | string[] | undefined, fallback = '/app'): string {
  const single = Array.isArray(value) ? value[0] : value;
  return single !== undefined &&
    single.startsWith('/app') &&
    !single.startsWith('//') &&
    !single.includes('\\') &&
    single.length <= 512
    ? single
    : fallback;
}
