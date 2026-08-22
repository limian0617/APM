import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { payloadHash } from "@/modules/governance/domain/idempotency";
import { assertWritableAsset } from "../application/asset-release-service";

type ImpactDomain = {
  assertAssetUpgradeCandidate?: (input: {
    technicalAssetId: string;
    source: {
      releaseId: string;
      releaseVersionId: string;
      revision: number;
      snapshotChecksum: string;
      sourceWatermark: string;
      status: "PUBLISHED" | "SUPERSEDED" | "DRAFT";
    };
    target: {
      releaseId: string;
      releaseVersionId: string;
      revision: number;
      snapshotChecksum: string;
      sourceWatermark: string;
      status: "PUBLISHED" | "SUPERSEDED" | "DRAFT";
    };
  }) => string;
  buildAssetReleaseRecallTargetKey?: (input: {
    scope: "RELEASE" | "RELEASE_VERSION";
    releaseId: string;
    releaseVersionId?: string | null;
  }) => string;
  assertAssetReleaseRecallRevision?: (input: {
    currentState: "ACTIVE" | "WITHDRAWN" | null;
    currentRevision: number;
    nextRevision: number;
    kind: "ISSUED" | "CORRECTED" | "WITHDRAWN" | "REISSUED";
    affectedVersionSetChecksum: string;
    expectedAffectedVersionSetChecksum?: string | null;
  }) => "ACTIVE" | "WITHDRAWN";
  assertAssetReleaseRecallRevisionSource?: (input: {
    sourceAssetReleaseId: string;
    sourceAssetReleaseVersionId: string;
    technicalAssetId: string;
    anchor: {
      releaseId: string;
      assetReleaseVersionId: string;
      technicalAssetId: string;
    };
  }) => void;
  buildAssetImpactAssessmentSource?: (input: {
    recallId: string;
    recallRevisionId: string;
    recallRevisionNumber: number;
    recallRevisionSnapshotChecksum: string;
    recallRevisionKind: "ISSUED" | "CORRECTED" | "WITHDRAWN" | "REISSUED";
    recallRevisionState: "ACTIVE" | "WITHDRAWN";
    projectFactsWatermark: string;
  }) => { sourceWatermark: string };
  buildAssetDeactivationImpactAssessmentSource?: (input: {
    technicalAssetId: string;
    technicalAssetEventId: string;
    eventSequence: number;
    eventSnapshot: unknown;
    projectFactsWatermark: string;
  }) => { sourceWatermark: string };
  assertAssetImpactSource?: (input: {
    sourceType: "RECALL" | "ASSET_DEACTIVATION";
    recallId?: string | null;
    technicalAssetEventId?: string | null;
  }) => string;
  nextAssetImpactStatus?: (
    status:
      | "OPEN"
      | "ACKNOWLEDGED"
      | "ASSESSING"
      | "UPGRADE_PLANNED"
      | "RISK_ACCEPTANCE_PENDING"
      | "MITIGATED"
      | "ACCEPTED_RISK"
      | "CLOSED",
    action:
      | "ACKNOWLEDGE"
      | "ASSESS"
      | "PLAN_UPGRADE"
      | "REQUEST_RISK_ACCEPTANCE"
      | "MITIGATE"
      | "APPROVE_RISK_ACCEPTANCE"
      | "REJECT_RISK_ACCEPTANCE"
      | "CLOSE"
      | "REFRESH"
  ) => string;
  buildAssetImpactProjectionAttemptKey?: (input: {
    impactId: string;
    assessmentRevisionId: string;
    assessmentSequence: number;
    snapshotChecksum: string;
    sourceWatermark: string;
    desiredState: "ACTIVE" | "RESOLVED";
    sourceJobId: string;
    sourceEventType: string;
    ruleId?: string | null;
    ruleVersion?: number | null;
  }) => string;
  buildAssetReleaseRecallAffectedVersionSet?: (input: {
    scope: "RELEASE" | "RELEASE_VERSION";
    releaseId: string;
    targetReleaseVersionId?: string | null;
    versions: readonly {
      assetReleaseVersionId: string;
      releaseId: string;
      technicalAssetId: string;
      revision: number;
      snapshotChecksum: string;
      sourceWatermark: string;
      status: "PUBLISHED" | "SUPERSEDED";
    }[];
  }) => {
    affectedVersionSetChecksum: string;
    affectedVersions: readonly unknown[];
  };
};

async function loadImpactDomain(): Promise<ImpactDomain> {
  try {
    return (await import("./asset-upgrade-impact")) as ImpactDomain;
  } catch {
    return {};
  }
}

