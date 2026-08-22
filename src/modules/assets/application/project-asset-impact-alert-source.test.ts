import { describe, expect, it, vi } from "vitest";

import { readAssetImpactAlertSource } from "./project-asset-impact-alert-source";

function client(input?: {
  status?: string;
  eventRevisionMatches?: boolean;
  historicalOnly?: unknown;
  manualAssignmentRequired?: unknown;
}) {
  const calls: string[] = [];
  const project = { id: "project-1", status: "EXECUTING" };
  const impact = {
    id: "impact-1",
    projectId: "project-1",
    technicalAssetId: "asset-1",
    sourceType: "RECALL",
    sourceKey: "RECALL:recall-1",
    status: input?.status ?? "OPEN",
    version: 3,
    ownerMembershipId: "membership-owner",
    dueAt: new Date("2026-09-01T00:00:00.000Z"),
    currentAssessmentRevisionId: "assessment-2"
  };
  const assessment = {
    id: "assessment-2",
    impactId: "impact-1",
    projectId: "project-1",
    technicalAssetId: "asset-1",
    sequence: 2,
    snapshotChecksum: "a".repeat(64),
    sourceWatermark: "b".repeat(64),
    frozenAt: new Date("2026-08-21T00:00:00.000Z"),
    ownerMembershipId: "membership-owner",
    dueAt: new Date("2026-09-01T00:00:00.000Z"),
    snapshotJson: {
      historicalOnly:
        input && Object.prototype.hasOwnProperty.call(input, "historicalOnly")
          ? input.historicalOnly
          : false,
      manualAssignmentRequired:
        input && Object.prototype.hasOwnProperty.call(input, "manualAssignmentRequired")
          ? input.manualAssignmentRequired
          : false,
      restrictedFileFacts: ["must-not-cross-the-port"]
    }
  };
  const transaction = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "projects"')) {
        calls.push("project-lock");
        return [project];
      }
      calls.push("impact-lock");
      return [{ id: impact.id }];
    }),
    assetProjectImpact: {
      findFirst: vi.fn(async () => {
        calls.push("impact-read");
        return impact;
      })
    },
    assetImpactAssessmentRevision: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        calls.push(`assessment-read:${where.id}`);
        if (where.id === assessment.id) return assessment;
        return input?.eventRevisionMatches === false
          ? null
          : { ...assessment, id: where.id, sequence: 1 };
      })
    }
  };
  return { transaction, calls };
}

describe("APM-064 AST asset-impact alert source port", () => {
  it("locks the project first and returns only current authoritative non-sensitive facts", async () => {
    const fake = client();
    const source = await readAssetImpactAlertSource(fake.transaction as never, {
      projectId: "project-1",
      impactId: "impact-1",
      eventAssessmentRevisionId: "assessment-1"
    });

    expect(fake.calls[0]).toBe("project-lock");
    expect(source).toEqual({
      projectId: "project-1",
      projectStatus: "EXECUTING",
      impactId: "impact-1",
      impactVersion: 3,
      technicalAssetId: "asset-1",
      impactSourceType: "RECALL",
      impactSourceKey: "RECALL:recall-1",
      impactStatus: "OPEN",
      assessmentRevisionId: "assessment-2",
      assessmentSequence: 2,
      snapshotChecksum: "a".repeat(64),
      sourceWatermark: "b".repeat(64),
      frozenAt: new Date("2026-08-21T00:00:00.000Z"),
      ownerMembershipId: "membership-owner",
      dueAt: new Date("2026-09-01T00:00:00.000Z"),
      historicalOnly: false,
      manualAssignmentRequired: false,
      alertSourceKey: "ASSET_IMPACT:impact-1",
      desiredState: "ACTIVE"
    });
    expect(source).not.toHaveProperty("snapshotJson");
    expect(source).not.toHaveProperty("restrictedFileFacts");
  });

  it.each(["MITIGATED", "ACCEPTED_RISK", "CLOSED"])(
    "maps %s to the resolved alert projection",
    async (status) => {
      const fake = client({ status });
      await expect(
        readAssetImpactAlertSource(fake.transaction as never, {
          projectId: "project-1",
          impactId: "impact-1",
          eventAssessmentRevisionId: null
        })
      ).resolves.toMatchObject({ desiredState: "RESOLVED", impactStatus: status });
    }
  );

  it("rejects an event assessment revision from another impact", async () => {
    const fake = client({ eventRevisionMatches: false });
    await expect(
      readAssetImpactAlertSource(fake.transaction as never, {
        projectId: "project-1",
        impactId: "impact-1",
        eventAssessmentRevisionId: "foreign-assessment"
      })
    ).rejects.toMatchObject({ code: "ASSET_IMPACT_EVENT_RELATION_INVALID", status: 409 });
  });

  it.each([{ historicalOnly: "false" }, { manualAssignmentRequired: 0 }, { historicalOnly: null }])(
    "default-denies malformed operational snapshot booleans %#",
    async (input) => {
      const fake = client(input);
      await expect(
        readAssetImpactAlertSource(fake.transaction as never, {
          projectId: "project-1",
          impactId: "impact-1",
          eventAssessmentRevisionId: null
        })
      ).rejects.toMatchObject({ code: "ASSET_IMPACT_SOURCE_SNAPSHOT_INVALID", status: 409 });
    }
  );
});
