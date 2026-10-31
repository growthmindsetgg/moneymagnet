import { OPS, type MetricCondition, type ValueCondition } from "./config";

export function isMissing(v: unknown): v is null | undefined {
  return v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v));
}

/** True when every op present in `cond` holds for `value`. A condition with no ops always matches. */
export function matchValue(value: unknown, cond: ValueCondition): boolean {
  if (cond.missing !== undefined && isMissing(value) !== cond.missing) return false;
  for (const op of OPS) {
    if (!(op in cond)) continue;
    const target = cond[op];
    if (op === "eq" && value !== target) return false;
    if (op === "ne" && value === target) return false;
    if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
      if (typeof value !== "number" || typeof target !== "number") return false;
      if (op === "gt" && !(value > target)) return false;
      if (op === "gte" && !(value >= target)) return false;
      if (op === "lt" && !(value < target)) return false;
      if (op === "lte" && !(value <= target)) return false;
    }
  }
  return true;
}

export type Tri = "pass" | "fail" | "unknown";

/** Evaluates a multi-metric condition. A missing metric makes it "unknown" unless the condition asks about missingness. */
export function matchMetrics(snapshot: object, cond: MetricCondition): Tri {
  let unknown = false;
  for (const [metric, vc] of Object.entries(cond)) {
    const v = (snapshot as Record<string, unknown>)[metric];
    if (vc.missing !== undefined) {
      if (!matchValue(v, vc)) return "fail";
      continue;
    }
    if (isMissing(v)) {
      if (vc.orMissing) continue;
      unknown = true;
      continue;
    }
    if (!matchValue(v, vc)) return "fail";
  }
  return unknown ? "unknown" : "pass";
}

/** `when` (all) and/or `anyOf` (at least one). */
export function matchRule(snapshot: object, rule: { when?: MetricCondition; anyOf?: MetricCondition[] }): Tri {
  const parts: Tri[] = [];
  if (rule.when) parts.push(matchMetrics(snapshot, rule.when));
  if (rule.anyOf) {
    const any = rule.anyOf.map((c) => matchMetrics(snapshot, c));
    parts.push(any.includes("pass") ? "pass" : any.includes("unknown") ? "unknown" : "fail");
  }
  if (parts.includes("fail")) return "fail";
  if (parts.includes("unknown")) return "unknown";
  return "pass";
}
