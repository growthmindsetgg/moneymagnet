import { ImageResponse } from "next/og";

// Share card for every page (link previews on X, Telegram, Discord). Static: rendered once at build.
// Brand words only — no tier or score, so a preview can never show a number the page did not measure.
export const alt = "MoneyMagnet — score any meme coin before you ape";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "#f4f4f2", color: "#0a0a0a", padding: 72, border: "12px solid #0a0a0a" }}>
        <div style={{ display: "flex", fontSize: 36, letterSpacing: 4 }}>MONEYMAGNET</div>
        <div style={{ display: "flex", flexDirection: "column", fontSize: 84, lineHeight: 1 }}>
          <span>SCORE ANY MEME COIN</span>
          <span>BEFORE YOU APE</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 24, fontSize: 30 }}>
          <span style={{ display: "flex", background: "#39ff14", border: "3px solid #0a0a0a", padding: "6px 20px", whiteSpace: "nowrap" }}>S–F TIER</span>
          <span style={{ display: "flex" }}>with every factor&apos;s evidence · 5 chains</span>
        </div>
      </div>
    ),
    size,
  );
}
