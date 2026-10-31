import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/analyze/route";
import type { ScoreReport } from "@/lib/types";
import { FIXTURES } from "./fixtures/addresses";

const call = (body: unknown) =>
  POST(new Request("http://localhost/api/analyze", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

describe("POST /api/analyze (live network)", () => {
  for (const fx of FIXTURES) {
    it(`analyzes ${fx.name}`, async () => {
      const res = await call({ address: fx.address });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toMatch(/max-age=120/);
      const report = (await res.json()) as ScoreReport;
      expect(["S", "A", "B", "C", "D", "F", "U"]).toContain(report.tier);
      expect(report.groups).toHaveLength(4);
      const down = report.sourceStatus.filter((s) => s.state === "failed");
      if (down.length) console.warn(`[${fx.name}] sources down: ${down.map((s) => `${s.id} (${s.message})`).join(", ")}`);
      const withData = report.groups.filter((g) => g.hasData).length;
      const criticalDown = report.sourceStatus.filter((s) => (fx.critical as readonly string[]).includes(s.id) && s.state === "failed");
      if (withData < 3 || criticalDown.length) {
        console.warn(`[${fx.name}] ${withData}/4 groups with data, critical sources down: ${criticalDown.map((s) => s.id).join(", ") || "none"} — report still rendered, tier not asserted`);
      } else {
        expect(withData).toBeGreaterThanOrEqual(3);
        if ("liveFollowsSimulator" in fx && fx.liveFollowsSimulator) {
          // The honeypot verdict is live data: F exactly when the simulator says it can't be sold.
          const honeypot = report.rules.find((r) => r.id === "honeypot")!;
          if (report.token.sellable === false) {
            expect(report.tier).toBe("F");
            expect(honeypot.state).toBe("fired");
          } else {
            expect(honeypot.state).not.toBe("fired");
            console.warn(`[${fx.name}] live simulator now says sellable=${report.token.sellable} — tier ${report.tier} (recorded fixture still asserts F)`);
          }
        } else {
          expect(fx.expectTiers as readonly string[]).toContain(report.tier);
        }
      }
    });
  }

  it("rejects an invalid address with 400", async () => {
    const res = await call({ address: "not-an-address" });
    expect(res.status).toBe(400);
  });
});
