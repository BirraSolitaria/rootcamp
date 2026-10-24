import type { MeDto, RunDto } from '@rootcamp/api-contract';
import type { PracticePublic } from '@rootcamp/content-schema';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiClientError } from '../../api/client';
import { errorText } from '../../api/messages';
import { Mascot } from '../../components/Mascot';
import { usePracticeContent } from '../../content/useContent';
import { Shell } from '../../layout/Shell';
import { useLayout } from '../../layout/useLayout';
import { Terminal } from '../../terminal/Terminal';
import { HeaderChips } from '../Path/HeaderChips';
import { ExpiryToast } from './ExpiryToast';
import { type GoalMark, GoalsPanel, nextGoalText } from './GoalsPanel';
import { HintsPanel } from './HintsPanel';
import { BUSY_TEXT, STATE_LABEL, failedText, stoppedText } from './messages';
import { QueueCard, StartingCard } from './QueueCard';
import { RunTimer, secondsUntil, useNow } from './RunTimer';
import { StartCard } from './StartCard';
import { type Incident, useIncident } from './useIncident';
import styles from './Practice.module.css';

/**
 * «Инцидент» (`/practice/:practiceId`, §8.1): the brief, goals and reward, «Начать», then the
 * queue, the boot and the terminal with «Проверить», «Сбросить сервер», hints, the timer and the
 * CPU/RAM line. Below 640 px it is a full-screen layout with tabs (§8.3).
 */
export function PracticeScreen({ me }: { me: MeDto }) {
  const { practiceId = '' } = useParams();
  return <IncidentScreen key={practiceId} me={me} practiceId={practiceId} />;
}

function IncidentScreen({ me, practiceId }: { me: MeDto; practiceId: string }) {
  const phone = useLayout() === 'phone';
  const content = usePracticeContent(practiceId);
  const inc = useIncident(practiceId);
  const practice = content.data;

  if (!practice) {
    const body = content.error ? (
      <div className={styles.message}>
        <p role="alert" className="alert">
          {content.error instanceof ApiClientError && content.error.status === 404
            ? 'Инцидент не найден'
            : errorText(content.error)}
        </p>
        <Link to="/practice" className="btn btn-ghost">
          К практике
        </Link>
      </div>
    ) : (
      <div className={styles.message}>
        <Mascot state="waiting" />
      </div>
    );
    return phone ? body : <Shell isAdmin={me.user.isAdmin}>{body}</Shell>;
  }
  return <Loaded me={me} practice={practice} inc={inc} phone={phone} />;
}

function marksOf(practice: PracticePublic, run: RunDto | undefined, inc: Incident) {
  const marks: Record<string, GoalMark> = {};
  for (const g of run?.goals ?? []) marks[g.id] = { passed: g.passed };
  for (const g of inc.check.result?.goals ?? []) {
    marks[g.id] = { passed: g.passed, output: g.output, checked: true };
  }
  const passed = practice.goals.filter((g) => marks[g.id]?.passed).length;
  return { marks, passed };
}

