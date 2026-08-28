import { describe, expect, it } from "vitest";

import { deriveProcurementDisplayStatus, type ProcurementStatusFacts } from "./procurement-status";

describe("APM-090B procurement display status", () => {
  it.each([
    [{ requirementStatus: "DRAFT" }, "PENDING_CONFIRMATION"],
    [{ requirementStatus: "CANCELED" }, "CANCELED"],
    [{ requirementStatus: "CONFIRMED", hasChangeImpact: true }, "CHANGE_PENDING"],
    [
      { requirementStatus: "CONFIRMED", rejectedOrReturnedQuantity: "1", usableQuantity: "0" },
      "REJECTED_RETURNED"
    ],
    [{ requirementStatus: "CONFIRMED", isOverdue: true, usableQuantity: "0" }, "OVERDUE_BLOCKED"],
    [{ requirementStatus: "CONFIRMED", usableQuantity: "10", requiredQuantity: "10" }, "READY"],
    [
      { requirementStatus: "CONFIRMED", arrivedQuantity: "5", usableQuantity: "0" },
      "PENDING_ACCEPTANCE"
    ],
    [
      { requirementStatus: "CONFIRMED", arrivedQuantity: "5", requiredQuantity: "10" },
      "PARTIALLY_ARRIVED"
    ],
    [{ requirementStatus: "CONFIRMED", orderedQuantity: "10" }, "ORDERED"],
    [{ requirementStatus: "CONFIRMED", requisitioned: true }, "REQUISITIONED"],
    [{ requirementStatus: "CONFIRMED" }, "PENDING_REQUISITION"]
  ])("derives %j as %s", (facts, expected) => {
    expect(deriveProcurementDisplayStatus(facts as ProcurementStatusFacts)).toBe(expected);
  });
});
