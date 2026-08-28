import { describe, expect, it } from "vitest";

import { validateRequirementDraft } from "./procurement-policy";

describe("APM-090A procurement policy", () => {
  it("requires an exact published drawing version for drawing-custom work", () => {
    expect(() =>
      validateRequirementDraft({
        businessType: "DRAWING_CUSTOM",
        quantity: "2.000000",
        trackingUnit: "PCS",
        drawingId: null,
        drawingVersionId: null,
        outsourcedProcess: null
      })
    ).toThrow(expect.objectContaining({ code: "PROC_DRAWING_VERSION_REQUIRED" }));
  });

  it("requires an outsourced process only for outsourced work", () => {
    expect(() =>
      validateRequirementDraft({
        businessType: "OUTSOURCED_PROCESS",
        quantity: "1.000000",
        trackingUnit: "PCS",
        drawingId: null,
        drawingVersionId: null,
        outsourcedProcess: null
      })
    ).toThrow(expect.objectContaining({ code: "PROC_OUTSOURCED_PROCESS_REQUIRED" }));
  });
});
