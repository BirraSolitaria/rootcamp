import type { MatchPairsTask } from '@rootcamp/content-schema';
import { shuffle } from '@rootcamp/logic';
import { useState } from 'react';
import { Tile, type TileTone } from './Tile';
import { HEADING_ATTR, type TaskViewProps } from './types';
import styles from './views.module.css';

const PAIR_TONES = 5;

/**
 * Tap a left tile, then a right one, to link them; tapping a linked tile unlinks the pair.
 * Linked pairs get a colour and a number (so the link is not shown by colour alone).
 */
export function MatchPairsView({ task, locked, rng, onChange }: TaskViewProps<MatchPairsTask>) {
  const [rightOrder] = useState(() =>
    shuffle(
      task.pairs.map((_, i) => i),
      rng,
    ),
  );
  /** links[leftIndex] = original right index; slots[leftIndex] = colour slot. */
  const [links, setLinks] = useState<Record<number, number>>({});
  const [slots, setSlots] = useState<Record<number, number>>({});
  const [activeLeft, setActiveLeft] = useState<number | null>(null);

  const commit = (next: Record<number, number>, nextSlots: Record<number, number>) => {
    setLinks(next);
    setSlots(nextSlots);
    const pairs = Object.entries(next).map(([l, r]) => ({
      left: task.pairs[Number(l)]!.left,
      right: task.pairs[r]!.right,
    }));
    onChange(pairs.length === 0 ? null : { type: 'match_pairs', pairs });
  };
  const unlink = (left: number) => {
    const next = { ...links };
    const ns = { ...slots };
    delete next[left];
    delete ns[left];
    commit(next, ns);
  };
  const leftOf = (right: number) => {
    const e = Object.entries(links).find(([, r]) => r === right);
    return e ? Number(e[0]) : null;
  };
  const freeSlot = () => {
    const used = new Set(Object.values(slots));
    for (let i = 0; ; i++) if (!used.has(i)) return i;
  };

  const pressLeft = (i: number) => {
    if (links[i] !== undefined) {
      unlink(i);
      setActiveLeft(null);
      return;
    }
    setActiveLeft(activeLeft === i ? null : i);
  };
  const pressRight = (r: number) => {
    const linkedLeft = leftOf(r);
    if (linkedLeft !== null) {
      unlink(linkedLeft);
      return;
    }
    if (activeLeft === null) return;
    commit({ ...links, [activeLeft]: r }, { ...slots, [activeLeft]: freeSlot() });
    setActiveLeft(null);
  };

  const pairTone = (slot: number) => `pair${slot % PAIR_TONES}` as TileTone;
  const tile = (text: string, slot: number | undefined) =>
    slot === undefined ? (
      text
    ) : (
      <>
        {text}
        <span className={styles.badge} aria-hidden="true">
          {slot + 1}
        </span>
      </>
    );

  return (
    <div className={styles.root}>
      <h2 className={styles.question} tabIndex={-1} {...HEADING_ATTR}>
        {task.prompt}
      </h2>
      <div className={styles.cols}>
        <div className={styles.col} role="group" aria-label="Левая колонка">
          {task.pairs.map((p, i) => {
            const slot = links[i] !== undefined ? slots[i] : undefined;
            return (
              <Tile
                key={i}
                tone={slot !== undefined ? pairTone(slot) : activeLeft === i ? 'selected' : 'idle'}
                pressed={activeLeft === i}
                label={slot !== undefined ? `${p.left}, пара ${slot + 1}` : undefined}
                disabled={locked}
                onClick={() => pressLeft(i)}
              >
                {tile(p.left, slot)}
              </Tile>
            );
          })}
        </div>
        <div className={styles.col} role="group" aria-label="Правая колонка">
          {rightOrder.map((r) => {
            const l = leftOf(r);
            const slot = l !== null ? slots[l] : undefined;
            const text = task.pairs[r]!.right;
            return (
              <Tile
                key={r}
                tone={slot !== undefined ? pairTone(slot) : 'idle'}
                label={slot !== undefined ? `${text}, пара ${slot + 1}` : undefined}
                disabled={locked}
                onClick={() => pressRight(r)}
              >
                {tile(text, slot)}
              </Tile>
            );
          })}
        </div>
      </div>
    </div>
  );
}
