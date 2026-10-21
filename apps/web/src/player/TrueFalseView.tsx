import type { TrueFalseTask } from '@rootcamp/content-schema';
import { useState } from 'react';
import { useDigitKeys } from './keys';
import { Tile } from './Tile';
import { HEADING_ATTR, type TaskViewProps } from './types';
import styles from './views.module.css';

const CHOICES = [
  { value: true, label: 'Верно' },
  { value: false, label: 'Неверно' },
] as const;

export function TrueFalseView({ task, locked, onChange }: TaskViewProps<TrueFalseTask>) {
  const [value, setValue] = useState<boolean | null>(null);
  const pick = (v: boolean) => {
    if (locked) return;
    setValue(v);
    onChange({ type: 'true_false', value: v });
  };
  useDigitKeys(CHOICES.length, !locked, (shown) => {
    const choice = CHOICES[shown];
    if (choice) pick(choice.value);
  });

  return (
    <div className={styles.root}>
      <h2 className={styles.kicker} tabIndex={-1} {...HEADING_ATTR}>
        Верно или нет?
      </h2>
      <p className={styles.statement}>{task.statement}</p>
      <div className={styles.row} role="group" aria-label="Варианты ответа">
        {CHOICES.map((c, shown) => (
          <Tile
            key={c.label}
            hint={String(shown + 1)}
            tone={value === c.value ? 'selected' : 'idle'}
            pressed={value === c.value}
            nativeEnter={value !== c.value}
            disabled={locked}
            onClick={() => pick(c.value)}
          >
            {c.label}
          </Tile>
        ))}
      </div>
    </div>
  );
}
