import { useCallback, useMemo, useRef, useState } from 'react';
import { ctrlOf, KEY_SEQUENCES, type KeyName } from './keys';
import styles from './MobileKeys.module.css';

/** §8.3: the 6×2 grid, row by row. `Ctrl` is the sticky modifier, not a sequence. */
const GRID: readonly { key: KeyName | 'Ctrl'; label: string; aria?: string }[] = [
  { key: 'Esc', label: 'Esc' },
  { key: 'Tab', label: 'Tab' },
  { key: 'Ctrl', label: 'Ctrl' },
  { key: 'Up', label: '↑', aria: 'Вверх' },
  { key: 'Down', label: '↓', aria: 'Вниз' },
  { key: 'Pipe', label: '|' },
  { key: 'Left', label: '←', aria: 'Влево' },
  { key: 'Right', label: '→', aria: 'Вправо' },
  { key: 'Slash', label: '/' },
  { key: 'Dash', label: '-' },
  { key: 'Tilde', label: '~' },
  { key: 'CtrlC', label: '^C', aria: 'Ctrl+C' },
];

export interface MobileKeysController {
  /** The sticky `Ctrl` is armed: the next typed character goes out as `ctrlOf`. */
  ctrlArmed: boolean;
  /** A key of the row was pressed. */
  press(key: KeyName | 'Ctrl'): void;
  /** Everything typed into the terminal passes through here (so the armed `Ctrl` applies). */
  input(data: string): void;
}

/** Sticky-Ctrl state plus routing to `onSend`; the terminal feeds its own input through `input`. */
export function useMobileKeys(onSend: (data: string) => void): MobileKeysController {
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const armed = useRef(false);
  const send = useRef(onSend);
  send.current = onSend;

  const setArmed = useCallback((v: boolean) => {
    armed.current = v;
    setCtrlArmed(v);
  }, []);

  const press = useCallback(
    (key: KeyName | 'Ctrl') => {
      if (key === 'Ctrl') {
        setArmed(!armed.current);
        return;
      }
      if (armed.current) setArmed(false);
      send.current(KEY_SEQUENCES[key]);
    },
    [setArmed],
  );

  const input = useCallback(
    (data: string) => {
      if (!data) return;
      if (armed.current) {
        setArmed(false);
        // A paste or an IME burst is not «the next letter»: pass it on as is.
        send.current(data.length === 1 ? ctrlOf(data) : data);
        return;
      }
      send.current(data);
    },
    [setArmed],
  );

  return useMemo(() => ({ ctrlArmed, press, input }), [ctrlArmed, press, input]);
}

/** The extra key row under the terminal on phones (§8.3). Buttons never take focus. */
export function MobileKeys({ keys }: { keys: MobileKeysController }) {
  return (
    <div className={styles.grid} role="toolbar" aria-label="Дополнительные клавиши">
      {GRID.map(({ key, label, aria }) => {
        const isCtrl = key === 'Ctrl';
        return (
          <button
            key={key}
            type="button"
            tabIndex={-1}
            className={isCtrl && keys.ctrlArmed ? `${styles.key} ${styles.armed}` : styles.key}
            aria-label={aria}
            aria-pressed={isCtrl ? keys.ctrlArmed : undefined}
            // Keep focus in xterm's textarea, or the soft keyboard would close.
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => keys.press(key)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
