import { describe, expect, it } from "vitest";

import { detectProcurementChangeImpact } from "./change-impact";

const priorRevision = {
  id: "revision-1",
  requirementId: "requirement-1",
  materialReferenceId: "material-1",
  quantity: "2.000000",
  trackingUnit: "PCS",
  businessType: "DRAWING_CUSTOM" as const,
  deliveryUnitId: "unit-1",
  moduleId: "module-1",
  responsibilityPackageId: "package-1",
  taskId: "task-1",
  requiredOn: "2026-08-20",
  predictedAssemblyStartOn: "2026-08-18",
  drawingId: "drawing-1",
  drawingVersionId: "drawing-version-1",
  outsourcedProcess: null
};

describe("APM-091B procurement change impact", () => {
  it("detects a major impact only when a confirmed revision changes an execution field after procurement facts exist", () => {
    expect(
      detectProcurementChangeImpact({
        previous: priorRevision,
        next: { ...priorRevision, id: "revision-2", quantity: "3.000000" },
        previousStatus: "CONFIRMED",
        previousTrackingLines: [
          {
            id: "tracking-1",
            supplierReferenceId: "supplier-1",
            responsibleMembershipId: "member-1",
            source: "LOCAL"
          }
        ],
        previousFulfillmentEvents: []
      })
    ).toMatchObject({
      type: "REVISED",
      requirementId: "requirement-1",
      previousRevisionId: "revision-1",
      nextRevisionId: "revision-2",
      changedFields: ["quantity"],
      obligations: expect.arrayContaining([
        { type: "PROCUREMENT_OWNER", subjectId: "member-1" },
        { type: "SUPPLIER", subjectId: "supplier-1" },
        { type: "OLD_TRACKING", subjectId: "tracking-1" }
      ])
    });
  });

  it("does not create an impact for a field-equivalent revision or one without old execution facts", () => {
    expect(
      detectProcurementChangeImpact({
        previous: priorRevision,
        next: priorRevision,
        previousStatus: "CONFIRMED",
        previousTrackingLines: [{ id: "tracking-1", source: "LOCAL" }],
        previousFulfillmentEvents: []
      })
    ).toBeNull();
    expect(
      detectProcurementChangeImpact({
        previous: priorRevision,
        next: { ...priorRevision, drawingVersionId: "drawing-version-2" },
        previousStatus: "CONFIRMED",
        previousTrackingLines: [],
        previousFulfillmentEvents: []
      })
    ).toBeNull();
  });

  it("detects a confirmed cancellation with old fulfillment facts and requires their explicit disposition", () => {
    expect(
      detectProcurementChangeImpact({
        previous: priorRevision,
        next: null,
        previousStatus: "CONFIRMED",
        previousTrackingLines: [],
        previousFulfillmentEvents: [{ id: "event-1", source: "ERP" }]
      })
    ).toMatchObject({
      type: "CANCELED",
      changedFields: ["canceled"],
      obligations: expect.arrayContaining([
        { type: "ERP_PROJECTION", subjectId: "project" },
        { type: "OLD_FULFILLMENT", subjectId: "event-1" }
      ])
    });
  });
});
