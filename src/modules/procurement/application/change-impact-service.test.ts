import { describe, expect, it } from "vitest";

import {
  assertImpactResolutionAllowed,
  isChangeImpactResolved,
  validateChangeImpactResolution
} from "./change-impact-service";
import { PROCUREMENT_CHANGE_IMPACT_DISPOSITIONS } from "@/modules/procurement/domain/change-impact";

describe("APM-091B procurement change impact resolution rules", () => {
  it("exposes only the approved append-only disposition vocabulary", () => {
    expect(PROCUREMENT_CHANGE_IMPACT_DISPOSITIONS).toEqual([
      "OWNER_PLAN_CONFIRMED",
      "SUPPLIER_ACCEPTED",
      "ERP_PROJECTED",
      "CANCELED",
      "REWORK",
      "RETURNED",
      "CONTINUE_USE"
    ]);
  });

  it("requires the procurement owner obligation to use the owner-plan disposition", () => {
    expect(() =>
      validateChangeImpactResolution({
        obligationType: "PROCUREMENT_OWNER",
        disposition: "SUPPLIER_ACCEPTED",
        evidenceReference: "plan:123",
        reason: "采购负责人确认"
      })
    ).toThrow(expect.objectContaining({ code: "PROC_CHANGE_DISPOSITION_INVALID" }));

    expect(
      validateChangeImpactResolution({
        obligationType: "PROCUREMENT_OWNER",
        disposition: "OWNER_PLAN_CONFIRMED",
        evidenceReference: "plan:123",
        reason: "采购负责人确认"
      })
    ).toEqual({
      disposition: "OWNER_PLAN_CONFIRMED",
      evidenceReference: "plan:123",
      reason: "采购负责人确认"
    });
  });

  it("requires explicit supplier and ERP evidence instead of accepting client assertions", () => {
    expect(() =>
      validateChangeImpactResolution({
        obligationType: "SUPPLIER",
        disposition: "SUPPLIER_ACCEPTED",
        evidenceReference: "",
        reason: "供应商已确认"
      })
    ).toThrow(expect.objectContaining({ code: "PROC_CHANGE_EVIDENCE_REQUIRED" }));

    expect(() =>
      validateChangeImpactResolution({
        obligationType: "ERP_PROJECTION",
        disposition: "ERP_PROJECTED",
        evidenceReference: "erp:order-1",
        reason: "ERP 已同步"
      })
    ).toThrow(expect.objectContaining({ code: "PROC_CHANGE_ERP_PROJECTION_REQUIRED" }));

    expect(
      validateChangeImpactResolution({
        obligationType: "ERP_PROJECTION",
        disposition: "ERP_PROJECTED",
        evidenceReference: "erp:order-1",
        reason: "ERP 已同步",
        erpProjection: { confirmed: true, sourceVersion: "42" }
      })
    ).toMatchObject({ disposition: "ERP_PROJECTED" });
  });

  it("allows only explicit dispositions for old tracking and fulfillment facts", () => {
    expect(() =>
      validateChangeImpactResolution({
        obligationType: "OLD_TRACKING",
        disposition: "SUPPLIER_ACCEPTED",
        evidenceReference: "order:1",
        reason: "旧订单继续使用"
      })
    ).toThrow(expect.objectContaining({ code: "PROC_CHANGE_DISPOSITION_INVALID" }));

    expect(
      validateChangeImpactResolution({
        obligationType: "OLD_FULFILLMENT",
        disposition: "CONTINUE_USE",
        evidenceReference: "receipt:1",
        reason: "到货继续使用"
      })
    ).toMatchObject({ disposition: "CONTINUE_USE" });
  });

  it("only permits RESOLVED after every obligation has append-only resolution evidence", () => {
    expect(isChangeImpactResolved([{ resolved: true }, { resolved: false }])).toBe(false);
    expect(isChangeImpactResolved([{ resolved: true }, { resolved: true }])).toBe(true);
    expect(() =>
      assertImpactResolutionAllowed({
        currentStatus: "OPEN",
        requestedStatus: "RESOLVED",
        allObligationsResolved: false
      })
    ).toThrow(expect.objectContaining({ code: "PROC_CHANGE_OBLIGATIONS_INCOMPLETE" }));
    expect(() =>
      assertImpactResolutionAllowed({
        currentStatus: "OPEN",
        requestedStatus: "RESOLVED",
        allObligationsResolved: true
      })
    ).not.toThrow();
  });
});
