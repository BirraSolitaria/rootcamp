import { type ServerCtl, TerminalTicketResponse } from '@rootcamp/api-contract';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { type ITheme, Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef } from 'react';
import { apiFetch } from '../api/client';
import { MobileKeys, useMobileKeys } from './MobileKeys';
import styles from './Terminal.module.css';
import {
  type TerminalClosedReason,
  type TerminalSocketState,
  useTerminalSocket,
} from './useTerminalSocket';
import { useVisualViewport } from './useVisualViewport';

/** §8.3 */
export const FONT_SIZE = 14;
export const FONT_SIZE_COMPACT = 12.5;
export const FONT_SIZE_MIN = 11;
export const MIN_COLS = 40;

export interface TerminalProps {
  runId: string;
  /** Phone layout: 12.5 px font, the 6×2 key row, height follows `visualViewport`. */
  compact: boolean;
  /** Server control frames (`expiring`, `extended`, `closed`, …) for the practice screen. */
  onCtl?: (ctl: ServerCtl) => void;
  onStateChange?: (state: TerminalSocketState) => void;
  /** Defaults to `POST /api/runs/:runId/terminal-ticket`. */
  getTicket?: () => Promise<{ url: string }>;
}

export function fetchTerminalTicket(runId: string): Promise<{ url: string }> {
  return apiFetch(
    `/api/runs/${encodeURIComponent(runId)}/terminal-ticket`,
    { method: 'POST' },
    TerminalTicketResponse,
  );
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** xterm theme from the palette tokens (tokens.css). */
function themeFromTokens(): ITheme {
  const ink = cssVar('--ink', '#e6e9f5');
  return {
    background: cssVar('--term', '#0f1324'),
    foreground: ink,
    cursor: cssVar('--amber', '#ffb547'),
    cursorAccent: cssVar('--term', '#0f1324'),
    selectionBackground: cssVar('--amber-soft', 'rgba(255, 181, 71, 0.25)'),
    red: cssVar('--coral', '#ff7a70'),
    brightRed: cssVar('--coral', '#ff7a70'),
    green: cssVar('--teal', '#43d1b5'),
    brightGreen: cssVar('--teal', '#43d1b5'),
    yellow: cssVar('--amber', '#ffb547'),
    brightYellow: cssVar('--amber', '#ffb547'),
    white: ink,
    brightBlack: cssVar('--faint', '#6b7499'),
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const CLOSED_TEXT: Partial<Record<TerminalClosedReason, string>> = {
  too_many: 'Терминал уже открыт в двух местах. Закрой лишнюю вкладку и подключись снова.',
  expired: 'Время песочницы вышло.',
  idle: 'Песочница остановлена из-за простоя.',
  solved: 'Инцидент решён — песочница остановлена.',
  reset: 'Сервер сбрасывается…',
};

/**
 * The practice terminal (§8.3): xterm.js over `useTerminalSocket`. Thin on purpose — the logic
 * lives in the socket hook, `keys.ts` and `MobileKeys`, which are unit-tested; xterm itself
 * does not run in jsdom.
 */
export function Terminal({ runId, compact, onCtl, onStateChange, getTicket }: TerminalProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastSize = useRef<string | null>(null);

  const ticketRef = useRef(getTicket);
  ticketRef.current = getTicket;
  const onCtlRef = useRef(onCtl);
  onCtlRef.current = onCtl;

  const socket = useTerminalSocket({
    getTicket: () => (ticketRef.current ? ticketRef.current() : fetchTerminalTicket(runId)),
    onData: (bytes) => termRef.current?.write(bytes),
    onCtl: (ctl) => {
      // tmux redraws the whole screen on attach: start from a clean screen every time.
      if (ctl.t === 'ready') {
        lastSize.current = null;
        termRef.current?.reset();
      }
      onCtlRef.current?.(ctl);
    },
  });
  const socketRef = useRef(socket);
  socketRef.current = socket;

  const keys = useMobileKeys((data) => socketRef.current.sendInput(data));
  const keysRef = useRef(keys);
  keysRef.current = keys;

  const baseFont = compact ? FONT_SIZE_COMPACT : FONT_SIZE;
  const baseFontRef = useRef(baseFont);
  baseFontRef.current = baseFont;

  const sendSize = useCallback(() => {
    const term = termRef.current;
    if (!term || socketRef.current.state !== 'open') return;
    const cols = clamp(term.cols, 20, 400);
    const rows = clamp(term.rows, 5, 200);
    const key = `${cols}x${rows}`;
    if (key === lastSize.current) return;
    if (socketRef.current.sendCtl({ t: 'resize', cols, rows })) lastSize.current = key;
  }, []);

  /** Fit to the container; below 40 columns shrink the font to 11 px, then scroll sideways. */
  const refit = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const scroller = scrollerRef.current;
    const host = hostRef.current;
    if (!term || !fit || !scroller || !host || scroller.clientWidth === 0) return;
    host.style.width = '';
    const setFont = (px: number) => {
      if (term.options.fontSize !== px) term.options.fontSize = px;
    };
    setFont(baseFontRef.current);
    let dims = fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    if (dims.cols < MIN_COLS && baseFontRef.current > FONT_SIZE_MIN) {
      setFont(FONT_SIZE_MIN);
      dims = fit.proposeDimensions() ?? dims;
    }
    if (dims.cols < MIN_COLS) {
      host.style.width = `${Math.ceil((host.clientWidth * MIN_COLS) / Math.max(1, dims.cols)) + 2}px`;
      dims = { cols: MIN_COLS, rows: dims.rows };
    }
    const rows = Math.max(1, dims.rows);
    if (term.cols !== dims.cols || term.rows !== rows) term.resize(dims.cols, rows);
    sendSize();
  }, [sendSize]);

  useEffect(() => {
    const host = hostRef.current;
    const scroller = scrollerRef.current;
    if (!host || !scroller) return;
    const term = new XTerm({
      fontFamily: 'JetBrains Mono',
      fontSize: baseFontRef.current,
      theme: themeFromTokens(),
      scrollback: 3000,
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);
    const ta = term.textarea;
    if (ta) {
      ta.setAttribute('autocapitalize', 'off');
      ta.setAttribute('autocorrect', 'off');
      ta.setAttribute('autocomplete', 'off');
      ta.setAttribute('spellcheck', 'false');
      ta.spellcheck = false;
    }
    termRef.current = term;
    fitRef.current = fit;

    const onData = term.onData((d) => keysRef.current.input(d));
    // Mouse reports in X10 mode: one byte per char.
    const onBinary = term.onBinary((d) =>
      socketRef.current.sendInput(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff)),
    );
    const ro = new ResizeObserver(() => refit());
    ro.observe(scroller);
    refit();
    // Metrics measured before JetBrains Mono loaded are off: refit once fonts are in.
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) refit();
    });

    return () => {
      alive = false;
      ro.disconnect();
      onData.dispose();
      onBinary.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [refit]);

  useEffect(() => {
    refit();
  }, [baseFont, refit]);

  const onStateRef = useRef(onStateChange);
  onStateRef.current = onStateChange;
  useEffect(() => {
    if (socket.state === 'open') sendSize();
    onStateRef.current?.(socket.state);
  }, [socket.state, sendSize]);

  const vvHeight = useVisualViewport(areaRef, compact);

  let banner: { text: string; action?: string } | null = null;
  if (socket.state === 'connecting') banner = { text: 'Подключаемся…' };
  else if (socket.state === 'reconnecting') banner = { text: 'Переподключаемся…' };
  else if (socket.state === 'lost')
    banner = { text: 'Соединение потеряно', action: 'Подключиться' };
  else if (socket.state === 'closed') {
    const reason = socket.closedReason;
    banner = {
      text: (reason && CLOSED_TEXT[reason]) ?? 'Сессия терминала завершена.',
      ...(reason === 'too_many' ? { action: 'Подключиться' } : {}),
    };
  }

  return (
    <div
      ref={areaRef}
      className={compact ? `${styles.area} ${styles.compact}` : styles.area}
      style={vvHeight !== null ? { height: vvHeight } : undefined}
      data-state={socket.state}
    >
      <div className={styles.screen}>
        <div ref={scrollerRef} className={styles.scroller}>
          <div ref={hostRef} className={styles.host} />
        </div>
        {banner && (
          <div className={styles.banner} role="status">
            <span>{banner.text}</span>
            {banner.action && (
              <button type="button" className="btn" onClick={() => socket.reconnect()}>
                {banner.action}
              </button>
            )}
          </div>
        )}
      </div>
      {compact && <MobileKeys keys={keys} />}
    </div>
  );
}
