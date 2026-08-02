import { describe, expect, it } from "vitest";

import {
  componentChecksum,
  templateChecksum,
  type TemplateComponentContent,
  type TemplateComponentTypeCode
} from "@/modules/configuration/domain/template-policy";

import {
  buildProjectTemplateSnapshot,
  ProjectCreationError,
  type SourceSnapshotComponent,
  validateProjectIdentity
} from "./project-template-snapshot";

function sourceComponents(): SourceSnapshotComponent[] {
  const definitions: Array<{
    type: TemplateComponentTypeCode;
    content: TemplateComponentContent;
  }> = [
    { type: "STAGE", content: { stages: [{ code: "S0", name: "启动", sequence: 0 }] } },
    {
      type: "GATE",
      content: {
        gates: [
          {
            code: "G1",
            name: "基线",
            stageCode: "S0",
            requiredCheckerCodes: ["DOCUMENTS.COMPLETE"]
          }
        ]
      }
    },
    { type: "ROLE", content: { roles: [{ code: "PM", name: "项目经理", required: true }] } },
    {
      type: "WBS",
      content: {
        packages: [{ code: "START", name: "启动", stageCode: "S0", weight: 10 }]
      }
    }
  ];
  return definitions.map(({ type, content }, position) => {
    const componentName = `${type} component`;
    return {
      sourceComponentVersionId: `${type.toLowerCase()}-v1`,
      componentCode: `TEST.${type}`,
      componentType: type,
      componentName,
      componentVersion: 1,
      description: null,
      content,
      sourceChecksum: componentChecksum({
        componentType: type,
        name: componentName,
        description: null,
        content
      }),
      slot: `${type}.0`,
      position
    };
  });
}

function sourceInput() {
  const components = sourceComponents();
  const storedTemplateChecksum = templateChecksum({
    name: "标准模板",
    description: null,
    references: components.map((component) => ({
      componentVersionId: component.sourceComponentVersionId,
      componentType: component.componentType,
      slot: component.slot,
      position: component.position,
      checksum: component.sourceChecksum
    }))
  });
  return {
    sourceTemplateVersionId: "template-v1",
    suppliedTemplateChecksum: storedTemplateChecksum,
    storedTemplateChecksum,
    templateCode: "STANDARD.LINE",
    templateName: "标准模板",
    templateDescription: null,
    templateVersion: 1,
    templatePublishedAt: new Date("2026-08-03T00:00:00.000Z"),
    components
  };
}

describe("APM-011 project template snapshot", () => {
  it("builds a deterministic project-owned snapshot", () => {
    const input = sourceInput();
    const first = buildProjectTemplateSnapshot(input);
    const second = buildProjectTemplateSnapshot({
      ...input,
      components: [...input.components].reverse()
    });
    expect(first.snapshotChecksum).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.snapshotChecksum).toBe(first.snapshotChecksum);
    expect(first.components.map(({ slot }) => slot)).toEqual([
      "STAGE.0",
      "GATE.0",
      "ROLE.0",
      "WBS.0"
    ]);
  });

  it("rejects stale caller and tampered component checksums", () => {
    const input = sourceInput();
    expect(() =>
      buildProjectTemplateSnapshot({ ...input, suppliedTemplateChecksum: "0".repeat(64) })
    ).toThrowError(ProjectCreationError);
    expect(() =>
      buildProjectTemplateSnapshot({
        ...input,
        components: input.components.map((component, index) =>
          index === 0 ? { ...component, componentName: "tampered" } : component
        )
      })
    ).toThrow(/发布内容校验失败/u);
  });

  it("normalizes project identity without accepting unstable codes", () => {
    expect(
      validateProjectIdentity({ code: "PRJ-001", name: " 项目一 ", departmentId: "D1" })
    ).toEqual({
      code: "PRJ-001",
      name: "项目一",
      departmentId: "D1"
    });
    expect(() => validateProjectIdentity({ code: "project-1", name: "Invalid" })).toThrow(
      /大写代码/u
    );
  });
});
