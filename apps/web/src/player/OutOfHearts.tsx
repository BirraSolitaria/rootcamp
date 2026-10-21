import { formatMmSs } from '@rootcamp/logic';
import { useEffect, useState } from 'react';
import { Mascot } from '../components/Mascot';
import styles from './parts.module.css';

/** Remaining ms to a deadline set from `ms` (null = nothing to wait for), ticking every second. */
function useCountdown(ms: number | null): number | null {
  const [deadline] = useState(() => (ms === null ? null : Date.now() + ms));
  const [now, setNow] = useState(() => Date.now());
  const left = deadline === null ? null : Math.max(0, deadline - now);
  const running = left !== null && left > 0;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return left;
}

export interface OutOfHeartsProps {
  /** ms to the next heart from the server (`hearts.msToNext`). */
  msToNext: number | null;
  onReview(): void;
  onHome(): void;
}

/** «Сердечки кончились»: live timer to the next heart, «К повторению» / «На главную». */
export function OutOfHearts({ msToNext, onReview, onHome }: OutOfHeartsProps) {
  const left = useCountdown(msToNext);
  return (
    <div className={styles.outOfHearts}>
      <Mascot state="sad" size={88} />
      <h2 className={styles.outTitle}>Сердечки кончились</h2>
      <p className={styles.outTimer} aria-live="polite" aria-atomic="true">
        {left === null || left === 0
          ? 'Сердечко уже восстановилось'
          : `Следующее сердечко через ${formatMmSs(left)}`}
      </p>
      <p className={styles.muted}>
        Повторение доступно без сердечек — и за каждую сессию даёт +1 сердечко.
      </p>
      <div className={styles.actions}>
        <button type="button" className="btn" onClick={onReview}>
          К повторению
        </button>
        <button type="button" className="btn btn-ghost" onClick={onHome}>
          На главную
        </button>
      </div>
    </div>
  );
}
