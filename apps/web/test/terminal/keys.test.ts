import { describe, expect, it } from 'vitest';
import { chunkInput, ctrlOf, KEY_SEQUENCES } from '../../src/terminal/keys';

describe('KEY_SEQUENCES', () => {
  it('maps the mobile keys to escape sequences', () => {
    expect(KEY_SEQUENCES).toEqual({
      Esc: '\x1b',
      Tab: '\t',
      Up: '\x1b[A',
      Down: '\x1b[B',
      Left: '\x1b[D',
      Right: '\x1b[C',
      Pipe: '|',
      Slash: '/',
      Dash: '-',
      Tilde: '~',
      CtrlC: '\x03',
    });
  });
});

describe('ctrlOf', () => {
  it('turns letters into control characters', () => {
    expect(ctrlOf('c')).toBe('\x03');
    expect(ctrlOf('a')).toBe('\x01');
    expect(ctrlOf('z')).toBe('\x1a');
    expect(ctrlOf('D')).toBe('\x04');
    expect(ctrlOf('[')).toBe('\x1b');
  });

  it('leaves characters without a control form alone', () => {
    expect(ctrlOf('1')).toBe('1');
    expect(ctrlOf('ж')).toBe('ж');
  });
});

describe('chunkInput', () => {
  it('splits into frames of at most 4096 bytes', () => {
    expect(chunkInput('x'.repeat(9000)).map((c) => c.length)).toEqual([4096, 4096, 808]);
  });

  it('returns nothing for empty input and one frame for short input', () => {
    expect(chunkInput('')).toEqual([]);
    expect(Array.from(chunkInput('ls\r')[0]!)).toEqual([0x6c, 0x73, 0x0d]);
  });

  it('never splits a UTF-8 character between frames', () => {
    // 'я' is two bytes: 4095 ASCII + 'я' must not cut it in half.
    const chunks = chunkInput('x'.repeat(4095) + 'я' + 'y', 4096);
    expect(chunks.map((c) => c.length)).toEqual([4095, 3]);
    const text = chunks.map((c) => new TextDecoder().decode(c)).join('');
    expect(text).toBe('x'.repeat(4095) + 'яy');
  });

  it('honours a custom limit', () => {
    expect(chunkInput('abcdefg', 3).map((c) => c.length)).toEqual([3, 3, 1]);
  });
});
