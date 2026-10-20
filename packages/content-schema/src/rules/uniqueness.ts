import { normalize, normalizeKey } from '../normalize.js';
import {
  asArray,
  at,
  isObj,
  isStr,
  isStrArray,
  lessons,
  type Obj,
  type RuleContext,
} from './context.js';
import { isInteractiveType } from './tasks.js';

// R4: IDs are unique across the whole content tree.
// R13: no two tasks of the same type ask the same question, across all tracks.

export function checkUniqueness(ctx: RuleContext): void {
  const seenIds = new Map<string, string>();
  const unique = (id: unknown, path: string) => {
    if (!isStr(id)) return;
    const first = seenIds.get(id);
    if (first !== undefined) ctx.error('R4', path, `id '${id}' уже использован в ${first}`);
    else seenIds.set(id, path);
  };
  for (const track of ctx.tree.tracks) {
    unique(track.src.id, at(track.file, 'id'));
    for (const section of track.sections) {
      unique(section.src.id, at(section.file, 'id'));
      for (const lesson of section.lessons) {
        unique(lesson.src?.id, at(lesson.file, 'id'));
        asArray(lesson.src?.tasks).forEach((task, i) => {
          if (isObj(task)) unique(task.id, at(lesson.file, `tasks[${i}].id`));
        });
      }
    }
  }
  for (const practice of ctx.tree.practices) {
    unique(practice.manifest.id, at(`${practice.dir}/practice.yaml`, 'id'));
  }

  const seenKeys = new Map<string, string>();
  for (const { lesson, src } of lessons(ctx.tree)) {
    asArray(src.tasks).forEach((task, i) => {
      if (!isObj(task)) return;
      const key = questionKey(task);
      if (key === undefined) return;
      const path = at(lesson.file, `tasks[${i}]`);
      const first = seenKeys.get(key);
      if (first !== undefined) ctx.error('R13', path, `дубликат вопроса: совпадает с ${first}`);
      else seenKeys.set(key, path);
    });
  }
}

/** R13 key: `<type>|normalizeKey(question text)`; the text depends on the type. */
function questionKey(task: Obj): string | undefined {
  const text = questionText(task);
  return text === undefined ? undefined : `${String(task.type)}|${normalizeKey(text)}`;
}

function questionText(task: Obj): string | undefined {
  if (!isInteractiveType(task.type)) return undefined;
  const { prompt } = task;
  switch (task.type) {
    case 'single_choice':
      return isStr(task.question) ? task.question : undefined;
    case 'true_false':
      return isStr(task.statement) ? task.statement : undefined;
    case 'assemble':
      return isStr(prompt) && isStrArray(task.answer)
        ? `${prompt} ${task.answer.join(' ')}`
        : undefined;
    case 'fill_blank':
      return isStr(task.template) ? task.template : undefined;
    case 'match_pairs': {
      const pairs = asArray(task.pairs);
      if (!isStr(prompt) || !pairs.every((x) => isObj(x) && isStr(x.left))) return undefined;
      const lefts = pairs.map((x) => normalize((x as { left: string }).left)).sort();
      return `${prompt} ${lefts.join(' ')}`;
    }
    case 'order_steps':
      return isStr(prompt) && isStrArray(task.steps)
        ? `${prompt} ${task.steps.join('|')}`
        : undefined;
  }
}
