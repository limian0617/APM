import { createHash, randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";

import {
  createAcceptanceBatch,
  createAcceptanceTemplateVersion,
  lockAcceptanceBatch,
  recordAcceptanceResultRevision,
  startAcceptanceBatch
} from "./acceptance-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const actorId = `acceptance-actor-${suffix}`;
const projectId = `acceptance-project-${suffix}`;

function auditContext(operationId: string): AuditContext {
  return {
    actorId,
    requestId: `acceptance-request-${operationId}`,
    traceId: createHash("sha256").update(operationId).digest("hex").slice(0, 32),
    source: "API",
    sourceIp: "127.0.0.1",
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId: "quality",
    operationId
  };
}

async function publishTemplate(acceptanceType: "FAT" | "SAT" = "FAT") {
  return createAcceptanceTemplateVersion({
    template: {
      code: `ACCEPTANCE.${acceptanceType}.${randomUUID().slice(0, 8)}`,
      name: `${acceptanceType} 基础模板`,
      acceptanceType,
      items: [
        {
          code: "POWER",
          name: "上电",
          position: 1,
          method: "观察",
          acceptanceCriteria: "正常",
          unit: "V",
          required: true,
          evidenceRequired: false,
          applicableScope: "PROJECT",
          defaultDiscipline: "电气"
        }
      ]
    },
    actorId,
    projectId,
    auditContext: auditContext(`template-${randomUUID()}`)
  });
}

describeDatabase("APM-100 acceptance application commands", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: actorId,
        employeeNo: `ACCEPTANCE-${suffix}`.toUpperCase(),
        name: "验收集成测试人",
        departmentId: "quality"
      }
    });
    await db.project.create({
      data: {
        id: projectId,
        code: `ACCEPTANCE-${suffix}`.toUpperCase(),
        name: "验收集成测试项目",
        departmentId: "quality",
        createdById: actorId
      }
    });
  });

  it("creates immutable template and batch facts with audit and Outbox in one workflow", async () => {
    const template = await publishTemplate();
    const batch = await createAcceptanceBatch({
      projectId,
      acceptanceType: "FAT",
      scopeType: "PROJECT",
      scopeId: projectId,
      templateVersionId: template.templateVersion.id,
      version: 0,
      actorId,
      auditContext: auditContext(`batch-${randomUUID()}`)
    });

    expect(template.templateVersion.items).toHaveLength(1);
    expect(batch.batch).toMatchObject({ projectId, status: "DRAFT", version: 1 });
    await expect(
      db.auditLog.count({
        where: {
          objectId: { in: [template.templateVersion.id, batch.batch.id] },
          action: { in: ["ACCEPTANCE_TEMPLATE_PUBLISHED", "ACCEPTANCE_BATCH_CREATED"] }
        }
      })
    ).resolves.toBe(2);
    await expect(
      db.outboxEvent.count({
        where: {
          aggregateId: { in: [template.templateVersion.id, batch.batch.id] },
          eventType: { in: ["acceptance.template-version.published", "acceptance.batch.created"] }
        }
      })
    ).resolves.toBe(2);
  });

  it("uses optimistic versions, preserves result revisions, and rejects writes after locking", async () => {
    const template = await publishTemplate();
    const item = template.templateVersion.items[0];
    if (!item) throw new Error("expected frozen acceptance test item");
    const batch = await createAcceptanceBatch({
      projectId,
      acceptanceType: "FAT",
      scopeType: "PROJECT",
      scopeId: projectId,
      templateVersionId: template.templateVersion.id,
      version: 0,
      actorId,
      auditContext: auditContext(`batch-lock-${randomUUID()}`)
    });
    await expect(
      startAcceptanceBatch({
        projectId,
        batchId: batch.batch.id,
        version: 99,
        actorId,
        auditContext: auditContext(`stale-${randomUUID()}`)
      })
    ).rejects.toMatchObject({ code: "ACCEPTANCE_VERSION_CONFLICT", status: 409 });

    const started = await startAcceptanceBatch({
      projectId,
      batchId: batch.batch.id,
      version: batch.resourceVersion,
      actorId,
      auditContext: auditContext(`start-${randomUUID()}`)
    });
    const recorded = await recordAcceptanceResultRevision({
      projectId,
      batchId: batch.batch.id,
      itemId: item.id,
      version: started.resourceVersion,
      decision: "PASS",
      measuredValue: "230V",
      measuredUnit: "V",
      actorId,
      auditContext: auditContext(`result-${randomUUID()}`)
    });
    const corrected = await recordAcceptanceResultRevision({
      projectId,
      batchId: batch.batch.id,
      itemId: item.id,
      version: recorded.resourceVersion,
      decision: "PASS",
      measuredValue: "230.1V",
      measuredUnit: "V",
      correctionReason: "复测仪表读数",
      actorId,
      auditContext: auditContext(`correction-${randomUUID()}`)
    });
    const locked = await lockAcceptanceBatch({
      projectId,
      batchId: batch.batch.id,
      version: corrected.resourceVersion,
      actorId,
      auditContext: auditContext(`lock-${randomUUID()}`)
    });

    expect(corrected.revision).toMatchObject({
      revisionNo: 2,
      supersedesRevisionId: recorded.revision.id
    });
    expect(locked.batch.status).toBe("LOCKED");
    await expect(
      recordAcceptanceResultRevision({
        projectId,
        batchId: batch.batch.id,
        itemId: item.id,
        version: locked.resourceVersion,
        decision: "PASS",
        actorId,
        auditContext: auditContext(`locked-${randomUUID()}`)
      })
    ).rejects.toMatchObject({ code: "ACCEPTANCE_BATCH_LOCKED", status: 409 });
    await expect(
      db.acceptanceTestResultRevision.count({ where: { resultId: recorded.result.id } })
    ).resolves.toBe(2);
  });

  it("serializes concurrent template publication without exposing a unique-constraint failure", async () => {
    const code = `ACCEPTANCE.FAT.CONCURRENT.${randomUUID().slice(0, 8)}`;
    const command = () =>
      createAcceptanceTemplateVersion({
        template: {
          code,
          name: "并发 FAT 模板",
          acceptanceType: "FAT",
          items: [
            {
              code: "POWER",
              name: "上电",
              position: 1,
              method: "观察",
              acceptanceCriteria: "正常",
              unit: "V",
              required: true,
              evidenceRequired: false,
              applicableScope: "PROJECT",
              defaultDiscipline: "电气"
            }
          ]
        },
        actorId,
        auditContext: auditContext(`concurrent-template-${randomUUID()}`)
      });
    const settled = await Promise.allSettled([command(), command()]);
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(
      rejected.every((result) => result.reason?.code === "ACCEPTANCE_TEMPLATE_VERSION_CONFLICT")
    ).toBe(true);
    const published = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof command>>> =>
        result.status === "fulfilled"
    );
    expect(published).not.toHaveLength(0);
    const rows = await db.acceptanceTemplateVersion.findMany({
      where: { template: { code } },
      orderBy: { version: "asc" }
    });
    expect(rows.map((row) => row.version)).toEqual(rows.map((_, index) => index + 1));
  });

  it("refuses to lock a batch while its current FAIL result has no unified issue relation", async () => {
    const template = await publishTemplate();
    const item = template.templateVersion.items[0];
    if (!item) throw new Error("expected frozen acceptance test item");
    const batch = await createAcceptanceBatch({
      projectId,
      acceptanceType: "FAT",
      scopeType: "PROJECT",
      scopeId: projectId,
      templateVersionId: template.templateVersion.id,
      version: 0,
      actorId,
      auditContext: auditContext(`batch-unlinked-fail-${randomUUID()}`)
    });
    const started = await startAcceptanceBatch({
      projectId,
      batchId: batch.batch.id,
      version: batch.resourceVersion,
      actorId,
      auditContext: auditContext(`start-unlinked-fail-${randomUUID()}`)
    });
    const recorded = await recordAcceptanceResultRevision({
      projectId,
      batchId: batch.batch.id,
      itemId: item.id,
      version: started.resourceVersion,
      decision: "FAIL",
      measuredValue: "180V",
      measuredUnit: "V",
      actorId,
      auditContext: auditContext(`result-unlinked-fail-${randomUUID()}`)
    });
    await expect(
      lockAcceptanceBatch({
        projectId,
        batchId: batch.batch.id,
        version: recorded.resourceVersion,
        actorId,
        auditContext: auditContext(`lock-unlinked-fail-${randomUUID()}`)
      })
    ).rejects.toMatchObject({ code: "ACCEPTANCE_FAILURE_ISSUE_REQUIRED", status: 409 });
  });
});
