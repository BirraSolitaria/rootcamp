import { normalize } from '../normalize.js';
import { INTERACTIVE_TASK_TYPES, type InteractiveTaskType } from '../types.js';
import {
  asArray,
  at,
  cyr,
  hasDuplicates,
  isObj,
  isStr,
  isStrArray,
  lessons,
  reqStr,
  type Obj,
  type RuleContext,
} from './context.js';

// Per-task rules R5–R12 and R17, the per-lesson type mix R14 and the
// per-track type share R15 (complete tracks only).

/** Fields of each task type besides id/type/explanation; `?` marks optional ones. */
const TASK_FIELDS: Record<InteractiveTaskType, string[]> = {
  single_choice: ['question', 'options', 'correctIndex'],
  true_false: ['statement', 'answer'],
  assemble: ['prompt', 'answer', 'altAnswers?', 'distractors'],
  fill_blank: ['prompt', 'template', 'acceptedAnswers'],
  match_pairs: ['prompt', 'pairs'],
  order_steps: ['prompt', 'steps'],
};

/** The field holding the question text of each type (R5 ≤ 200, R6). */
export const QUESTION_FIELD: Record<InteractiveTaskType, string> = {
  single_choice: 'question',
  true_false: 'statement',
  assemble: 'prompt',
  fill_blank: 'prompt',
  match_pairs: 'prompt',
  order_steps: 'prompt',
};

/** R15 counts only the five DockerLingo types; order_steps is optional. */
const R15_TYPES: InteractiveTaskType[] = [
  'single_choice',
  'true_false',
  'assemble',
  'fill_blank',
  'match_pairs',
];

const QUESTION_MAX = 200;
const EXPLANATION = { min: 20, max: 400 };

export const isInteractiveType = (v: unknown): v is InteractiveTaskType =>
  (INTERACTIVE_TASK_TYPES as readonly unknown[]).includes(v);

export function checkTasks(ctx: RuleContext): void {
  /** Per complete track: type → count, plus the total. */
  const trackCounts = new Map<
    string,
    { file: string; total: number; byType: Map<string, number> }
  >();

  for (const { track, lesson, src } of lessons(ctx.tree)) {
    const f = lesson.file;
    const tasks = asArray(src.tasks);
    const lessonCounts = new Map<string, number>();
    let stats = trackCounts.get(track.file);
    if (!stats && track.src.status === 'complete') {
      stats = { file: track.file, total: 0, byType: new Map() };
      trackCounts.set(track.file, stats);
    }

    tasks.forEach((task, i) => {
      const p = `tasks[${i}]`;
      if (!isObj(task)) {
        ctx.error('R7', at(f, p), 'задание должно быть объектом');
        return;
      }
      const type = checkTask(ctx, f, p, task);
      if (!type) return;
      lessonCounts.set(type, (lessonCounts.get(type) ?? 0) + 1);
      if (stats) {
        stats.total++;
        stats.byType.set(type, (stats.byType.get(type) ?? 0) + 1);
      }
    });

    // R14
    if (tasks.length > 0) {
      if (lessonCounts.size < 3) {
        ctx.error('R14', at(f, 'tasks'), `в уроке ${lessonCounts.size} типов заданий, нужно ≥ 3`);
      }
      for (const [type, count] of lessonCounts) {
        if (count * 2 > tasks.length) {
          ctx.error('R14', at(f, 'tasks'), `тип ${type}: ${count} из ${tasks.length} (> 50%)`);
        }
      }
    }
  }

  // R15
  for (const { file, total, byType } of trackCounts.values()) {
    for (const type of R15_TYPES) {
      const count = byType.get(type) ?? 0;
      if (total === 0 || count * 10 < total) {
        ctx.error('R15', file, `тип ${type}: ${count} из ${total} заданий (< 10%)`);
      }
    }
  }
}

