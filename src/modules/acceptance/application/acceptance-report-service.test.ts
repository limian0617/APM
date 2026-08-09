import { describe, expect, it } from "vitest";

import { createControlledReportObjectKey } from "./acceptance-report-service";

describe("APM-102 controlled report storage", () => {
  it("generates an opaque UUID file-object key for each generated report", () => {
    const objectKey = createControlledReportObjectKey();

    expect(objectKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(objectKey).not.toContain("/");
  });
});
