import { useEffect, useState } from 'react';
import styles from './Practice.module.css';

/** `Date.now()`, refreshed every `intervalMs` while `enabled`. */
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}

/** Whole seconds until `expiresAt` (never negative); null without a deadline. */
export function secondsUntil(expiresAt: string | null, now: number): number | null {
  if (expiresAt === null) return null;
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

/** `mm:ss`, or `h:mm:ss` from an hour up. */
export function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Time left on the sandbox; amber in the last 5 minutes. */
export function RunTimer({ seconds }: { seconds: number }) {
  return (
    <span
      role="timer"
      aria-label="Осталось времени"
      className={styles.timer}
      data-low={seconds <= 300 ? 'true' : undefined}
    >
      {formatClock(seconds)}
    </span>
  );
}
