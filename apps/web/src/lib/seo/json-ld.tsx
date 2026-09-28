import { headers } from 'next/headers';
import type { JsonLdNode } from './structured-data';

export function serializeJsonLd(data: JsonLdNode): string {
  return JSON.stringify(data)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

export async function JsonLd({ data }: { readonly data: JsonLdNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <script
      type="application/ld+json"
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
