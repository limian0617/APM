import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  createResponsibilityPackageBodySchema,
  responsibilityPackageCommandPathSchema,
  responsibilityPackageQuerySchema,
  updateResponsibilityPackageBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

const body = {
  code: "MECH.DESIGN",
  name: "机械设计",
  description: null,
  deliveryUnitId: "machine-1",
  moduleId: "module-1",
  ownerMembershipId: "member-1",
  inputs: [{ code: "REQUIREMENT", description: "冻结需求" }],
  outputs: [{ code: "DRAWING", description: "发布图纸" }],
  acceptanceCriteria: [{ code: "REVIEWED", description: "完成评审" }],
  valueWeight: 25,
  reason: "创建责任包"
};

describe("APM-014 responsibility package HTTP contract", () => {
  it("accepts exact create, update, command path, and list DTOs", () => {
    const { code: _code, ...updateBody } = body;
    expect(parseDto(createResponsibilityPackageBodySchema, body, "body")).toEqual(body);
    expect(
      parseDto(updateResponsibilityPackageBodySchema, { ...updateBody, version: 1 }, "body")
    ).toEqual({ ...updateBody, version: 1 });
    expect(
      parseDto(
        responsibilityPackageCommandPathSchema,
        { projectId: "project-1", packageId: "package-1", command: "accept" },
        "path"
      )
    ).toEqual({ projectId: "project-1", packageId: "package-1", command: "accept" });
    expect(parseDto(responsibilityPackageQuerySchema, { limit: "25" }, "query")).toEqual({
      limit: 25
    });
  });

  it("rejects unknown fields, invalid actions, empty arrays, and weight overflow", () => {
    expect(() =>
      parseDto(createResponsibilityPackageBodySchema, { ...body, wage: 100 }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        responsibilityPackageCommandPathSchema,
        { projectId: "project-1", packageId: "package-1", command: "delete" },
        "path"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        createResponsibilityPackageBodySchema,
        { ...body, inputs: [], valueWeight: 1_000_001 },
        "body"
      )
    ).toThrowError(ApiContractError);
  });
});
