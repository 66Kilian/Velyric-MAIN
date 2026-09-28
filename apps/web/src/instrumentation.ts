export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') {
    return;
  }
  const { parseWebConfig } = await import('./server/config');
  parseWebConfig(process.env);
}
