import { describe, expect, it } from "vitest";

import {
  acceptanceBatchPathSchema,
  acceptanceBatchQuerySchema,
  acceptanceResultBodySchema,
  createAcceptanceBatchBodySchema,
  createAcceptanceTemplateBodySchema,
  acceptanceServiceErrorResponse
} from "./acceptance-http";

describe("acceptance HTTP contracts", () => {
  it("rejects unknown fields and invalid acceptance scopes", () => {
    expect(
      createAcceptanceBatchBodySchema.safeParse({
        acceptanceType: "FAT",
        scopeType: "PROJECT",
        scopeId: "project-1",
        templateVersionId: "template-v1",
        version: 0,
        unexpected: true
      }).success
    ).toBe(false);
    expect(acceptanceBatchPathSchema.safeParse({ projectId: "p-1", batchId: "b-1" }).success).toBe(
      true
    );
    expect(
      acceptanceBatchQuerySchema.safeParse({ limit: "20", acceptanceType: "SAT" }).success
    ).toBe(true);
  });

  it("requires a decision and supports text measured values and optional evidence", () => {
    expect(
      acceptanceResultBodySchema.safeParse({
        version: 1,
        itemId: "item-1",
        decision: "PASS",
        measuredValue: "230V",
        measuredUnit: "V",
        note: "正常",
        correctionReason: null,
        evidenceFileIds: []
      }).success
    ).toBe(true);
    expect(acceptanceResultBodySchema.safeParse({ version: 1, decision: "UNKNOWN" }).success).toBe(
      false
    );
  });

  it("maps service errors to structured responses", async () => {
    const response = acceptanceServiceErrorResponse({
      code: "ACCEPTANCE_BATCH_LOCKED",
      message: "验收批次已锁定，不可修改。",
      status: 409
    });
    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: "ACCEPTANCE_BATCH_LOCKED" }
    });
  });
});
