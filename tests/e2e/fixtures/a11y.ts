import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

export async function expectAccessible(page: Page, testInfo: TestInfo): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const blocking = results.violations.filter((violation) =>
    BLOCKING_IMPACTS.has(violation.impact ?? ''),
  );
  if (blocking.length > 0) {
    await testInfo.attach('axe-violations.json', {
      body: JSON.stringify(blocking, null, 2),
      contentType: 'application/json',
    });
  }
  expect(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}
