"use client";

import { VIEW_KEY } from "./Brand";

/** Fired after the view flips, so the Research view toggle can follow. */
export const VIEW_EVENT = "mm:view";

/** Switches to the Research view (same effect as the toggle) and scrolls to the Verification section. */
export function openResearch(targetId = "verify-heading") {
  document.documentElement.dataset.view = "research";
  try {
    localStorage.setItem(VIEW_KEY, "research");
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
  document.querySelectorAll<HTMLDetailsElement>("details[data-row]").forEach((d) => (d.open = true));
  window.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: "research" }));
  // The section is display:none until the view flips: scroll on the next frame.
  requestAnimationFrame(() => document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" }));
}

export default function DeepResearchButton() {
  return (
    <button type="button" onClick={() => openResearch()} className="mm-display-sm shrink-0 border-2 border-[var(--neon-ink)] bg-[var(--neon-ink)] px-5 py-2 text-lg text-[var(--neon)] transition-transform duration-150 hover:-translate-y-0.5 focus-visible:outline-offset-2" data-testid="deep-research-button">
      Deep research →
    </button>
  );
}
