import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  componentChecksum,
  TEMPLATE_COMPONENT_TYPES,
  templateChecksum,
  TemplateValidationError,
  parseGateDefinitionRules,
  validateTemplateComponentContent,
  validateTemplateMilestoneCodesUnique,
  validateTemplateReferences,
  type TemplateComponentContent
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

  it("normalizes a cropped merged stage component before calculating its checksum", () => {
    const content = validateTemplateComponentContent("STAGE", {
      stages: [
        { code: " S4 ", name: " 装配与联调 ", sequence: 4 },
        { code: " S0 ", name: " 项目启动 ", sequence: 0 },
        {
          code: " S1 ",
          name: " 方案与详细设计 ",
          description: " 标准机合并方案和设计评审 ",
          sequence: 1
        }
      ]
    });
    const expected: TemplateComponentContent = {
      stages: [
        { code: "S0", name: "项目启动", sequence: 0 },
        {
          code: "S1",
          name: "方案与详细设计",
          description: "标准机合并方案和设计评审",
          sequence: 1
        },
        { code: "S4", name: "装配与联调", sequence: 4 }
      ]
    };

    expect(content).toEqual(expected);
    expect(
      componentChecksum({ componentType: "STAGE", name: "阶段", description: null, content })
    ).toBe(
      componentChecksum({
        componentType: "STAGE",
        name: "阶段",
        description: null,
        content: expected
      })
    );
  });

  it("rejects invalid stage labels and descriptions", () => {
    expect(() =>
      validateTemplateComponentContent("STAGE", {
        stages: [{ code: "S0", name: " ", sequence: 0 }]
      })
    ).toThrowError(TemplateValidationError);
    expect(() =>
      validateTemplateComponentContent("STAGE", {
        stages: [{ code: "S0", name: "名称", description: " ", sequence: 0 }]
      })
    ).toThrowError(TemplateValidationError);
    expect(() =>
      validateTemplateComponentContent("STAGE", {
        stages: [{ code: "S0", name: "n".repeat(201), sequence: 0 }]
      })
    ).toThrowError(TemplateValidationError);
    expect(() =>
      validateTemplateComponentContent("STAGE", {
        stages: [{ code: "S0", name: "名称", description: "d".repeat(2001), sequence: 0 }]
      })
    ).toThrowError(TemplateValidationError);
  });

  it("rejects unknown stage component fields", () => {
    expect(() =>
      validateTemplateComponentContent("STAGE", {
        stages: [{ code: "S0", name: "启动", sequence: 0 }],
        unexpected: true
      })
    ).toThrowError(TemplateValidationError);
    expect(() =>
      validateTemplateComponentContent("STAGE", {
        stages: [{ code: "S0", name: "启动", sequence: 0, unexpected: true }]
      })
    ).toThrowError(TemplateValidationError);
  });

  it("rejects duplicate stage sequences", () => {
    expect(() =>
      validateTemplateComponentContent("STAGE", {
        stages: [
          { code: "S0", name: "启动", sequence: 0 },
          { code: "S1", name: "方案冻结", sequence: 0 }
        ]
      })
    ).toThrowError(TemplateValidationError);
  });

  it("rejects stage codes outside S0-S8 and sequence values that do not match the stage ordinal", () => {
    for (const stage of [
      { code: "s0", name: "启动", sequence: 0 },
      { code: "S9", name: "超出九阶段", sequence: 9 },
      { code: "ALPHA", name: "自定义阶段", sequence: 0 },
      { code: "S4", name: "错位阶段", sequence: 2 },
      { code: "S0", name: "启动", sequence: -1 },
      { code: "S0", name: "启动", sequence: 0.5 },
      { code: "S0", name: "启动", sequence: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      expect(() => validateTemplateComponentContent("STAGE", { stages: [stage] })).toThrowError(
        TemplateValidationError
      );
    }
  });

  it("accepts a cropped subset and rejects more than the nine canonical stage definitions", () => {
    const stages = Array.from({ length: 9 }, (_, sequence) => ({
      code: `S${sequence}`,
      name: `阶段 ${sequence}`,
      sequence
    }));

    expect(validateTemplateComponentContent("STAGE", { stages })).toMatchObject({ stages });
    expect(() =>
      validateTemplateComponentContent("STAGE", {
        stages: [...stages, { code: "S9", name: "阶段 9", sequence: 9 }]
      })
    ).toThrowError(TemplateValidationError);
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

  it("preserves legacy Gate JSON while exposing project-scoped v1 bindings for materialization", () => {
    const legacyContent = {
      gates: [
        {
          code: "G1",
          name: "执行基线批准",
          stageCode: "S0",
          requiredCheckerCodes: ["DOCUMENTS.COMPLETE"]
        }
      ]
    };

    const validated = validateTemplateComponentContent("GATE", legacyContent);

    expect(validated).toEqual(legacyContent);
    expect(validated).not.toHaveProperty("gates.0.scope");
    expect(
      componentChecksum({
        componentType: "GATE",
        name: "Gate",
        description: null,
        content: validated
      })
    ).toBe(
      componentChecksum({
        componentType: "GATE",
        name: "Gate",
        description: null,
        content: legacyContent
      })
    );
    expect(parseGateDefinitionRules(validated)).toEqual([
      {
        code: "G1",
        name: "执行基线批准",
        stageCode: "S0",
        scope: "PROJECT",
        checkerBindings: [{ code: "DOCUMENTS.COMPLETE", version: 1 }],
        bindingFormat: "LEGACY"
      }
    ]);
  });

  it("accepts explicit Gate scopes and versioned checker bindings", () => {
    const content = {
      gates: [
        {
          code: "G2",
          name: "模块交付确认",
          stageCode: "S4",
          scope: "MODULE",
          checkers: [
            { code: "STAGE.AWAITING_GATE", version: 1 },
            { code: "DOCUMENTS.COMPLETE", version: 2 }
          ]
        }
      ]
    };

    expect(validateTemplateComponentContent("GATE", content)).toEqual(content);
    expect(parseGateDefinitionRules(content)).toEqual([
      {
        code: "G2",
        name: "模块交付确认",
        stageCode: "S4",
        scope: "MODULE",
        checkerBindings: [
          { code: "STAGE.AWAITING_GATE", version: 1 },
          { code: "DOCUMENTS.COMPLETE", version: 2 }
        ],
        bindingFormat: "EXPLICIT"
      }
    ]);
  });

  it("rejects invalid, duplicate, and mixed Gate checker forms", () => {
    const invalidContents = [
      {
        gates: [
          {
            code: "G1",
            name: "基线",
            stageCode: "S0",
            requiredCheckerCodes: ["DOCUMENTS.COMPLETE"]
          },
          {
            code: "G1",
            name: "重复",
            stageCode: "S1",
            requiredCheckerCodes: ["DOCUMENTS.COMPLETE"]
          }
        ]
      },
      {
        gates: [
          {
            code: "G1",
            name: "基线",
            stageCode: "S0",
            checkers: [
              { code: "DOCUMENTS.COMPLETE", version: 1 },
              { code: "DOCUMENTS.COMPLETE", version: 1 }
            ]
          }
        ]
      },
      {
        gates: [
          {
            code: "G1",
            name: "基线",
            stageCode: "S0",
            scope: "LINE",
            checkers: [{ code: "DOCUMENTS.COMPLETE", version: 1 }]
          }
        ]
      },
      {
        gates: [
          {
            code: "G1",
            name: "基线",
            stageCode: "S0",
            checkers: [{ code: "DOCUMENTS.COMPLETE", version: 0 }]
          }
        ]
      },
      {
        gates: [
          {
            code: "G1",
            name: "基线",
            stageCode: "S0",
            requiredCheckerCodes: ["DOCUMENTS.COMPLETE"],
            checkers: [{ code: "DOCUMENTS.COMPLETE", version: 1 }]
          }
        ]
      }
    ];

    for (const content of invalidContents) {
      expect(() => validateTemplateComponentContent("GATE", content)).toThrowError(
        TemplateValidationError
      );
    }
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

  it("rejects duplicate milestone codes across separate template components", () => {
    expect(() =>
      validateTemplateMilestoneCodesUnique([
        {
          componentType: "MILESTONE",
          content: { milestones: [{ code: "DESIGN.FREEZE", name: "设计冻结", position: 10 }] }
        },
        {
          componentType: "MILESTONE",
          content: { milestones: [{ code: "DESIGN.FREEZE", name: "重复设计冻结", position: 20 }] }
        }
      ])
    ).toThrow(/重复/u);
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

  it("rejects a milestone rule with a blank name", () => {
    expect(() =>
      validateTemplateComponentContent("MILESTONE", {
        milestones: [{ code: "DESIGN.FREEZE", name: "   ", position: 10 }]
      })
    ).toThrowError(TemplateValidationError);
  });

  it("rejects a milestone rule with a blank description", () => {
    expect(() =>
      validateTemplateComponentContent("MILESTONE", {
        milestones: [{ code: "DESIGN.FREEZE", name: "设计冻结", description: "   ", position: 10 }]
      })
    ).toThrowError(TemplateValidationError);
  });

  it("rejects unknown root fields in a milestone component", () => {
    expect(() =>
      validateTemplateComponentContent("MILESTONE", {
        milestones: [{ code: "DESIGN.FREEZE", name: "设计冻结", position: 10 }],
        unexpected: true
      })
    ).toThrowError(TemplateValidationError);
  });

  it("rejects unknown fields in a milestone rule", () => {
    expect(() =>
      validateTemplateComponentContent("MILESTONE", {
        milestones: [{ code: "DESIGN.FREEZE", name: "设计冻结", position: 10, unexpected: true }]
      })
    ).toThrowError(TemplateValidationError);
  });

  it("normalizes milestone text before calculating its checksum", () => {
    const content = validateTemplateComponentContent("MILESTONE", {
      milestones: [
        {
          code: " DESIGN.FREEZE ",
          name: "  设计冻结  ",
          description: " 客户验收前置 ",
          position: 10
        }
      ]
    });
    const normalizedContent = {
      milestones: [
        {
          code: "DESIGN.FREEZE",
          name: "设计冻结",
          description: "客户验收前置",
          position: 10
        }
      ]
    };

    expect(content).toEqual(normalizedContent);
    expect(
      componentChecksum({
        componentType: "MILESTONE",
        name: "里程碑",
        description: null,
        content
      })
    ).toBe(
      componentChecksum({
        componentType: "MILESTONE",
        name: "里程碑",
        description: null,
        content: normalizedContent
      })
    );
  });

  it("keeps template component declarations aligned with the enum append migration", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260803090000_apm_025_milestone_component/migration.sql"
      ),
      "utf8"
    );

    expect(Object.values(TEMPLATE_COMPONENT_TYPES)).toEqual([
      "STAGE",
      "GATE",
      "ROLE",
      "WBS",
      "CAPABILITY_RULE",
      "MILESTONE"
    ]);
    expect(schema).toContain(`enum TemplateComponentType {
  STAGE
  GATE
  ROLE
  WBS
  CAPABILITY_RULE
  MILESTONE
}`);
    expect(migration.trim()).toBe("ALTER TYPE \"TemplateComponentType\" ADD VALUE 'MILESTONE';");
    expect(migration).not.toMatch(/\b(?:BEFORE|AFTER)\b/u);
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
