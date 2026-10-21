import styles from './parts.module.css';

/** Lesson progress, `value` 0..1 (clamped). */
export function ProgressBar({
  value,
  label = 'Прогресс урока',
}: {
  value: number;
  label?: string;
}) {
  const p = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const pct = Math.round(p * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={styles.progress}
    >
      <div className={styles.progressFill} style={{ width: `${p * 100}%` }} />
    </div>
  );
}
