import type { AppLocale } from '@/i18n/routing';

export type JsonLdNode = Readonly<Record<string, unknown>>;

export interface LegalEntityFacts {
  readonly name: string;
  readonly address: string;
  readonly registration: string;
  readonly taxNumber: string;
  readonly salesEmail: string;
  readonly privacyEmail: string;
}

export function organizationId(origin: string): string {
  return `${origin}/#organization`;
}

export function websiteId(origin: string): string {
  return `${origin}/#website`;
}

export function softwareId(origin: string): string {
  return `${origin}/#software`;
}

export function organizationSchema(input: {
  readonly origin: string;
  readonly brandName: string;
  readonly description: string;
  readonly legalEntity: LegalEntityFacts;
  readonly sameAs?: readonly string[];
}): JsonLdNode {
  const sameAs = (input.sameAs ?? []).filter((entry) => entry.startsWith('https://'));
  return {
    '@type': 'Organization',
    '@id': organizationId(input.origin),
    name: input.brandName,
    legalName: input.legalEntity.name,
    url: `${input.origin}/`,
    logo: `${input.origin}/brand/velyric-emblem.png`,
    description: input.description,
    email: input.legalEntity.salesEmail,
    taxID: input.legalEntity.taxNumber,
    identifier: input.legalEntity.registration,
    address: { '@type': 'PostalAddress', streetAddress: input.legalEntity.address },
    contactPoint: [
      {
        '@type': 'ContactPoint',
        contactType: 'sales',
        email: input.legalEntity.salesEmail,
        availableLanguage: ['hu', 'de', 'en'],
      },
      {
        '@type': 'ContactPoint',
        contactType: 'privacy',
        email: input.legalEntity.privacyEmail,
        availableLanguage: ['hu', 'de', 'en'],
      },
    ],
    ...(sameAs.length > 0 ? { sameAs } : {}),
  };
}

export function websiteSchema(input: {
  readonly origin: string;
  readonly brandName: string;
  readonly locale: AppLocale;
}): JsonLdNode {
  return {
    '@type': 'WebSite',
    '@id': websiteId(input.origin),
    name: input.brandName,
    url: `${input.origin}/`,
    inLanguage: input.locale,
    publisher: { '@id': organizationId(input.origin) },
  };
}

export interface SoftwareOffer {
  readonly name: string;
  readonly price: number;
  readonly currency: string;
  readonly unit: 'MONTH' | 'YEAR';
  readonly url: string;
}

export function softwareApplicationSchema(input: {
  readonly origin: string;
  readonly brandName: string;
  readonly description: string;
  readonly locale: AppLocale;
  readonly featureList: readonly string[];
  readonly offers?: readonly SoftwareOffer[];
}): JsonLdNode {
  const offers = (input.offers ?? []).map((offer) => ({
    '@type': 'Offer',
    name: offer.name,
    price: offer.price,
    priceCurrency: offer.currency,
    url: offer.url,
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: offer.price,
      priceCurrency: offer.currency,
      referenceQuantity: {
        '@type': 'QuantitativeValue',
        value: 1,
        unitCode: offer.unit === 'MONTH' ? 'MON' : 'ANN',
      },
    },
  }));
  return {
    '@type': 'SoftwareApplication',
    '@id': softwareId(input.origin),
    name: input.brandName,
    url: `${input.origin}/`,
    applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'Voice AI telephony platform',
    operatingSystem: 'Web browser',
    inLanguage: input.locale,
    description: input.description,
    featureList: [...input.featureList],
    provider: { '@id': organizationId(input.origin) },
    ...(offers.length > 0 ? { offers } : {}),
  };
}

export function webPageSchema(input: {
  readonly origin: string;
  readonly url: string;
  readonly name: string;
  readonly description: string;
  readonly locale: AppLocale;
  readonly dateModified?: string;
  readonly hasBreadcrumb?: boolean;
  readonly primaryImage?: string;
}): JsonLdNode {
  return {
    '@type': 'WebPage',
    '@id': `${input.url}#webpage`,
    url: input.url,
    name: input.name,
    description: input.description,
    inLanguage: input.locale,
    isPartOf: { '@id': websiteId(input.origin) },
    about: { '@id': organizationId(input.origin) },
    ...(input.dateModified === undefined ? {} : { dateModified: input.dateModified }),
    ...(input.hasBreadcrumb === true ? { breadcrumb: { '@id': `${input.url}#breadcrumb` } } : {}),
    ...(input.primaryImage === undefined ? {} : { primaryImageOfPage: input.primaryImage }),
  };
}

export interface BreadcrumbItem {
  readonly name: string;
  readonly url: string;
}

export function breadcrumbSchema(pageUrl: string, items: readonly BreadcrumbItem[]): JsonLdNode {
  return {
    '@type': 'BreadcrumbList',
    '@id': `${pageUrl}#breadcrumb`,
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export interface FaqItem {
  readonly question: string;
  readonly answer: string;
}

export function faqSchema(pageUrl: string, items: readonly FaqItem[]): JsonLdNode {
  return {
    '@type': 'FAQPage',
    '@id': `${pageUrl}#faq`,
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}

export function techArticleSchema(input: {
  readonly origin: string;
  readonly url: string;
  readonly headline: string;
  readonly description: string;
  readonly locale: AppLocale;
  readonly dateModified: string;
}): JsonLdNode {
  return {
    '@type': 'TechArticle',
    '@id': `${input.url}#article`,
    headline: input.headline,
    description: input.description,
    url: input.url,
    inLanguage: input.locale,
    dateModified: input.dateModified,
    publisher: { '@id': organizationId(input.origin) },
    isPartOf: { '@id': websiteId(input.origin) },
  };
}

export function definedTermSchema(input: {
  readonly origin: string;
  readonly url: string;
  readonly term: string;
  readonly definition: string;
  readonly locale: AppLocale;
  readonly glossaryUrl: string;
  readonly glossaryName: string;
}): JsonLdNode {
  return {
    '@type': 'DefinedTerm',
    '@id': `${input.url}#term`,
    name: input.term,
    description: input.definition,
    url: input.url,
    inLanguage: input.locale,
    inDefinedTermSet: {
      '@type': 'DefinedTermSet',
      '@id': `${input.glossaryUrl}#termset`,
      name: input.glossaryName,
      url: input.glossaryUrl,
    },
  };
}

export function contactPageSchema(input: {
  readonly origin: string;
  readonly url: string;
  readonly name: string;
  readonly description: string;
  readonly locale: AppLocale;
}): JsonLdNode {
  return {
    '@type': 'ContactPage',
    '@id': `${input.url}#webpage`,
    url: input.url,
    name: input.name,
    description: input.description,
    inLanguage: input.locale,
    isPartOf: { '@id': websiteId(input.origin) },
    about: { '@id': organizationId(input.origin) },
  };
}

export function jsonLdGraph(nodes: readonly JsonLdNode[]): JsonLdNode {
  return { '@context': 'https://schema.org', '@graph': nodes };
}
