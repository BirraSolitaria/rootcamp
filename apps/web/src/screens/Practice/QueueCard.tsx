import { Mascot } from '../../components/Mascot';
import styles from './Practice.module.css';

/** `queued`: «Ты N-й в очереди» with the waiting mascot (§8.1). */
export function QueueCard({ position }: { position: number | null }) {
  return (
    <div className={styles.stageCard} role="status">
      <Mascot state="waiting" />
      <p className="t-heading">
        {position === null ? 'Ждём место в очереди…' : `Ты ${position}-й в очереди`}
      </p>
      <p className="t-small">Как только освободится место, сервер запустится сам.</p>
    </div>
  );
}

/** `starting`: the sandbox is being created and set up. */
export function StartingCard() {
  return (
    <div className={styles.stageCard} role="status">
      <Mascot state="waiting" />
      <p className="t-heading">Готовим сервер…</p>
      <p className="t-small">Обычно это занимает меньше минуты.</p>
    </div>
  );
}
