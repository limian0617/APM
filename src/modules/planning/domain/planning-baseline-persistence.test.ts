import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("APM-023 planning baseline persistence contract", () => {
  it("keeps planning-baseline coverage in the APM-040 to APM-042 upgrade root", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("Validate APM-040 to APM-042 upgrade migration");
    expect(workflow).toContain("20260804060000_apm_034_alert_governance");
    expect(workflow).toContain("20260805010000_apm_023_planning_baselines");
    expect(workflow).toContain("20260805050000_apm_040_cockpit_projection");
  });
});
