import type { Format } from "./config";

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

function round(n: number, digits = 1): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

export function formatAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${round(hours)}h`;
  return `${round(hours / 24, 0)}d`;
}

export function formatUsd(n: number): string {
  const sign = n < 0 ? "-" : n > 0 ? "+" : "";
  const abs = Math.abs(n);
  if (abs < 1) return `${sign}$${abs.toPrecision(3)}`;
  return `${sign}$${compact.format(abs)}`;
}

export function formatPrice(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return `$${n.toPrecision(4)}`;
}

export function formatCompactUsd(n: number | null): string {
  if (n == null) return "—";
  return `$${compact.format(n)}`;
}

export function formatValue(value: unknown, format: Format): string {
  if (value === null || value === undefined) return "no data";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  switch (format) {
    case "pct":
      return `${round(value)}%`;
    case "signedPct":
      return `${value > 0 ? "+" : ""}${round(value)}%`;
    case "signedRatioPct":
      return `${value > 0 ? "+" : ""}${round(value * 100)}%`;
    case "ratio":
      return `${value.toFixed(2)}×`;
    case "int":
      return String(Math.round(value));
    case "usd":
      return formatUsd(value);
    case "usdAbs":
      return Math.abs(value) < 1 ? `$${value.toFixed(2)}` : formatCompactUsd(value);
    case "age":
      return formatAge(value);
    case "bool":
      return value ? "yes" : "no";
    default:
      return round(value, 2);
  }
}
