import AnalyzeForm from "@/components/AnalyzeForm";

const TAGS = ["robinhood", "solana", "launch mode", "established"];

export default function Home() {
  return (
    <section className="pt-4 sm:pt-8">
      {/* Four stacked lines on small screens; from 1200px two lines spanning ~75% of the container
          ("SCORE ANY MEME COIN / BEFORE YOU APE"), so the input stays above the fold. */}
      <h1 className="mm-display mm-headline" data-testid="headline">
        <span className="block">
          Score any<br className="min-[1200px]:hidden" />
          <span className="hidden min-[1200px]:inline"> </span>meme coin
        </span>
        <span className="block">
          before<br className="min-[1200px]:hidden" />
          <span className="hidden min-[1200px]:inline"> </span>you ape
        </span>
      </h1>

      <div className="mt-6 max-w-3xl sm:mt-8">
        <div className="mm-box p-4 text-sm sm:p-5" data-testid="explainer">
          <p>Paste a contract address — the chain is detected for you (0x… is checked on Robinhood Chain, Base, Monad and Ethereum; base58 is Solana).</p>
          <p>Get a tier from S to F, scored from holders, flow, liquidity and launch behaviour.</p>
          <p>Every factor&apos;s evidence sits under the score: value, points, source, and why.</p>
        </div>
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="What it covers" data-testid="home-tags">
          {TAGS.map((t) => (
            <li key={t} className="mm-tag text-sm uppercase tracking-wider">
              <span>{t}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-6 sm:mt-8" data-testid="home-form">
        <AnalyzeForm />
      </div>
    </section>
  );
}
