import {
  asArray,
  at,
  dayNumber,
  isObj,
  isStr,
  isStrArray,
  lessons,
  strings,
  type Obj,
  type RuleContext,
} from './context.js';
import { isInteractiveType } from './tasks.js';

// R21: currency linter. Errors in theory `code` blocks and in correct answers;
// warnings for a stale reviewedAt and for ingress-nginx without «снят».

const COMPOSE_V1 = /\bdocker-compose\b(?!\.ya?ml)/;
const COMPOSE_V1_FILE = /\bdocker-compose\.ya?ml\b/;
const COMPOSE_SERVICES = /services:/;
const COMPOSE_VERSION = /^\s*version\s*:/m;
const INGRESS_NGINX = /ingress-nginx/i;
const RETIRED = /снят/i;
const REVIEW_MAX_DAYS = 180;

export function checkFreshness(ctx: RuleContext): void {
  const today = dayNumber(ctx.today);
  for (const track of ctx.tree.tracks) {
    const reviewed = dayNumber(track.src.reviewedAt);
    if (today !== undefined && reviewed !== undefined && today - reviewed > REVIEW_MAX_DAYS) {
      ctx.warn(
        'R21',
        at(track.file, 'reviewedAt'),
        `сверка была ${today - reviewed} дней назад (> ${REVIEW_MAX_DAYS})`,
      );
    }
  }

  for (const { lesson, src } of lessons(ctx.tree)) {
    const f = lesson.file;
    const theory = isObj(src.theory) ? src.theory : {};
    asArray(theory.blocks).forEach((b, i) => {
      if (!isObj(b) || b.type !== 'code' || !isStr(b.code)) return;
      const path = at(f, `theory.blocks[${i}].code`);
      checkModernCompose(ctx, path, b.code);
      if (COMPOSE_SERVICES.test(b.code) && COMPOSE_VERSION.test(b.code)) {
        ctx.error('R21', path, 'ключ version: в compose-файле устарел, его нужно удалить');
      }
    });
    asArray(src.tasks).forEach((task, i) => {
      if (!isObj(task)) return;
      for (const [field, text] of answerTexts(task))
        checkModernCompose(ctx, at(f, `tasks[${i}].${field}`), text);
    });
    for (const [field, text] of strings(src)) {
      if (INGRESS_NGINX.test(text) && !RETIRED.test(text)) {
        ctx.warn(
          'R21',
          at(f, field),
          'ingress-nginx упомянут без пометки, что он снят с поддержки',
        );
      }
    }
  }
}

function checkModernCompose(ctx: RuleContext, path: string, text: string): void {
  if (COMPOSE_V1.test(text)) {
    ctx.error('R21', path, 'docker-compose через дефис устарел: используй docker compose');
  }
  if (COMPOSE_V1_FILE.test(text)) {
    ctx.error('R21', path, 'имя по умолчанию — compose.yaml, а не docker-compose.yml');
  }
}

/** Texts a learner gives or sees as correct: `[field locator, text]`. */
function answerTexts(task: Obj): [string, string][] {
  if (!isInteractiveType(task.type)) return [];
  const out: [string, string][] = [];
  switch (task.type) {
    case 'single_choice': {
      const i = task.correctIndex;
      if (isStrArray(task.options) && typeof i === 'number' && isStr(task.options[i])) {
        out.push([`options[${i}]`, task.options[i]]);
      }
      break;
    }
    case 'true_false':
      if (task.answer === true && isStr(task.statement)) out.push(['statement', task.statement]);
      break;
    case 'assemble':
      if (isStrArray(task.answer)) out.push(['answer', task.answer.join(' ')]);
      asArray(task.altAnswers).forEach((alt, i) => {
        if (isStrArray(alt)) out.push([`altAnswers[${i}]`, alt.join(' ')]);
      });
      break;
    case 'fill_blank':
      asArray(task.acceptedAnswers).forEach((a, i) => {
        if (!isStr(a)) return;
        const filled = isStr(task.template) ? task.template.replace('___', a) : a;
        out.push([`acceptedAnswers[${i}]`, filled]);
      });
      break;
    case 'match_pairs':
      asArray(task.pairs).forEach((p, i) => {
        if (!isObj(p)) return;
        if (isStr(p.left)) out.push([`pairs[${i}].left`, p.left]);
        if (isStr(p.right)) out.push([`pairs[${i}].right`, p.right]);
      });
      break;
    case 'order_steps':
      asArray(task.steps).forEach((s, i) => {
        if (isStr(s)) out.push([`steps[${i}]`, s]);
      });
      break;
  }
  return out;
}
