import type { TheoryCard } from '@rootcamp/content-schema';
import styles from './parts.module.css';

/** Theory card shown when a lesson opens; «Начать задания» starts the tasks. */
export function TheoryCardView({ theory, onStart }: { theory: TheoryCard; onStart(): void }) {
  return (
    <div className={styles.screen}>
      <article className={styles.theory}>
        <p className={styles.kicker}>теория · перед сборкой слоя</p>
        <h2 className={styles.theoryTitle}>{theory.title}</h2>
        {theory.blocks.map((b, i) =>
          b.type === 'code' ? (
            <div key={i} className={styles.codeWindow}>
              <div className={styles.codeBar} aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <pre className={styles.codeText}>{b.code}</pre>
            </div>
          ) : (
            <p key={i} className={styles.theoryText}>
              {b.text}
            </p>
          ),
        )}
      </article>
      <div className={styles.screenFooter}>
        <button type="button" className={['btn', styles.wide].join(' ')} onClick={onStart}>
          Начать задания
        </button>
      </div>
    </div>
  );
}
