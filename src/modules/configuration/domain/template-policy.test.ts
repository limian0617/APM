import { describe, expect, it } from "vitest";

import {
  componentChecksum,
  templateChecksum,
  TemplateValidationError,
  validateTemplateComponentContent,
  validateTemplateReferences
} from "./template-policy";

describe("APM-010 template policy", () => {
  it("validates stable component rules and deterministic checksums", () => {
    const content = validateTemplateComponentContent("STAGE", {
      stages: [
        { code: "S1", name: "方案冻结", sequence: 1 },
        { code: "S0", name: "项目启动", sequence: 0 }
      ]
    });
    const first = componentChecksum({
      componentType: "STAGE",
      name: "阶段",
      description: null,
      content
    });
    const second = componentChecksum({
      description: null,
      content,
      name: "阶段",
      componentType: "STAGE"
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toBe(first);
  });

  it("rejects duplicate and incomplete component rules", () => {
    expect(() =>
      validateTemplateComponentContent("STAGE", {
        stages: [
          { code: "S0", name: "A", sequence: 0 },
          { code: "S0", name: "B", sequence: 1 }
        ]
      })
    ).toThrowError(TemplateValidationError);
    expect(() =>
      validateTemplateComponentContent("GATE", {
        gates: [{ code: "G1", name: "基线", stageCode: "S0", requiredCheckerCodes: [] }]
      })
    ).toThrow(/至少一个检查器/u);
  });

  it("validates a canonical milestone component payload", () => {
    expect(
      validateTemplateComponentContent("MILESTONE", {
        milestones: [
          { code: "DESIGN.FREEZE", name: "设计冻结", position: 10 },
          {
            code: "FAT.READY",
            name: "FAT 准备",
            description: "客户验收前置",
            position: 20
          }
        ]
      })
    ).toEqual({
      milestones: [
        { code: "DESIGN.FREEZE", name: "设计冻结", position: 10 },
        {
          code: "FAT.READY",
          description: "客户验收前置",
          name: "FAT 准备",
          position: 20
        }
      ]
    });
  });

  it("rejects milestone rules with duplicate codes", () => {
    expect(() =>
      validateTemplateComponentContent("MILESTONE", {
        milestones: [
          { code: "DESIGN.FREEZE", name: "设计冻结", position: 10 },
          { code: "DESIGN.FREEZE", name: "FAT 准备", position: 20 }
        ]
      })
    ).toThrowError(TemplateValidationError);
  });

  it("rejects milestone rules with duplicate positions", () => {
    expect(() =>
      validateTemplateComponentContent("MILESTONE", {
        milestones: [
          { code: "DESIGN.FREEZE", name: "设计冻结", position: 10 },
          { code: "FAT.READY", name: "FAT 准备", position: 10 }
        ]
      })
    ).toThrowError(TemplateValidationError);
  });

  it("rejects a milestone rule without a name", () => {
    expect(() =>
      validateTemplateComponentContent("MILESTONE", {
        milestones: [{ code: "DESIGN.FREEZE", position: 10 }]
      })
    ).toThrowError(TemplateValidationError);
  });

  it("requires complete template component types and unique positions", () => {
    const base = [
      {
        componentVersionId: "stage",
        componentType: "STAGE" as const,
        slot: "STAGE",
        position: 0,
        checksum: "a".repeat(64)
      },
      {
        componentVersionId: "gate",
        componentType: "GATE" as const,
        slot: "GATE",
        position: 1,
        checksum: "b".repeat(64)
      },
      {
        componentVersionId: "role",
        componentType: "ROLE" as const,
        slot: "ROLE",
        position: 2,
        checksum: "c".repeat(64)
      },
      {
        componentVersionId: "wbs",
        componentType: "WBS" as const,
        slot: "WBS",
        position: 3,
        checksum: "d".repeat(64)
      }
    ];
    expect(validateTemplateReferences([...base].reverse()).map(({ slot }) => slot)).toEqual([
      "STAGE",
      "GATE",
      "ROLE",
      "WBS"
    ]);
    expect(() => validateTemplateReferences(base.slice(0, 3))).toThrow(/WBS/u);
    expect(() =>
      validateTemplateReferences([{ ...base[0]! }, { ...base[1]!, position: 0 }, ...base.slice(2)])
    ).toThrow(/排序位置不能重复/u);
    expect(
      templateChecksum({ name: "标准模板", description: null, references: [...base].reverse() })
    ).toBe(templateChecksum({ name: "标准模板", description: null, references: base }));
  });
});
