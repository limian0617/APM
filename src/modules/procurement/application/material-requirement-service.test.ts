import { describe, expect, it } from "vitest";

import {
  assertDrawingRequirementReference,
  assertErpReferenceFieldsReadOnly,
  assertProcurementCapabilityEnabled
} from "./material-requirement-service";

describe("APM-090A material requirement service boundaries", () => {
  it("rejects writes when PROCUREMENT_COLLABORATION is not effectively enabled", () => {
    expect(() =>
      assertProcurementCapabilityEnabled({
        projectId: "project-disabled",
        companyEnabled: true,
        selectedEnabled: false
      })
    ).toThrow(expect.objectContaining({ code: "PROC_CAPABILITY_DISABLED", status: 409 }));
  });

  it("rejects editing ERP-owned material fields in ERP mode", () => {
    expect(() =>
      assertErpReferenceFieldsReadOnly({
        projectId: "project-enabled",
        mode: "ERP",
        source: "ERP",
        hasErpOwnedFieldEdits: true
      })
    ).toThrow(expect.objectContaining({ code: "PROC_ERP_FIELD_READ_ONLY", status: 409 }));
  });

  it("rejects a drawing version from another project or without PUBLISHED status", () => {
    expect(() =>
      assertDrawingRequirementReference({
        projectId: "project-enabled",
        drawingProjectId: "project-other",
        drawingVersionStatus: "PUBLISHED"
      })
    ).toThrow(expect.objectContaining({ code: "PROC_DRAWING_PROJECT_MISMATCH", status: 422 }));

    expect(() =>
      assertDrawingRequirementReference({
        projectId: "project-enabled",
        drawingProjectId: "project-enabled",
        drawingVersionStatus: "DRAFT"
      })
    ).toThrow(expect.objectContaining({ code: "PROC_DRAWING_VERSION_NOT_PUBLISHED", status: 422 }));
  });
});
