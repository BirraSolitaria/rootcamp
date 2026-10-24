import { useState } from 'react';
import styles from './Practice.module.css';

type Phase = 5 | 1;

/**
 * §9 «TTL истёк»: a toast 5 and 1 minute before the end, with «Продлить» when the run can be
 * extended. Remount it (`key`) on a new deadline so a dismissal does not outlive it.
 */
export function ExpiryToast({
  secondsLeft,
  canExtend,
  onExtend,
  pending,
  error,
}: {
  secondsLeft: number;
  canExtend: boolean;
  onExtend: () => void;
  pending: boolean;
  error: string | null;
}) {
  const [dismissed, setDismissed] = useState<Phase | null>(null);
  const phase: Phase | null =
    secondsLeft <= 0 ? null : secondsLeft <= 60 ? 1 : secondsLeft <= 300 ? 5 : null;
  // Closing the 5-minute toast still lets the 1-minute one through.
  if (phase === null || dismissed === 1 || dismissed === phase) return null;
  return (
    <div role="status" aria-label="Время заканчивается" className={styles.toast}>
      <p className="t-body-strong">
        {phase === 1 ? 'До конца меньше минуты' : 'До конца меньше 5 минут'}
      </p>
      {error && <p className="t-small">{error}</p>}
      <div className={styles.toastActions}>
        {canExtend && (
          <button type="button" className="btn" onClick={onExtend} disabled={pending}>
            Продлить
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => setDismissed(phase)}>
          Закрыть
        </button>
      </div>
    </div>
  );
}
