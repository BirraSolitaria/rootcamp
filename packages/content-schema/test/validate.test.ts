import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  defaultShellcheck,
  loadContentTree,
  validateContent,
  type ContentTree,
  type ExecFn,
  type ShellcheckRunner,
} from '../src/node.js';
import { runCli } from '../src/cli.js';

const MINI = fileURLToPath(new URL('./fixtures/mini', import.meta.url));
const MINI_CONTENT = `${MINI}/content`;
const TODAY = '2026-10-20';
const cleanShellcheck: ShellcheckRunner = async () => [];

let fixture: ContentTree;
beforeAll(async () => {
  fixture = await loadContentTree(MINI_CONTENT);
  expect(fixture.errors).toEqual([]);
});

/* eslint-disable @typescript-eslint/no-explicit-any -- mutations build deliberately broken trees */
const base = (): any => structuredClone(fixture);
const track = (t: any) => t.tracks[0];
const section = (t: any) => track(t).sections[0];
const lesson = (t: any, i = 0) => section(t).lessons[i].src;
// Fixture layout of every lesson: 0,1 single_choice · 2,3 true_false · 4,5 assemble ·
// 6,7 fill_blank · 8 match_pairs · 9 order_steps.
const task = (t: any, i: number, l = 0) => lesson(t, l).tasks[i];
const practice = (t: any) => t.practices[0];

/** The fixture track re-identified as `id` (all IDs and files moved), without the practice node. */
const trackCopy = (t: any, id: string) => {
  const copy = JSON.parse(
    JSON.stringify(track(t)).replaceAll('"t9', `"${id}`).replaceAll('tracks/t9/', `tracks/${id}/`),
  );
  copy.sections[0].src.nodes = copy.sections[0].src.nodes.filter((n: any) => 'lesson' in n);
  return copy;
};

const explanation = 'Пояснение к заданию: так устроен Docker.';
const singleChoice = (id: string) => ({
  id,
  type: 'single_choice',
  explanation,
  question: `Новый вопрос ${id}?`,
  options: ['Да', 'Нет', 'Может быть'],
  correctIndex: 0,
});
const trueFalse = (id: string) => ({
  id,
  type: 'true_false',
  explanation,
  statement: `Новое утверждение ${id}.`,
  answer: true,
});

const validate = (
  tree: ContentTree,
  shellcheck: ShellcheckRunner = cleanShellcheck,
  today = TODAY,
) => validateContent(tree, { shellcheck, today });

it('the mini fixture is valid', async () => {
  expect(await validate(fixture)).toEqual([]);
});

