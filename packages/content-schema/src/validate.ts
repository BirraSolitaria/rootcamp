import type { ContentTree } from './load.js';
import { checkFreshness } from './rules/freshness.js';
import { checkIds } from './rules/ids.js';
import { checkPractices } from './rules/practices.js';
import { checkStructure } from './rules/structure.js';
import { checkTasks } from './rules/tasks.js';
import { checkUniqueness } from './rules/uniqueness.js';
import { makeContext } from './rules/context.js';
import type { ShellcheckRunner } from './shellcheck.js';
import type { ValidationError } from './types.js';

export interface ValidateOptions {
  shellcheck: ShellcheckRunner;
  /** `YYYY-MM-DD`, the reference date for the R21 reviewedAt warning. */
  today: string;
}

/**
 * Checks a loaded content tree against rules R1–R22 (spec §4.3). The result
 * starts with the loader's own errors. Async because shellcheck (R18) runs
 * external processes; it never throws on bad content.
 */
export async function validateContent(
  tree: ContentTree,
  opts: ValidateOptions,
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [...tree.errors];
  const ctx = makeContext(tree, opts.today, errors);
  checkIds(ctx);
  checkStructure(ctx);
  checkTasks(ctx);
  checkUniqueness(ctx);
  await checkPractices(ctx, opts.shellcheck);
  checkFreshness(ctx);
  return errors;
}
