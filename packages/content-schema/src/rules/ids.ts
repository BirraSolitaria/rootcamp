import { ID_RE } from '../ids.js';
import { asArray, at, dirOf, isObj, isStr, pad2, stemOf, type RuleContext } from './context.js';

// ID formats (§4.1) and their positions in the tree:
// track → R7, sections → R1, lessons and lesson nodes → R2, tasks → R3,
// practices and goals → R18, practice nodes → R19; plus R20 (published IDs).

export function checkIds(ctx: RuleContext): void {
  for (const track of ctx.tree.tracks) {
    const f = track.file;
    const trackId = track.src.id;
    const trackDir = stemOf(dirOf(f)); // tracks/<t>/track.yaml → <t>
    if (!isStr(trackId) || !ID_RE.track.test(trackId)) {
      ctx.error('R7', at(f, 'id'), `id трека '${String(trackId)}' не соответствует t\\d{1,2}`);
    } else if (trackId !== trackDir) {
      ctx.error('R7', at(f, 'id'), `id трека '${trackId}' не совпадает с каталогом '${trackDir}'`);
    }
    asArray(track.src.prerequisites).forEach((p, i) => {
      if (!isStr(p) || !ID_RE.track.test(p)) {
        ctx.error('R7', at(f, `prerequisites[${i}]`), `'${String(p)}' не является id трека`);
      }
    });

    asArray(track.src.sections).forEach((name, i) => {
      const expected = `s${pad2(i + 1)}`;
      if (name !== expected) {
        ctx.error(
          'R1',
          at(f, `sections[${i}]`),
          `ожидается '${expected}', найдено '${String(name)}'`,
        );
      }
    });

    for (const section of track.sections) {
      const sf = section.file;
      const sectionDir = dirOf(sf); // tracks/<t>/<s>
      const expectedSectionId = `${trackDir}.${stemOf(sectionDir)}`;
      const sectionId = section.src.id;
      if (!isStr(sectionId) || !ID_RE.section.test(sectionId) || sectionId !== expectedSectionId) {
        ctx.error(
          'R1',
          at(sf, 'id'),
          `ожидается id раздела '${expectedSectionId}', найдено '${String(sectionId)}'`,
        );
      }

      let lessonNo = 0;
      asArray(section.src.nodes).forEach((node, i) => {
        if (isObj(node) && 'lesson' in node) {
          const expected = `l${pad2(++lessonNo)}`;
          if (node.lesson !== expected) {
            ctx.error(
              'R2',
              at(sf, `nodes[${i}].lesson`),
              `ожидается '${expected}', найдено '${String(node.lesson)}'`,
            );
          }
        } else if (isObj(node) && 'practice' in node) {
          if (!isStr(node.practice) || !ID_RE.practice.test(node.practice)) {
            ctx.error(
              'R19',
              at(sf, `nodes[${i}].practice`),
              `'${String(node.practice)}' не является id практики`,
            );
          }
        } else {
          ctx.error('R7', at(sf, `nodes[${i}]`), 'узел должен быть { lesson } или { practice }');
        }
      });

      for (const lesson of section.lessons) {
        const lf = lesson.file;
        const expectedLessonId = `${expectedSectionId}.${stemOf(lf)}`;
        const lessonId = lesson.src?.id;
        if (!isStr(lessonId) || !ID_RE.lesson.test(lessonId) || lessonId !== expectedLessonId) {
          ctx.error(
            'R2',
            at(lf, 'id'),
            `ожидается id урока '${expectedLessonId}', найдено '${String(lessonId)}'`,
          );
        }
        asArray(lesson.src?.tasks).forEach((task, i) => {
          const expected = `${expectedLessonId}.t${pad2(i + 1)}`;
          const id = isObj(task) ? task.id : undefined;
          if (!isStr(id) || !ID_RE.task.test(id)) {
            ctx.error(
              'R3',
              at(lf, `tasks[${i}].id`),
              `'${String(id)}' не соответствует формату id задания`,
            );
          } else if (id !== expected) {
            ctx.error(
              'R3',
              at(lf, `tasks[${i}].id`),
              `ожидается id '${expected}', найдено '${id}'`,
            );
          }
        });
      }
    }
  }

  for (const practice of ctx.tree.practices) {
    const pf = `${practice.dir}/practice.yaml`;
    const m = practice.manifest;
    const dirName = stemOf(practice.dir);
    if (!isStr(m.id) || !ID_RE.practice.test(m.id)) {
      ctx.error('R18', at(pf, 'id'), `'${String(m.id)}' не соответствует inc-[a-z0-9-]{3,40}`);
    } else if (m.id !== dirName) {
      ctx.error('R18', at(pf, 'id'), `id практики '${m.id}' не совпадает с каталогом '${dirName}'`);
    }
    const goalIds: string[] = [];
    asArray(m.goals).forEach((goal, i) => {
      const id = isObj(goal) ? goal.id : undefined;
      if (!isStr(id) || !ID_RE.goal.test(id)) {
        ctx.error(
          'R18',
          at(pf, `goals[${i}].id`),
          `'${String(id)}' не соответствует [a-z0-9-]{2,30}`,
        );
      } else if (goalIds.includes(id)) {
        ctx.error('R18', at(pf, `goals[${i}].id`), `id цели '${id}' повторяется`);
      } else goalIds.push(id);
    });
  }

  checkPublishedIds(ctx);
}

/** Every ID the tree defines, including the builder's practice lessons `<section>.p-<practice>`. */
export function treeIds(ctx: RuleContext): Set<string> {
  const ids = new Set<string>();
  const add = (v: unknown) => void (isStr(v) && ids.add(v));
  for (const track of ctx.tree.tracks) {
    add(track.src.id);
    for (const section of track.sections) {
      add(section.src.id);
      for (const node of asArray(section.src.nodes)) {
        if (isObj(node) && isStr(node.practice) && isStr(section.src.id)) {
          const lessonId = `${section.src.id}.p-${node.practice}`;
          add(lessonId);
          add(`${lessonId}.t01`);
        }
      }
      for (const lesson of section.lessons) {
        add(lesson.src?.id);
        for (const task of asArray(lesson.src?.tasks)) if (isObj(task)) add(task.id);
      }
    }
  }
  for (const practice of ctx.tree.practices) add(practice.manifest.id);
  return ids;
}

/** R20: a published ID may only disappear when listed in removed-ids.yaml. */
function checkPublishedIds(ctx: RuleContext): void {
  const present = treeIds(ctx);
  const removed = new Set(ctx.tree.removedIds);
  for (const id of ctx.tree.publishedIds) {
    if (!present.has(id) && !removed.has(id)) {
      ctx.error(
        'R20',
        'published-ids.json',
        `опубликованный id '${id}' исчез; удаление — только через removed-ids.yaml`,
      );
    }
  }
}
