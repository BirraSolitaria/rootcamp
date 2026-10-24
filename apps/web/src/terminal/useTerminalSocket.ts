import {
  type ClientCtl,
  ServerCtl,
  WS_CLOSE_REASONS,
  WS_CLOSE_TOO_MANY,
  type WsCloseReason,
} from '@rootcamp/api-contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { chunkInput } from './keys';

export type TerminalSocketState = 'connecting' | 'open' | 'reconnecting' | 'lost' | 'closed';
/** Why the socket is `closed` for good: the server's `{t:'closed'}` reason, or 4409. */
export type TerminalClosedReason = WsCloseReason | 'too_many';

export const PING_EVERY_MS = 20_000;
export const PONG_TIMEOUT_MS = 45_000;
/** Backoff between attempts; the last one repeats. */
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
/** An outage longer than this is `lost` (the user presses «Подключиться»). */
export const RETRY_BUDGET_MS = 120_000;
/** Ticket request + handshake + `ready` must fit in this. */
export const ATTEMPT_TIMEOUT_MS = 10_000;

const WS_OPEN = 1;

/**
 * The ticket's `url` is relative (`/ws/terminal?ticket=…`, same origin through Caddy): it becomes
 * `ws(s)://<page host>` + url, `wss` when the page is https. Absolute ws(s) urls pass through.
 */
