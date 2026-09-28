import 'server-only';
import type { Metadata } from 'next';
import type { AppLocale } from '@/i18n/routing';
import { webConfig } from '@/server/config';
import { buildMetadata, type PageSeoInput } from './metadata';
import {
  breadcrumbSchema,
  faqSchema,
  jsonLdGraph,
  webPageSchema,
  type BreadcrumbItem,
  type FaqItem,
  type JsonLdNode,
} from './structured-data';
import { absoluteUrl, localizedPath, type PageLocation } from './urls';

export function seoOrigin(): string {
  return webConfig().publicWebOrigin;
}

export function pageUrl(location: PageLocation, locale: AppLocale): string {
  return absoluteUrl(seoOrigin(), localizedPath(location, locale));
}

export function pageMetadata(input: Omit<PageSeoInput, 'origin'>): Metadata {
  return buildMetadata({ ...input, origin: seoOrigin() });
}

export function pageGraph(input: {
  readonly locale: AppLocale;
  readonly location: PageLocation;
  readonly name: string;
  readonly description: string;
  readonly dateModified?: string;
  readonly breadcrumb?: readonly BreadcrumbItem[];
  readonly faq?: readonly FaqItem[];
  readonly extra?: readonly JsonLdNode[];
}): JsonLdNode {
  const origin = seoOrigin();
  const url = absoluteUrl(origin, localizedPath(input.location, input.locale));
  const breadcrumb = input.breadcrumb ?? [];
  const hasBreadcrumb = breadcrumb.length > 0;
  const nodes: JsonLdNode[] = [
    webPageSchema({
      origin,
      url,
      name: input.name,
      description: input.description,
      locale: input.locale,
      hasBreadcrumb,
      ...(input.dateModified === undefined ? {} : { dateModified: input.dateModified }),
    }),
  ];
  if (hasBreadcrumb) {
    nodes.push(breadcrumbSchema(url, breadcrumb));
  }
  if (input.faq !== undefined && input.faq.length > 0) {
    nodes.push(faqSchema(url, input.faq));
  }
  if (input.extra !== undefined) {
    nodes.push(...input.extra);
  }
  return jsonLdGraph(nodes);
}