function Loaded({
  me,
  practice,
  inc,
  phone,
}: {
  me: MeDto;
  practice: PracticePublic;
  inc: Incident;
  phone: boolean;
}) {
  const run = inc.run && !inc.foreign ? inc.run : undefined;
  const state = run?.state;
  const solvedHere = state === 'solved' && inc.check.result?.solved === true;
  /** The sandbox is up: the terminal is shown (a solved one lives on for 2 minutes). */
  const live = state === 'ready' || solvedHere;
  const timed = live && run?.expiresAt != null;
  const now = useNow(timed);
  const left = timed ? secondsUntil(run?.expiresAt ?? null, now) : null;

  // The deadline passed: ask the api right away instead of waiting for the next poll.
  const over = left === 0 && state === 'ready';
  const { refetchRun } = inc;
  useEffect(() => {
    if (over) refetchRun();
  }, [over, refetchRun]);

  const { marks, passed } = marksOf(practice, run, inc);
  const canCheck = state === 'ready' && !inc.check.pending;

  const stage = <Stage practice={practice} inc={inc} run={run} live={live} phone={phone} />;
  const timer = left !== null ? <RunTimer seconds={left} /> : null;
  const usage = live && run?.usage ? <UsageLine usage={run.usage} /> : null;
  const toast =
    left !== null && run ? (
      <ExpiryToast
        key={run.expiresAt}
        secondsLeft={left}
        canExtend={run.canExtend}
        onExtend={inc.extend.run}
        pending={inc.extend.pending}
        error={inc.extend.error}
      />
    ) : null;
  const checkButton = (
    <button type="button" className="btn" onClick={inc.check.run} disabled={!canCheck}>
      Проверить
    </button>
  );
  const checkError = inc.check.error && (
    <p role="alert" className="alert">
      {inc.check.error}
    </p>
  );
  const goals = <GoalsPanel goals={practice.goals} marks={marks} />;
  const hints = (
    <HintsPanel
      hints={run?.hints ?? []}
      hintCount={practice.hintCount}
      hintCost={practice.reward.hintCost}
      canReveal={state === 'ready'}
      onReveal={inc.hint.run}
      pending={inc.hint.pending}
      error={inc.hint.error}
    />
  );
  const controls = run && state === 'ready' && <RunControls run={run} inc={inc} />;
  const stateLabel = state ? STATE_LABEL[state] : 'Не запущен';

  if (phone) {
    return (
      <div className={styles.phone}>
        <header className={styles.phoneHeader}>
          <Link to="/practice" className={styles.back} aria-label="Назад">
            ←
          </Link>
          <div className={styles.phoneTitle}>
            <h1 className={styles.phoneName}>{practice.title}</h1>
            <span className={styles.phoneState} data-state={state}>
              {stateLabel}
              {timer && ' · '}
              {timer}
            </span>
          </div>
          {checkButton}
        </header>
        {checkError}
        {toast}
        {run ? (
          <PhoneTabs
            goalsLabel={`Цели ${passed}/${practice.goals.length}`}
            terminal={
              <>
                <p className={styles.nextGoal}>{nextGoalText(practice.goals, marks)}</p>
                {stage}
              </>
            }
            goals={
              <>
                {goals}
                {usage}
                {controls}
                <Brief practice={practice} />
              </>
            }
            hints={hints}
          />
        ) : (
          <div className={styles.phoneBody}>
            <Brief practice={practice} />
            {goals}
            {stage}
          </div>
        )}
      </div>
    );
  }

  return (
    <Shell isAdmin={me.user.isAdmin}>
      <div className={styles.screen}>
        <header className={styles.head}>
          <Link to="/practice" className={styles.backLink}>
            ← Практика
          </Link>
          <h1 className="t-display">{practice.title}</h1>
          <div className={styles.statusRow}>
            <span className={styles.pill} data-state={state}>
              {stateLabel}
            </span>
            {timer}
            {usage}
          </div>
          <HeaderChips me={me} />
        </header>
        {toast}
        <div className={styles.grid}>
          <div className={styles.side}>
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Бриф</h2>
              <Brief practice={practice} />
            </section>
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>{`Цели ${passed}/${practice.goals.length}`}</h2>
              {goals}
              {checkButton}
              {checkError}
              {controls}
            </section>
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Подсказки</h2>
              {hints}
            </section>
          </div>
          <div className={styles.stage}>{stage}</div>
        </div>
      </div>
    </Shell>
  );
}

function Brief({ practice }: { practice: PracticePublic }) {
  const { base, noHintBonus } = practice.reward;
  return (
    <div className={styles.brief}>
      <p className="t-body">{practice.brief}</p>
      <p className={styles.reward}>
        {noHintBonus > 0
          ? `Награда: +${base} XP, ещё +${noHintBonus} без подсказок`
          : `Награда: +${base} XP`}
      </p>
    </div>
  );
}

function UsageLine({ usage }: { usage: NonNullable<RunDto['usage']> }) {
  return (
    <span className={styles.usage}>
      {`CPU ${Math.round(usage.cpuPct)}% · RAM ${Math.round(usage.memMb)} / ${Math.round(usage.memLimitMb)} МБ`}
    </span>
  );
}

