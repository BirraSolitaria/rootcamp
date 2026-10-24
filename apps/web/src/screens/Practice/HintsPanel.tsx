import styles from './Practice.module.css';

/** Revealed hints, and the button that opens the next one for `hintCost` XP. */
export function HintsPanel({
  hints,
  hintCount,
  hintCost,
  canReveal,
  onReveal,
  pending,
  error,
}: {
  hints: string[];
  hintCount: number;
  hintCost: number;
  /** A run is ready: hints are opened on a live run only. */
  canReveal: boolean;
  onReveal: () => void;
  pending: boolean;
  error: string | null;
}) {
  if (hintCount === 0) return <p className="t-small">У этого инцидента нет подсказок.</p>;
  const left = hintCount - hints.length;
  return (
    <div className={styles.hints}>
      {hints.length > 0 && (
        <ol className={styles.hintList}>
          {hints.map((text, i) => (
            <li key={i} className={styles.hint}>
              {text}
            </li>
          ))}
        </ol>
      )}
      {left > 0 ? (
        <>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onReveal}
            disabled={!canReveal || pending}
          >
            {`Подсказка · −${hintCost} XP`}
          </button>
          <p className="t-small">{`Открыто ${hints.length} из ${hintCount}`}</p>
        </>
      ) : (
        <p className="t-small">Подсказок больше нет.</p>
      )}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </div>
  );
}
