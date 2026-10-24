import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/** axe violations of impact `serious` or `critical`, as short readable lines. */
export async function seriousViolations(page: Page): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.impact} ${v.id}: ${v.help} — ${v.nodes
          .slice(0, 5)
          .map((n) => n.target.join(' '))
          .join(' | ')}`,
    );
}
