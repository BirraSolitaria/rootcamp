import { Link } from 'react-router-dom';
import { errorText } from '../../api/messages';
import { ApiClientError } from '../../api/client';
import { Mascot } from '../../components/Mascot';
import { HeartsIndicator } from '../../player/HeartsIndicator';
import { ProgressBar } from '../../player/ProgressBar';
import { TaskPlayer } from '../../player/TaskPlayer';
import { NetBanner } from './NetBanner';
import { OutOfHeartsModal } from './OutOfHeartsModal';
import styles from './Session.module.css';
import { SummaryView } from './SummaryView';
import type { LearningSession } from './useLearningSession';

function startErrorText(err: unknown): string {
  if (err instanceof ApiClientError) {
    if (err.code === 'locked') return 'Этот урок пока закрыт — сначала пройди предыдущие.';
    if (err.code === 'not_found') return 'Урок не найден.';
  }
  return errorText(err);
}

export function Loading() {
  return (
    <div className={styles.center}>
      <Mascot state="waiting" />
    </div>
  );
}

/**
 * The playing part shared by «Урок» and «Повторение»: top bar (exit, progress, hearts), the
 * task player, «Нет связи», the summary, «Сердечки кончились», errors and the restart toast.
 */
export function SessionView({
  session,
  exitTo,
  progressLabel,
  fallbackMsToNext = null,
}: {
  session: LearningSession;
  /** Where «выйти» and the summary's «Продолжить» go. */
  exitTo: string;
  progressLabel: string;
  /** Regen timer to show when the start itself was refused for `no_hearts`. */
  fallbackMsToNext?: number | null;
}) {
  const { state, task } = session;
  let body;
  if (state.phase === 'summary') {
    body = <SummaryView summary={state.summary} exitTo={exitTo} />;
  } else if (state.phase === 'out_of_hearts') {
    body = <OutOfHeartsModal msToNext={state.msToNext ?? fallbackMsToNext} />;
  } else if (state.phase === 'error' || session.unplayable || session.contentError) {
    const err = state.phase === 'error' ? state.error : session.contentError;
    body = (
      <div className={styles.message}>
        <Mascot state="sad" />
        <p role="alert" className="alert">
          {session.unplayable ? 'Это задание сейчас недоступно.' : startErrorText(err)}
        </p>
        <div className={styles.actions}>
          <button type="button" className="btn" onClick={() => void session.restart()}>
            Начать заново
          </button>
          <Link to={exitTo} className="btn btn-ghost">
            Выйти
          </Link>
        </div>
      </div>
    );
  } else if (state.phase === 'task' && task !== null) {
    body = (
      <>
        <header className={styles.top}>
          <Link to={exitTo} className={styles.exit} aria-label="Выйти">
            ✕
          </Link>
          <ProgressBar value={state.done / state.total} label={progressLabel} />
          <HeartsIndicator count={state.hearts.count} msToNext={state.hearts.msToNext} />
        </header>
        {state.offline && <NetBanner onRetry={session.retry} busy={state.sending} />}
        <div className={styles.player}>
          <TaskPlayer
            task={task}
            presentation={state.presentation}
            onSubmit={session.submit}
            feedback={state.feedback}
            onContinue={session.onContinue}
          />
        </div>
      </>
    );
  } else {
    body = <Loading />;
  }
  return (
    <div className={styles.screen}>
      {body}
      {session.toast !== null && (
        <div role="status" className={styles.toast}>
          {session.toast}
        </div>
      )}
    </div>
  );
}
