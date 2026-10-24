import type { PracticePublic } from '@rootcamp/content-schema';
import styles from './Practice.module.css';

export interface GoalMark {
  passed: boolean;
  /** Output of the last failed check. */
  output?: string;
  /** Comes from a check of this run (not only the progress kept across runs). */
  checked?: boolean;
}

/** The incident's goals with their marks (teal ✓ / coral ✗ after a check). */
export function GoalsPanel({
  goals,
  marks,
}: {
  goals: PracticePublic['goals'];
  marks: Record<string, GoalMark>;
}) {
  return (
    <ol className={styles.goals}>
      {goals.map((g) => {
        const mark = marks[g.id];
        const passed = mark?.passed;
        return (
          <li
            key={g.id}
            className={styles.goal}
            data-passed={passed === undefined ? undefined : String(passed)}
            data-checked={mark?.checked ? 'true' : undefined}
          >
            <span className={styles.goalMark} aria-hidden="true">
              {passed === true ? '✓' : passed === false && mark?.checked ? '✗' : '○'}
            </span>
            <span className={styles.goalBody}>
              <span>{g.title}</span>
              {passed === false && mark?.output && (
                <span className={styles.goalOutput}>{mark.output}</span>
              )}
            </span>
            <span className="visually-hidden">{passed ? 'выполнено' : 'не выполнено'}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** «Следующая цель» line above the phone terminal. */
export function nextGoalText(goals: PracticePublic['goals'], marks: Record<string, GoalMark>) {
  const next = goals.find((g) => !marks[g.id]?.passed);
  return next ? `Следующая цель: ${next.title}` : 'Все цели выполнены — нажми «Проверить»';
}
