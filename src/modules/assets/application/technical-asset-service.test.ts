import { describe, expect, it, vi } from "vitest";

import type { AuditContext } from "@/modules/audit/contracts/audit";

import { transitionTechnicalAsset } from "./technical-asset-service";

const auditContext: AuditContext = {
  actorId: "owner-1",
  requestId: "request-1",
  traceId: "trace-1",
  source: "API",
  sourceIp: null,
  userAgent: "Vitest",
  reason: null,
  projectId: null,
  departmentId: "engineering",
  operationId: "generic-disable-1"
};

describe("APM-064 technical asset command boundary", () => {
  it("rejects generic DISABLED before entering a transaction", async () => {
    const transaction = { $queryRaw: vi.fn() };

    await expect(
      transitionTechnicalAsset(
        {
          rndProjectId: "rnd-1",
          assetId: "asset-1",
          version: 1,
          toStatus: "DISABLED",
          reason: "must use dedicated command",
          actorId: "owner-1",
          auditContext
        },
        transaction as never
      )
    ).rejects.toMatchObject({
      code: "TECHNICAL_ASSET_DEACTIVATION_COMMAND_REQUIRED",
      status: 409
    });
    expect(transaction.$queryRaw).not.toHaveBeenCalled();
  });
});
