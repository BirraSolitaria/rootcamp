import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { OutOfHearts } from '../../player/OutOfHearts';
import styles from './Session.module.css';

/** «Сердечки кончились» over the lesson: timer to the next heart, review or home. */
export function OutOfHeartsModal({ msToNext }: { msToNext: number | null }) {
  const navigate = useNavigate();
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);
  return (
    <div className={styles.backdrop}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Сердечки кончились"
        className={styles.dialog}
      >
        <OutOfHearts
          msToNext={msToNext}
          onReview={() => navigate('/review')}
          onHome={() => navigate('/')}
        />
      </div>
    </div>
  );
}