/** Checks one task; returns its type when it is a known interactive type. */
function checkTask(
  ctx: RuleContext,
  f: string,
  p: string,
  task: Obj,
): InteractiveTaskType | undefined {
  const err = (rule: string, field: string, message: string) =>
    ctx.error(rule, at(f, `${p}.${field}`), message);

  if (
    reqStr(ctx, task.explanation, at(f, `${p}.explanation`), { max: EXPLANATION.max }) &&
    task.explanation.length < EXPLANATION.min
  ) {
    err('R5', 'explanation', `длина ${task.explanation.length} < ${EXPLANATION.min}`);
  }
  cyr(ctx, task.explanation, at(f, `${p}.explanation`));

  // R7: known type and exact field set
  if (task.type === 'terminal_practice') {
    err('R7', 'type', 'terminal_practice создаёт сборщик из узла practice; в уроке он запрещён');
    return undefined;
  }
  if (!isInteractiveType(task.type)) {
    err('R7', 'type', `неизвестный тип '${String(task.type)}'`);
    return undefined;
  }
  const type = task.type;
  const fields = TASK_FIELDS[type];
  const allowed = new Set(['id', 'type', 'explanation', ...fields.map((x) => x.replace('?', ''))]);
  for (const key of Object.keys(task)) {
    if (!allowed.has(key)) err('R7', key, `лишнее поле '${key}' для типа ${type}`);
  }
  for (const field of ['id', 'explanation', ...fields]) {
    if (!field.endsWith('?') && !(field in task))
      err('R7', field, `нет обязательного поля '${field}'`);
  }

  // R5/R6 on the question text
  const qf = QUESTION_FIELD[type];
  if (qf in task) {
    reqStr(ctx, task[qf], at(f, `${p}.${qf}`), { max: QUESTION_MAX });
    cyr(ctx, task[qf], at(f, `${p}.${qf}`));
  }

  switch (type) {
    case 'single_choice': {
      const { options, correctIndex } = task;
      if (!isStrArray(options) || options.length < 3 || options.length > 4) {
        err('R8', 'options', 'ожидается 3–4 строковых варианта');
      } else if (options.some((o) => o.trim() === '') || hasDuplicates(options.map(normalize))) {
        err('R8', 'options', 'варианты должны быть непусты и попарно различны после normalize');
      }
      const n = Array.isArray(options) ? options.length : 0;
      if (
        typeof correctIndex !== 'number' ||
        !Number.isInteger(correctIndex) ||
        correctIndex < 0 ||
        correctIndex >= n
      ) {
        err('R8', 'correctIndex', `correctIndex должен быть целым в [0, ${n})`);
      }
      break;
    }
    case 'true_false':
      if (typeof task.answer !== 'boolean') err('R9', 'answer', 'answer должен быть boolean');
      break;
    case 'assemble': {
      const { answer, distractors, altAnswers } = task;
      const badToken = (t: string) => t.trim() === '' || t !== t.trim();
      if (!isStrArray(answer) || answer.length < 2 || answer.length > 10 || answer.some(badToken)) {
        err('R10', 'answer', 'ожидается 2–10 непустых токенов без пробелов по краям');
      }
      if (
        !isStrArray(distractors) ||
        distractors.length < 1 ||
        distractors.length > 4 ||
        distractors.some(badToken)
      ) {
        err('R10', 'distractors', 'ожидается 1–4 непустых токена без пробелов по краям');
      } else if (isStrArray(answer) && distractors.some((d) => answer.includes(d))) {
        err('R10', 'distractors', 'дистрактор совпадает с токеном ответа');
      }
      if (altAnswers !== undefined) {
        if (!Array.isArray(altAnswers)) {
          err('R10', 'altAnswers', 'altAnswers должен быть массивом массивов токенов');
        } else if (isStrArray(answer)) {
          const sortedAnswer = JSON.stringify([...answer].sort());
          altAnswers.forEach((alt, ai) => {
            const ap = `altAnswers[${ai}]`;
            if (!isStrArray(alt) || alt.some(badToken))
              err('R10', ap, 'ожидается массив непустых токенов без пробелов по краям');
            else if (JSON.stringify([...alt].sort()) !== sortedAnswer)
              err('R10', ap, 'набор токенов не совпадает с answer');
            else if (JSON.stringify(alt) === JSON.stringify(answer))
              err('R10', ap, 'порядок совпадает с answer');
          });
        }
      }
      break;
    }
    case 'fill_blank': {
      const { template, acceptedAnswers } = task;
      if (!isStr(template) || template.split('___').length !== 2) {
        err('R11', 'template', "в template должно быть ровно одно '___'");
      }
      if (!isStrArray(acceptedAnswers) || acceptedAnswers.length < 1) {
        err('R11', 'acceptedAnswers', 'ожидается ≥ 1 строки');
      } else if (
        acceptedAnswers.some((a) => a.trim() === '') ||
        hasDuplicates(acceptedAnswers.map(normalize))
      ) {
        err('R11', 'acceptedAnswers', 'ответы должны быть непусты и различны после normalize');
      }
      break;
    }
    case 'match_pairs': {
      const { pairs } = task;
      const pairsOk =
        Array.isArray(pairs) && pairs.every((x) => isObj(x) && isStr(x.left) && isStr(x.right));
      if (!pairsOk || pairs.length < 3 || pairs.length > 5) {
        err('R12', 'pairs', 'ожидается 3–5 пар { left, right } из строк');
      } else {
        const ps = pairs as { left: string; right: string }[];
        const lefts = ps.map((x) => normalize(x.left));
        const rights = ps.map((x) => normalize(x.right));
        if ([...lefts, ...rights].some((s) => s === ''))
          err('R12', 'pairs', 'элементы пар не должны быть пустыми');
        if (hasDuplicates(lefts)) err('R12', 'pairs', 'left должны быть различны после normalize');
        if (hasDuplicates(rights))
          err('R12', 'pairs', 'right должны быть различны после normalize');
      }
      break;
    }
    case 'order_steps': {
      const { steps } = task;
      if (!isStrArray(steps) || steps.length < 3 || steps.length > 6) {
        err('R17', 'steps', 'ожидается 3–6 строковых шагов');
      } else if (steps.some((s) => s.trim() === '')) {
        err('R17', 'steps', 'шаги не должны быть пустыми');
      } else if (hasDuplicates(steps.map(normalize))) {
        err('R17', 'steps', 'шаги должны быть попарно различны после normalize');
      }
      break;
    }
  }
  return type;
}