const cases: [string, (t: any) => void][] = [
  ['R1', (t) => void (track(t).src.sections = ['s02'])],
  ['R1', (t) => void (track(t).src.sections = ['s01', 's02'])], // s02 not loaded
  ['R1', (t) => void (track(t).src.sections = ['../x'])],
  ['R1', (t) => void (section(t).src.id = 't9.s02')],
  ['R2', (t) => void section(t).src.nodes.splice(3, 1)], // 3 lessons
  ['R2', (t) => void (section(t).src.nodes[1] = { lesson: '../x' })],
  ['R2', (t) => void (section(t).src.nodes[1] = { lesson: 'l03' })], // sequence gap
  ['R2', (t) => void (lesson(t).id = 't9.s01.l05')],
  ['R3', (t) => void (lesson(t).tasks.length = 9)],
  ['R3', (t) => void (task(t, 1).id = 't9.s01.l01.t2')],
  ['R3', (t) => void (task(t, 1).id = 't9.s01.l01.t03')],
  ['R4', (t) => void t.practices.push(structuredClone(practice(t)))],
  ['R5', (t) => void (section(t).src.description = 'а'.repeat(121))],
  ['R5', (t) => void (track(t).src.description = 'а'.repeat(161))],
  ['R5', (t) => void (lesson(t).title = 'а'.repeat(51))],
  ['R5', (t) => void (lesson(t).title = '   ')],
  ['R5', (t) => void (lesson(t).theory.blocks = [])],
  ['R5', (t) => void (lesson(t).theory.blocks = [{ type: 'code', code: 'x'.repeat(1201) }])],
  ['R5', (t) => void (task(t, 0).explanation = 'Коротко')],
  ['R5', (t) => void (task(t, 0).question = `${'а'.repeat(200)}?`)],
  ['R5', (t) => void (practice(t).manifest.brief = 'Короткий бриф.')],
  ['R6', (t) => void (task(t, 0).explanation = 'Only latin text here, long enough')],
  ['R6', (t) => void (lesson(t).theory.blocks[0].text = 'latin only')],
  ['R7', (t) => void (track(t).src.id = 'track9')],
  ['R7', (t) => void (track(t).src.reviewedAt = '2026-13-01')],
  ['R7', (t) => void (track(t).src.prerequisites = ['linux'])],
  ['R7', (t) => void (task(t, 0).type = 'essay')],
  [
    'R7',
    (t) =>
      void (lesson(t).tasks[0] = {
        id: 't9.s01.l01.t01',
        type: 'terminal_practice',
        practiceId: 'inc-demo',
      }),
  ],
  [
    'R7',
    (t) => void t.errors.push({ path: 'x.yaml', rule: 'R7', message: 'loader', severity: 'error' }),
  ],
  ['R8', (t) => void (task(t, 0).options = ['a', 'A ', 'b'])],
  ['R8', (t) => void (task(t, 0).correctIndex = 3)],
  ['R8', (t) => void (task(t, 0).options = ['a', 'b'])],
  ['R9', (t) => void (task(t, 2).answer = 'true')],
  ['R10', (t) => void (task(t, 4).distractors = ['run'])],
  ['R10', (t) => void (task(t, 5).altAnswers = [['docker', 'run', '-i', '-t', 'alpine']])], // same order
  ['R10', (t) => void (task(t, 5).altAnswers = [['docker', 'run', '-i', 'alpine']])], // other multiset
  ['R10', (t) => void (task(t, 4).answer = ['docker', ' run', '-d', 'nginx'])],
  ['R10', (t) => void (task(t, 4).answer = ['docker'])],
  ['R11', (t) => void (task(t, 6).template = 'docker ___ ___')],
  ['R11', (t) => void (task(t, 6).acceptedAnswers = ['ps', ' PS'])],
  ['R11', (t) => void (task(t, 6).acceptedAnswers = [])],
  ['R12', (t) => void (task(t, 8).pairs = task(t, 8).pairs.slice(0, 2))],
  ['R12', (t) => void (task(t, 8).pairs[1].right = ` ${task(t, 8).pairs[0].right.toUpperCase()} `)],
  ['R13', (t) => void (task(t, 1).question = task(t, 0).question.replace('?', '!'))],
  ['R13', (t) => void (task(t, 0, 1).question = `«${task(t, 0).question}»`)], // across lessons
  ['R13', (t) => void t.tracks.push(trackCopy(t, 't8'))], // across tracks
  [
    'R14',
    (t) => {
      for (const i of [2, 3, 4, 5]) lesson(t).tasks[i] = singleChoice(task(t, i).id); // 6 of 10
    },
  ],
  [
    'R14',
    (t) => {
      const l = lesson(t);
      l.tasks = l.tasks.map((x: any, i: number) => (i < 5 ? singleChoice(x.id) : trueFalse(x.id)));
    },
  ],
  [
    'R15',
    (t) => {
      track(t).src.status = 'complete';
      lesson(t).tasks[8] = trueFalse(task(t, 8).id); // match_pairs 3 of 40
    },
  ],
  ['R16', (t) => void (track(t).src.status = 'complete')], // 4 lessons
  ['R17', (t) => void (task(t, 9).steps = ['Скачать образ', 'Запустить контейнер'])],
  ['R17', (t) => void (task(t, 9).steps = ['Нажать Enter', ' нажать  enter', 'Скачать образ'])],
  ['R17', (t) => void (task(t, 9).steps = ['Скачать образ', '', 'Запустить контейнер'])],
  ['R18', (t) => void (practice(t).manifest.image = 'rc/unknown:1')],
  ['R18', (t) => void (practice(t).manifest.class = 'heavy')],
  ['R18', (t) => void (practice(t).manifest.goals[0].check = 'check/missing.sh')],
  ['R18', (t) => void delete practice(t).files['setup.sh']],
  ['R18', (t) => void delete practice(t).files['solution.sh']],
  ['R18', (t) => void (practice(t).manifest.solution = 'fix.sh')],
  ['R18', (t) => void (practice(t).manifest.reward.base = 9)], // < 5 × 2 hints
  ['R18', (t) => void (practice(t).manifest.id = 'inc-x')],
  ['R18', (t) => void (practice(t).manifest.goals[1].id = 'File_Created')],
  ['R18', (t) => void (practice(t).manifest.track = 't5')],
  ['R19', (t) => void section(t).src.nodes.push({ practice: 'inc-missing' })],
  ['R19', (t) => void section(t).src.nodes.push({ practice: 'inc-demo' })],
  ['R19', (t) => void section(t).src.nodes.push({ practice: '../inc-demo' })],
  ['R20', (t) => void (t.publishedIds = ['t9.s01.l05'])],
  ['R20', (t) => void (t.publishedIds = ['t9.s01.l01.t11'])],
  ['R21', (t) => void (lesson(t).theory.blocks[1].code = 'docker-compose up -d')],
  ['R21', (t) => void (task(t, 6).acceptedAnswers = ['docker-compose ps'])],
  ['R21', (t) => void (task(t, 0).options[0] = 'docker-compose up')], // correct option
  [
    'R21',
    (t) =>
      void (lesson(t).theory.blocks[1].code =
        "version: '3.8'\nservices:\n  web:\n    image: nginx"),
  ],
  [
    'R21',
    (t) => void (lesson(t).theory.blocks[1].code = 'docker compose -f docker-compose.yml up'),
  ],
  [
    'R22',
    (t) => {
      track(t).src.status = 'complete';
      section(t).src.nodes = [];
      section(t).lessons = [];
    },
  ],
];

