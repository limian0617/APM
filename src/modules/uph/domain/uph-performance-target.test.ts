import { describe, expect, it } from "vitest";

import {
  compareDecimalUph,
  decideUphPerformance,
  normalizePositiveTargetUph,
  planTargetDraft,
  selectApplicableTargetVersion
} from "./uph-performance-target";

describe("APM-084 UPH performance target rules", () => {
  it("normalizes positive decimal targets without binary floating point", () => {
    expect(normalizePositiveTargetUph("12.3")).toBe("12.300000");
    expect(compareDecimalUph("10.000001", "10.000000")).toBe(1);
    expect(() => normalizePositiveTargetUph("0.000000")).toThrow("UPH_TARGET_MUST_BE_POSITIVE");
    expect(() => normalizePositiveTargetUph("100000000000000.000000")).toThrow(
      "UPH_TARGET_INVALID"
    );
  });

  it("classifies strict underperformance, equality, and NO_OUTPUT", () => {
    expect(
      decideUphPerformance({ actualGoodUph: "99.999999", targetUph: "100", status: "COMPUTED" })
    ).toMatchObject({ underperforming: true, shortfallUph: "0.000001" });
    expect(
      decideUphPerformance({ actualGoodUph: "100", targetUph: "100.000000", status: "COMPUTED" })
        .underperforming
    ).toBe(false);
    expect(
      decideUphPerformance({ actualGoodUph: "0", targetUph: "1", status: "NO_OUTPUT" }).shortfallUph
    ).toBe("1.000000");
  });

  it("selects the latest target effective before lock time", () => {
    const first = { targetUph: "100", effectiveAt: new Date("2026-01-01T00:00:00Z") };
    const second = { targetUph: "110", effectiveAt: new Date("2026-02-01T00:00:00Z") };
    expect(selectApplicableTargetVersion([second, first], new Date("2026-01-15T00:00:00Z"))).toBe(
      first
    );
    expect(
      selectApplicableTargetVersion([second, first], new Date("2025-12-31T00:00:00Z"))
    ).toBeNull();
  });

  it("plans exact project/root draft scope", () => {
    expect(
      planTargetDraft({
        projectId: "p1",
        topologyRootNodeId: "root",
        targetUph: "80",
        reason: "baseline"
      })
    ).toMatchObject({ status: "DRAFT", targetUph: "80.000000" });
  });
});
