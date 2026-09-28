import { describe, expect, it } from 'vitest';
import { serializeJsonLd } from '@/lib/seo/json-ld';
import {
  breadcrumbSchema,
  contactPageSchema,
  definedTermSchema,
  faqSchema,
  jsonLdGraph,
  organizationSchema,
  softwareApplicationSchema,
  webPageSchema,
  websiteSchema,
  type LegalEntityFacts,
} from '@/lib/seo/structured-data';

const ORIGIN = 'https://velyric.com';
const PAGE = `${ORIGIN}/en/ai-voice-agents`;

const LEGAL_ENTITY: LegalEntityFacts = {
  name: 'Velyric Kft.',
  address: 'Example utca 1, 1051 Budapest',
  registration: '01-09-123456',
  taxNumber: '12345678-2-41',
  salesEmail: 'sales@velyric.com',
  privacyEmail: 'privacy@velyric.com',
};

const FORBIDDEN_TYPES = ['AggregateRating', 'Review', 'Rating'];

function graph() {
  return jsonLdGraph([
    organizationSchema({
      origin: ORIGIN,
      brandName: 'Velyric',
      description: 'AI voice agents for businesses.',
      legalEntity: LEGAL_ENTITY,
    }),
    websiteSchema({ origin: ORIGIN, brandName: 'Velyric', locale: 'en' }),
    softwareApplicationSchema({
      origin: ORIGIN,
      brandName: 'Velyric',
      description: 'AI voice agents for businesses.',
      locale: 'en',
      featureList: ['Multilingual voice', 'Calendar booking'],
      offers: [
        { name: 'Start', price: 39900, currency: 'HUF', unit: 'MONTH', url: `${ORIGIN}/en/pricing` },
      ],
    }),
    webPageSchema({
      origin: ORIGIN,
      url: PAGE,
      name: 'AI voice agents',
      description: 'What Velyric does on a call.',
      locale: 'en',
      hasBreadcrumb: true,
      dateModified: '2026-09-16',
    }),
    breadcrumbSchema(PAGE, [
      { name: 'Home', url: `${ORIGIN}/en` },
      { name: 'AI voice agents', url: PAGE },
    ]),
    faqSchema(PAGE, [{ question: 'Can it transfer to a human?', answer: 'Yes, on request or DTMF.' }]),
  ]);
}

