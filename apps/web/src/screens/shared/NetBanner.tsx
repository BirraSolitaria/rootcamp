import styles from './Session.module.css';

/** «Нет связи» after the answer could not be sent (§9); «Повторить» resends the same answer. */
export function NetBanner({ onRetry, busy }: { onRetry(): void; busy: boolean }) {
  return (
    <div role="alert" className={styles.net}>
      <span>Нет связи</span>
      <button type="button" className="btn btn-ghost" onClick={onRetry} disabled={busy}>
        Повторить
      </button>
    </div>
  );
}
