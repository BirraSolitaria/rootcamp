import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskSchema } from '@rootcamp/content-schema';
import { loadContentTree } from '@rootcamp/content-schema/node';
import { convertUnit, mapId, trackYaml, type DockerLingoUnit } from '../src/convert.js';

const FIXTURE = new URL('./fixtures/u01.json', import.meta.url);
const loadFixture = async (): Promise<DockerLingoUnit> =>
  JSON.parse(await readFile(FIXTURE, 'utf8')) as DockerLingoUnit;

describe('mapId', () => {
  it('maps unit, lesson and task IDs into track t7', () => {
    expect(mapId('u03')).toBe('t7.s03');
    expect(mapId('u03-l02')).toBe('t7.s03.l02');
    expect(mapId('u03-l02-t07')).toBe('t7.s03.l02.t07');
  });

  it('rejects anything that is not a DockerLingo ID', () => {
    expect(() => mapId('t7.s03')).toThrow();
    expect(() => mapId('u3-l2')).toThrow();
    expect(() => mapId('u03-l02-t07-x')).toThrow();
  });
});

describe('convertUnit', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Writes a one-section track t7 from the converted unit and loads it back. */
  async function roundTrip(unit: DockerLingoUnit) {
    const out = convertUnit(unit);
    dir = await mkdtemp(join(tmpdir(), 'import-dockerlingo-'));
    const content = join(dir, 'content');
    const sectionDir = join(content, 'tracks', 't7', 's01');
    await mkdir(sectionDir, { recursive: true });
    await writeFile(join(content, 'tracks', 't7', 'track.yaml'), trackYaml(['s01']));
    await writeFile(join(sectionDir, 'section.yaml'), out.sectionYaml);
    for (const lesson of out.lessons) await writeFile(join(sectionDir, lesson.file), lesson.yaml);
    return { out, tree: await loadContentTree(content) };
  }

  it('produces YAML that loads back into the original unit with renamed IDs', async () => {
    const unit = await loadFixture();
    const { out, tree } = await roundTrip(unit);

    expect(out.lessons.map((l) => l.file)).toEqual(['l01.yaml', 'l02.yaml']);
    expect(tree.errors.filter((e) => e.path.startsWith('tracks/'))).toEqual([]);

    const track = tree.tracks[0]!;
    expect(track.src).toEqual({
      id: 't7',
      order: 7,
      title: 'Docker',
      description: expect.any(String),
      status: 'complete',
      prerequisites: ['t1', 't2', 't6'],
      reviewedAt: '2026-10-20',
      sections: ['s01'],
    });

    const section = track.sections[0]!;
    expect(section.src).toEqual({
      id: 't7.s01',
      title: unit.title,
      description: unit.description,
      nodes: [{ lesson: 'l01' }, { lesson: 'l02' }],
    });

    expect(section.lessons).toHaveLength(unit.lessons.length);
    section.lessons.forEach((loaded, i) => {
      const src = unit.lessons[i]!;
      const expectedTasks = src.tasks.map((t) => ({ ...t, id: mapId(t.id) }));
      expect(loaded.src).toEqual({
        id: mapId(src.id),
        title: src.title,
        theory: src.theory,
        tasks: expectedTasks,
      });
      loaded.src.tasks.forEach((task, j) => {
        expect(TaskSchema.parse(task)).toEqual(expectedTasks[j]);
      });
    });
  });

  it('keeps altAnswers and special characters intact', async () => {
    const unit: DockerLingoUnit = {
      id: 'u02',
      title: 'Тест: символы # и кавычки',
      description: "Описание с ': ' и '#', а также 'одинарными' кавычками.",
      lessons: [
        {
          id: 'u02-l01',
          title: 'Урок',
          theory: {
            title: 'Теория',
            blocks: [
              { type: 'text', text: 'Строка 1\nСтрока 2: с двоеточием' },
              { type: 'code', code: 'FROM alpine:3.20\nRUN echo "hi" # comment\n' },
              { type: 'code', code: '  indented\nlast' },
            ],
          },
          tasks: [
            {
              id: 'u02-l01-t01',
              type: 'assemble',
              prompt: 'Собери: команду',
              answer: ['docker', 'run', '-i', '-t', 'alpine'],
              altAnswers: [['docker', 'run', '-t', '-i', 'alpine']],
              distractors: ['-d'],
              explanation: 'Порядок флагов -i и -t не важен: true',
            },
            {
              id: 'u02-l01-t02',
              type: 'fill_blank',
              prompt: 'Впиши',
              template: 'EXPOSE ___',
              acceptedAnswers: ['80', 'true', 'null', '0x1F'],
              explanation: 'Числа и ключевые слова YAML остаются строками.',
            },
          ],
        },
      ],
    };
    const { tree } = await roundTrip(unit);
    expect(tree.errors.filter((e) => e.path.startsWith('tracks/'))).toEqual([]);
    const section = tree.tracks[0]!.sections[0]!;
    expect(section.src.title).toBe(unit.title);
    expect(section.src.description).toBe(unit.description);
    const lesson = section.lessons[0]!.src;
    expect(lesson.theory).toEqual(unit.lessons[0]!.theory);
    expect(lesson.tasks).toEqual(unit.lessons[0]!.tasks.map((t) => ({ ...t, id: mapId(t.id) })));
  });

  it('rejects a lesson or task whose ID does not belong to its parent', () => {
    const bad = (lessonId: string, taskId: string): DockerLingoUnit => ({
      id: 'u01',
      title: 'x',
      description: 'x',
      lessons: [
        {
          id: lessonId,
          title: 'x',
          theory: { title: 'x', blocks: [] },
          tasks: [
            { id: taskId, type: 'true_false', statement: 'x', answer: true, explanation: 'x' },
          ],
        },
      ],
    });
    expect(() => convertUnit(bad('u02-l01', 'u02-l01-t01'))).toThrow(/u02-l01/);
    expect(() => convertUnit(bad('u01-l01', 'u01-l02-t01'))).toThrow(/u01-l02-t01/);
  });

  it('rejects fields that have no rootcamp equivalent instead of dropping them', () => {
    const unit = {
      id: 'u01',
      title: 'x',
      description: 'x',
      lessons: [
        {
          id: 'u01-l01',
          title: 'x',
          theory: { title: 'x', blocks: [] },
          tasks: [
            {
              id: 'u01-l01-t01',
              type: 'true_false',
              statement: 'x',
              answer: true,
              explanation: 'x',
              hint: 'unknown field',
            },
          ],
        },
      ],
    } as unknown as DockerLingoUnit;
    expect(() => convertUnit(unit)).toThrow(/hint/);
  });
});