describe('structured data', () => {
  it('produces a single schema.org graph document', () => {
    const data = graph();
    expect(data['@context']).toBe('https://schema.org');
    expect(Array.isArray(data['@graph'])).toBe(true);
  });

  it('survives a json round trip', () => {
    const data = graph();
    expect(JSON.parse(JSON.stringify(data))).toEqual(JSON.parse(JSON.stringify(data)));
  });

  it('never emits ratings, reviews or any other fabricated trust signal', () => {
    const serialized = JSON.stringify(graph());
    for (const type of FORBIDDEN_TYPES) {
      expect(serialized).not.toContain(type);
    }
    expect(serialized).not.toContain('ratingValue');
    expect(serialized).not.toContain('reviewCount');
    expect(serialized).not.toContain('testimonial');
  });

  it('links every node to stable entity identifiers', () => {
    const nodes = graph()['@graph'] as readonly Record<string, unknown>[];
    const organization = nodes.find((node) => node['@type'] === 'Organization');
    const website = nodes.find((node) => node['@type'] === 'WebSite');
    const page = nodes.find((node) => node['@type'] === 'WebPage');
    expect(organization?.['@id']).toBe(`${ORIGIN}/#organization`);
    expect(website?.['publisher']).toEqual({ '@id': `${ORIGIN}/#organization` });
    expect(page?.['isPartOf']).toEqual({ '@id': `${ORIGIN}/#website` });
    expect(page?.['breadcrumb']).toEqual({ '@id': `${PAGE}#breadcrumb` });
  });

  it('only publishes organization identity that comes from configuration', () => {
    const organization = organizationSchema({
      origin: ORIGIN,
      brandName: 'Velyric',
      description: 'AI voice agents for businesses.',
      legalEntity: LEGAL_ENTITY,
    });
    expect(organization['legalName']).toBe(LEGAL_ENTITY.name);
    expect(organization['taxID']).toBe(LEGAL_ENTITY.taxNumber);
    expect(organization['email']).toBe(LEGAL_ENTITY.salesEmail);
  });

  it('omits sameAs entirely when no verified profile exists', () => {
    const organization = organizationSchema({
      origin: ORIGIN,
      brandName: 'Velyric',
      description: 'AI voice agents for businesses.',
      legalEntity: LEGAL_ENTITY,
    });
    expect(organization['sameAs']).toBeUndefined();
  });

  it('drops non-https sameAs entries', () => {
    const organization = organizationSchema({
      origin: ORIGIN,
      brandName: 'Velyric',
      description: 'AI voice agents for businesses.',
      legalEntity: LEGAL_ENTITY,
      sameAs: ['http://example.com/velyric', 'https://example.com/velyric'],
    });
    expect(organization['sameAs']).toEqual(['https://example.com/velyric']);
  });

  it('omits the offers property when no price is supplied', () => {
    const software = softwareApplicationSchema({
      origin: ORIGIN,
      brandName: 'Velyric',
      description: 'AI voice agents for businesses.',
      locale: 'de',
      featureList: ['Mehrsprachige Anrufe'],
    });
    expect(software['offers']).toBeUndefined();
  });

  it('prices offers with an explicit currency and monthly unit', () => {
    const software = softwareApplicationSchema({
      origin: ORIGIN,
      brandName: 'Velyric',
      description: 'AI voice agents for businesses.',
      locale: 'hu',
      featureList: ['Foglalás'],
      offers: [
        { name: 'Start', price: 39900, currency: 'HUF', unit: 'MONTH', url: `${ORIGIN}/hu/arak` },
      ],
    });
    const offers = software['offers'] as readonly Record<string, unknown>[];
    expect(offers[0]?.['priceCurrency']).toBe('HUF');
    expect(offers[0]?.['price']).toBe(39900);
  });

  it('numbers breadcrumb positions from one', () => {
    const breadcrumb = breadcrumbSchema(PAGE, [
      { name: 'Home', url: `${ORIGIN}/en` },
      { name: 'Glossary', url: `${ORIGIN}/en/glossary` },
    ]);
    const items = breadcrumb['itemListElement'] as readonly Record<string, unknown>[];
    expect(items.map((item) => item['position'])).toEqual([1, 2]);
  });

  it('shapes faq entries as questions with accepted answers', () => {
    const faq = faqSchema(PAGE, [{ question: 'Q?', answer: 'A.' }]);
    const entities = faq['mainEntity'] as readonly Record<string, unknown>[];
    expect(entities[0]?.['@type']).toBe('Question');
    expect(entities[0]?.['acceptedAnswer']).toEqual({ '@type': 'Answer', text: 'A.' });
  });

  it('builds defined terms inside a named term set', () => {
    const term = definedTermSchema({
      origin: ORIGIN,
      url: `${ORIGIN}/en/glossary/dtmf`,
      term: 'DTMF',
      definition: 'Touch tone signalling.',
      locale: 'en',
      glossaryUrl: `${ORIGIN}/en/glossary`,
      glossaryName: 'Glossary',
    });
    expect(term['@type']).toBe('DefinedTerm');
    expect((term['inDefinedTermSet'] as Record<string, unknown>)['@type']).toBe('DefinedTermSet');
  });

  it('marks the contact page as a ContactPage bound to the organization', () => {
    const contact = contactPageSchema({
      origin: ORIGIN,
      url: `${ORIGIN}/en/contact`,
      name: 'Contact',
      description: 'How to reach Velyric.',
      locale: 'en',
    });
    expect(contact['@type']).toBe('ContactPage');
    expect(contact['about']).toEqual({ '@id': `${ORIGIN}/#organization` });
  });

  it('escapes characters that could break out of a script element', () => {
    const serialized = serializeJsonLd({
      '@type': 'WebPage',
      name: '</script><script>alert(1)</script>',
    });
    expect(serialized).not.toContain('</script>');
    expect(serialized).not.toContain('<');
    expect(serialized).not.toContain('>');
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed['name']).toBe('</script><script>alert(1)</script>');
  });
});
