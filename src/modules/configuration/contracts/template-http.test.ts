import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  saveProjectTemplateDraftBodySchema,
  saveTemplateComponentDraftBodySchema,
  templateDiffQuerySchema
} from "@/modules/platform-api/contracts/internal-routes";

describe("APM-010 template HTTP contracts", () => {
  it("accepts a strict discriminated component DTO", () => {
    expect(
      parseDto(
        saveTemplateComponentDraftBodySchema,
        {
          version: 0,
          componentType: "STAGE",
          name: "九阶段",
          content: { stages: [{ code: "S0", name: "启动", sequence: 0 }] },
          reason: "创建阶段组件"
        },
        "body"
      )
    ).toMatchObject({ componentType: "STAGE", version: 0 });
  });

  it("rejects unknown fields and type/content mismatches", () => {
    expect(() =>
      parseDto(
        saveTemplateComponentDraftBodySchema,
        {
          version: 0,
          componentType: "STAGE",
          name: "阶段",
          content: { gates: [] },
          reason: "错误负载",
          unsafe: true
        },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        saveProjectTemplateDraftBodySchema,
        { version: 0, name: "模板", components: [], reason: "空模板" },
        "body"
      )
    ).toThrowError(ApiContractError);
  });

  it("parses only a positive comparison target version", () => {
    expect(parseDto(templateDiffQuerySchema, { toVersion: "2" }, "query")).toEqual({
      toVersion: 2
    });
    expect(() => parseDto(templateDiffQuerySchema, { toVersion: "0" }, "query")).toThrowError(
      ApiContractError
    );
  });
});
