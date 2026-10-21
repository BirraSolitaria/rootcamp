import { LessonSrcSchema, SectionSrcSchema, TrackSrcSchema } from '@rootcamp/content-schema';
import { Document, isScalar, Scalar, visit } from 'yaml';
import type { z } from 'zod';

// DockerLingo source format (E:\Duolingo_Docker\src\content\types.ts). Its five
// task types and their fields map 1:1 onto rootcamp's (order_steps and
// terminal_practice have no DockerLingo counterpart). Only the IDs change.

export interface DockerLingoTheoryCard {
  title: string;
  blocks: ({ type: 'text'; text: string } | { type: 'code'; code: string })[];
}

interface DockerLingoTaskBase {
  id: string;
  explanation: string;
}

export type DockerLingoTask = DockerLingoTaskBase &
  (
    | { type: 'single_choice'; question: string; options: string[]; correctIndex: number }
    | { type: 'true_false'; statement: string; answer: boolean }
    | {
        type: 'assemble';
        prompt: string;
        answer: string[];
        altAnswers?: string[][];
        distractors: string[];
      }
    | { type: 'fill_blank'; prompt: string; template: string; acceptedAnswers: string[] }
    | { type: 'match_pairs'; prompt: string; pairs: { left: string; right: string }[] }
  );

export interface DockerLingoLesson {
  id: string;
  title: string;
  theory: DockerLingoTheoryCard;
  tasks: DockerLingoTask[];
}

export interface DockerLingoUnit {
  id: string;
  title: string;
  description: string;
  lessons: DockerLingoLesson[];
}

export interface ConvertedUnit {
  sectionYaml: string;
  lessons: { file: string; yaml: string }[];
}

export const TRACK_ID = 't7';

const DL_ID = /^u(\d{2})(?:-l(\d{2})(?:-t(\d{2}))?)?$/;

/** `u03` → `t7.s03`, `u03-l02` → `t7.s03.l02`, `u03-l02-t07` → `t7.s03.l02.t07`. */
export function mapId(id: string): string {
  const m = DL_ID.exec(id);
  if (!m) throw new Error(`not a DockerLingo id: '${id}'`);
  const [, unit, lesson, task] = m;
  let out = `${TRACK_ID}.s${unit}`;
  if (lesson !== undefined) out += `.l${lesson}`;
  if (task !== undefined) out += `.t${task}`;
  return out;
}

/** Last ID segment: `t7.s03.l02` → `l02`. */
const leaf = (id: string): string => id.slice(id.lastIndexOf('.') + 1);

/**
 * Converts one DockerLingo unit into a rootcamp section (`section.yaml`) and its
 * lesson files (`lNN.yaml`). Throws on IDs that do not nest properly and on any
 * field rootcamp has no place for (the source schemas are strict), so nothing is
 * dropped silently.
 */
export function convertUnit(unit: DockerLingoUnit): ConvertedUnit {
  const sectionId = mapId(unit.id);
  const lessons = unit.lessons.map((lesson) => {
    if (!lesson.id.startsWith(`${unit.id}-`)) {
      throw new Error(`lesson '${lesson.id}' does not belong to unit '${unit.id}'`);
    }
    const lessonId = mapId(lesson.id);
    const src = {
      id: lessonId,
      title: lesson.title,
      theory: lesson.theory,
      tasks: lesson.tasks.map((task) => {
        if (!task.id.startsWith(`${lesson.id}-`)) {
          throw new Error(`task '${task.id}' does not belong to lesson '${lesson.id}'`);
        }
        return { ...task, id: mapId(task.id) };
      }),
    };
    strictCheck(LessonSrcSchema, src, lesson.id);
    return { file: `${leaf(lessonId)}.yaml`, yaml: toYaml(src) };
  });

  const section = {
    id: sectionId,
    title: unit.title,
    description: unit.description,
    nodes: lessons.map((l) => ({ lesson: l.file.replace(/\.yaml$/, '') })),
  };
  strictCheck(SectionSrcSchema, section, unit.id);
  return { sectionYaml: toYaml(section), lessons };
}

/** `track.yaml` of the Docker track; `sections` are the section directory names. */
export function trackYaml(sections: string[]): string {
  const track = {
    id: TRACK_ID,
    order: 7,
    title: 'Docker',
    description:
      'Контейнеры с нуля: образы, docker run, тома, сети, Dockerfile, многоэтапная сборка, Compose, отладка и лучшие практики.',
    status: 'complete',
    prerequisites: ['t1', 't2', 't6'],
    reviewedAt: '2026-10-20',
    sections,
  };
  strictCheck(TrackSrcSchema, track, TRACK_ID);
  return toYaml(track);
}

function strictCheck(schema: z.ZodType, value: unknown, where: string): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`${where}: ${issues}`);
  }
}

/** Plain scalars that YAML 1.2 would still read back as strings and that read well unquoted. */
const SAFE_PLAIN = /^[a-z][a-z0-9_.]*$/;
const YAML_WORDS = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n']);

/**
 * Block-style YAML: multi-line strings as literal blocks (`|`), other strings
 * single-quoted (so `:` and `#` survive), except simple identifiers
 * (`single_choice`, `l01`, `t7.s01`) which stay plain. No line folding.
 */
export function toYaml(value: unknown): string {
  const doc = new Document(value);
  visit(doc, {
    Pair(_, pair) {
      if (isScalar(pair.value)) styleScalar(pair.value);
    },
    Seq(_, seq) {
      for (const item of seq.items) if (isScalar(item)) styleScalar(item);
    },
  });
  return doc.toString({ lineWidth: 0, indentSeq: true });
}

function styleScalar(node: Scalar): void {
  if (typeof node.value !== 'string') return;
  const s = node.value;
  if (s.includes('\n')) node.type = Scalar.BLOCK_LITERAL;
  else if (SAFE_PLAIN.test(s) && !YAML_WORDS.has(s)) node.type = Scalar.PLAIN;
  // As prettier does: a string with `'` but no `"` reads better double-quoted.
  else if (s.includes("'") && !s.includes('"')) node.type = Scalar.QUOTE_DOUBLE;
  else node.type = Scalar.QUOTE_SINGLE;
}
