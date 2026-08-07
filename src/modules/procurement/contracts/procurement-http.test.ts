import { describe, expect, it } from "vitest";

import {
  appendFulfillmentEventBodySchema,
  createMaterialRequirementBodySchema,
  procurementCommandSchema,
  procurementServiceErrorResponse,
  parseMaterialRequirementBody,
  reverseFulfillmentEventBodySchema
} from "./procurement-http";

describe("APM-090A procurement HTTP contracts", () => {
  it("rejects unknown fields and invalid decimal, unit and date values", () => {
    const result = createMaterialRequirementBodySchema.safeParse({
      materialReferenceId: "material-1",
      quantity: "1.1234567",
      trackingUnit: "pcs",
      requiredOn: "2026/09/01",
      isCritical: false,
      businessType: "STANDARD_PURCHASE",
      sourceType: "MANUAL",
      unexpected: true
    });
    expect(result.success).toBe(false);
  });

  it("requires an exact published drawing version for drawing customization", () => {
    const parsed = parseMaterialRequirementBody({
      materialReferenceId: "material-1",
      quantity: "1",
      trackingUnit: "PCS",
      requiredOn: "2026-09-01",
      isCritical: false,
      businessType: "DRAWING_CUSTOM",
      sourceType: "DRAWING_PUBLISHED"
    });
    expect(parsed).toBeNull();
  });

  it("accepts only confirm, revise and cancel commands", () => {
    expect(procurementCommandSchema.safeParse("delete").success).toBe(false);
    expect(procurementCommandSchema.safeParse("confirm").success).toBe(true);
  });

  it("maps procurement service errors to the shared API envelope", async () => {
    const response = procurementServiceErrorResponse({
      code: "PROC_CAPABILITY_DISABLED",
      message: "disabled",
      status: 409
    });
    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: "PROC_CAPABILITY_DISABLED" }
    });
  });

  it("accepts only appendable fulfillment events with controlled timestamps", () => {
    const accepted = appendFulfillmentEventBodySchema.safeParse({
      requirementId: "requirement-1",
      requirementRevisionId: "revision-1",
      eventType: "PURCHASE_ARRIVED",
      quantity: "2",
      trackingUnit: "PCS",
      businessOccurredAt: "2026-08-07T00:00:00.000Z",
      reason: "到货登记"
    });
    expect(accepted.success).toBe(true);
    expect(
      appendFulfillmentEventBodySchema.safeParse({
        requirementId: "requirement-1",
        requirementRevisionId: "revision-1",
        eventType: "REVERSED",
        quantity: "2",
        trackingUnit: "PCS",
        businessOccurredAt: "2026-08-07",
        reason: "绕过反向接口"
      }).success
    ).toBe(false);
  });

  it("requires a versioned reverse command with a reason", () => {
    expect(
      reverseFulfillmentEventBodySchema.safeParse({ version: 1, reason: "录入错误" }).success
    ).toBe(true);
    expect(reverseFulfillmentEventBodySchema.safeParse({ version: 0, reason: "" }).success).toBe(
      false
    );
  });
});
