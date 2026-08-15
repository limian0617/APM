import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";

import { confirmKnowledgeReuse, correctKnowledgeReuse } from "./knowledge-reuse-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  actor: `knowledge-reuse-actor-${suffix}`,
  sourceProject: `knowledge-reuse-source-${suffix}`,
  targetProject: `knowledge-reuse-target-${suffix}`,
  membership: `knowledge-reuse-membership-${suffix}`,
  entry: `knowledge-reuse-entry-${suffix}`,
  version: `knowledge-reuse-version-${suffix}`
};
const auditContext = (operationId: string): AuditContext => ({
  actorId: ids.actor,
  source: "API" as const,
  requestId: `knowledge-reuse-${operationId}`,
  traceId: null,
  sourceIp: null,
  userAgent: "Vitest",
  reason: "APM-104 knowledge reuse integration test",
  projectId: null,
  departmentId: null,
  operationId
});

describeDatabase("APM-104 PostgreSQL knowledge reuse and correction", () => {
  beforeAll(async () => {
    await db.user.create({
      data: {
        id: ids.actor,
        employeeNo: `KNOWLEDGE-REUSE-${suffix}`.toUpperCase(),
        name: "Knowledge reuse integration actor"
      }
    });
    await db.project.createMany({
      data: [
        {
          id: ids.sourceProject,
          code: `KNOWLEDGE.REUSE.SOURCE.${suffix}`.toUpperCase(),
          name: "Knowledge reuse source project",
          status: "CLOSED",
          initializationStatus: "READY",
          projectType: "CUSTOMER_DELIVERY",
          equipmentShape: "SINGLE_MACHINE",
          structureStatus: "READY",
          createdById: ids.actor
        },
        {
          id: ids.targetProject,
          code: `KNOWLEDGE.REUSE.TARGET.${suffix}`.toUpperCase(),
          name: "Knowledge reuse target project",
          status: "IN_PROGRESS",
          initializationStatus: "READY",
          projectType: "CUSTOMER_DELIVERY",
          equipmentShape: "SINGLE_MACHINE",
          structureStatus: "READY",
          createdById: ids.actor
        }
      ]
    });
    await db.projectMember.create({
      data: {
        id: ids.membership,
        projectId: ids.targetProject,
        userId: ids.actor,
        projectRole: "PROJECT_MANAGER",
        assignedById: ids.actor
      }
    });
    await db.knowledgeEntry.create({
      data: {
        id: ids.entry,
        code: `KNOWLEDGE.REUSE.${suffix}`.toUpperCase(),
        status: "ACTIVE",
        version: 1,
        createdById: ids.actor,
        updatedById: ids.actor
      }
    });
    await db.knowledgeEntryVersion.create({
      data: {
        id: ids.version,
        entryId: ids.entry,
        sourceProjectId: ids.sourceProject,
        versionNo: 1,
        status: "PUBLISHED",
        title: "脱敏调试经验",
        sanitizedSummary: "仅包含可复用的内部调试经验。",
        experienceType: "COMMISSIONING",
        discipline: "ELECTRICAL",
        normalizedKeywordsJson: ["伺服", "调试"],
        normalizedKeywordsText: "伺服 调试",
        applicableProjectTypesJson: ["CUSTOMER_DELIVERY"],
        applicableStageCodesJson: ["S5"],
        preconditions: "已确认参数基线。",
        recommendedPractice: "逐步调整并记录结果。",
        antiPatterns: "不得复制客户原始数据。",
        limitations: "仅适用于受控调试。",
        ipSanitizationDeclaration: "已完成知识产权与脱敏检查。",
        internalReusable: true,
        contentChecksum: "a".repeat(64),
        createdById: ids.actor,
        submittedById: ids.actor,
        submittedAt: new Date(),
        publishedById: ids.actor,
        publishedAt: new Date()
      }
    });
    await db.knowledgeEntry.update({
      where: { id: ids.entry },
      data: { currentPublishedVersionId: ids.version }
    });
  });

  it("confirms a current published version then appends a correction with audit and Outbox facts", async () => {
    const confirmation = await confirmKnowledgeReuse({
      targetProjectId: ids.targetProject,
      targetDeliveryUnitId: null,
      entryCode: `KNOWLEDGE.REUSE.${suffix}`.toUpperCase(),
      version: 1,
      scenario: "在目标项目的受控调试阶段采用该经验。",
      evidenceSummary: "项目经理人工确认实际采用并记录了受控证据。",
      actorId: ids.actor,
      idempotencyKey: `knowledge-reuse-confirm-${suffix}`,
      auditContext: auditContext(`confirm-${suffix}`),
      targetProjectAccess: true
    });
    expect(confirmation).toMatchObject({
      targetProjectId: ids.targetProject,
      knowledgeEntryId: ids.entry,
      knowledgeVersionId: ids.version,
      idempotent: false
    });

    const correction = await correctKnowledgeReuse({
      targetProjectId: ids.targetProject,
      reuseRecordId: confirmation.id,
      expectedReuseVersion: confirmation.version,
      correctionType: "TEXT_CORRECTION",
      reason: "补充采用范围的脱敏说明。",
      correctionText: "仅适用于空载调试阶段。",
      actorId: ids.actor,
      idempotencyKey: `knowledge-reuse-correct-${suffix}`,
      auditContext: auditContext(`correct-${suffix}`),
      targetProjectAccess: true
    });
    expect(correction).toMatchObject({
      reuseRecordId: confirmation.id,
      correctionType: "TEXT_CORRECTION"
    });

    await expect(
      db.knowledgeReuseRecord.findUniqueOrThrow({ where: { id: confirmation.id } })
    ).resolves.toMatchObject({
      targetProjectId: ids.targetProject,
      knowledgeEntryId: ids.entry,
      knowledgeVersionId: ids.version,
      version: 1
    });
    await expect(
      db.knowledgeReuseCorrection.findFirstOrThrow({
        where: {
          id: correction.id,
          targetProjectId: ids.targetProject,
          reuseRecordId: confirmation.id
        }
      })
    ).resolves.toMatchObject({ correctionType: "TEXT_CORRECTION" });
    await expect(
      db.auditLog.count({
        where: {
          projectId: ids.targetProject,
          action: { in: ["KNOWLEDGE_REUSE_CONFIRMED", "KNOWLEDGE_REUSE_CORRECTED"] }
        }
      })
    ).resolves.toBe(2);
    await expect(
      db.outboxEvent.count({
        where: {
          aggregateId: confirmation.id,
          eventType: { in: ["knowledge.reuse.confirmed", "knowledge.reuse.corrected"] }
        }
      })
    ).resolves.toBe(2);
  });

  it("rejects adoption when the exact current published pointer is missing or the entry is revoked", async () => {
    await db.knowledgeEntry.update({
      where: { id: ids.entry },
      data: { currentPublishedVersionId: null }
    });

    await expect(
      confirmKnowledgeReuse({
        targetProjectId: ids.targetProject,
        targetDeliveryUnitId: null,
        entryCode: `KNOWLEDGE.REUSE.${suffix}`.toUpperCase(),
        version: 1,
        scenario: "不得采用不再是当前指针的知识。",
        evidenceSummary: "此请求必须被拒绝。",
        actorId: ids.actor,
        idempotencyKey: `knowledge-reuse-non-current-${suffix}`,
        auditContext: auditContext(`non-current-${suffix}`),
        targetProjectAccess: true
      })
    ).rejects.toMatchObject({ code: "KNOWLEDGE_REUSE_VERSION_NOT_ADOPTABLE", status: 409 });

    await db.knowledgeEntry.update({
      where: { id: ids.entry },
      data: { status: "REVOKED", currentPublishedVersionId: null }
    });

    await expect(
      confirmKnowledgeReuse({
        targetProjectId: ids.targetProject,
        targetDeliveryUnitId: null,
        entryCode: `KNOWLEDGE.REUSE.${suffix}`.toUpperCase(),
        version: 1,
        scenario: "不得采用已撤销知识。",
        evidenceSummary: "此请求必须被拒绝。",
        actorId: ids.actor,
        idempotencyKey: `knowledge-reuse-revoked-${suffix}`,
        auditContext: auditContext(`revoked-${suffix}`),
        targetProjectAccess: true
      })
    ).rejects.toMatchObject({ code: "KNOWLEDGE_REUSE_VERSION_NOT_ADOPTABLE", status: 409 });
  });
});
