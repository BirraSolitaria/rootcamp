import type { Task, UserAnswer } from '@rootcamp/content-schema';
import { isAnswerReady } from '@rootcamp/logic';
import { useEffect, useRef, useState } from 'react';
import { AssembleView } from './AssembleView';
import { type Feedback, FeedbackBanner } from './FeedbackBanner';
import { FillBlankView } from './FillBlankView';
import { hasModifier } from './keys';
import { MatchPairsView } from './MatchPairsView';
import { OrderStepsView } from './OrderStepsView';
import { seededRng } from './rng';
import { SingleChoiceView } from './SingleChoiceView';
import styles from './TaskPlayer.module.css';
import { TrueFalseView } from './TrueFalseView';
import type { TaskViewProps } from './types';

export type { Feedback } from './FeedbackBanner';

export interface TaskPlayerProps {
  task: Task;
  /** Show counter of the task in the session: a new value remounts the view (fresh shuffle, empty answer). */
  presentation: number;
  onSubmit(answer: UserAnswer): void;
  /** `null` until the answer is checked. */
  feedback: Feedback | null;
  onContinue(): void;
  /** Overrides the shuffle rng (default: seeded by task id + presentation). */
  rng?: () => number;
}

/**
 * One task + «Проверить», then the feedback banner with «Продолжить». Shared by the lesson
 * and review screens. Keyboard: «1»–«4» pick an option (single_choice / true_false), Enter
 * presses «Проверить», then «Продолжить».
 */
export function TaskPlayer(props: TaskPlayerProps) {
  return <PlayerInner key={`${props.task.id}:${props.presentation}`} {...props} />;
}

function PlayerInner({ task, presentation, onSubmit, feedback, onContinue, rng }: TaskPlayerProps) {
  const [shuffleRng] = useState(() => rng ?? seededRng(`${task.id}:${presentation}`));
  const [answer, setAnswer] = useState<UserAnswer | null>(null);
  const [checked, setChecked] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const locked = checked || feedback !== null;
  const ready = isAnswerReady(task, answer);

  const check = () => {
    if (!answer || !ready || locked) return;
    setChecked(true);
    onSubmit(answer);
  };

  // A newly shown task takes focus (its heading), unless the banner already has it.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || root.contains(document.activeElement)) return;
    root.querySelector<HTMLElement>('[data-task-heading]')?.focus({ preventScroll: true });
  }, []);

  // Enter = the primary button («Проверить» or «Продолжить») when focus is in the player or
  // nowhere; tiles, drag handles and controls outside the player keep their own Enter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || hasModifier(e)) return;
      const root = rootRef.current;
      const target = e.target instanceof Element ? e.target : null;
      const onPage = !target || target === document.body || target === document.documentElement;
      if (!root || (!onPage && !root.contains(target))) return;
      if (target?.closest('[data-native-enter]') || target instanceof HTMLTextAreaElement) return;
      const primary = root.querySelector<HTMLButtonElement>('[data-primary]');
      if (!primary || primary.disabled) return;
      e.preventDefault();
      primary.click();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const view: TaskViewProps<Task> = { task, locked, rng: shuffleRng, onChange: setAnswer };

  return (
    <div className={styles.player} ref={rootRef}>
      <section className={styles.task} aria-label="Задание">
        <TaskView {...view} />
      </section>
      <div className={styles.footer}>
        {feedback ? (
          <FeedbackBanner {...feedback} onContinue={onContinue} />
        ) : task.type === 'terminal_practice' ? null : (
          <div className={styles.footerInner}>
            <button
              type="button"
              className={['btn', styles.check].join(' ')}
              disabled={!ready || locked}
              onClick={check}
              data-primary="check"
            >
              Проверить
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function TaskView({ task, ...rest }: TaskViewProps<Task>) {
  switch (task.type) {
    case 'single_choice':
      return <SingleChoiceView task={task} {...rest} />;
    case 'true_false':
      return <TrueFalseView task={task} {...rest} />;
    case 'assemble':
      return <AssembleView task={task} {...rest} />;
    case 'fill_blank':
      return <FillBlankView task={task} {...rest} />;
    case 'match_pairs':
      return <MatchPairsView task={task} {...rest} />;
    case 'order_steps':
      return <OrderStepsView task={task} {...rest} />;
    case 'terminal_practice':
      return <p>Это задание решается в практике.</p>;
  }
}
