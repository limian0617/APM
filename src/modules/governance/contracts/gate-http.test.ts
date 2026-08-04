import { describe, expect, it } from "vitest";

import { GateServiceError } from "../application/gate-service";
import { GateConditionalReleaseError } from "../domain/gate-conditional-release";

import {
  gateServiceErrorResponse,
  parseConditionalReleasePayload,
  parseGateCheckPayload,
  parseGateInstancePayload,
  parseGateSubmissionCommandPayload
} from "./gate-http";

describe("APM-031 Gate HTTP contracts", () => {
  it("accepts only explicit non-project scope targets", () => {
    expect(
      parseGateInstancePayload({
        definitionId: "definition-1",
        scope: "DELIVERY_UNIT",
        deliveryUnitId: "unit-1"
      })
    ).toEqual({
      definitionId: "definition-1",
      scope: "DELIVERY_UNIT",
      deliveryUnitId: "unit-1"
    });
    expect(
      parseGateInstancePayload({
        definitionId: "definition-1",
        scope: "MODULE",
        deliveryUnitId: "unit-1",
        moduleId: "module-1"
      })
    ).toMatchObject({ scope: "MODULE", moduleId: "module-1" });
  });

  it("rejects invalid scope targets and unknown instance properties", () => {
    expect(() =>
      parseGateInstancePayload({ definitionId: "definition-1", scope: "PROJECT" })
    ).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED", status: 422 }));
    expect(() =>
      parseGateInstancePayload({
        definitionId: "definition-1",
        scope: "DELIVERY_UNIT",
        deliveryUnitId: "unit-1",
        moduleId: "module-1"
      })
    ).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED", status: 422 }));
    expect(() =>
      parseGateInstancePayload({
        definitionId: "definition-1",
        scope: "MODULE",
        deliveryUnitId: "unit-1",
        moduleId: "module-1",
        extra: true
      })
    ).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED", status: 422 }));
  });

  it("requires a positive optimistic version and an execution reason", () => {
    expect(parseGateCheckPayload({ version: 1, reason: "Run the Gate checks" })).toEqual({
      version: 1,
      reason: "Run the Gate checks"
    });
    expect(() => parseGateCheckPayload({ version: 0, reason: "Run the Gate checks" })).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED", status: 422 })
    );
    expect(() => parseGateCheckPayload({ version: 1, reason: "", unexpected: true })).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED", status: 422 })
    );
  });

  it("requires a version and reason for every Gate submission lifecycle command", () => {
    expect(parseGateSubmissionCommandPayload({ version: 2, reason: "提交当前检查结果" })).toEqual({
      version: 2,
      reason: "提交当前检查结果"
    });
    expect(() => parseGateSubmissionCommandPayload({ version: 0, reason: "提交" })).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED", status: 422 })
    );
    expect(() =>
      parseGateSubmissionCommandPayload({ version: 2, reason: "", extra: true })
    ).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED", status: 422 }));
  });

  it("maps typed Gate service failures without leaking implementation details", async () => {
    const response = gateServiceErrorResponse(
      new GateServiceError("GATE_INSTANCE_NOT_FOUND", "内部实例信息", 404)
    );

    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: "GATE_INSTANCE_NOT_FOUND", message: "内部实例信息" }
    });
  });

  it("requires every conditional release residual fact and rejects unknown fields", () => {
    expect(
      parseConditionalReleasePayload({
        version: 3,
        reason: "条件放行并记录遗留项",
        residualItems: [
          {
            title: "补充照片",
            ownerMembershipId: "owner-membership",
            verifierMembershipId: "verifier-membership",
            dueAt: "2030-01-10T00:00:00.000Z",
            evidence: "FAT 记录 12",
            escalationRule: "逾期升级给 PM"
          }
        ]
      })
    ).toMatchObject({ version: 3, residualItems: [{ title: "补充照片" }] });
    expect(() =>
      parseConditionalReleasePayload({ version: 3, reason: "条件放行", residualItems: [] })
    ).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED", status: 422 }));
    expect(() =>
      parseConditionalReleasePayload({
        version: 3,
        reason: "条件放行",
        residualItems: [
          {
            title: "补充照片",
            ownerMembershipId: "owner-membership",
            verifierMembershipId: "verifier-membership",
            dueAt: "not-a-date",
            evidence: "",
            escalationRule: "逾期升级给 PM"
          }
        ],
        unexpected: true
      })
    ).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED", status: 422 }));
  });

  it("maps conditional release failures to the standard error envelope", async () => {
    const response = gateServiceErrorResponse(
      new GateConditionalReleaseError("RESIDUAL_OWNER_FORBIDDEN", "内部授权信息", 403)
    );

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: "RESIDUAL_OWNER_FORBIDDEN", message: "内部授权信息" }
    });
  });
});
