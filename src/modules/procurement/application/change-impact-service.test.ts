import { describe, expect, it, vi } from "vitest";

import * as changeImpactService from "./change-impact-service";

import {
  assertImpactResolutionAllowed,
  isChangeImpactResolved,
  resolveProcurementChangeImpact,
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

  it("rejects an ERP obligation when only a legacy ERP tracking projection exists", async () => {
    const legacyTrackingLookup = vi.fn().mockResolvedValue({ sourceVersion: "legacy-v1" });
    const stableImpactProjectionLookup = vi.fn().mockResolvedValue(null);
    const createResolution = vi
      .fn()
      .mockRejectedValue(
        new Error("ERP resolution must not be created without an impact projection")
      );
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      procurementChangeImpact: {
        findFirst: vi.fn().mockResolvedValue({
          id: "impact-1",
          projectId: "project-1",
          previousRevisionId: "revision-before",
          nextRevisionId: "revision-after",
          status: "OPEN",
          version: 1,
          changedFieldsJson: ["quantity"],
          obligations: [
            {
              id: "obligation-erp",
              type: "ERP_PROJECTION",
              subjectId: "project",
              resolution: null
            }
          ]
        })
      },
      projectMember: {
        findFirst: vi.fn().mockResolvedValue({ id: "membership-1", projectRole: "PROCUREMENT" })
      },
      procurementTrackingLine: { findFirst: legacyTrackingLookup },
      procurementFulfillmentEvent: { findFirst: vi.fn().mockResolvedValue(null) },
      externalMapping: { findFirst: stableImpactProjectionLookup },
      procurementChangeImpactResolution: { create: createResolution }
    } as never;

    await expect(
      resolveProcurementChangeImpact(
        {
          projectId: "project-1",
          impactId: "impact-1",
          obligationId: "obligation-erp",
          version: 1,
          disposition: "ERP_PROJECTED",
          evidenceReference: "erp:change-v2",
          reason: "ERP 变更结果已投影",
          actorId: "user-1",
          auditContext: {
            actorId: "user-1",
            requestId: "request-1",
            traceId: "a".repeat(32),
            source: "API",
            sourceIp: null,
            userAgent: "Vitest",
            reason: null,
            projectId: "project-1",
            departmentId: "engineering",
            operationId: "resolve-impact-1"
          }
        },
        transaction
      )
    ).rejects.toMatchObject({ code: "PROC_CHANGE_ERP_PROJECTION_REQUIRED" });
    expect(createResolution).not.toHaveBeenCalled();
    expect(stableImpactProjectionLookup).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectId: "project-1",
          apmObjectType: "PROCUREMENT_CHANGE_IMPACT",
          apmObjectId: "impact-1",
          sourceVersion: { not: null },
          sourceHash: { not: null }
        })
      })
    );
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

  it("rejects a stale aggregate version before recording an obligation disposition", () => {
    expect(() =>
      assertImpactResolutionAllowed({
        currentStatus: "OPEN",
        requestedStatus: "RESOLVED",
        allObligationsResolved: true,
        expectedVersion: 3,
        currentVersion: 4
      })
    ).toThrow(expect.objectContaining({ code: "PROC_CHANGE_VERSION_CONFLICT", status: 409 }));
  });

  it("returns the existing evidence as an idempotent result only when every business field matches", async () => {
    const transaction = resolvedObligationTransaction();

    await expect(resolveExistingObligation(transaction.transaction)).resolves.toMatchObject({
      idempotent: true,
      resolution: {
        id: "resolution-1",
        disposition: "OWNER_PLAN_CONFIRMED",
        evidenceReference: "owner-plan:1",
        reason: "采购负责人确认处置"
      }
    });
    expect(transaction.writes).toEqual({ resolution: 0, audit: 0, outbox: 0 });
  });

  it.each([
    ["disposition", { disposition: "REWORK" }],
    ["evidenceReference", { evidenceReference: "owner-plan:changed" }],
    ["reason", { reason: "采购负责人改变处置方案" }]
  ])(
    "rejects an already resolved obligation when %s differs without writing another fact",
    async (_field, change) => {
      const transaction = resolvedObligationTransaction();

      await expect(
        resolveExistingObligation(transaction.transaction, change)
      ).rejects.toMatchObject({
        code: "PROC_CHANGE_OBLIGATION_ALREADY_RESOLVED",
        status: 409
      });
      expect(transaction.writes).toEqual({ resolution: 0, audit: 0, outbox: 0 });
    }
  );

  it("rejects a stale version for an unresolved obligation before writing any evidence", async () => {
    const createResolution = vi.fn();
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      procurementChangeImpact: {
        findFirst: vi.fn().mockResolvedValue({
          id: "impact-1",
          projectId: "project-1",
          previousRevisionId: "revision-before",
          nextRevisionId: "revision-after",
          status: "OPEN",
          version: 2,
          changedFieldsJson: ["quantity"],
          obligations: [
            {
              id: "obligation-1",
              type: "PROCUREMENT_OWNER",
              subjectId: "membership-1",
              resolution: null
            }
          ]
        })
      },
      projectMember: {
        findFirst: vi.fn().mockResolvedValue({ id: "membership-1", projectRole: "PROCUREMENT" })
      },
      procurementChangeImpactResolution: { create: createResolution }
    } as never;

    await expect(resolveExistingObligation(transaction)).rejects.toMatchObject({
      code: "PROC_CHANGE_VERSION_CONFLICT",
      status: 409
    });
    expect(createResolution).not.toHaveBeenCalled();
  });

  it("exposes project-scoped list and detail read ports for the procurement impact views", () => {
    const service = changeImpactService as unknown as Record<string, unknown>;
    expect(service.listProcurementChangeImpacts).toBeTypeOf("function");
    expect(service.readProcurementChangeImpactDetail).toBeTypeOf("function");
  });
});

