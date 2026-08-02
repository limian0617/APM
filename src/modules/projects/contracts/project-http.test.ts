import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  createProjectBodySchema,
  deliveryUnitPathSchema,
  deliveryUnitStatusBodySchema,
  initializeProjectStructureBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

const valid = {
  code: "PRJ-001",
  name: "项目一",
  departmentId: "engineering",
  templateCode: "STANDARD.LINE",
  templateVersion: 1,
  templateChecksum: "a".repeat(64),
  reason: "创建交付项目"
};

describe("APM-011 project create HTTP contract", () => {
  it("accepts the exact published template selector", () => {
    expect(parseDto(createProjectBodySchema, valid, "body")).toEqual(valid);
  });

  it("rejects unknown fields, unstable project codes, and malformed checksums", () => {
    expect(() => parseDto(createProjectBodySchema, { ...valid, extra: true }, "body")).toThrowError(
      ApiContractError
    );
    expect(() =>
      parseDto(createProjectBodySchema, { ...valid, code: "prj-1" }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(createProjectBodySchema, { ...valid, templateChecksum: "bad" }, "body")
    ).toThrowError(ApiContractError);
  });
});

describe("APM-012 project structure HTTP contract", () => {
  const structure = {
    projectVersion: 1,
    projectType: "CUSTOMER_DELIVERY" as const,
    equipmentShape: "SINGLE_MACHINE" as const,
    deliveryUnits: [
      {
        code: "MACHINE.01",
        name: "一号单机",
        unitType: "MACHINE" as const,
        parentCode: null,
        position: 0
      }
    ],
    modules: [
      {
        code: "MODULE.01",
        name: "上料模块",
        machineCode: "MACHINE.01",
        position: 0
      }
    ],
    reason: "初始化项目交付结构"
  };

  it("accepts exact structure and status command DTOs", () => {
    expect(parseDto(initializeProjectStructureBodySchema, structure, "body")).toEqual(structure);
    expect(
      parseDto(
        deliveryUnitPathSchema,
        { projectId: "project-1", deliveryUnitId: "machine-1" },
        "path"
      )
    ).toEqual({ projectId: "project-1", deliveryUnitId: "machine-1" });
    expect(
      parseDto(deliveryUnitStatusBodySchema, { version: 1, enabled: false, reason: "停用" }, "body")
    ).toEqual({ version: 1, enabled: false, reason: "停用" });
  });

  it("rejects unknown fields, invalid nulls, and excessive structure sizes", () => {
    expect(() =>
      parseDto(initializeProjectStructureBodySchema, { ...structure, unexpected: true }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        initializeProjectStructureBodySchema,
        { ...structure, equipmentShape: undefined },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        initializeProjectStructureBodySchema,
        {
          ...structure,
          deliveryUnits: Array.from({ length: 1001 }, () => structure.deliveryUnits[0])
        },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        deliveryUnitStatusBodySchema,
        { version: 0, enabled: "false", reason: "停用" },
        "body"
      )
    ).toThrowError(ApiContractError);
  });
});
