import { ImageResponse } from 'next/og';

export const dynamic = 'force-dynamic';

const WIDTH = 1200;
const HEIGHT = 630;
const MAX_TITLE = 110;
const FALLBACK_TITLE = 'AI voice agents for modern businesses';

const TAGLINES: Readonly<Record<string, string>> = {
  hu: 'AI hangasszisztensek vállalkozásoknak',
  de: 'KI-Telefonassistenten für Unternehmen',
  en: 'AI voice agents for modern businesses',
};

export function GET(request: Request): ImageResponse {
  const params = new URL(request.url).searchParams;
  const locale = params.get('locale') ?? 'en';
  const rawTitle = params.get('title') ?? TAGLINES[locale] ?? FALLBACK_TITLE;
  const title = rawTitle.slice(0, MAX_TITLE);
  const tagline = TAGLINES[locale] ?? TAGLINES['en'] ?? FALLBACK_TITLE;
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px',
          backgroundColor: '#071327',
          backgroundImage:
            'radial-gradient(900px 500px at 88% -12%, rgba(240,0,255,0.42), transparent 62%), radial-gradient(700px 420px at 4% 108%, rgba(255,122,89,0.32), transparent 60%)',
          color: '#ffffff',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
          <div
            style={{
              width: '54px',
              height: '54px',
              borderRadius: '16px',
              backgroundImage: 'linear-gradient(135deg, #F000FF, #FF007A 55%, #FF7A59)',
            }}
          />
          <div style={{ fontSize: '34px', fontWeight: 700, letterSpacing: '-0.02em' }}>Velyric</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <div
            style={{
              fontSize: title.length > 64 ? '56px' : '68px',
              fontWeight: 700,
              lineHeight: 1.08,
              letterSpacing: '-0.03em',
              maxWidth: '980px',
            }}
          >
            {title}
          </div>
          <div style={{ display: 'flex', width: '180px', height: '8px', borderRadius: '999px', backgroundImage: 'linear-gradient(90deg, #F000FF, #FF007A 50%, #FF7A59)' }} />
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '24px',
            color: 'rgba(255,255,255,0.72)',
          }}
        >
          <div style={{ display: 'flex' }}>{tagline}</div>
          <div style={{ display: 'flex' }}>velyric.com</div>
        </div>
      </div>
    ),
    { width: WIDTH, height: HEIGHT },
  );
}
