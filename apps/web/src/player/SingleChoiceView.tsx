import type { SingleChoiceTask } from '@rootcamp/content-schema';
import { shuffle } from '@rootcamp/logic';
import { useState } from 'react';
import { useDigitKeys } from './keys';
import { Tile } from './Tile';
import { HEADING_ATTR, type TaskViewProps } from './types';
import styles from './views.module.css';

export function SingleChoiceView({ task, locked, rng, onChange }: TaskViewProps<SingleChoiceTask>) {
  const [order] = useState(() =>
    shuffle(
      task.options.map((_, i) => i),
      rng,
    ),
  );
  const [selected, setSelected] = useState<number | null>(null);
  const pick = (i: number) => {
    if (locked) return;
    setSelected(i);
    onChange({ type: 'single_choice', selectedIndex: i });
  };
  useDigitKeys(order.length, !locked, (shown) => {
    const i = order[shown];
    if (i !== undefined) pick(i);
  });

  return (
    <div className={styles.root}>
      <h2 className={styles.question} tabIndex={-1} {...HEADING_ATTR}>
        {task.question}
      </h2>
      <div className={styles.list} role="group" aria-label="Варианты ответа">
        {order.map((i, shown) => (
          <Tile
            key={i}
            hint={shown < 4 ? String(shown + 1) : undefined}
            tone={selected === i ? 'selected' : 'idle'}
            pressed={selected === i}
            nativeEnter={selected !== i}
            disabled={locked}
            onClick={() => pick(i)}
          >
            {task.options[i]}
          </Tile>
        ))}
      </div>
    </div>
  );
}
