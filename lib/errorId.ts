/**
 * Short error ids shown to the user and written to the logs, so a report can be matched to a log line.
 * Format: "MM-" + 6 Crockford base32 characters (no I, L, O, U), e.g. MM-7KQ2XD. Render errors that
 * Next.js reports with a digest are shown as "MM-D" + the digest (the id Vercel's logs carry).
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ERROR_ID_RE = /^MM-(?:[0-9A-HJKMNP-TV-Z]{6}|D\w+)$/;

export function newErrorId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `MM-${Array.from(bytes, (b) => ALPHABET[b % 32]).join("")}`;
}

export const digestId = (digest: string) => `MM-D${digest.replace(/\W/g, "").slice(0, 12)}`;

/** One log line per error: `[MM-7KQ2XD] where: message`. */
export function logError(id: string, where: string, err: unknown): void {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[${id}] ${where}: ${message.slice(0, 500)}`, err instanceof Error && err.stack ? `\n${err.stack.split("\n").slice(1, 6).join("\n")}` : "");
}
