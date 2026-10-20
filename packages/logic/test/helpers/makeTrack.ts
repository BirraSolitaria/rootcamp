import { INTERACTIVE_TASK_TYPES } from '@rootcamp/content-schema';
import type {
  InteractiveTaskType,
  Lesson,
  PathNode,
  Section,
  SectionRef,
  Task,
  Track,
} from '@rootcamp/content-schema';
import type { CourseIndex } from '../../src/courseQuery.js';

const pad2 = (n: number) => String(n).padStart(2, '0');

export function makeTask(id: string, type: InteractiveTaskType): Task {
  const explanation = `Пояснение к заданию ${id}: так устроен Docker.`;
  switch (type) {
    case 'single_choice':
      return {
        id,
        type,
        explanation,
        question: `Вопрос ${id}: что верно?`,
        options: [`Вариант А ${id}`, `Вариант Б ${id}`, `Вариант В ${id}`],
        correctIndex: 0,
      };
    case 'true_false':
      return { id, type, explanation, statement: `Утверждение ${id} верно.`, answer: true };
    case 'assemble':
      return {
        id,
        type,
        explanation,
        prompt: `Собери команду ${id}`,
        answer: ['docker', 'run', 'nginx'],
        distractors: ['стоп'],
      };
    case 'fill_blank':
      return {
        id,
        type,
        explanation,
        prompt: `Впиши пропуск ${id}`,
        template: `Команда ${id}: docker ___ nginx`,
        acceptedAnswers: ['run'],
      };
    case 'match_pairs':
      return {
        id,
        type,
        explanation,
        prompt: `Сопоставь пары ${id}`,
        pairs: [
          { left: `ключ 1 ${id}`, right: `значение 1 ${id}` },
          { left: `ключ 2 ${id}`, right: `значение 2 ${id}` },
          { left: `ключ 3 ${id}`, right: `значение 3 ${id}` },
        ],
      };
    case 'order_steps':
      return {
        id,
        type,
        explanation,
        prompt: `Расставь шаги ${id}`,
        steps: ['docker build', 'docker push', 'docker run'],
      };
  }
}

/** Node token in a section layout: `'L'` is a lesson, anything else is a practice id. */
export type LayoutToken = 'L' | `inc-${string}`;

export interface MakeTrackOptions {
  id?: string;
  sections?: number;
  lessonsPerSection?: number;
  tasksPerLesson?: number;
  /** Explicit path per section; overrides `sections`/`lessonsPerSection`. */
  layout?: LayoutToken[][];
}

/**
 * Deterministic synthetic track for tests. Lesson ids follow `<section>.lNN`,
 * practice wrapper lessons `<section>.p-<practiceId>`.
 */
export function makeTrack(opts: MakeTrackOptions = {}): { track: Track; index: CourseIndex } {
  const { id = 't1', sections = 2, lessonsPerSection = 4, tasksPerLesson = 6 } = opts;
  const layout =
    opts.layout ??
    Array.from({ length: sections }, () => Array.from({ length: lessonsPerSection }, (): LayoutToken => 'L'));

  const refs: SectionRef[] = [];
  const sectionMap = new Map<string, Section>();
  layout.forEach((tokens, s) => {
    const sectionId = `${id}.s${pad2(s + 1)}`;
    const nodes: PathNode[] = [];
    const lessons: Lesson[] = [];
    let lessonNo = 0;
    for (const token of tokens) {
      if (token === 'L') {
        const lessonId = `${sectionId}.l${pad2(++lessonNo)}`;
        const title = `Урок ${lessonId}`;
        nodes.push({ kind: 'lesson', lessonId, title });
        lessons.push({
          id: lessonId,
          kind: 'lesson',
          title,
          theory: {
            title: `Теория ${lessonId}`,
            blocks: [
              { type: 'text', text: `Текст теории ${lessonId}.` },
              { type: 'code', code: 'docker run nginx' },
            ],
          },
          tasks: Array.from({ length: tasksPerLesson }, (_, i) =>
            makeTask(
              `${lessonId}.t${pad2(i + 1)}`,
              INTERACTIVE_TASK_TYPES[i % INTERACTIVE_TASK_TYPES.length] as InteractiveTaskType,
            ),
          ),
        });
      } else {
        const lessonId = `${sectionId}.p-${token}`;
        const title = `Практика ${token}`;
        nodes.push({ kind: 'practice', lessonId, practiceId: token, title });
        lessons.push({
          id: lessonId,
          kind: 'practice',
          title,
          tasks: [{ id: `${lessonId}.t01`, type: 'terminal_practice', practiceId: token }],
        });
      }
    }
    refs.push({
      id: sectionId,
      title: `Раздел ${sectionId}`,
      description: `Описание раздела ${sectionId}.`,
      lessonCount: lessonNo,
      nodes,
    });
    sectionMap.set(sectionId, {
      id: sectionId,
      title: `Раздел ${sectionId}`,
      description: `Описание раздела ${sectionId}.`,
      lessons,
    });
  });

  const track: Track = {
    id,
    order: 1,
    title: `Трек ${id}`,
    description: `Описание трека ${id}.`,
    status: 'complete',
    prerequisites: [],
    reviewedAt: '2026-10-20',
    sections: refs,
  };
  return { track, index: { tracks: [track], sections: sectionMap } };
}