/** «Сбросить сервер» (asks first: everything on the server is lost) and «Остановить сервер». */
function RunControls({ run, inc }: { run: RunDto; inc: Incident }) {
  const [confirm, setConfirm] = useState(false);
  const error = inc.reset.error ?? inc.stop.error;
  return (
    <div className={styles.controls}>
      {confirm ? (
        <div className={styles.confirm}>
          <p className="t-body">Всё на сервере пропадёт, инцидент начнётся заново.</p>
          <div className={styles.row}>
            <button
              type="button"
              className="btn"
              disabled={inc.reset.pending}
              onClick={() => {
                setConfirm(false);
                inc.reset.run();
              }}
            >
              Да, сбросить
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>
              Отмена
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.row}>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={run.resetsLeft === 0 || inc.reset.pending}
            onClick={() => setConfirm(true)}
          >
            {`Сбросить сервер (осталось ${run.resetsLeft})`}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={inc.stop.pending}
            onClick={inc.stop.run}
          >
            Остановить
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The main area: start card, queue, boot, terminal or the end of the run. */
function Stage({
  practice,
  inc,
  run,
  live,
  phone,
}: {
  practice: PracticePublic;
  inc: Incident;
  run: RunDto | undefined;
  live: boolean;
  phone: boolean;
}) {
  const startProps = {
    cls: practice.class,
    onStart: inc.start.run,
    pending: inc.start.pending,
    error: inc.start.error,
  };
  if (inc.foreign && inc.run) {
    return (
      <div className={styles.stageCard}>
        <p className="t-heading">У тебя уже запущен другой инцидент</p>
        <p className="t-small">Одновременно может работать только один сервер.</p>
        <Link to={`/practice/${inc.run.practiceId}`} className="btn">
          Открыть запущенный инцидент
        </Link>
      </div>
    );
  }
  if (inc.runError) {
    return (
      <div className={styles.stageCard}>
        <p role="alert" className="alert">
          {inc.runError}
        </p>
        <button type="button" className="btn btn-ghost" onClick={inc.refetchRun}>
          Повторить
        </button>
      </div>
    );
  }
  if (inc.runPending) {
    return (
      <div className={styles.stageCard}>
        <Mascot state="waiting" />
      </div>
    );
  }
  if (!run) return <StartCard {...startProps} />;

  let body: ReactNode;
  switch (run.state) {
    case 'queued':
      body = <QueueCard position={run.queuePosition} />;
      break;
    case 'starting':
      body = <StartingCard />;
      break;
    case 'expired':
      body = <StartCard {...startProps} mascot="sleep" note="Время вышло" label="Новый сервер" />;
      break;
    case 'failed': {
      const f = failedText(run.stopReason);
      body = <StartCard {...startProps} mascot="sad" note={f.text} label={f.action} />;
      break;
    }
    case 'stopped':
      body = (
        <StartCard
          {...startProps}
          mascot="sleep"
          note={stoppedText(run.stopReason)}
          label="Новый сервер"
        />
      );
      break;
    case 'queue_timeout':
      body = <StartCard {...startProps} mascot="sad" note={BUSY_TEXT} />;
      break;
    case 'solved':
      if (!live) {
        body = (
          <StartCard {...startProps} mascot="happy" note="Инцидент решён" label="Пройти ещё раз" />
        );
      }
      break;
    case 'ready':
      break;
  }
  const result = inc.check.result;
  return (
    <>
      {run.state === 'solved' && live && result && (
        <div className={`note ${styles.solved}`} role="status">
          <strong className="t-heading">Решено</strong>
          <span className={styles.solvedXp}>{`+${result.xpAwarded} XP`}</span>
        </div>
      )}
      {body ??
        (live && (
          <div className={styles.term}>
            <Terminal
              key={`${run.runId}:${run.resetsLeft}`}
              runId={run.runId}
              compact={phone}
              onCtl={inc.onCtl}
            />
          </div>
        ))}
    </>
  );
}

/** Phone tabs «Терминал | Цели X/Y | Подсказки»; hidden panels stay mounted (the socket lives). */
function PhoneTabs({
  goalsLabel,
  terminal,
  goals,
  hints,
}: {
  goalsLabel: string;
  terminal: ReactNode;
  goals: ReactNode;
  hints: ReactNode;
}) {
  const id = useId();
  const [tab, setTab] = useState<'terminal' | 'goals' | 'hints'>('terminal');
  const tabs = [
    { key: 'terminal', label: 'Терминал', body: terminal },
    { key: 'goals', label: goalsLabel, body: goals },
    { key: 'hints', label: 'Подсказки', body: hints },
  ] as const;
  return (
    <>
      <div role="tablist" aria-label="Разделы инцидента" className={styles.tabs}>
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`${id}-${t.key}-tab`}
            aria-controls={`${id}-${t.key}`}
            aria-selected={tab === t.key}
            className={styles.tab}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.key}
          role="tabpanel"
          id={`${id}-${t.key}`}
          aria-labelledby={`${id}-${t.key}-tab`}
          hidden={tab !== t.key}
          className={styles.panel}
        >
          {t.body}
        </div>
      ))}
    </>
  );
}
