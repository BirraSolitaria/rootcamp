import type { PracticeStatus } from '@rootcamp/api-contract';
import type { SectionRef } from '@rootcamp/content-schema';
import { type LessonStatus, pluralRu } from '@rootcamp/logic';
import { useState } from 'react';
import { LessonLayer } from './LessonLayer';
import { PracticeNodeCard } from './PracticeNodeCard';
import styles from './Path.module.css';

/** Sections before the current one are done, after it locked. */
export type SectionState = 'done' | 'current' | 'locked';

const layers = (n: number) => `${n} ${pluralRu(n, 'слой', 'слоя', 'слоёв')}`;

/**
 * A section of the track: the current one is open with its layers; a done one is folded into
 * «N слоёв · образ собран» and opens on click; a locked one stays folded.
 */
export function SectionBlock({
  section,
  state,
  lessons,
  practices,
}: {
  section: SectionRef;
  state: SectionState;
  lessons: Record<string, LessonStatus>;
  practices: Record<string, PracticeStatus>;
}) {
  const [open, setOpen] = useState(false);
  const lessonIds = section.nodes.flatMap((n) => (n.kind === 'lesson' ? [n.lessonId] : []));
  const total = lessonIds.length;
  const expanded = state === 'current' || (state === 'done' && open);
  const listId = `layers-${section.id}`;

  let meta: string;
  if (state === 'done') meta = `${layers(total)} · образ собран`;
  else if (state === 'locked') meta = `${layers(total)} · закрыт`;
  else {
    const built = lessonIds.filter((id) => lessons[id] === 'completed').length;
    meta = `${built} из ${layers(total)}`;
  }

  return (
    <section className={styles.section} data-status={state}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>
          {state === 'done' ? (
            <button
              type="button"
              className={styles.sectionToggle}
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setOpen((v) => !v)}
            >
              <span>{section.title}</span>
              <span className={styles.chevron} aria-hidden="true">
                &gt;
              </span>
            </button>
          ) : (
            <span>{section.title}</span>
          )}
        </h2>
        <p className={styles.sectionMeta}>{meta}</p>
      </div>
      {expanded && (
        <ol className={styles.layers} id={listId}>
          {section.nodes.map((node) =>
            node.kind === 'lesson' ? (
              <LessonLayer
                key={node.lessonId}
                lessonId={node.lessonId}
                title={node.title}
                num={lessonIds.indexOf(node.lessonId) + 1}
                status={lessons[node.lessonId] ?? 'locked'}
              />
            ) : (
              <PracticeNodeCard
                key={node.practiceId}
                practiceId={node.practiceId}
                title={node.title}
                status={practices[node.practiceId] ?? 'locked'}
              />
            ),
          )}
        </ol>
      )}
    </section>
  );
}