function resolvedObligationTransaction() {
  const writes = {
    resolution: 0,
    audit: 0,
    outbox: 0
  };
  return {
    transaction: {
      $queryRaw: vi.fn().mockResolvedValue([]),
      procurementChangeImpact: {
        findFirst: vi.fn().mockResolvedValue({
          id: "impact-1",
          projectId: "project-1",
          previousRevisionId: "revision-before",
          nextRevisionId: "revision-after",
          status: "RESOLVED",
          version: 2,
          changedFieldsJson: ["quantity"],
          obligations: [
            {
              id: "obligation-1",
              type: "PROCUREMENT_OWNER",
              subjectId: "membership-1",
              resolution: {
                id: "resolution-1",
                disposition: "OWNER_PLAN_CONFIRMED",
                evidenceReference: "owner-plan:1",
                reason: "采购负责人确认处置"
              }
            }
          ]
        })
      },
      procurementChangeImpactObligation: { findMany: vi.fn().mockResolvedValue([]) },
      projectMember: {
        findFirst: vi.fn().mockResolvedValue({ id: "membership-1", projectRole: "PROCUREMENT" })
      },
      procurementChangeImpactResolution: {
        create: vi.fn(async () => {
          writes.resolution += 1;
        })
      },
      auditLog: {
        create: vi.fn(async () => {
          writes.audit += 1;
        })
      },
      outboxEvent: {
        create: vi.fn(async () => {
          writes.outbox += 1;
        })
      }
    } as never,
    writes
  };
}

function resolveExistingObligation(
  transaction: never,
  change: Partial<{
    disposition: string;
    evidenceReference: string;
    reason: string;
  }> = {}
) {
  return resolveProcurementChangeImpact(
    {
      projectId: "project-1",
      impactId: "impact-1",
      obligationId: "obligation-1",
      version: 1,
      disposition: "OWNER_PLAN_CONFIRMED",
      evidenceReference: "owner-plan:1",
      reason: "采购负责人确认处置",
      actorId: "user-1",
      auditContext: {
        actorId: "user-1",
        requestId: "request-existing-obligation",
        traceId: "b".repeat(32),
        source: "API",
        sourceIp: null,
        userAgent: "Vitest",
        reason: null,
        projectId: "project-1",
        departmentId: "engineering",
        operationId: "resolve-existing-obligation"
      },
      ...change
    },
    transaction
  );
}
