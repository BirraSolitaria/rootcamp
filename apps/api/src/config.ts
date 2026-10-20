const DEFAULT_PORT = 3000;

/** Parses the PORT env value; unset or empty means 3000. Throws on anything but a 0-65535 integer. */
export function parsePort(value: string | undefined): number {
  const raw = value?.trim() ?? '';
  if (raw === '') return DEFAULT_PORT;
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port > 65535) {
    throw new Error(`PORT must be an integer 0-65535, got "${value}"`);
  }
  return port;
}
