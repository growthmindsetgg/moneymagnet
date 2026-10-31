"use client";

import { useEffect, useState } from "react";
import { VIEW_KEY } from "./Brand";
import { VIEW_EVENT } from "./DeepResearch";

type View = "verdict" | "research";

/** Opens (research) or closes (verdict) every factor row's details. */
function setRows(open: boolean) {
  document.querySelectorAll<HTMLDetailsElement>("details[data-row]").forEach((d) => (d.open = open));
}

/**
 * "Research view" switch, remembered in localStorage. The view itself is `html[data-view]`, set before
 * paint by THEME_INIT, so research-only sections never flash; this only flips it and expands the rows.
 */
export default function ResearchToggle() {
  const [view, setView] = useState<View>("verdict");
  useEffect(() => {
    const v = document.documentElement.dataset.view === "research" ? "research" : "verdict";
    setView(v);
    if (v === "research") setRows(true);
    // The Deep research button flips the view elsewhere on the page.
    const follow = (e: Event) => setView((e as CustomEvent<View>).detail);
    window.addEventListener(VIEW_EVENT, follow);
    return () => window.removeEventListener(VIEW_EVENT, follow);
  }, []);
  const on = view === "research";
  return (
    <button
      type="button"
      className={`mm-pill px-3 py-1 text-xs font-bold uppercase tracking-wider ${on ? "sev-good" : ""}`}
      aria-pressed={on}
      data-testid="research-toggle"
      onClick={() => {
        const next: View = on ? "verdict" : "research";
        document.documentElement.dataset.view = next;
        try {
          localStorage.setItem(VIEW_KEY, next);
        } catch {
          // storage unavailable: the choice lasts for this page only
        }
        setRows(next === "research");
        setView(next);
      }}
    >
      Research view
    </button>
  );
}