export function toWsUrl(
  url: string,
  loc: Pick<Location, 'protocol' | 'host'> = window.location,
): string {
  if (/^wss?:\/\//.test(url)) return url;
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${url}`;
}

/** 4000 + index after `{t:'closed'}`: final. */
function finalReasonOf(code: number): TerminalClosedReason | null {
  if (code === WS_CLOSE_TOO_MANY) return 'too_many';
  const i = code - 4000;
  return i >= 0 && i < WS_CLOSE_REASONS.length ? WS_CLOSE_REASONS[i]! : null;
}

export interface TerminalSocketOptions {
  /** A fresh single-use ticket (called for every attempt). */
  getTicket: () => Promise<{ url: string }>;
  /** TTY output bytes. */
  onData: (bytes: Uint8Array) => void;
  /** Parsed server control frames (`ready`, `pong`, `expiring`, `extended`, `closed`). */
  onCtl?: (ctl: ServerCtl) => void;
}

export interface TerminalSocket {
  state: TerminalSocketState;
  closedReason: TerminalClosedReason | null;
  /** Sends typed/pasted text as ≤ 4 KB binary frames; `false` (dropped) when not open. */
  sendInput: (data: string | Uint8Array) => boolean;
  sendCtl: (ctl: ClientCtl) => boolean;
  /** Starts over (new outage budget) — the «Подключиться» button. */
  reconnect: () => void;
}

/**
 * The terminal WebSocket (§5.2) with heartbeat and reconnects. Every attempt takes a new ticket.
 * Close codes: 4000–4008 (after `{t:'closed'}`) and 4409 are final; everything else (1000 shell
 * exited, 1001, 1006, 1011, 4100 silence, 4401 ticket refused, missing pong) retries with backoff
 * until the 2 min budget of the outage is spent → `lost`.
 */
export function useTerminalSocket(opts: TerminalSocketOptions): TerminalSocket {
  const [state, setStateRaw] = useState<TerminalSocketState>('connecting');
  const [closedReason, setClosedReason] = useState<TerminalClosedReason | null>(null);

  const optsRef = useRef(opts);
  optsRef.current = opts;

  const ws = useRef<WebSocket | null>(null);
  const stateRef = useRef<TerminalSocketState>('connecting');
  /** Bumped on every attempt and on teardown: stale callbacks compare and bail out. */
  const attemptId = useRef(0);
  const failures = useRef(0);
  const outageStart = useRef<number | null>(null);
  const timers = useRef<{
    retry?: ReturnType<typeof setTimeout>;
    attempt?: ReturnType<typeof setTimeout>;
    pong?: ReturnType<typeof setTimeout>;
    ping?: ReturnType<typeof setInterval>;
  }>({});
  const connectRef = useRef<() => void>(() => {});

  const setState = useCallback((s: TerminalSocketState) => {
    stateRef.current = s;
    setStateRaw(s);
  }, []);

  /** Drops the current socket and its timers without firing any of its handlers. */
  const teardown = useCallback(() => {
    attemptId.current++;
    const t = timers.current;
    clearTimeout(t.retry);
    clearTimeout(t.attempt);
    clearTimeout(t.pong);
    clearInterval(t.ping);
    timers.current = {};
    const sock = ws.current;
    ws.current = null;
    if (sock) {
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
      try {
        sock.close(1000);
      } catch {
        // already closing
      }
    }
  }, []);

  const finish = useCallback(
    (reason: TerminalClosedReason) => {
      teardown();
      setClosedReason(reason);
      setState('closed');
    },
    [teardown, setState],
  );

  /** The attempt or the open socket failed: schedule the next try or give up. */
  const fail = useCallback(() => {
    teardown();
    const now = Date.now();
    outageStart.current ??= now;
    const delay = RETRY_DELAYS_MS[Math.min(failures.current, RETRY_DELAYS_MS.length - 1)]!;
    failures.current++;
    if (now + delay - outageStart.current > RETRY_BUDGET_MS) {
      setState('lost');
      return;
    }
    setState('reconnecting');
    timers.current.retry = setTimeout(() => connectRef.current(), delay);
  }, [teardown, setState]);

  const armPongTimeout = useCallback(() => {
    clearTimeout(timers.current.pong);
    timers.current.pong = setTimeout(fail, PONG_TIMEOUT_MS);
  }, [fail]);

  const connect = useCallback(() => {
    teardown();
    const id = attemptId.current;
    outageStart.current ??= Date.now();
    timers.current.attempt = setTimeout(() => {
      if (id === attemptId.current) fail();
    }, ATTEMPT_TIMEOUT_MS);

    optsRef.current.getTicket().then(
      ({ url }) => {
        if (id !== attemptId.current) return;
        const sock = new WebSocket(toWsUrl(url));
        sock.binaryType = 'arraybuffer';
        ws.current = sock;
        let finalReason: TerminalClosedReason | null = null;

        sock.onopen = () => {
          if (id !== attemptId.current) return;
          timers.current.ping = setInterval(() => {
            if (sock.readyState === WS_OPEN) sock.send(JSON.stringify({ t: 'ping' }));
          }, PING_EVERY_MS);
          armPongTimeout();
        };
        sock.onmessage = (e: MessageEvent) => {
          if (id !== attemptId.current) return;
          if (typeof e.data !== 'string') {
            optsRef.current.onData(new Uint8Array(e.data as ArrayBuffer));
            return;
          }
          let json: unknown;
          try {
            json = JSON.parse(e.data);
          } catch {
            return;
          }
          const parsed = ServerCtl.safeParse(json);
          if (!parsed.success) return;
          const ctl = parsed.data;
          if (ctl.t === 'pong') armPongTimeout();
          if (ctl.t === 'ready') {
            clearTimeout(timers.current.attempt);
            failures.current = 0;
            outageStart.current = null;
            setState('open');
          }
          if (ctl.t === 'closed') finalReason = ctl.reason;
          optsRef.current.onCtl?.(ctl);
        };
        sock.onclose = (e: CloseEvent) => {
          if (id !== attemptId.current) return;
          const reason = finalReason ?? finalReasonOf(e.code);
          if (reason) finish(reason);
          else fail();
        };
        // `error` is always followed by `close`.
        sock.onerror = () => {};
      },
      () => {
        if (id === attemptId.current) fail();
      },
    );
  }, [teardown, fail, finish, armPongTimeout, setState]);
  connectRef.current = connect;

  useEffect(() => {
    failures.current = 0;
    outageStart.current = null;
    connectRef.current();
    return teardown;
  }, [teardown]);

  // The browser knows about a network loss long before a missing pong (45 s) would: `offline`
  // drops a live or connecting socket at once (→ «Переподключаемся…», backoff retries);
  // `online` during the backoff tries again right away. Final states are left alone.
  useEffect(() => {
    const onOffline = () => {
      if (stateRef.current === 'open' || stateRef.current === 'connecting') fail();
    };
    const onOnline = () => {
      if (stateRef.current !== 'reconnecting') return;
      failures.current = 0;
      connectRef.current();
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [fail]);

  const reconnect = useCallback(() => {
    failures.current = 0;
    outageStart.current = null;
    setClosedReason(null);
    setState('connecting');
    connectRef.current();
  }, [setState]);

  const sendInput = useCallback((data: string | Uint8Array) => {
    const sock = ws.current;
    if (!sock || sock.readyState !== WS_OPEN || stateRef.current !== 'open') return false;
    const frames =
      typeof data === 'string'
        ? chunkInput(data, 4096)
        : Array.from({ length: Math.ceil(data.length / 4096) }, (_, i) =>
            data.subarray(i * 4096, (i + 1) * 4096),
          );
    for (const f of frames) sock.send(f);
    return true;
  }, []);

  const sendCtl = useCallback((ctl: ClientCtl) => {
    const sock = ws.current;
    if (!sock || sock.readyState !== WS_OPEN) return false;
    sock.send(JSON.stringify(ctl));
    return true;
  }, []);

  return { state, closedReason, sendInput, sendCtl, reconnect };
}
