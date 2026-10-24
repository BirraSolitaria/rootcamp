import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { jsonResponse, mockFetch } from '../utils';

// xterm.js needs a real layout engine: the component test runs against a stand-in.
const xterm = vi.hoisted(() => ({
  instances: [] as {
    options: Record<string, unknown>;
    cols: number;
    rows: number;
    textarea: HTMLTextAreaElement | undefined;
    emitData: (d: string) => void;
    write: Mock;
    resize: Mock;
    reset: Mock;
  }[],
  proposed: { cols: 80, rows: 24 },
}));

vi.mock('@xterm/xterm', async () => {
  const { vi } = await import('vitest');
  class Terminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    textarea: HTMLTextAreaElement | undefined;
    private dataCb: (d: string) => void = () => {};
    write = vi.fn();
    reset = vi.fn();
    resize = vi.fn((c: number, r: number) => {
      this.cols = c;
      this.rows = r;
    });
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      xterm.instances.push(this as never);
    }
    loadAddon(addon: { activate?: (t: unknown) => void }) {
      addon.activate?.(this);
    }
    open(el: HTMLElement) {
      this.textarea = document.createElement('textarea');
      el.appendChild(this.textarea);
    }
    onData(cb: (d: string) => void) {
      this.dataCb = cb;
      return { dispose() {} };
    }
    onBinary() {
      return { dispose() {} };
    }
    emitData(d: string) {
      this.dataCb(d);
    }
    dispose() {}
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    proposeDimensions() {
      return { ...xterm.proposed };
    }
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

const { Terminal } = await import('../../src/terminal/Terminal');

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = 'blob';
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(d: string | Uint8Array) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  ready() {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ t: 'ready' }) });
  }
  get bins() {
    return this.sent.filter((d): d is Uint8Array => typeof d !== 'string');
  }
  get ctl() {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d));
  }
}

const lastWs = () => FakeWebSocket.instances.at(-1)!;
const term = () => xterm.instances.at(-1)!;

beforeEach(() => {
  FakeWebSocket.instances = [];
  xterm.instances = [];
  xterm.proposed = { cols: 80, rows: 24 };
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  // jsdom has no layout: give the terminal a width so it fits at all.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Terminal', () => {
  it('configures xterm per §8.3 and hardens the hidden textarea', () => {
    render(<Terminal runId="r1" compact={false} getTicket={() => new Promise(() => {})} />);
    expect(term().options).toMatchObject({
      fontFamily: 'JetBrains Mono',
      fontSize: 14,
      scrollback: 3000,
      cursorBlink: true,
    });
    expect((term().options.theme as { background: string }).background).toBeTruthy();
    const ta = term().textarea!;
    expect(ta).toHaveAttribute('autocapitalize', 'off');
    expect(ta).toHaveAttribute('autocorrect', 'off');
    expect(ta).toHaveAttribute('spellcheck', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('Подключаемся…');
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('gets a ticket from the api, sends its size on ready and chunks input', async () => {
    const fetch = mockFetch(() =>
      jsonResponse(200, { ticket: 'abc', url: '/ws/terminal?ticket=abc' }),
    );
    render(<Terminal runId="r1" compact={false} />);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(fetch.mock.calls[0]![0]).toBe('/api/runs/r1/terminal-ticket');
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
    expect(lastWs().url).toBe(`ws://${window.location.host}/ws/terminal?ticket=abc`);

    act(() => lastWs().ready());
    expect(lastWs().ctl).toContainEqual({ t: 'resize', cols: 80, rows: 24 });
    expect(term().reset).toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();

    act(() => term().emitData('y'.repeat(5000)));
    expect(lastWs().bins.map((b) => b.length)).toEqual([4096, 904]);

    act(() => lastWs().onmessage?.({ data: new Uint8Array([0x24, 0x20]).buffer }));
    expect(term().write).toHaveBeenCalledWith(new Uint8Array([0x24, 0x20]));
  });

  it('compact: 12.5 px, the key row, and Ctrl applies to typed letters', async () => {
    render(
      <Terminal runId="r1" compact getTicket={async () => ({ url: '/ws/terminal?ticket=a' })} />,
    );
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => lastWs().ready());
    expect(term().options.fontSize).toBe(12.5);

    fireEvent.click(screen.getByRole('button', { name: 'Вверх' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl' }));
    act(() => term().emitData('c'));
    const decoded = lastWs().bins.map((b) => new TextDecoder().decode(b));
    expect(decoded).toEqual(['\x1b[A', '\x03']);
  });

  it('below 40 columns: font drops to 11 px, then the terminal keeps 40 columns', () => {
    xterm.proposed = { cols: 30, rows: 20 };
    render(<Terminal runId="r1" compact getTicket={() => new Promise(() => {})} />);
    expect(term().options.fontSize).toBe(11);
    expect(term().resize).toHaveBeenLastCalledWith(40, 20);
  });

  describe('JetBrains Mono still loading at open()', () => {
    let resolveFont: () => void;
    let load: Mock;
    beforeEach(() => {
      load = vi.fn(() => new Promise<void>((r) => (resolveFont = r)));
      Object.defineProperty(document, 'fonts', { configurable: true, value: { load } });
    });
    afterEach(() => {
      delete (document as { fonts?: unknown }).fonts;
    });

    it('switches to an equivalent family once the face loads, so xterm re-measures, and refits', async () => {
      render(<Terminal runId="r1" compact={false} getTicket={() => new Promise(() => {})} />);
      expect(load).toHaveBeenCalledWith('14px "JetBrains Mono"');
      expect(term().options.fontFamily).toBe('JetBrains Mono');
      // The real cell is narrower than the fallback font's: more columns fit.
      xterm.proposed = { cols: 96, rows: 34 };
      expect(term().resize).not.toHaveBeenCalledWith(96, 34);
      await act(async () => resolveFont());
      expect(term().options.fontFamily).toBe("'JetBrains Mono', monospace");
      expect(term().resize).toHaveBeenLastCalledWith(96, 34);
    });

    it('does nothing once unmounted', async () => {
      const { unmount } = render(
        <Terminal runId="r1" compact={false} getTicket={() => new Promise(() => {})} />,
      );
      const t = term();
      unmount();
      xterm.proposed = { cols: 96, rows: 34 };
      await act(async () => resolveFont());
      expect(t.options.fontFamily).toBe('JetBrains Mono');
      expect(t.resize).not.toHaveBeenCalledWith(96, 34);
    });
  });

  it('shows «Соединение потеряно» after 2 min and reconnects on «Подключиться»', async () => {
    vi.useFakeTimers();
    const getTicket = vi.fn(() => Promise.reject(new Error('down')));
    render(<Terminal runId="r1" compact={false} getTicket={getTicket} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Переподключаемся…');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Соединение потеряно');
    const calls = getTicket.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Подключиться' }));
    expect(getTicket).toHaveBeenCalledTimes(calls + 1);
  });
});
