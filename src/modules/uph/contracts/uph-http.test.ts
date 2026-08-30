import { describe, expect, it } from "vitest";

import {
  uphDefinitionBodySchema,
  uphPatchDefinitionBodySchema,
  uphDraftCorrectionBodySchema,
  uphSelectionQuerySchemaByKind
} from "./uph-http";

describe("APM-080 HTTP contracts", () => {
  it("accepts only strict definition DTO fields", () => {
    expect(
      uphDefinitionBodySchema.parse({
        kind: "FORMULA",
        content: { formulaCode: "CANONICAL_UPH_V1", formulaJson: {} },
        projectVersion: 3
      })
    ).toEqual({
      kind: "FORMULA",
      content: { formulaCode: "CANONICAL_UPH_V1", formulaJson: {} },
      projectVersion: 3
    });
    expect(() =>
      uphDefinitionBodySchema.parse({
        kind: "FORMULA",
        content: {},
        projectVersion: 3,
        ownerMembershipId: "client-controlled"
      })
    ).toThrow();
  });

  it("selects a strict query schema by kind: CT current queries are module-scoped", () => {
    expect(
      uphSelectionQuerySchemaByKind.CT.parse({
        selection: "currentWork",
        projectModuleId: "module-1"
      })
    ).toEqual({
      selection: "currentWork",
      projectModuleId: "module-1"
    });
    expect(
      uphSelectionQuerySchemaByKind.CT.parse({
        selection: "currentPublished",
        projectModuleId: "module-1"
      })
    ).toEqual({
      selection: "currentPublished",
      projectModuleId: "module-1"
    });
    expect(() => uphSelectionQuerySchemaByKind.CT.parse({ selection: "currentWork" })).toThrow();
    expect(
      uphSelectionQuerySchemaByKind.CT.parse({ selection: "exact", versionId: "version-1" })
    ).toEqual({ selection: "exact", versionId: "version-1" });
    expect(() =>
      uphSelectionQuerySchemaByKind.CT.parse({
        selection: "currentWork",
        versionId: "ignored",
        projectModuleId: "module-1"
      })
    ).toThrow();
    expect(() =>
      uphSelectionQuerySchemaByKind.CT.parse({
        selection: "exact",
        versionId: "version-1",
        projectModuleId: "module-1"
      })
    ).toThrow();
  });

  it.each(["TOPOLOGY", "FORMULA"] as const)(
    "%s current queries remain valid without CT module scope and exact rejects it",
    (kind) => {
      expect(uphSelectionQuerySchemaByKind[kind].parse({ selection: "currentWork" })).toEqual({
        selection: "currentWork"
      });
      expect(uphSelectionQuerySchemaByKind[kind].parse({ selection: "currentPublished" })).toEqual({
        selection: "currentPublished"
      });
      expect(
        uphSelectionQuerySchemaByKind[kind].parse({ selection: "exact", versionId: "version-1" })
      ).toEqual({ selection: "exact", versionId: "version-1" });
      expect(() =>
        uphSelectionQuerySchemaByKind[kind].parse({
          selection: "currentWork",
          projectModuleId: "module-1"
        })
      ).toThrow();
      expect(() =>
        uphSelectionQuerySchemaByKind[kind].parse({
          selection: "exact",
          versionId: "version-1",
          projectModuleId: "module-1"
        })
      ).toThrow();
    }
  );

  it("requires neutral correction reason and a non-empty explanation", () => {
    expect(
      uphDraftCorrectionBodySchema.parse({
        reason: "会签后发现漏项",
        reasonCode: "DRAFT_CORRECTION"
      })
    ).toEqual({
      reason: "会签后发现漏项",
      reasonCode: "DRAFT_CORRECTION"
    });
    expect(() =>
      uphDraftCorrectionBodySchema.parse({
        reason: "质量拒绝",
        reasonCode: "QUALITY_PUBLICATION_REFUSAL"
      })
    ).toThrow();
  });

  it("rejects client watermarks, parallel-group extensions, and arbitrary formula codes", () => {
    expect(() =>
      uphDefinitionBodySchema.parse({
        kind: "TOPOLOGY",
        projectVersion: 1,
        content: {
          projectShape: "LINE",
          sourceWatermark: "client-controlled",
          roots: []
        }
      })
    ).toThrow();
    expect(() =>
      uphDefinitionBodySchema.parse({
        kind: "TOPOLOGY",
        projectVersion: 1,
        content: {
          projectShape: "LINE",
          roots: [
            {
              sourceId: "line-1",
              sourceType: "LINE",
              parentSourceId: null,
              relation: "ROOT",
              parallelGroups: [[]]
            }
          ]
        }
      })
    ).toThrow();
    expect(() =>
      uphDefinitionBodySchema.parse({
        kind: "FORMULA",
        projectVersion: 1,
        content: { formulaCode: "module-capacity-v1", formulaJson: {} }
      })
    ).toThrow();
  });

  it("requires exact version identity for PATCH DTOs", () => {
    expect(() =>
      uphPatchDefinitionBodySchema.parse({
        kind: "FORMULA",
        projectVersion: 2,
        content: { formulaCode: "CANONICAL_UPH_V1", formulaJson: {} }
      })
    ).toThrow();
    expect(
      uphPatchDefinitionBodySchema.parse({
        kind: "FORMULA",
        projectVersion: 2,
        versionId: "version-1",
        resourceVersion: 3,
        content: { formulaCode: "CANONICAL_UPH_V1", formulaJson: {} }
      })
    ).toMatchObject({ versionId: "version-1", resourceVersion: 3 });
  });
});
