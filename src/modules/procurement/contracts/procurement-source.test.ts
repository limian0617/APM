import { describe, expect, it } from "vitest";

import {
  ERP_OWNED_FIELDS,
  MemoryErpProjectionSource,
  type ProcurementProjectionEnvelope,
  type ProcurementSourcePort
} from "./procurement-source";

describe("APM-090B procurement source port", () => {
  it("accepts only read-only projection facts and exposes no ERP accounting methods", () => {
    const source: ProcurementSourcePort = new MemoryErpProjectionSource();
    const projection: ProcurementProjectionEnvelope = {
      sourceSystem: "ERP-TEST",
      objectType: "PURCHASE_ORDER_LINE",
      externalId: "PO-1",
      externalLineId: "1",
      sourceVersion: "v1",
      sourceHash: "hash",
      occurredAt: new Date().toISOString(),
      payload: { externalStatus: "OPEN" }
    };
    expect(source.mode).toBe("ERP");
    expect(ERP_OWNED_FIELDS).not.toContain("price");
    expect(ERP_OWNED_FIELDS).not.toContain("tax");
    expect(ERP_OWNED_FIELDS).not.toContain("payment");
    expect(source.upsertProjection(projection)).resolves.toMatchObject({ accepted: true });
    expect(source).not.toHaveProperty("writeInventory");
    expect(source).not.toHaveProperty("writePurchaseOrder");
  });

  it("rejects a projection with missing stable external identity", async () => {
    const source = new MemoryErpProjectionSource();
    await expect(
      source.upsertProjection({
        sourceSystem: "ERP-TEST",
        objectType: "PURCHASE_ORDER_LINE",
        externalId: "",
        externalLineId: "1",
        sourceVersion: "v1",
        sourceHash: "hash",
        occurredAt: new Date().toISOString(),
        payload: {}
      })
    ).rejects.toMatchObject({ code: "PROC_EXTERNAL_ID_REQUIRED", status: 422 });
  });
});
