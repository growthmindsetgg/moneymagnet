"use client";

import { useEffect, useState } from "react";

/** "MM" as a quick signature: one pen stroke, two humps each, a trailing swash. Inline SVG, no font. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 76 36" className={className} role="img" aria-label="MoneyMagnet" focusable="false">
      <path
        d="M3 27c2.5-7 5-15 7.5-19.5 1.2 6 2 11.5 3 16 2.6-7 5.4-12.6 8.3-16 .4 6.3.4 12 2 17.5 2.4-7.4 5.6-13.6 8.6-17 .9 6.1 1.6 11.6 2.8 15.6 2.8-6.8 5.9-12 8.9-15.3.2 6.5.5 12.4 2.6 16.8 1.6 3.3 6 3.6 10.3 1.2 4.3-2.4 8-5.6 10.8-8.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8 32.5c14-1.6 33-2 55-.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

type Theme = "light" | "dark";
const KEY = "mm:theme";

/** Result-page view: "verdict" (default) or "research" (every detail). */
export const VIEW_KEY = "mm:view";

/** Runs before paint (inlined in <head>) so a stored theme or view never flashes the other one. */
export const THEME_INIT = `try{var d=document.documentElement,t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")d.dataset.theme=t;d.dataset.view=localStorage.getItem("${VIEW_KEY}")==="research"?"research":"verdict"}catch(e){}`;

/** Light / dark toggle. Without a stored choice the OS preference (prefers-color-scheme) applies. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => {
    const stored = document.documentElement.dataset.theme as Theme | undefined;
    setTheme(stored ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  }, []);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="mm-pill min-w-[6.5rem] px-3 py-1 text-center text-xs uppercase tracking-wider"
      data-testid="theme-toggle"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem(KEY, next);
        } catch {
          // storage unavailable: the choice lasts for this page only
        }
        setTheme(next);
      }}
    >
      <span aria-hidden="true">{theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"} </span>
      {theme ?? "auto"}
      <span className="sr-only"> theme — switch to {next}</span>
    </button>
  );
}
