import { webConfig } from '@/server/config';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const config = webConfig();
    const response = await fetch(`${config.controlApiUrl}/healthz/ready`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    return Response.json(
      { status: response.ok ? 'ready' : 'degraded', control_api: response.ok },
      { status: response.ok ? 200 : 503 },
    );
  } catch {
    return Response.json({ status: 'unavailable', control_api: false }, { status: 503 });
  }
}
