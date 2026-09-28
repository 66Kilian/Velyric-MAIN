'use client';

import Script from 'next/script';
import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render(
        container: HTMLElement,
        options: {
          readonly sitekey: string;
          readonly appearance: 'interaction-only';
          readonly callback: (token: string) => void;
          readonly 'expired-callback': () => void;
          readonly 'error-callback': () => void;
        },
      ): string;
      remove(widgetId: string): void;
    };
  }
}

/**
 * Cloudflare Turnstile, `appearance: interaction-only`: no widget is drawn and
 * legitimate visitors see nothing, so it costs the signup form no layout space
 * or friction. A challenge only renders itself when Cloudflare actually needs
 * one. `onToken(null)` on expiry/error keeps the caller from submitting a
 * stale token; `render=explicit` on the script stops it from auto-scanning
 * the page so this is the only widget it ever creates.
 */
export function TurnstileWidget({
  siteKey,
  onToken,
}: {
  readonly siteKey: string;
  readonly onToken: (token: string | null) => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const [scriptReady, setScriptReady] = useState(false);

  useEffect(() => {
    if (!scriptReady || container.current === null || window.turnstile === undefined) {
      return undefined;
    }
    const widgetId = window.turnstile.render(container.current, {
      sitekey: siteKey,
      appearance: 'interaction-only',
      callback: (token) => {
        onTokenRef.current(token);
      },
      'expired-callback': () => {
        onTokenRef.current(null);
      },
      'error-callback': () => {
        onTokenRef.current(null);
      },
    });
    return () => {
      window.turnstile?.remove(widgetId);
    };
  }, [scriptReady, siteKey]);

  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        onReady={() => {
          setScriptReady(true);
        }}
      />
      <div ref={container} />
    </>
  );
}
