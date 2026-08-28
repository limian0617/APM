import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";

import {
  createAcceptanceBatch,
  createAcceptanceTemplateVersion,
  recordAcceptanceResultRevision,
  startAcceptanceBatch
} from "./acceptance-service";
import { reviewSatOfflineDraft, submitSatOfflineDraft } from "./sat-offline-draft-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const actorId = `offline-draft-actor-${suffix}`;
const projectId = `offline-draft-project-${suffix}`;

function auditContext(operationId: string): AuditContext {
  return {
    actorId,
    projectId,
    departmentId: "quality",
    requestId: `offline-draft-${operationId}-${suffix}`,
    traceId: "0123456789abcdef0123456789abcdef",
    source: "SYSTEM",
    sourceIp: null,
    userAgent: null,
    reason: null,
    operationId
  };
}

async function createSatBatch() {
  const template = await createAcceptanceTemplateVersion({
    actorId,
    auditContext: auditContext("template"),
    template: {
      code: `SAT.OFFLINE.${randomUUID().slice(0, 8)}`,
      name: "SAT 离线草稿模板",
      acceptanceType: "SAT",
      items: [
        {
          code: "POWER",
          name: "通电检查",
          position: 1,
          method: "测量",
          acceptanceCriteria: "220V",
          unit: "V",
          required: true,
          evidenceRequired: false,
          applicableScope: "PROJECT",
          defaultDiscipline: "电气"
        }
      ]
    }
  });
  const batch = await createAcceptanceBatch({
    projectId,
    acceptanceType: "SAT",
    scopeType: "PROJECT",
    scopeId: projectId,
    templateVersionId: template.templateVersion.id,
    version: 0,
    actorId,
    auditContext: auditContext("batch")
  });
  const started = await startAcceptanceBatch({
    projectId,
    batchId: batch.batch.id,
    version: batch.resourceVersion,
    actorId,
    auditContext: auditContext("start")
  });
  return { batch: started.batch, itemId: template.templateVersion.items[0]!.id };
}

describeDatabase("APM-103 PostgreSQL SAT offline draft submissions", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: actorId,
        employeeNo: `OFFLINE-${suffix}`.toUpperCase(),
        name: "SAT 离线草稿测试人",
        departmentId: "quality"
      }
    });
    await db.project.create({
      data: {
        id: projectId,
        code: `SAT-${suffix}`.toUpperCase(),
        name: "SAT 离线草稿项目",
        createdById: actorId
      }
    });
  });

  it("stores a retry-safe pending submission without creating a formal result", async () => {
    const { batch, itemId } = await createSatBatch();
    const input = {
      clientDraftId: `draft-${randomUUID()}`,
      projectId,
      batchId: batch.id,
      itemId,
      baselineBatchVersion: batch.version,
      baselineResultRevisionId: null,
      decision: "PASS" as const,
      measuredValue: "220",
      measuredUnit: "V",
      note: "离线采集",
      capturedAt: "2026-08-10T10:00:00.000Z",
      actorId,
      auditContext: auditContext("submit")
    };
    const first = await submitSatOfflineDraft(input);
    const retry = await submitSatOfflineDraft(input);

    expect(first.status).toBe("PENDING_REVIEW");
    expect(retry.idempotent).toBe(true);
    expect(retry.submission.id).toBe(first.submission.id);
    expect(
      await db.acceptanceTestResult.count({ where: { projectId, batchId: batch.id, itemId } })
    ).toBe(0);

    const reviewed = await reviewSatOfflineDraft({
      projectId,
      submissionId: first.submission.id,
      version: first.submission.version,
      decision: "ACCEPT",
      reason: "质量复核通过",
      actorId,
      auditContext: auditContext("review")
    });
    expect(reviewed.submission.status).toBe("ACCEPTED");
    expect(reviewed.reviewedResultRevisionId).toBeTruthy();
    expect(
      await db.acceptanceTestResultRevision.count({
        where: { projectId, result: { batchId: batch.id, itemId } }
      })
    ).toBe(1);
  });

  it("preserves a server-result conflict and blocks a non-corrective accept", async () => {
    const { batch, itemId } = await createSatBatch();
    const current = await recordAcceptanceResultRevision({
      projectId,
      batchId: batch.id,
      itemId,
      version: batch.version,
      decision: "PASS",
      measuredValue: "220",
      measuredUnit: "V",
      note: "在线结果",
      evidenceFileIds: [],
      actorId,
      auditContext: auditContext("formal")
    });
    const conflict = await submitSatOfflineDraft({
      clientDraftId: `conflict-${randomUUID()}`,
      projectId,
      batchId: batch.id,
      itemId,
      baselineBatchVersion: batch.version,
      baselineResultRevisionId: null,
      decision: "FAIL",
      measuredValue: "180",
      measuredUnit: "V",
      note: "离线失败结果",
      capturedAt: "2026-08-10T10:00:00.000Z",
      actorId,
      auditContext: auditContext("conflict")
    });
    expect(conflict.status).toBe("CONFLICT");
    await expect(
      reviewSatOfflineDraft({
        projectId,
        submissionId: conflict.submission.id,
        version: conflict.submission.version,
        decision: "ACCEPT",
        reason: "不允许静默覆盖",
        actorId,
        auditContext: auditContext("bad-review")
      })
    ).rejects.toMatchObject({ code: "ACCEPTANCE_OFFLINE_DRAFT_CONFLICT", status: 409 });
    expect(current.revision.id).toBeTruthy();
  });
});
