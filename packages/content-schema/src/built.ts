import type { Task, TerminalPracticeTask, TheoryCard } from './types.js';

// Built course shapes (spec §4.2): JSON produced by the content builder.

export interface Track {
  id: string;
  order: number;
  title: string;
  description: string;
  /** draft tracks are not published. */
  status: 'partial' | 'complete';
  /** Recommendation only; does not block access. */
  prerequisites: string[];
  reviewedAt: string;
  sections: SectionRef[];
}

export interface SectionRef {
  id: string;
  title: string;
  description: string;
  lessonCount: number;
  nodes: PathNode[];
}

export type PathNode =
  | { kind: 'lesson'; lessonId: string; title: string }
  | { kind: 'practice'; lessonId: string; practiceId: string; title: string };

/** sections/<id>.json */
export interface Section {
  id: string;
  title: string;
  description: string;
  lessons: Lesson[];
}

export type Lesson =
  | { id: string; kind: 'lesson'; title: string; theory: TheoryCard; tasks: Task[] }
  /** Wrapper lesson for a practice node: id `<section>.p-<practiceId>`. */
  | { id: string; kind: 'practice'; title: string; tasks: [TerminalPracticeTask] };

/** Practice manifest fields safe to send to the client. */
export interface PracticePublic {
  id: string;
  title: string;
  track: string;
  brief: string;
  class: 'light' | 'docker' | 'heavy';
  goals: { id: string; title: string }[];
  hintCount: number;
  reward: { base: number; noHintBonus: number; hintCost: number };
  timeoutMin: number;
}

export interface Catalog {
  version: string;
  tracks: Track[];
}
