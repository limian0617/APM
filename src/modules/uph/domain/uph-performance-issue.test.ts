import { describe, expect, it } from "vitest";

import { assertPerformanceIssueCreation, decidePerformanceIssue } from "./uph-performance-issue";

describe("APM-084 performance issue decision", () => {
  it("uses exact actual-good-UPH comparison and leaves severity to caller", () => {
    const decision = decidePerformanceIssue({
      actualGoodUph: "99.999999",
      targetUph: "100",
      status: "COMPUTED"
    });
    expect(decision).toMatchObject({ underperforming: true, shortfallUph: "0.000001" });
    expect(() =>
      assertPerformanceIssueCreation(
        decidePerformanceIssue({ actualGoodUph: "100", targetUph: "100", status: "COMPUTED" })
      )
    ).toThrow("UPH_TARGET_MET");
  });

  it("treats NO_OUTPUT as underperforming when the positive target is configured", () => {
    expect(
      decidePerformanceIssue({ actualGoodUph: "0", targetUph: "1", status: "NO_OUTPUT" })
        .underperforming
    ).toBe(true);
  });
});