describe("APM-064 asset upgrade and impact domain", () => {
  it("blocks new release facts for disabled assets without changing existing R&D terminal rules", () => {
    expect(() =>
      assertWritableAsset({ status: "DISABLED", rndProject: { status: "IN_DEVELOPMENT" } })
    ).toThrowError(expect.objectContaining({ code: "ASSET_RELEASE_NOT_WRITABLE" }));
    expect(() =>
      assertWritableAsset({ status: "VALIDATED", rndProject: { status: "COMPLETED" } })
    ).toThrowError(expect.objectContaining({ code: "ASSET_RELEASE_NOT_WRITABLE" }));
    expect(() =>
      assertWritableAsset({ status: "VALIDATED", rndProject: { status: "IN_DEVELOPMENT" } })
    ).not.toThrow();
  });

  it("freezes one recall root target and one immutable affected-version set across revisions", async () => {
    const domain = await loadImpactDomain();

    expect(typeof domain.buildAssetReleaseRecallTargetKey).toBe("function");
    expect(
      domain.buildAssetReleaseRecallTargetKey?.({ scope: "RELEASE", releaseId: "release-1" })
    ).toBe("RELEASE:release-1");
    expect(
      domain.buildAssetReleaseRecallTargetKey?.({
        scope: "RELEASE_VERSION",
        releaseId: "release-1",
        releaseVersionId: "version-1"
      })
    ).toBe("RELEASE_VERSION:version-1");
    expect(
      domain.assertAssetReleaseRecallRevision?.({
        currentState: null,
        currentRevision: 0,
        nextRevision: 1,
        kind: "ISSUED",
        affectedVersionSetChecksum: "a".repeat(64)
      })
    ).toBe("ACTIVE");
    expect(() =>
      domain.assertAssetReleaseRecallRevisionSource?.({
        sourceAssetReleaseId: "release-2",
        sourceAssetReleaseVersionId: "version-1",
        technicalAssetId: "asset-1",
        anchor: {
          releaseId: "release-1",
          assetReleaseVersionId: "version-1",
          technicalAssetId: "asset-1"
        }
      })
    ).toThrowError(expect.objectContaining({ code: "RECALL_REVISION_SOURCE_MISMATCH" }));
    expect(() =>
      domain.assertAssetReleaseRecallRevision?.({
        currentState: "ACTIVE",
        currentRevision: 1,
        nextRevision: 2,
        kind: "CORRECTED",
        affectedVersionSetChecksum: "b".repeat(64),
        expectedAffectedVersionSetChecksum: "a".repeat(64)
      })
    ).toThrow("affected-version set");
    expect(() =>
      domain.assertAssetReleaseRecallRevision?.({
        currentState: "ACTIVE",
        currentRevision: 1,
        nextRevision: 2,
        kind: "REISSUED",
        affectedVersionSetChecksum: "a".repeat(64),
        expectedAffectedVersionSetChecksum: "a".repeat(64)
      })
    ).toThrowError(expect.objectContaining({ code: "RECALL_REVISION_INVALID" }));
    expect(() =>
      domain.assertAssetReleaseRecallRevision?.({
        currentState: "WITHDRAWN",
        currentRevision: 2,
        nextRevision: 3,
        kind: "CORRECTED",
        affectedVersionSetChecksum: "a".repeat(64),
        expectedAffectedVersionSetChecksum: "a".repeat(64)
      })
    ).toThrowError(expect.objectContaining({ code: "RECALL_REVISION_INVALID" }));
    expect(
      domain.assertAssetReleaseRecallRevision?.({
        currentState: "WITHDRAWN",
        currentRevision: 2,
        nextRevision: 3,
        kind: "REISSUED",
        affectedVersionSetChecksum: "a".repeat(64),
        expectedAffectedVersionSetChecksum: "a".repeat(64)
      })
    ).toBe("ACTIVE");
  });

  it("canonicalizes each exact affected version without dynamically including future release versions", async () => {
    const domain = await loadImpactDomain();
    const first = {
      assetReleaseVersionId: "version-1",
      releaseId: "release-1",
      technicalAssetId: "asset-1",
      revision: 1,
      snapshotChecksum: "a".repeat(64),
      sourceWatermark: "watermark-1",
      status: "SUPERSEDED" as const
    };
    const second = {
      assetReleaseVersionId: "version-2",
      releaseId: "release-1",
      technicalAssetId: "asset-1",
      revision: 2,
      snapshotChecksum: "b".repeat(64),
      sourceWatermark: "watermark-2",
      status: "PUBLISHED" as const
    };

    expect(typeof domain.buildAssetReleaseRecallAffectedVersionSet).toBe("function");
    const ordered = domain.buildAssetReleaseRecallAffectedVersionSet?.({
      scope: "RELEASE",
      releaseId: "release-1",
      versions: [first, second]
    });
    const reversed = domain.buildAssetReleaseRecallAffectedVersionSet?.({
      scope: "RELEASE",
      releaseId: "release-1",
      versions: [
        {
          status: second.status,
          sourceWatermark: second.sourceWatermark,
          snapshotChecksum: second.snapshotChecksum,
          revision: second.revision,
          technicalAssetId: second.technicalAssetId,
          releaseId: second.releaseId,
          assetReleaseVersionId: second.assetReleaseVersionId
        },
        {
          status: first.status,
          sourceWatermark: first.sourceWatermark,
          snapshotChecksum: first.snapshotChecksum,
          revision: first.revision,
          technicalAssetId: first.technicalAssetId,
          releaseId: first.releaseId,
          assetReleaseVersionId: first.assetReleaseVersionId
        }
      ]
    });
    expect(ordered?.affectedVersions).toHaveLength(2);
    expect(reversed?.affectedVersionSetChecksum).toBe(ordered?.affectedVersionSetChecksum);
    expect(ordered?.affectedVersionSetChecksum).toBe(
      payloadHash({ affectedVersions: [first, second] }).hash
    );
    expect(() =>
      domain.buildAssetReleaseRecallAffectedVersionSet?.({
        scope: "RELEASE_VERSION",
        releaseId: "release-1",
        targetReleaseVersionId: "version-1",
        versions: [first, second]
      })
    ).toThrowError(expect.objectContaining({ code: "RECALL_TARGET_INVALID" }));
  });

  it("derives distinct assessment watermarks for exact recall revisions sharing one release anchor", async () => {
    const domain = await loadImpactDomain();
    const common = {
      recallId: "recall-1",
      recallRevisionSnapshotChecksum: "a".repeat(64),
      recallRevisionState: "ACTIVE" as const,
      projectFactsWatermark: "project-facts-1"
    };
    const issued = domain.buildAssetImpactAssessmentSource?.({
      ...common,
      recallRevisionId: "revision-1",
      recallRevisionNumber: 1,
      recallRevisionKind: "ISSUED"
    });
    const corrected = domain.buildAssetImpactAssessmentSource?.({
      ...common,
      recallRevisionId: "revision-2",
      recallRevisionNumber: 2,
      recallRevisionKind: "CORRECTED",
      recallRevisionSnapshotChecksum: "b".repeat(64)
    });
    expect(issued?.sourceWatermark).toMatch(/^[0-9a-f]{64}$/u);
    expect(corrected?.sourceWatermark).toMatch(/^[0-9a-f]{64}$/u);
    expect(corrected?.sourceWatermark).not.toBe(issued?.sourceWatermark);
    const event = {
      technicalAssetId: "asset-1",
      technicalAssetEventId: "event-1",
      eventSequence: 2,
      eventSnapshot: { technicalAssetId: "asset-1", status: "DISABLED", version: 2 }
    };
    const firstProjectFacts = domain.buildAssetDeactivationImpactAssessmentSource?.({
      ...event,
      projectFactsWatermark: "project-facts-1"
    });
    const secondProjectFacts = domain.buildAssetDeactivationImpactAssessmentSource?.({
      ...event,
      projectFactsWatermark: "project-facts-2"
    });
    expect(firstProjectFacts?.sourceWatermark).toMatch(/^[0-9a-f]{64}$/u);
    expect(secondProjectFacts?.sourceWatermark).not.toBe(firstProjectFacts?.sourceWatermark);
  });

  it("keeps impact causes exclusive and permits every approved disposition exit", async () => {
    const domain = await loadImpactDomain();

    expect(domain.assertAssetImpactSource?.({ sourceType: "RECALL", recallId: "recall-1" })).toBe(
      "RECALL:recall-1"
    );
    expect(() =>
      domain.assertAssetImpactSource?.({
        sourceType: "RECALL",
        recallId: "recall-1",
        technicalAssetEventId: "event-1"
      })
    ).toThrowError(expect.objectContaining({ code: "IMPACT_SOURCE_INVALID" }));
    expect(domain.nextAssetImpactStatus?.("UPGRADE_PLANNED", "MITIGATE")).toBe("MITIGATED");
    expect(domain.nextAssetImpactStatus?.("UPGRADE_PLANNED", "REQUEST_RISK_ACCEPTANCE")).toBe(
      "RISK_ACCEPTANCE_PENDING"
    );
    expect(
      domain.nextAssetImpactStatus?.("RISK_ACCEPTANCE_PENDING", "APPROVE_RISK_ACCEPTANCE")
    ).toBe("ACCEPTED_RISK");
  });

  it("requires a global immutable exact published upgrade candidate before any project adoption", async () => {
    const domain = await loadImpactDomain();
    const source = {
      releaseId: "release-old",
      releaseVersionId: "version-old",
      revision: 3,
      snapshotChecksum: "a".repeat(64),
      sourceWatermark: "source-watermark",
      status: "SUPERSEDED" as const
    };
    const target = {
      releaseId: "release-new",
      releaseVersionId: "version-new",
      revision: 4,
      snapshotChecksum: "b".repeat(64),
      sourceWatermark: "target-watermark",
      status: "PUBLISHED" as const
    };

    expect(typeof domain.assertAssetUpgradeCandidate).toBe("function");
    expect(
      domain.assertAssetUpgradeCandidate?.({
        technicalAssetId: "asset-1",
        source,
        target
      })
    ).toBe("asset-1:version-old:version-new");
    expect(() =>
      domain.assertAssetUpgradeCandidate?.({
        technicalAssetId: "asset-1",
        source,
        target: { ...target, status: "SUPERSEDED" }
      })
    ).toThrowError(expect.objectContaining({ code: "UPGRADE_CANDIDATE_INVALID" }));
  });

  it("uses a deterministic projection-attempt key rather than a second alert aggregate", async () => {
    const domain = await loadImpactDomain();
    const facts = {
      impactId: "impact-1",
      assessmentRevisionId: "assessment-2",
      assessmentSequence: 2,
      snapshotChecksum: "a".repeat(64),
      sourceWatermark: "b".repeat(64),
      desiredState: "ACTIVE" as const,
      sourceJobId: "persistent-job-1",
      sourceEventType: "asset.impact.assessed",
      ruleId: "rule-3",
      ruleVersion: 4
    };
    const first = domain.buildAssetImpactProjectionAttemptKey?.(facts);

    expect(first).toBe(domain.buildAssetImpactProjectionAttemptKey?.(facts));
    expect(first).toMatch(/^asset-impact-projection:[0-9a-f]{64}$/u);
    expect(first?.length).toBeLessThanOrEqual(191);
    expect(
      domain.buildAssetImpactProjectionAttemptKey?.({
        ...facts,
        sourceWatermark: "c".repeat(64)
      })
    ).toBe(first);
    expect(
      domain.buildAssetImpactProjectionAttemptKey?.({
        ...facts,
        sourceJobId: "persistent-job-2"
      })
    ).not.toBe(first);
    expect(
      domain.buildAssetImpactProjectionAttemptKey?.({
        ...facts,
        sourceEventType: "asset.impact.disposition-recorded"
      })
    ).not.toBe(first);
    expect(
      domain.buildAssetImpactProjectionAttemptKey?.({
        ...facts,
        ruleId: "rule-4"
      })
    ).not.toBe(first);
    expect(
      domain.buildAssetImpactProjectionAttemptKey?.({
        ...facts,
        ruleVersion: facts.ruleVersion + 1
      })
    ).not.toBe(first);
  });
});

