import { useEffect, useId, useRef } from 'react';
import { Mascot } from '../components/Mascot';
import styles from './FeedbackBanner.module.css';

export interface Feedback {
  correct: boolean;
  correctAnswerText: string;
  explanation: string;
}

export interface FeedbackBannerProps extends Feedback {
  onContinue(): void;
}

/**
 * Bottom banner after «Проверить»: teal «Верно!» or coral «Неверно» + «Правильно: …» in mono;
 * the explanation is always shown. Focus moves to «Продолжить» so Enter / Space continue.
 */
export function FeedbackBanner({
  correct,
  correctAnswerText,
  explanation,
  onContinue,
}: FeedbackBannerProps) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  useEffect(() => {
    button.current?.focus({ preventScroll: true });
  }, []);
  const proceed = () => {
    if (done.current) return;
    done.current = true;
    onContinue();
  };
  return (
    <div role="status" className={[styles.banner, correct ? styles.ok : styles.bad].join(' ')}>
      <div className={styles.inner}>
        <div className={styles.head}>
          <Mascot state={correct ? 'happy' : 'sad'} size={40} />
          <p className={styles.title}>{correct ? 'Верно!' : 'Неверно'}</p>
        </div>
        <div id={id} className={styles.body}>
          {!correct && correctAnswerText !== '' && (
            <div className={styles.answer}>
              <span>Правильно:</span>
              <pre className={styles.code}>{correctAnswerText}</pre>
            </div>
          )}
          <p className={styles.explanation}>{explanation}</p>
        </div>
        <button
          ref={button}
          type="button"
          className={['btn', styles.continue].join(' ')}
          aria-describedby={id}
          onClick={proceed}
          data-primary="continue"
        >
          Продолжить
        </button>
      </div>
    </div>
  );
}
