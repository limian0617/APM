import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("APM-023 planning baseline persistence contract", () => {
  it("keeps CI upgrade coverage at the APM-034 to APM-023 boundary", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("Validate APM-034 to APM-023 upgrade migration");
    expect(workflow).toContain("20260804060000_apm_034_alert_governance");
  });
});
