/** What the extra mobile keys (§8.3) send to the TTY. */
export const KEY_SEQUENCES = {
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
} as const satisfies Record<string, string>;

export type KeyName = keyof typeof KEY_SEQUENCES;

/**
 * The control character for `Ctrl+<ch>`: letters (either case) → `\x01`…`\x1a`, `@ [ \ ] ^ _`
 * → `\x00`, `\x1b`…`\x1f`, `?` → DEL. Anything else comes back unchanged.
 */
export function ctrlOf(ch: string): string {
  if (ch.length !== 1) return ch;
  const code = ch.toUpperCase().charCodeAt(0);
  if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40);
  if (ch === '?') return '\x7f';
  return ch;
}

const encoder = new TextEncoder();

/**
 * UTF-8 bytes of `s` cut into frames of at most `max` bytes (the server drops bigger input
 * frames, §5.2). A cut never lands inside a multi-byte character.
 */
export function chunkInput(s: string, max = 4096): Uint8Array[] {
  const bytes = encoder.encode(s);
  const out: Uint8Array[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + max, bytes.length);
    if (end < bytes.length) {
      // Back off over continuation bytes (10xxxxxx) so the next frame starts on a lead byte.
      let cut = end;
      while (cut > start && (bytes[cut]! & 0xc0) === 0x80) cut--;
      if (cut > start) end = cut;
    }
    out.push(bytes.subarray(start, end));
    start = end;
  }
  return out;
}
