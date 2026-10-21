import type { AssembleTask } from '@rootcamp/content-schema';
import { shuffle } from '@rootcamp/logic';
import { useEffect, useRef, useState } from 'react';
import { Tile, TileGhost } from './Tile';
import { HEADING_ATTR, type TaskViewProps } from './types';
import styles from './views.module.css';

/** Tiles are identified by their index in answer.concat(distractors), not by text. */
export function AssembleView({ task, locked, rng, onChange }: TaskViewProps<AssembleTask>) {
  const [all] = useState(() => task.answer.concat(task.distractors));
  const [bank] = useState(() =>
    shuffle(
      all.map((_, i) => i),
      rng,
    ),
  );
  const [chosen, setChosen] = useState<number[]>([]);
  // Keyboard users keep their place: the tile they pressed disappears, so focus moves on.
  const rootRef = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useEffect(() => {
    if (focusKey === null) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  // Decorative only: after «Проверить», a tile whose text is in no accepted answer is marked wrong.
  const accepted = new Set([task.answer, ...(task.altAnswers ?? [])].flat());

  const update = (next: number[]) => {
    setChosen(next);
    onChange(next.length === 0 ? null : { type: 'assemble', tokens: next.map((i) => all[i]!) });
  };
  const add = (i: number) => {
    const next = [...chosen, i];
    update(next);
    const pos = bank.indexOf(i);
    const free = [...bank.slice(pos + 1), ...bank.slice(0, pos)].find((b) => !next.includes(b));
    setFocusKey(free !== undefined ? `bank-${free}` : `answer-${i}`);
  };
  const remove = (i: number) => {
    const pos = chosen.indexOf(i);
    const next = chosen.filter((c) => c !== i);
    update(next);
    const neighbour = next[Math.min(pos, next.length - 1)];
    setFocusKey(neighbour !== undefined ? `answer-${neighbour}` : `bank-${i}`);
  };

  return (
    <div className={styles.root} ref={rootRef}>
      <h2 className={styles.question} tabIndex={-1} {...HEADING_ATTR}>
        {task.prompt}
      </h2>
      <div className={styles.window}>
        <div className={styles.titleBar} aria-hidden="true">
          <span className={styles.dot} />
          <span className={styles.dot} />
          <span className={styles.dot} />
          терминал
        </div>
        <div className={styles.terminal}>
          <span className={styles.prompt} aria-hidden="true">
            $
          </span>
          <div className={styles.answerRow} role="group" aria-label="Твой ответ">
            {chosen.length === 0 && (
              <span className={styles.placeholder}>нажимай на плитки снизу</span>
            )}
            {chosen.map((i) => (
              <Tile
                key={i}
                dataKey={`answer-${i}`}
                mono
                tone={locked && !accepted.has(all[i]!) ? 'wrong' : 'idle'}
                disabled={locked}
                onClick={() => remove(i)}
              >
                {all[i]}
              </Tile>
            ))}
          </div>
        </div>
      </div>
      <div className={styles.bank} role="group" aria-label="Плитки">
        {bank.map((i) =>
          chosen.includes(i) ? (
            <TileGhost key={i} mono>
              {all[i]}
            </TileGhost>
          ) : (
            <Tile key={i} dataKey={`bank-${i}`} mono disabled={locked} onClick={() => add(i)}>
              {all[i]}
            </Tile>
          ),
        )}
      </div>
    </div>
  );
}
