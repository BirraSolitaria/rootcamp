import {
  asArray,
  at,
  cyr,
  dayNumber,
  isObj,
  reqStr,
  type Obj,
  type RuleContext,
} from './context.js';

// Counts and texts of tracks, sections, lessons and theory cards:
// R1 (sections loaded), R2 (4–6 lessons), R3 (10–15 tasks), R5/R6, R7 (track
// fields), R16 (40–60 lessons in a complete track), R22 (no empty sections).

const TRACK_DESCRIPTION_MAX = 160;
const SECTION_DESCRIPTION_MAX = 120;
const LESSON_TITLE_MAX = 50;
const THEORY_BLOCKS = { min: 1, max: 8 };
const THEORY_CHARS_MAX = 1200;
const LESSONS_PER_SECTION = { min: 4, max: 6 };
const TASKS_PER_LESSON = { min: 10, max: 15 };
const LESSONS_PER_COMPLETE_TRACK = { min: 40, max: 60 };

export function checkStructure(ctx: RuleContext): void {
  for (const track of ctx.tree.tracks) {
    const f = track.file;
    const complete = track.src.status === 'complete';
    reqStr(ctx, track.src.title, at(f, 'title'));
    reqStr(ctx, track.src.description, at(f, 'description'), { max: TRACK_DESCRIPTION_MAX });
    if (dayNumber(track.src.reviewedAt) === undefined) {
      ctx.error(
        'R7',
        at(f, 'reviewedAt'),
        `ожидается дата YYYY-MM-DD, найдено '${String(track.src.reviewedAt)}'`,
      );
    }
    const listed = asArray(track.src.sections).length;
    if (track.sections.length !== listed) {
      ctx.error(
        'R1',
        at(f, 'sections'),
        `загружено ${track.sections.length} разделов из ${listed}`,
      );
    }

    let lessonCount = 0;
    for (const section of track.sections) {
      const sf = section.file;
      reqStr(ctx, section.src.title, at(sf, 'title'));
      reqStr(ctx, section.src.description, at(sf, 'description'), { max: SECTION_DESCRIPTION_MAX });
      const nodes = asArray(section.src.nodes);
      const lessonNodes = nodes.filter((n) => isObj(n) && 'lesson' in n).length;
      lessonCount += lessonNodes;
      if (nodes.length === 0) {
        // An empty section is a placeholder; allowed until the track is complete.
        if (complete)
          ctx.error(
            'R22',
            at(sf, 'nodes'),
            'раздел трека со status: complete не может быть пустым',
          );
      } else if (lessonNodes < LESSONS_PER_SECTION.min || lessonNodes > LESSONS_PER_SECTION.max) {
        ctx.error('R2', at(sf, 'nodes'), `ожидается 4–6 уроков, найдено ${lessonNodes}`);
      }
      for (const lesson of section.lessons) {
        if (isObj(lesson.src)) checkLesson(ctx, lesson.file, lesson.src);
      }
    }

    if (
      complete &&
      (lessonCount < LESSONS_PER_COMPLETE_TRACK.min || lessonCount > LESSONS_PER_COMPLETE_TRACK.max)
    ) {
      ctx.error('R16', at(f, 'sections'), `всего уроков ${lessonCount}, ожидается 40–60`);
    }
  }
}

function checkLesson(ctx: RuleContext, f: string, lesson: Obj): void {
  reqStr(ctx, lesson.title, at(f, 'title'), { max: LESSON_TITLE_MAX });

  const theory = lesson.theory;
  if (!isObj(theory)) {
    ctx.error('R5', at(f, 'theory'), 'теория отсутствует');
  } else {
    reqStr(ctx, theory.title, at(f, 'theory.title'));
    const blocks = asArray(theory.blocks);
    if (blocks.length < THEORY_BLOCKS.min || blocks.length > THEORY_BLOCKS.max) {
      ctx.error(
        'R5',
        at(f, 'theory.blocks'),
        `в теории должно быть 1–8 блоков, найдено ${blocks.length}`,
      );
    }
    let chars = 0;
    blocks.forEach((b, i) => {
      const bp = `theory.blocks[${i}]`;
      if (isObj(b) && b.type === 'text') {
        if (reqStr(ctx, b.text, at(f, `${bp}.text`))) chars += b.text.length;
        cyr(ctx, b.text, at(f, `${bp}.text`));
      } else if (isObj(b) && b.type === 'code') {
        if (reqStr(ctx, b.code, at(f, `${bp}.code`))) chars += b.code.length;
      } else {
        ctx.error(
          'R5',
          at(f, bp),
          'блок должен быть { type: text, text } или { type: code, code }',
        );
      }
    });
    if (chars > THEORY_CHARS_MAX) {
      ctx.error('R5', at(f, 'theory.blocks'), `теория ${chars} символов > ${THEORY_CHARS_MAX}`);
    }
  }

  const tasks = asArray(lesson.tasks);
  if (tasks.length < TASKS_PER_LESSON.min || tasks.length > TASKS_PER_LESSON.max) {
    ctx.error('R3', at(f, 'tasks'), `ожидается 10–15 заданий, найдено ${tasks.length}`);
  }
}
