import { createHash } from 'node:crypto';
import type { AgentLocale } from '@velyric/contracts';
import { NextResponse, type NextRequest } from 'next/server';
import { AGENT_LOCALES, PACES, VOICE_PERSONAS, type Pace } from '@/lib/setup';
import { serverGet } from '@/server/api';
import { webConfig } from '@/server/config';

export const dynamic = 'force-dynamic';

const VOICES: ReadonlySet<string> = new Set(VOICE_PERSONAS.map((persona) => persona.voice));
const WINDOW_MS = 10 * 60_000;
const REQUESTS_PER_WINDOW = 40;
const CACHE_LIMIT = 300;
const audioCache = new Map<string, ArrayBuffer>();
const usage = new Map<string, number[]>();

const PACE_INSTRUCTIONS: Readonly<Record<Pace, string>> = {
  calm: 'Speak slowly and calmly.',
  natural: 'Speak at a natural, relaxed pace.',
  dynamic: 'Speak briskly with upbeat energy.',
};

const LANGUAGE_NAMES: Readonly<Record<AgentLocale, string>> = {
  hu: 'Hungarian',
  en: 'English',
  de: 'German',
};

function failure(status: number, code: string): NextResponse {
  return NextResponse.json({ code }, { status, headers: { 'cache-control': 'no-store' } });
}

function allow(userId: string, now: number): boolean {
  const recent = (usage.get(userId) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= REQUESTS_PER_WINDOW) {
    usage.set(userId, recent);
    return false;
  }
  recent.push(now);
  usage.set(userId, recent);
  return true;
}

function audioResponse(audio: ArrayBuffer): NextResponse {
  return new NextResponse(audio, {
    headers: { 'content-type': 'audio/mpeg', 'cache-control': 'private, no-store' },
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = webConfig();
  if (request.headers.get('origin') !== new URL(config.publicWebOrigin).origin) {
    return failure(403, 'FORBIDDEN');
  }
  let userId: string;
  try {
    userId = (await serverGet<{ user: { id: string } }>('/me')).user.id;
  } catch {
    return failure(401, 'UNAUTHENTICATED');
  }
  if (config.voicePreviewApiKey === null) {
    return failure(503, 'VOICE_PREVIEW_UNAVAILABLE');
  }
  const body = (await request.json().catch(() => null)) as {
    voice?: unknown;
    locale?: unknown;
    pace?: unknown;
    text?: unknown;
  } | null;
  const voice = typeof body?.voice === 'string' && VOICES.has(body.voice) ? body.voice : null;
  const locale = AGENT_LOCALES.find((entry) => entry === body?.locale) ?? null;
  const pace = PACES.find((entry) => entry === body?.pace) ?? 'natural';
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (voice === null || locale === null || text === '' || text.length > 500) {
    return failure(400, 'VALIDATION_FAILED');
  }
  const cacheKey = createHash('sha256')
    .update(JSON.stringify([voice, locale, pace, text]))
    .digest('hex');
  const cached = audioCache.get(cacheKey);
  if (cached !== undefined) {
    return audioResponse(cached);
  }
  if (!allow(userId, Date.now())) {
    return failure(429, 'RATE_LIMITED');
  }
  let upstream: Response;
  try {
    upstream = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.voicePreviewApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice,
        input: text,
        instructions: `You are a friendly front-desk receptionist speaking ${LANGUAGE_NAMES[locale]}. ${PACE_INSTRUCTIONS[pace]}`,
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return failure(502, 'PROVIDER_UNAVAILABLE');
  }
  if (!upstream.ok) {
    return failure(502, 'PROVIDER_UNAVAILABLE');
  }
  const audio = await upstream.arrayBuffer();
  if (audioCache.size >= CACHE_LIMIT) {
    const oldest = audioCache.keys().next().value;
    if (oldest !== undefined) {
      audioCache.delete(oldest);
    }
  }
  audioCache.set(cacheKey, audio);
  return audioResponse(audio);
}
