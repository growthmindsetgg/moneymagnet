import AnalyzeForm from "@/components/AnalyzeForm";
import StateBlock from "@/components/StateBlock";

export default function NotFound() {
  return (
    <div className="space-y-8 pt-4">
      <StateBlock word="No CA" title="That doesn't look like a token address" reason="Use a Robinhood Chain address (0x + 40 hex) or a Solana mint (base58, 32–44 chars)." />
      <AnalyzeForm />
    </div>
  );
}
