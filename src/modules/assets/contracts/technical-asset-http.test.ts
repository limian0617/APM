import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  createRndProjectBodySchema,
  createTechnicalAssetBodySchema,
  rndProjectCommandPathSchema,
  technicalAssetCommandBodySchema,
  technicalAssetPathSchema,
  technicalAssetValidationBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

describe("APM-061 technical asset HTTP contracts", () => {
  it("accepts strict R&D project, asset master, transition, and validation DTOs", () => {
    expect(
      parseDto(
        createRndProjectBodySchema,
        {
          code: "rnd.feeder-01",
          name: "标准上料模组研发",
          description: "企业标准机械资产研发",
          departmentId: "engineering",
          ownerId: "owner-1",
          reason: "立项独立研发项目"
        },
        "body"
      )
    ).toMatchObject({ code: "RND.FEEDER-01", ownerId: "owner-1" });
    expect(
      parseDto(
        createTechnicalAssetBodySchema,
        {
          assetNumber: "ast.mech.feeder-01",
          assetType: "MECHANICAL",
          name: "标准上料模组",
          ownerId: "owner-1",
          reason: "建立企业技术资产主记录"
        },
        "body"
      )
    ).toMatchObject({ assetNumber: "AST.MECH.FEEDER-01", assetType: "MECHANICAL" });
    expect(
      parseDto(
        rndProjectCommandPathSchema,
        { rndProjectId: "rnd-1", command: "submit-validation" },
        "path"
      )
    ).toEqual({ rndProjectId: "rnd-1", command: "submit-validation" });
    expect(
      parseDto(technicalAssetPathSchema, { rndProjectId: "rnd-1", assetId: "asset-1" }, "path")
    ).toEqual({ rndProjectId: "rnd-1", assetId: "asset-1" });
    expect(
      parseDto(technicalAssetCommandBodySchema, { version: 2, reason: "提交独立验证" }, "body")
    ).toEqual({ version: 2, reason: "提交独立验证" });
    expect(
      parseDto(
        technicalAssetValidationBodySchema,
        { version: 2, decision: "PASSED", evidence: "独立测试报告通过", reason: "记录验证结论" },
        "body"
      )
    ).toMatchObject({ decision: "PASSED" });
  });

  it("rejects unknown properties, invalid master identity, loose commands, and invalid evidence", () => {
    expect(() =>
      parseDto(
        createTechnicalAssetBodySchema,
        {
          assetNumber: "asset number",
          assetType: "MECHANICAL",
          name: "标准上料模组",
          ownerId: "owner-1",
          reason: "建立资产"
        },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        rndProjectCommandPathSchema,
        { rndProjectId: "rnd-1", command: "publish-release" },
        "path"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        technicalAssetValidationBodySchema,
        { version: 2, decision: "PASSED", evidence: "", reason: "记录验证结论", release: "v1" },
        "body"
      )
    ).toThrowError(ApiContractError);
  });
});
