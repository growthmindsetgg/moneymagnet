/** Rejected / error states: one big display word, the reason in mono. */

/** The API's refusal text names the old brand; the UI shows the current one. */
export const brand = (s: string) => s.replace(/HoodTier/g, "MoneyMagnet");

export function rejectWord(rejected: string): string {
  if (/stock token/i.test(rejected)) return "Stock";
  if (/stablecoin/i.test(rejected)) return "Stable";
  if (/paste a contract address/i.test(rejected)) return "No token";
  return "Not a meme";
}

export default function StateBlock({ word, title, reason, address, testId }: { word: string; title: string; reason?: string | null; address?: string; testId?: string }) {
  return (
    <section className="mm-box p-4 sm:p-8" data-testid={testId}>
      <p className="mm-display text-[22vw] sm:text-[12rem]" aria-hidden="true">
        {word}
      </p>
      <h1 className="mt-6 break-words font-mono text-base font-bold sm:text-lg" data-testid={testId ? "rejected" : undefined}>
        {title}
      </h1>
      {reason && <p className="mt-2 break-words font-mono text-sm">{reason}</p>}
      {address && <p className="mt-2 break-all font-mono text-xs text-muted">{address}</p>}
    </section>
  );
}
