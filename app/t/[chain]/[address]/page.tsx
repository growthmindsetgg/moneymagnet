import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Report from "@/components/Report";
import AnalyzeForm from "@/components/AnalyzeForm";
import StateBlock, { brand, rejectWord } from "@/components/StateBlock";
import ErrorState from "@/components/ErrorState";
import LiveReport from "@/components/LiveReport";
import ChainPicker from "@/components/ChainPicker";
import { failureCause } from "@/components/failure";
import { analyzeCached, InvalidAddressError, NotAMemeError, peekReport, type AnalyzeOptions } from "@/lib/analyze";
import { addressKind, detectChain, isEvmChain, normalizeAddress } from "@/lib/chain";
import { resolveEvmChain } from "@/lib/resolveChain";
import { logError, newErrorId } from "@/lib/errorId";
import { ageCachedReport, normalizeReport, ReportShapeError, type CacheMarker } from "@/lib/normalizeReport";
import { knownNonMeme, stockRegistry } from "@/lib/memeFilter";

export const dynamic = "force-dynamic";
// §2b: the analysis stops waiting at 45s (lib/budget.ts), well inside this limit, so the page never 504s.
export const maxDuration = 60;

type Params = Promise<{ chain: string; address: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { chain, address } = await params;
  const url = `/t/${chain}/${address}`;
  return { title: `MoneyMagnet · ${address.slice(0, 6)}…${address.slice(-4)}`, alternates: { canonical: url }, openGraph: { url } };
}

export default async function TokenPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { chain: chainParam, address: rawAddress } = await params;
  const sp = await searchParams;
  const input = decodeURIComponent(rawAddress);
  const kind = addressKind(input);
  if (!kind) notFound();
  const qs = new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string")).toString();
  const suffix = qs ? `?${qs}` : "";

  // /t/auto/<0x…>: resolve the EVM chain (code + pairs on each), redirect when one chain has it, else pick.
  if (kind === "evm" && !isEvmChain(chainParam)) {
    const normalized = input.toLowerCase();
    const res = await resolveEvmChain(normalized);
    if (res.candidates.length === 1) redirect(`/t/${res.candidates[0].chain}/${normalized}${suffix}`);
    if (res.candidates.length > 1)
      return (
        <div className="space-y-8">
          <AnalyzeForm compact />
          <ChainPicker address={normalized} candidates={res.candidates} suffix={suffix} />
        </div>
      );
    // On no chain: the original default (Robinhood Chain), which then says "no contract code at this address".
    redirect(`/t/robinhood/${normalized}${suffix}`);
  }
  const chain = detectChain(input, chainParam)!;
  const normalized = normalizeAddress(chain, input);
  if (chain !== chainParam || normalized !== rawAddress) redirect(`/t/${chain}/${normalized}${suffix}`);

  const freshTag = typeof sp.fresh === "string" ? sp.fresh : undefined;
  const opts: AnalyzeOptions = {
    chain,
    fresh: freshTag !== undefined,
    freshTag,
    simulate: sp.simulate === "hoodscan-down" ? "hoodscan-down" : undefined,
  };
  // Cold pages fetch the analysis from the browser (components/LiveReport), so a timeout, a blocked call or
  // a broken answer shows the ERR state. Warm pages (a result under 2 minutes old — for ?fresh=X, the result
  // of that very run) render right here.
  const warm = sp.ssr ? null : await peekReport(normalized, opts);
  if (!warm && !sp.ssr) {
    // Known non-memes (registered stocks, stables, wrapped assets) are refused without an analysis: right here.
    const refused = knownNonMeme(chain, normalized, chain === "robinhood" ? await stockRegistry().catch(() => undefined) : undefined);
    if (refused) {
      const rejected = brand(refused.rejected ?? "not a memecoin");
      return (
        <div className="space-y-8">
          <AnalyzeForm compact />
          <StateBlock testId="not-a-meme" word={rejectWord(rejected)} title={rejected} reason={refused.reason ? `${refused.reason}.` : null} address={normalized} />
        </div>
      );
    }
    return (
      <div className="space-y-10">
        <AnalyzeForm compact />
        <LiveReport chain={chain} address={normalized} fresh={freshTag ?? null} simulate={opts.simulate ?? null} renderId={newErrorId()} />
      </div>
    );
  }

  let result: { report: unknown; cached: boolean; previous?: unknown };
  try {
    // The result of this page's own fresh run is not "cached".
    result = warm ? { report: warm.report, cached: !opts.fresh, previous: warm.previous } : await analyzeCached(normalized, opts);
  } catch (err) {
    if (err instanceof NotAMemeError || err instanceof InvalidAddressError) {
      const rejected = brand(err instanceof NotAMemeError ? err.message : "paste a contract address");
      return (
        <div className="space-y-8">
          <AnalyzeForm compact />
          <StateBlock testId="not-a-meme" word={rejectWord(rejected)} title={rejected} reason={err instanceof NotAMemeError && err.reason ? `${err.reason}.` : null} address={normalized} />
        </div>
      );
    }
    return <Failed err={err} where={`page /t/${chain}/${normalized}`} />;
  }
  try {
    const normalized = normalizeReport(result.report);
    // A cached result says so with its age, and its stale ages count from the fetch (same marker as /api/analyze).
    const aged = result.cached ? ageCachedReport(normalized) : null;
    const report = aged?.report ?? normalized;
    const cache: CacheMarker = aged?.cache ?? { cached: false, generatedAt: normalized.generatedAt, ageSeconds: 0 };
    const previous = result.previous ? normalizeReport(result.previous) : undefined;
    return (
      <div className="space-y-10">
        <AnalyzeForm compact />
        <Report report={report} cached={cache.cached} cacheAgeSeconds={cache.ageSeconds} previous={previous} />
      </div>
    );
  } catch (err) {
    return <Failed err={err} where={`page render /t/${chain}/${normalized}`} />;
  }
}

function Failed({ err, where }: { err: unknown; where: string }) {
  const id = newErrorId();
  logError(id, where, err);
  const cause = err instanceof ReportShapeError ? failureCause("partial", null, err.message.replace(/^incomplete report: /, "")) : failureCause("exception");
  return (
    <div className="space-y-8">
      <AnalyzeForm compact />
      <ErrorState cause={cause} errorId={id} logged />
    </div>
  );
}
