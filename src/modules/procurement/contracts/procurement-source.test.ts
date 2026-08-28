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

  it("rejects an older source version and a conflicting replay", async () => {
    const source = new MemoryErpProjectionSource();
    const base: ProcurementProjectionEnvelope = {
      sourceSystem: "ERP-TEST",
      objectType: "PURCHASE_ORDER_LINE",
      externalId: "PO-2",
      externalLineId: "1",
      sourceVersion: "2",
      sourceHash: "hash-2",
      occurredAt: new Date().toISOString(),
      payload: {}
    };
    await source.upsertProjection(base);
    await expect(
      source.upsertProjection({ ...base, sourceVersion: "1", sourceHash: "hash-1" })
    ).rejects.toMatchObject({
      code: "PROC_SOURCE_VERSION_OUT_OF_ORDER",
      status: 409
    });
    await expect(
      source.upsertProjection({ ...base, sourceHash: "different" })
    ).rejects.toMatchObject({
      code: "PROC_SOURCE_VERSION_CONFLICT",
      status: 409
    });
  });
});