it.each(cases)('%s is detected', async (rule, mutate) => {
  const t = base();
  mutate(t);
  const errors = await validate(t);
  expect(errors.some((e) => e.rule === rule && e.severity === 'error')).toBe(true);
});

describe('rule details', () => {
  it('errors carry a file path with a field locator', async () => {
    const t = base();
    task(t, 0, 2).options = ['x', 'X', 'y'];
    const errors = await validate(t);
    expect(errors).toEqual([
      expect.objectContaining({
        rule: 'R8',
        path: 'tracks/t9/s01/l03.yaml#tasks[0].options',
        severity: 'error',
      }),
    ]);
  });

  it('R17: order_steps steps equal after normalize', async () => {
    const t = base();
    task(t, 9).steps = ['Нажать Enter', ' нажать  enter', 'Прочитать вывод'];
    const errors = await validate(t);
    expect(errors.map((e) => e.rule)).toEqual(['R17']);
  });

  it('R13 compares questions across tracks', async () => {
    const t = base();
    t.tracks.push(trackCopy(t, 't8'));
    const errors = await validate(t);
    expect(new Set(errors.map((e) => e.rule))).toEqual(new Set(['R13']));
    expect(errors).toHaveLength(40);
  });

  it('R13: order_steps key is prompt + steps', async () => {
    const t = base();
    const other = task(t, 9, 1);
    other.prompt = task(t, 9).prompt;
    expect(await validate(t)).toEqual([]); // same prompt, different steps
    other.steps = [...task(t, 9).steps];
    expect((await validate(t)).map((e) => e.rule)).toEqual(['R13']);
  });

  it('R15/R16/R22 do not apply to partial and draft tracks', async () => {
    for (const status of ['partial', 'draft']) {
      const t = base();
      track(t).src.status = status;
      lesson(t).tasks[8] = trueFalse(task(t, 8).id);
      t.tracks.push({
        file: 'tracks/t8/track.yaml',
        src: { ...structuredClone(track(t).src), id: 't8', status },
        sections: [
          {
            file: 'tracks/t8/s01/section.yaml',
            src: { id: 't8.s01', title: 'Заготовка', description: 'Пока пусто', nodes: [] },
            lessons: [],
          },
        ],
      });
      expect(await validate(t)).toEqual([]);
    }
  });

  it('R15 does not require order_steps', async () => {
    const t = base();
    track(t).src.status = 'complete';
    for (const l of section(t).lessons) l.src.tasks[9] = trueFalse(l.src.tasks[9].id);
    const rules = (await validate(t)).map((e) => e.rule);
    expect(rules).not.toContain('R15');
    expect(rules).toContain('R16');
  });

  it('R18: shellcheck warnings fail, info/style do not', async () => {
    const seen: string[][] = [];
    const runner =
      (level: 'warning' | 'info' | 'style' | 'error'): ShellcheckRunner =>
      async (files) => {
        seen.push(files.map((f) => f.path));
        return [{ path: files[0]!.path, line: 2, level, message: 'SC2086: quote it' }];
      };
    for (const level of ['info', 'style'] as const) {
      expect(await validate(fixture, runner(level))).toEqual([]);
    }
    for (const level of ['warning', 'error'] as const) {
      const errors = await validate(fixture, runner(level));
      expect(errors).toEqual([
        expect.objectContaining({
          rule: 'R18',
          severity: 'error',
          path: expect.stringMatching(/:2$/),
        }),
      ]);
    }
    expect(seen[0]!.sort()).toEqual([
      'practices/inc-demo/check/file-created.sh',
      'practices/inc-demo/check/service-running.sh',
      'practices/inc-demo/setup.sh',
    ]);
  });

  it('R18: a runner throwing ENOENT gives exactly one "shellcheck недоступен" error', async () => {
    const enoent: ShellcheckRunner = async () => {
      throw Object.assign(new Error('spawn shellcheck ENOENT'), { code: 'ENOENT' });
    };
    const errors = await validate(fixture, enoent);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ rule: 'R18', severity: 'error' });
    expect(errors[0]!.message).toContain('shellcheck недоступен');
  });

  it('R18: shellcheck is not called when there are no scripts', async () => {
    const t = base();
    t.practices = [];
    section(t).src.nodes.pop();
    const never: ShellcheckRunner = async () => {
      throw new Error('must not be called');
    };
    expect(await validate(t, never)).toEqual([]);
  });

  it('R20: removed IDs may disappear; practice lessons count as present', async () => {
    const t = base();
    t.publishedIds = [
      't9',
      't9.s01.l01.t10',
      't9.s01.p-inc-demo',
      't9.s01.p-inc-demo.t01',
      't9.s02',
    ];
    t.removedIds = ['t9.s02'];
    expect(await validate(t)).toEqual([]);
  });

  it('R21 warnings: stale reviewedAt and ingress-nginx without «снят»', async () => {
    const t = base();
    lesson(t).theory.blocks[0].text = 'Контроллер ingress-nginx часто встречается в кластерах.';
    lesson(t, 1).theory.blocks[0].text =
      'Контроллер ingress-nginx снят с поддержки, выбирай другой.';
    const errors = await validate(t, cleanShellcheck, '2027-04-19'); // 181 days later
    expect(errors.map((e) => [e.rule, e.severity, e.path])).toEqual([
      ['R21', 'warning', 'tracks/t9/track.yaml#reviewedAt'],
      ['R21', 'warning', 'tracks/t9/s01/l01.yaml#theory.blocks[0].text'],
    ]);
    expect(await validate(fixture, cleanShellcheck, '2027-04-18')).toEqual([]); // 180 days
  });

  it('R21: docker-compose.yml alone is not reported twice', async () => {
    const t = base();
    lesson(t).theory.blocks[1].code = 'cat docker-compose.yml';
    expect((await validate(t)).map((e) => e.rule)).toEqual(['R21']);
  });

  it('does not throw on garbage inside the tree', async () => {
    const t = base();
    lesson(t).tasks.push(null, 7, { type: 'single_choice' });
    lesson(t).theory = null;
    section(t).src.nodes.push(null);
    practice(t).manifest.goals = null;
    await expect(validate(t)).resolves.not.toHaveLength(0);
  });
});

