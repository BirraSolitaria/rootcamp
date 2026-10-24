import { ShellcheckUnavailableError, type ShellcheckRunner } from '../shellcheck.js';
import { asArray, at, isObj, isStr, reqStr, type Obj, type RuleContext } from './context.js';

// R18: practice manifests and their scripts. R19: practice nodes in sections.
// Also R5 for the practice texts (brief 100–700 characters, §4.2).

const BRIEF = { min: 100, max: 700 };
/**
 * Goals are checked one after another in a single exec request, which the api gives 45 s
 * (SANDBOXD_TIMEOUTS_MS.execChecks); the sum of goal timeouts stays below that with headroom.
 */
const MAX_TOTAL_CHECK_SEC = 40;
const SETUP = 'setup.sh';
const SOLUTION = 'solution.sh';
/** shellcheck levels that fail validation (§4.3: warning and above). */
const FAILING_LEVELS = new Set(['error', 'warning']);

export async function checkPractices(
  ctx: RuleContext,
  shellcheck: ShellcheckRunner,
): Promise<void> {
  const trackIds = new Set(ctx.tree.tracks.map((t) => t.src.id));
  const images = new Map(ctx.tree.images.images.map((i) => [i.ref, i.class]));
  const scripts: { path: string; content: string }[] = [];

  for (const practice of ctx.tree.practices) {
    const pf = `${practice.dir}/practice.yaml`;
    const m = practice.manifest;
    const has = (rel: unknown): rel is string => isStr(rel) && Object.hasOwn(practice.files, rel);
    const script = (rel: string) => {
      const path = `${practice.dir}/${rel}`;
      if (!scripts.some((s) => s.path === path))
        scripts.push({ path, content: practice.files[rel]! });
    };

    reqStr(ctx, m.title, at(pf, 'title'));
    reqStr(ctx, m.brief, at(pf, 'brief'), BRIEF);
    reqStr(ctx, m.hostname, at(pf, 'hostname'));
    asArray(m.hints).forEach((h, i) => reqStr(ctx, h, at(pf, `hints[${i}]`)));

    if (!trackIds.has(m.track)) {
      ctx.error('R18', at(pf, 'track'), `трек '${String(m.track)}' не найден`);
    }
    const imageClass = images.get(m.image);
    if (imageClass === undefined) {
      ctx.error(
        'R18',
        at(pf, 'image'),
        `образа '${String(m.image)}' нет в sandbox/images/registry.yaml`,
      );
    } else if (imageClass !== m.class) {
      ctx.error(
        'R18',
        at(pf, 'class'),
        `класс '${String(m.class)}' не совпадает с классом образа '${imageClass}'`,
      );
    }

    asArray(m.goals).forEach((goal, i) => {
      const check = isObj(goal) ? goal.check : undefined;
      reqStr(ctx, isObj(goal) ? goal.title : undefined, at(pf, `goals[${i}].title`));
      if (!has(check))
        ctx.error('R18', at(pf, `goals[${i}].check`), `файл проверки '${String(check)}' не найден`);
      else script(check);
    });
    const totalCheckSec = asArray(m.goals).reduce<number>(
      (sum, goal) => sum + (isObj(goal) ? Number(goal.timeoutSec) || 0 : 0),
      0,
    );
    if (totalCheckSec > MAX_TOTAL_CHECK_SEC) {
      ctx.error(
        'R18',
        at(pf, 'goals'),
        `сумма timeoutSec целей ${totalCheckSec} с > ${MAX_TOTAL_CHECK_SEC} с`,
      );
    }
    if (!has(SETUP)) ctx.error('R18', practice.dir, `нет ${SETUP}`);
    else script(SETUP);
    if (m.solution !== SOLUTION) {
      ctx.error(
        'R18',
        at(pf, 'solution'),
        `ожидается '${SOLUTION}', найдено '${String(m.solution)}'`,
      );
    } else if (!has(SOLUTION)) {
      ctx.error('R18', practice.dir, `нет ${SOLUTION}`);
    }

    const reward: Obj = isObj(m.reward) ? m.reward : {};
    const hintCount = asArray(m.hints).length;
    const base = Number(reward.base);
    const hintCost = Number(reward.hintCost);
    if (!(base >= hintCost * hintCount)) {
      ctx.error(
        'R18',
        at(pf, 'reward.base'),
        `base ${base} < hintCost ${hintCost} × ${hintCount} подсказок`,
      );
    }
  }

  if (scripts.length > 0) await runShellcheck(ctx, shellcheck, scripts);
  checkPracticeNodes(ctx);
}

async function runShellcheck(
  ctx: RuleContext,
  shellcheck: ShellcheckRunner,
  scripts: { path: string; content: string }[],
): Promise<void> {
  let findings;
  try {
    findings = await shellcheck(scripts);
  } catch (e) {
    const message =
      e instanceof ShellcheckUnavailableError
        ? e.message
        : `shellcheck недоступен: ${(e as Error)?.message ?? String(e)}`;
    ctx.error('R18', 'practices', message);
    return;
  }
  for (const f of findings) {
    if (FAILING_LEVELS.has(f.level))
      ctx.error('R18', `${f.path}:${f.line}`, `shellcheck ${f.level}: ${f.message}`);
  }
}

/** R19: each practice node names an existing practice of the same track, at most once in all paths. */
function checkPracticeNodes(ctx: RuleContext): void {
  const practices = new Map(ctx.tree.practices.map((p) => [p.manifest.id, p.manifest]));
  const placed = new Map<string, string>();
  for (const track of ctx.tree.tracks) {
    for (const section of track.sections) {
      asArray(section.src.nodes).forEach((node, i) => {
        if (!isObj(node) || !isStr(node.practice)) return;
        const path = at(section.file, `nodes[${i}].practice`);
        const id = node.practice;
        const manifest = practices.get(id);
        if (!manifest) {
          ctx.error('R19', path, `практика '${id}' не найдена`);
          return;
        }
        if (manifest.track !== track.src.id) {
          ctx.error('R19', path, `практика '${id}' относится к треку '${manifest.track}'`);
        }
        const first = placed.get(id);
        if (first !== undefined)
          ctx.error('R19', path, `практика '${id}' уже стоит в пути: ${first}`);
        else placed.set(id, path);
      });
    }
  }
}
