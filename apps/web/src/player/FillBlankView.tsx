import type { FillBlankTask } from '@rootcamp/content-schema';
import { useState } from 'react';
import { HEADING_ATTR, type TaskViewProps } from './types';
import styles from './views.module.css';

/** Template with «___» replaced by an input (no autocorrect / autocapitalize). Enter = «Проверить». */
export function FillBlankView({ task, locked, onChange }: TaskViewProps<FillBlankTask>) {
  const [text, setText] = useState('');
  const at = task.template.indexOf('___');
  const before = (at >= 0 ? task.template.slice(0, at) : task.template).trim();
  const after = (at >= 0 ? task.template.slice(at + 3) : '').trim();
  return (
    <div className={styles.root}>
      <h2 className={styles.question} tabIndex={-1} {...HEADING_ATTR}>
        {task.prompt}
      </h2>
      <div className={styles.card}>
        {before !== '' && <pre className={styles.code}>{before}</pre>}
        <input
          className={styles.input}
          aria-label="Ответ"
          value={text}
          readOnly={locked}
          placeholder="впиши ответ"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          onChange={(e) => {
            setText(e.target.value);
            onChange({ type: 'fill_blank', text: e.target.value });
          }}
        />
        {after !== '' && <pre className={styles.code}>{after}</pre>}
      </div>
    </div>
  );
}