describe('defaultShellcheck', () => {
  const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  const files = [{ path: 'practices/inc-demo/setup.sh', content: '#!/bin/sh\necho $1\n' }];
  const json = JSON.stringify([
    { file: '-', line: 2, level: 'info', code: 2086, message: 'Double quote.' },
  ]);

  it('uses shellcheck from PATH', async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd, args, stdin) => {
      calls.push([cmd, ...args].join(' '));
      expect(stdin).toBe(files[0]!.content);
      return { code: 1, stdout: json, stderr: '' };
    };
    expect(await defaultShellcheck(exec)(files)).toEqual([
      {
        path: 'practices/inc-demo/setup.sh',
        line: 2,
        level: 'info',
        message: 'SC2086: Double quote.',
      },
    ]);
    expect(calls).toEqual(['shellcheck -f json -']);
  });

  it('falls back to docker on ENOENT', async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'shellcheck') throw enoent();
      return { code: 1, stdout: json, stderr: '' };
    };
    expect(await defaultShellcheck(exec)(files)).toHaveLength(1);
    expect(calls).toEqual([
      'shellcheck -f json -',
      'docker run --rm -i koalaman/shellcheck:v0.10.0 -f json -',
    ]);
  });

  it('without shellcheck and docker validation reports one R18 error and does not throw', async () => {
    const exec: ExecFn = async () => {
      throw enoent();
    };
    const errors = await validate(fixture, defaultShellcheck(exec));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ rule: 'R18', severity: 'error' });
    expect(errors[0]!.message).toContain('shellcheck недоступен');
  });

  it('treats an unreachable docker daemon as unavailable', async () => {
    const exec: ExecFn = async (cmd) => {
      if (cmd === 'shellcheck') throw enoent();
      return { code: 1, stdout: '', stderr: 'failed to connect to the docker API' };
    };
    await expect(defaultShellcheck(exec)(files)).rejects.toThrow(/shellcheck недоступен/);
  });
});

