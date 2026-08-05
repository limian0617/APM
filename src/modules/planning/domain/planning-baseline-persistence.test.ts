import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("APM-023 planning baseline persistence contract", () => {
  it("keeps CI upgrade coverage from APM-050 to APM-061", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("Validate APM-050 to APM-061 upgrade migration");
    expect(workflow).toContain("20260805010000_apm_023_planning_baselines");
  });
});
