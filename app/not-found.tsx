import type { Metadata } from "next";
import AnalyzeForm from "@/components/AnalyzeForm";
import StateBlock from "@/components/StateBlock";

export const metadata: Metadata = { title: "Not a token address", robots: { index: false } };

export default function NotFound() {
  return (
    <div className="space-y-8 pt-4">
      <StateBlock word="No CA" title="That doesn't look like a token address" reason="Use an EVM token address — Robinhood Chain, Base, Monad or Ethereum (0x + 40 hex) — or a Solana mint (base58, 32–44 chars)." />
      <AnalyzeForm />
    </div>
  );
}