describe('CLI', () => {
  const capture = () => {
    const lines: string[] = [];
    return { lines, out: (s: string) => void lines.push(s) };
  };

  it('prints a summary and exits 0 for a valid tree', async () => {
    const { lines, out } = capture();
    const code = await runCli(['validate', MINI_CONTENT], {
      shellcheck: cleanShellcheck,
      today: TODAY,
      out,
    });
    expect(code).toBe(0);
    expect(lines).toEqual(['0 errors, 0 warnings']);
  });

  it('an R21 warning alone keeps exit code 0', async () => {
    const { lines, out } = capture();
    const code = await runCli(['validate', MINI_CONTENT], {
      shellcheck: cleanShellcheck,
      today: '2027-06-01',
      out,
    });
    expect(code).toBe(0);
    expect(lines).toEqual([
      expect.stringMatching(/^warning R21 tracks\/t9\/track\.yaml#reviewedAt: /),
      '0 errors, 1 warnings',
    ]);
  });

  it('exits 1 on errors and prints them', async () => {
    const { lines, out } = capture();
    const code = await runCli(['validate', `${MINI}/missing`], {
      shellcheck: cleanShellcheck,
      today: TODAY,
      out,
    });
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^error R7 removed-ids\.yaml: /);
    expect(lines.at(-1)).toMatch(/^\d+ errors, 0 warnings$/);
  });

  it('exits 2 on bad usage', async () => {
    const { out } = capture();
    expect(await runCli([], { shellcheck: cleanShellcheck, today: TODAY, out })).toBe(2);
  });
});