describe("APM-064 persistence migration contract", () => {
  const migrationPath = resolve(
    process.cwd(),
    "prisma/migrations/20260821020000_apm_064_asset_upgrade_impact/migration.sql"
  );
  const schemaPath = resolve(process.cwd(), "prisma/schema.prisma");
  const adoptionServicePath = resolve(
    process.cwd(),
    "src/modules/assets/application/asset-upgrade-adoption-service.ts"
  );

  it("ships the transactional 55-to-56 migration before enabling its schema contract", () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it("keeps the 55-to-56 upgrade atomic without rewriting APM-063 active-reference cardinality", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql).toContain("USING ERRCODE = '23514'");
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(sql).not.toContain("project_asset_references_project_asset_active_key");
    expect(sql).not.toContain('LOCK TABLE "project_asset_references" IN ACCESS EXCLUSIVE MODE');
  });

  it("models the immutable recall, impact, adoption, and projection facts with real database constraints", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const schema = readFileSync(schemaPath, "utf8");

    expect(schema).toContain("model AssetReleaseRecall {");
    expect(schema).toContain("@@unique([technicalAssetId, targetKey])");
    expect(schema).not.toMatch(/@@unique\(\[technicalAssetId, targetKey\]\)[^\n]*ACTIVE/u);
    expect(schema).toContain("model AssetImpactAlertProjectionAttempt {");
    const projectionAttemptModel = schema
      .split("model AssetImpactAlertProjectionAttempt {")[1]
      ?.split("\n}")[0];
    expect(projectionAttemptModel).toBeDefined();
    expect(projectionAttemptModel).not.toContain("ProjectAlert");
    expect(projectionAttemptModel).toContain("sourceJobId");
    expect(projectionAttemptModel).toContain("sourceEventType");
    expect(schema).toContain("ASSET_IMPACT");
    expect(schema).toContain("ASSET_RELEASE_RECALL_READ");
    expect(schema).toContain("ASSET_PROJECT_IMPACT_READ");
    expect(schema).toContain("ASSET_UPGRADE_CANDIDATE_READ");
    expect(sql).toContain(
      `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_RELEASE_RECALL_READ'`
    );
    expect(sql).toContain(
      `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_PROJECT_IMPACT_READ'`
    );
    expect(sql).toContain(
      `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_UPGRADE_CANDIDATE_READ'`
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "asset_release_recalls_technical_asset_id_target_key_key"\n  ON "asset_release_recalls"("technical_asset_id", "target_key");'
    );
    expect(sql).not.toMatch(
      /asset_release_recalls[\s\S]{0,240}WHERE\s+"current_state"\s*=\s*'ACTIVE'/u
    );
    expect(sql).toContain('CONSTRAINT "asset_project_impacts_cause_check" CHECK');
    expect(sql).toContain("\"source_type\" = 'RECALL'");
    expect(sql).toContain("\"source_type\" = 'ASSET_DEACTIVATION'");
    expect(sql).toContain('FOREIGN KEY ("recall_id", "technical_asset_id")');
    expect(sql).toContain('FOREIGN KEY ("technical_asset_event_id", "technical_asset_id")');
    expect(sql).toContain("ON DELETE RESTRICT");
    expect(sql).toContain("CURRENT_TIMESTAMP");
    expect(sql).toContain("CREATE FUNCTION reject_apm_064_append_only()");
    expect(sql).toContain('BEFORE TRUNCATE ON "asset_impact_alert_projection_attempts"');
    expect(sql).toContain('"idempotency_key" TEXT NOT NULL');
    expect(sql).toContain('"source_job_id" TEXT NOT NULL');
    expect(sql).toContain('"source_event_type" TEXT NOT NULL');
    expect(sql).toContain('"asset_impact_alert_projection_attempts_idempotency_key"');
    expect(sql).toContain('"source_asset_release_id" TEXT NOT NULL');
    expect(sql).toContain('"source_asset_release_version_id" TEXT NOT NULL');
    expect(sql).toContain(
      'FOREIGN KEY ("source_asset_release_version_id", "source_asset_release_id", "technical_asset_id")'
    );
    expect(sql).toContain('"recall_revision_id" TEXT');
    expect(sql).toContain('"affected_version_count" INTEGER NOT NULL');
    expect(sql).toContain('"evidence_json" JSONB NOT NULL');
    expect(sql).toContain('"snapshot_json" JSONB NOT NULL');
    expect(sql).toContain('"snapshot_checksum" TEXT NOT NULL');
    expect(sql).toContain(
      "first recall revision must ISSUE a complete frozen affected-version set"
    );
    expect(sql).toContain("recall revision requires the previous exact current revision");
    expect(sql).toContain("recall current pointer must advance by exactly one revision");
    expect(sql).toContain("recall revision must become the exact current pointer before commit");
    expect(sql).toContain('AND version_row."published_at" <= root_row."created_at"');
    expect(sql).toContain("CREATE FUNCTION validate_asset_release_recall_insert()");
    expect(sql).toContain("only a withdrawn recall may be reissued");
    expect(sql).toContain("active recall may only be CORRECTED or WITHDRAWN");
  });

  it("keeps candidates global and immutable while adoption and mapping freeze project facts", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const schema = readFileSync(schemaPath, "utf8");
    const candidateModel = schema.split("model AssetUpgradeCandidate {")[1]?.split("\n}")[0];
    const adoptionModel = schema.split("model AssetUpgradeAdoption {")[1]?.split("\n}")[0];
    const mappingModel = schema.split("model AssetUpgradeUsageMapping {")[1]?.split("\n}")[0];

    expect(candidateModel).toContain("sourceAssetReleaseId");
    expect(candidateModel).toContain("sourceAssetReleaseVersionId");
    expect(candidateModel).toContain("targetAssetReleaseId");
    expect(candidateModel).toContain("targetAssetReleaseVersionId");
    expect(candidateModel).toContain("compatibilitySnapshotChecksum");
    expect(candidateModel).not.toContain("projectId");
    expect(candidateModel).not.toContain("impactId");
    expect(candidateModel).not.toContain("sourceReferenceId");
    expect(candidateModel).not.toContain("status");
    expect(adoptionModel).toContain("impactId");
    expect(adoptionModel).toContain("sourceReferenceVersion");
    expect(adoptionModel).toContain("targetReferenceVersion");
    expect(mappingModel).toContain("sourceUsageVersion");
    expect(mappingModel).toContain("migrationMode");
    expect(mappingModel).toContain("mappingSnapshotChecksum");
    expect(sql).toContain('"source_asset_release_version_id" TEXT NOT NULL');
    expect(sql).toContain('"target_asset_release_version_id" TEXT NOT NULL');
    expect(sql).toContain('"asset_upgrade_candidates_technical_asset_source_target_key"');
    expect(sql).toContain("CREATE TRIGGER asset_upgrade_candidates_reject_mutation");
    expect(sql).toContain("v_rnd_status IN ('COMPLETED', 'CANCELED')");
    expect(sql).toContain("CREATE FUNCTION validate_asset_upgrade_adoption_insert()");
    expect(sql).toContain(
      "upgrade adoption must bind exact candidate, impact, and source/target reference facts"
    );
    expect(sql).not.toContain("v_active_reference_count");
    expect(sql).toContain("upgrade adoption target release version is actively recalled");
    expect(sql).toContain("v_rnd_status IN ('COMPLETED', 'CANCELED')");
    expect(sql).toContain(
      "jsonb_typeof(NEW.\"mapping_snapshot_json\"->'source') IS DISTINCT FROM 'object'"
    );
    expect(sql).toContain(
      "NEW.\"mapping_snapshot_json\"->'source'->'configuration' IS DISTINCT FROM source_usage.\"configuration_json\""
    );
    expect(sql).toContain(
      "NEW.\"mapping_snapshot_json\"->'target'->'configuration' IS DISTINCT FROM target_usage.\"configuration_json\""
    );
    expect(sql).toContain("CREATE FUNCTION assert_asset_upgrade_adoption_complete()");
    expect(sql).toContain(
      "upgrade adoption requires complete source usage mapping and atomic source retirement"
    );
    expect(sql).toContain('ORDER BY "id" FOR UPDATE');
    expect(sql).toContain('"project_asset_usages_exact_upgrade_mapping_key"');
    const adoption = sql.slice(
      sql.indexOf("CREATE FUNCTION validate_asset_upgrade_adoption_insert()"),
      sql.indexOf("CREATE FUNCTION validate_asset_upgrade_usage_mapping_insert()")
    );
    const locks = [
      'FROM "projects" WHERE "id" = NEW."project_id" FOR UPDATE',
      'FROM "project_asset_references"',
      'FROM "project_asset_usages"',
      'FROM "technical_assets" WHERE "id" = NEW."technical_asset_id" FOR UPDATE',
      'FROM "asset_releases"',
      'FROM "asset_release_versions"',
      'FROM "asset_release_recalls" recall',
      'FROM "asset_upgrade_candidates"',
      'FROM "asset_project_impacts"'
    ].map((needle) => adoption.indexOf(needle));
    expect(locks.every((position) => position >= 0)).toBe(true);
    expect(locks).toEqual([...locks].sort((left, right) => left - right));
  });

  it("keeps application and database adoption writes on the same project-first lock order", () => {
    const serviceSource = readFileSync(adoptionServicePath, "utf8");
    const service = serviceSource.slice(
      serviceSource.indexOf("export async function adoptProjectAssetUpgrade("),
      serviceSource.indexOf("export async function adoptProjectAssetUpgrade(") + 20000
    );
    const sql = readFileSync(migrationPath, "utf8");
    const trigger = sql.slice(
      sql.indexOf("CREATE FUNCTION validate_asset_upgrade_adoption_insert()"),
      sql.indexOf("CREATE FUNCTION validate_asset_upgrade_usage_mapping_insert()")
    );
    const serviceLocks = [
      'FROM "projects" WHERE "id" = ${input.projectId} FOR UPDATE',
      'FROM "project_asset_references" WHERE "id" = ${sourceReferenceIdentity.id}',
      'FROM "project_asset_usages" WHERE "project_id" = ${input.projectId}',
      'FROM "rnd_projects" WHERE "id" = ${assetIdentity.rndProjectId} FOR UPDATE',
      'FROM "technical_assets" WHERE "id" = ${candidateIdentity.technicalAssetId} FOR UPDATE',
      'FROM "asset_releases" WHERE "technical_asset_id" = ${candidateIdentity.technicalAssetId}',
      'FROM "asset_release_versions" WHERE "technical_asset_id" = ${candidateIdentity.technicalAssetId}',
      "await lockImpactSource(client, impactIdentity)",
      'FROM "asset_release_recalls" recall',
      'FROM "asset_upgrade_candidates" WHERE "id" = ${candidateIdentity.id}',
      'FROM "asset_project_impacts" WHERE "id" = ${impactIdentity.id}'
    ].map((marker) => service.indexOf(marker));
    const triggerLocks = [
      'FROM "projects" WHERE "id" = NEW."project_id" FOR UPDATE',
      'FROM "project_asset_references"',
      'FROM "project_asset_usages"',
      'FROM "rnd_projects" WHERE "id" = v_rnd_project_id FOR UPDATE',
      'FROM "technical_assets" WHERE "id" = NEW."technical_asset_id" FOR UPDATE',
      'FROM "asset_releases"',
      'FROM "asset_release_versions"',
      'FROM "asset_release_recalls" recall',
      'FROM "asset_upgrade_candidates"',
      'FROM "asset_project_impacts"'
    ].map((marker) => trigger.indexOf(marker));

    for (const positions of [serviceLocks, triggerLocks]) {
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
    }
  });

  it("replaces the existing technical-asset trigger function so VALIDATED can only become DISABLED", () => {
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toContain("CREATE OR REPLACE FUNCTION validate_technical_asset_mutation()");
    expect(sql).toContain(
      "OLD.\"status\"::text = 'VALIDATED' AND NEW.\"status\"::text = 'DISABLED'"
    );
    expect(sql).not.toContain(
      "OLD.\"status\"::text = 'VALIDATED' AND NEW.\"status\"::text = 'CANCELED'"
    );
  });

  it("serializes direct project-asset writes against source availability and protects impact/risk aggregates", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const schema = readFileSync(schemaPath, "utf8");

    expect(sql).toContain("CREATE FUNCTION validate_project_asset_write_availability()");
    expect(sql).toContain("CREATE FUNCTION validate_asset_release_insert_availability()");
    expect(sql).toContain("technical asset or R&D project is unavailable for a new release fact");
    expect(sql).toContain(
      'CREATE TRIGGER asset_release_versions_insert_availability BEFORE INSERT ON "asset_release_versions"'
    );
    expect(sql).toContain('FROM "projects" WHERE "id" = v_project_id FOR UPDATE');
    expect(sql).toContain("project is unavailable for new project asset facts");
    expect(sql).toContain("project asset reference is not an exact active source fact");
    expect(sql).toContain("project asset usage is not an exact active source fact");
    expect(sql).toContain("project asset reference must freeze exact ReleaseVersion facts");
    expect(sql).toContain('FROM "rnd_projects" WHERE "id" = v_rnd_project_id FOR UPDATE');
    expect(sql).toContain("v_asset_status IN ('DISABLED', 'CANCELED')");
    expect(sql).toContain("exact release version is subject to an active recall");
    expect(sql).toContain(
      'CREATE TRIGGER project_asset_references_write_availability BEFORE INSERT ON "project_asset_references" FOR EACH ROW EXECUTE FUNCTION validate_project_asset_write_availability()'
    );
    expect(sql).toContain(
      'CREATE TRIGGER project_asset_usages_write_availability BEFORE INSERT ON "project_asset_usages" FOR EACH ROW EXECUTE FUNCTION validate_project_asset_write_availability()'
    );
    expect(sql).toContain(
      'CREATE TRIGGER project_asset_derivations_write_availability BEFORE INSERT ON "project_asset_derivations" FOR EACH ROW EXECUTE FUNCTION validate_project_asset_write_availability()'
    );
    const availability = sql.slice(
      sql.indexOf("CREATE FUNCTION validate_project_asset_write_availability()"),
      sql.indexOf("CREATE TRIGGER asset_release_recalls_validate_insert")
    );
    expect(
      availability.indexOf('FROM "projects" WHERE "id" = v_project_id FOR UPDATE')
    ).toBeLessThan(
      availability.indexOf('FROM "technical_assets" WHERE "id" = v_technical_asset_id FOR UPDATE')
    );
    expect(sql).not.toContain("reject_recalled_project_asset_write");
    expect(sql).not.toContain("reject_recalled_project_asset_derivation_write");
    expect(sql).toContain("CREATE FUNCTION validate_asset_impact_disposition_insert()");
    expect(sql).toContain("impact disposition must follow the frozen state machine");
    expect(sql).toContain(
      "impact disposition actor membership must be active and belong to the actor"
    );
    expect(sql).toContain("NEW.\"created_at\" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')");
    expect(sql).toContain(
      'CREATE TRIGGER asset_impact_dispositions_validate_insert BEFORE INSERT ON "asset_impact_dispositions" FOR EACH ROW EXECUTE FUNCTION validate_asset_impact_disposition_insert()'
    );
    expect(sql).toContain("CREATE FUNCTION validate_asset_impact_risk_decision_insert()");
    expect(sql).toContain("risk acceptance approver must be independent");
    expect(sql).toContain(
      'SELECT "owner_id" INTO v_technical_asset_owner_id FROM "technical_assets"'
    );
    expect(sql).toContain("risk acceptance request update must bind its exact decision fact");
    expect(sql).toContain("risk acceptance disposition requires its exact applied decision fact");
    expect(sql).toContain("CREATE FUNCTION assert_asset_impact_risk_request_applied()");
    expect(sql).toContain(
      "risk acceptance request requires its exact pending disposition and impact before commit"
    );
    expect(sql).toContain(
      'CREATE CONSTRAINT TRIGGER asset_impact_risk_requests_require_applied AFTER INSERT ON "asset_impact_risk_acceptance_requests" DEFERRABLE INITIALLY DEFERRED'
    );
    expect(sql).toContain("CREATE FUNCTION assert_asset_impact_risk_decision_applied()");
    expect(sql).toContain(
      "risk acceptance decision requires its exact request update, disposition, and impact before commit"
    );
    expect(sql).toContain(
      'CREATE CONSTRAINT TRIGGER asset_impact_risk_decisions_require_applied AFTER INSERT ON "asset_impact_risk_acceptance_decisions" DEFERRABLE INITIALLY DEFERRED'
    );
    expect(sql).toContain(
      'CREATE TRIGGER asset_impact_risk_decisions_validate_insert BEFORE INSERT ON "asset_impact_risk_acceptance_decisions" FOR EACH ROW EXECUTE FUNCTION validate_asset_impact_risk_decision_insert()'
    );
    expect(sql).toContain('"source_key" = \'ASSET_IMPACT:\' || "impact_id"');
    expect(sql).toContain('"assessment_snapshot_checksum" TEXT NOT NULL');
    expect(sql).toContain('"assessment_source_watermark" TEXT NOT NULL');
    expect(sql).toContain("asset_impact_assessment_revisions_projection_exact_key");
    expect(sql).toContain(
      "validate_asset_impact_alert_projection_attempt_insert() RETURNS trigger"
    );
    expect(sql).not.toContain(
      `ALTER TYPE "ProjectAlertEventType" ADD VALUE IF NOT EXISTS 'UPDATED'`
    );
    expect(sql).not.toContain(`ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ALERT_UPDATED'`);
    expect(sql).toContain(
      '(("rule_id" IS NULL AND "rule_version" IS NULL) OR ("rule_id" IS NOT NULL AND "rule_version" > 0))'
    );
    expect(sql).toContain(
      "(\"result\" IN ('DELIVERED', 'FAILED_TRANSIENT') AND \"rule_id\" IS NOT NULL)"
    );
    expect(sql).toContain("CREATE FUNCTION validate_asset_impact_assessment_revision_insert()");
    expect(sql).toContain("impact assessment refresh requires the previous exact current revision");
    expect(schema).toContain("actorMembershipSnapshotJson Json?");
    expect(schema).toContain("ownerMembershipSnapshotJson Json?");
    expect(schema).toContain("dueAt           DateTime?");
    expect(sql).toContain(
      "impact assessment actor must freeze an active membership belonging to the actor"
    );
    expect(sql).toContain(
      "impact assessment owner must freeze an active project-manager membership and future due date"
    );
    expect(sql).toContain("NEW.\"frozen_at\" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')");
    expect(sql).toContain("DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')");
    expect(sql).toContain(
      "impact disposition owner must freeze an active project-manager membership"
    );
    expect(sql).toContain(
      "asset project impact update requires its exact latest assessment and disposition facts"
    );
    expect(sql).toContain("impact assessment must become the exact current pointer before commit");
  });
});
