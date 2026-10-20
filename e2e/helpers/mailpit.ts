/** Mailpit of the e2e stand (infra/compose.e2e.yaml publishes its UI/API on 127.0.0.1:8026). */
export const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://127.0.0.1:8026';

export interface Mail {
  subject: string;
  text: string;
  /** Every http(s) URL in the text part, in order of appearance. */
  links: string[];
}

interface Address {
  Address: string;
}
interface Summary {
  ID: string;
  To: Address[];
}
interface Message {
  Subject: string;
  Text: string;
}

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${MAILPIT_URL}${path}`);
  if (!res.ok) throw new Error(`Mailpit GET ${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** Extracts http(s) links from a plain-text letter (trailing punctuation dropped). */
export function linksIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
}

/**
 * The newest letter addressed to `to` (exact address, case-insensitive). Polls until one
 * arrives: the api sends through its pg-boss queue, so delivery is asynchronous.
 */
export async function latestMail(to: string, timeoutMs = 20_000): Promise<Mail> {
  const want = to.toLowerCase();
  const query = encodeURIComponent(`to:"${to}"`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { messages } = await api<{ messages: Summary[] }>(
      `/api/v1/search?query=${query}&limit=50`,
    );
    // Search answers newest first.
    const hit = messages.find((m) => m.To.some((a) => a.Address.toLowerCase() === want));
    if (hit) {
      const msg = await api<Message>(`/api/v1/message/${hit.ID}`);
      return { subject: msg.Subject, text: msg.Text, links: linksIn(msg.Text) };
    }
    if (Date.now() > deadline) throw new Error(`no letter to ${to} within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
