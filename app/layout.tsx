import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import { THEME_INIT, ThemeToggle, Wordmark } from "@/components/Brand";
import "./globals.css";

// Self-hosted from app/fonts (Fontsource latin subsets, SIL OFL), so builds never depend on Google Fonts.
// next/font preloads them and adds size-adjusted fallbacks. display "optional": a font not ready within ~100ms
// is skipped for that visit instead of swapped in late, so text never reflows (no layout shift on load).
const anton = localFont({ src: "./fonts/anton-latin-400-normal.woff2", weight: "400", variable: "--font-anton", display: "optional" });
const jetbrains = localFont({
  src: [
    { path: "./fonts/jetbrains-mono-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/jetbrains-mono-latin-700-normal.woff2", weight: "700" },
  ],
  variable: "--font-jetbrains",
  display: "optional",
});

const SITE_TITLE = "MoneyMagnet — score any meme coin before you ape";
const SITE_DESCRIPTION = "Paste a Robinhood Chain, Base, Monad, Ethereum or Solana token address. MoneyMagnet gives it an S–F tier with every factor's evidence under the score.";

export const metadata: Metadata = {
  // MM_CANONICAL_ORIGIN is resolved in next.config (lib/canonical.ts): the canonical host once it is live.
  metadataBase: new URL(process.env.MM_CANONICAL_ORIGIN || "https://hoodtier.vercel.app"),
  alternates: { canonical: "/" },
  // Child pages set a short title ("0xd5f1…e725 tier on Robinhood Chain"); the template appends the brand.
  title: { default: SITE_TITLE, template: "%s · MoneyMagnet" },
  description: SITE_DESCRIPTION,
  applicationName: "MoneyMagnet",
  openGraph: { title: SITE_TITLE, description: SITE_DESCRIPTION, siteName: "MoneyMagnet", type: "website", locale: "en_US", url: "/" },
  twitter: { card: "summary_large_image", title: SITE_TITLE, description: SITE_DESCRIPTION },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f4f2" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0b" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${anton.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-dvh">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 mm-btn-neon px-3 py-1">
          Skip to content
        </a>
        <header className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-4 py-4 sm:px-8">
          <Link href="/" className="-ml-1 inline-flex items-center p-1" aria-label="MoneyMagnet — home">
            <Wordmark className="h-8 w-auto sm:h-9" />
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs uppercase tracking-wider text-muted sm:inline">Robinhood Chain · Base · Monad · Ethereum · Solana</span>
            <ThemeToggle />
          </div>
        </header>
        <main id="main" className="mx-auto min-h-dvh max-w-[1440px] px-4 pb-24 sm:px-8">
          {children}
        </main>
        <footer className="mm-rule-t">
          <p className="mx-auto max-w-[1440px] px-4 py-4 text-xs text-muted sm:px-8">
            data: HoodScan · ScanHood · Helius · RugCheck · GoPlus · DexScreener · GeckoTerminal · pump.fun feed · nad.fun · Basescan · Etherscan · chain RPCs
            {/* CoinGecko's keyed API plans require visible attribution with a link. */}
            {process.env.GECKO_API_KEY ? (
              <span className="block sm:inline">
                {" "}· Data provided by{" "}
                <a className="underline" href="https://www.coingecko.com/en/api" target="_blank" rel="noopener noreferrer">
                  CoinGecko<span className="sr-only"> (opens in a new tab)</span>
                </a>
              </span>
            ) : null}
            <span className="block sm:inline"> — not investment advice</span>
          </p>
        </footer>
      </body>
    </html>
  );
}
