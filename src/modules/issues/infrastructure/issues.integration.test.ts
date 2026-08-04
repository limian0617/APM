import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";

import {
  IssueServiceError,
  createProjectIssue,
  transitionProjectIssue,
  updateProjectIssue
} from "../application/issue-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  manager: `issue-manager-${suffix}`,
  engineer: `issue-engineer-${suffix}`
};

function auditContext(operationId: string, projectId: string): AuditContext {
  return {
    actorId: ids.manager,
    requestId: `request-${operationId}`,
    traceId: null,
    source: "API",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId: "engineering",
    operationId
  };
}

async function seedProject(label: string) {
  return db.project.create({
    data: {
      code: `APM070.${label}.${suffix}`.toUpperCase(),
      name: `APM-070 ${label}`,
      departmentId: "engineering",
      createdById: ids.manager
    }
  });
}

describeDatabase("APM-070 PostgreSQL unified issues", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.manager,
          employeeNo: `APM070-MANAGER-${suffix}`,
          name: "Issue manager",
          departmentId: "engineering"
        },
        {
          id: ids.engineer,
          employeeNo: `APM070-ENGINEER-${suffix}`,
          name: "Issue engineer",
          departmentId: "engineering"
        }
      ]
    });
  });

  it("persists one classified issue with separated phenomena and root cause, then retains lifecycle facts", async () => {
    const project = await seedProject("LIFECYCLE");
    const created = await createProjectIssue({
      projectId: project.id,
      title: "定位销干涉",
      confirmedText: "工件进入工位时定位销与夹具发生干涉，设备无法继续运行。",
      category: "FUNCTION",
      severity: "HIGH",
      phenomenonDescription: "干涉导致工位停机。",
      rootCauseCategory: "DESIGN",
      rootCauseDescription: "定位销行程未预留夹具公差。",
      tags: ["干涉", "停机", "干涉"],
      actorId: ids.manager,
      auditContext: auditContext("issue-create", project.id)
    });
    expect(created.issue).toMatchObject({
      projectId: project.id,
      category: "FUNCTION",
      severity: "HIGH",
      status: "PENDING_ACCEPTANCE"
    });
    expect(created.issue.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tag: "干涉" }),
        expect.objectContaining({ tag: "停机" })
      ])
    );

    const analyzing = await transitionProjectIssue({
      projectId: project.id,
      issueId: created.issue.id,
      version: created.issue.version,
      action: "START_ANALYSIS",
      reason: "已安排设计工程师分析。",
      verificationEvidence: null,
      actorId: ids.engineer,
      auditContext: auditContext("issue-analysis", project.id)
    });
    const processing = await transitionProjectIssue({
      projectId: project.id,
      issueId: created.issue.id,
      version: analyzing.issue.version,
      action: "START_PROCESSING",
      reason: "设计修改正在实施。",
      verificationEvidence: null,
      actorId: ids.engineer,
      auditContext: auditContext("issue-processing", project.id)
    });
    const pendingVerification = await transitionProjectIssue({
      projectId: project.id,
      issueId: created.issue.id,
      version: processing.issue.version,
      action: "SUBMIT_VERIFICATION",
      reason: "已完成定位销改造，等待现场验证。",
      verificationEvidence: null,
      actorId: ids.engineer,
      auditContext: auditContext("issue-verification", project.id)
    });
    const closed = await transitionProjectIssue({
      projectId: project.id,
      issueId: created.issue.id,
      version: pendingVerification.issue.version,
      action: "VERIFY_CLOSE",
      reason: "连续十次运行未再发生干涉。",
      verificationEvidence: "FAT-RUN-010 已确认。",
      actorId: ids.manager,
      auditContext: auditContext("issue-close", project.id)
    });
    const reopened = await transitionProjectIssue({
      projectId: project.id,
      issueId: created.issue.id,
      version: closed.issue.version,
      action: "REOPEN",
      reason: "改造后在另一夹具上再次出现干涉。",
      verificationEvidence: null,
      actorId: ids.manager,
      auditContext: auditContext("issue-reopen", project.id)
    });

    expect(reopened.issue).toMatchObject({ status: "ANALYZING", closedAt: null });
    await expect(
      db.issueHistory.findMany({
        where: { issueId: created.issue.id },
        orderBy: { sequence: "asc" }
      })
    ).resolves.toMatchObject([
      { eventType: "CREATED", sequence: 1 },
      { eventType: "STARTED_ANALYSIS", sequence: 2 },
      { eventType: "STARTED_PROCESSING", sequence: 3 },
      { eventType: "VERIFICATION_SUBMITTED", sequence: 4 },
      { eventType: "CLOSED", sequence: 5 },
      { eventType: "REOPENED", sequence: 6 }
    ]);
    await expect(
      db.$executeRaw`UPDATE "issue_histories" SET "reason" = 'forbidden' WHERE "issue_id" = ${created.issue.id}`
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`DELETE FROM "issues" WHERE "id" = ${created.issue.id}`
    ).rejects.toThrow();
  });

  it("rejects stale edits and incomplete closure evidence", async () => {
    const project = await seedProject("CONFLICT");
    const created = await createProjectIssue({
      projectId: project.id,
      title: "表面划伤",
      confirmedText: "设备出料口发现产品表面划伤。",
      category: "APPEARANCE",
      severity: "MEDIUM",
      phenomenonDescription: "产品表面有连续划痕。",
      rootCauseCategory: null,
      rootCauseDescription: null,
      tags: ["划伤"],
      actorId: ids.manager,
      auditContext: auditContext("issue-create-conflict", project.id)
    });
    const updated = await updateProjectIssue({
      projectId: project.id,
      issueId: created.issue.id,
      version: created.issue.version,
      title: "产品表面划伤",
      confirmedText: "设备出料口发现产品表面连续划伤。",
      category: "APPEARANCE",
      severity: "HIGH",
      phenomenonDescription: "产品表面有连续划痕。",
      rootCauseCategory: null,
      rootCauseDescription: null,
      tags: ["划伤", "外观"],
      reason: "现场复核后提升严重度。",
      actorId: ids.manager,
      auditContext: auditContext("issue-update", project.id)
    });
    await expect(
      updateProjectIssue({
        projectId: project.id,
        issueId: created.issue.id,
        version: created.issue.version,
        title: "过期更新",
        confirmedText: "过期更新。",
        category: "APPEARANCE",
        severity: "LOW",
        phenomenonDescription: null,
        rootCauseCategory: null,
        rootCauseDescription: null,
        tags: [],
        reason: "过期。",
        actorId: ids.manager,
        auditContext: auditContext("issue-stale", project.id)
      })
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      status: 409
    } satisfies Partial<IssueServiceError>);
    await expect(
      transitionProjectIssue({
        projectId: project.id,
        issueId: created.issue.id,
        version: updated.issue.version,
        action: "VERIFY_CLOSE",
        reason: "跳过流程关闭。",
        verificationEvidence: null,
        actorId: ids.manager,
        auditContext: auditContext("issue-bad-close", project.id)
      })
    ).rejects.toMatchObject({ code: "ISSUE_VERIFICATION_EVIDENCE_REQUIRED", status: 422 });
  });

  it.each(["CLOSED", "CANCELED"] as const)(
    "rejects edits and lifecycle transitions for a %s project",
    async (projectStatus) => {
      const project = await seedProject("READONLY");
      const created = await createProjectIssue({
        projectId: project.id,
        title: "关闭项目问题",
        confirmedText: "项目关闭前已登记的问题。",
        category: "DELIVERY_COMPLETENESS",
        severity: "LOW",
        phenomenonDescription: null,
        rootCauseCategory: null,
        rootCauseDescription: null,
        tags: [],
        actorId: ids.manager,
        auditContext: auditContext("issue-create-readonly", project.id)
      });
      await db.project.update({ where: { id: project.id }, data: { status: projectStatus } });

      await expect(
        updateProjectIssue({
          projectId: project.id,
          issueId: created.issue.id,
          version: created.issue.version,
          title: "不应更新",
          confirmedText: "关闭项目不得更新问题。",
          category: "DELIVERY_COMPLETENESS",
          severity: "LOW",
          phenomenonDescription: null,
          rootCauseCategory: null,
          rootCauseDescription: null,
          tags: [],
          reason: "不应允许。",
          actorId: ids.manager,
          auditContext: auditContext("issue-update-readonly", project.id)
        })
      ).rejects.toMatchObject({ code: "PROJECT_READ_ONLY", status: 409 });

      await expect(
        transitionProjectIssue({
          projectId: project.id,
          issueId: created.issue.id,
          version: created.issue.version,
          action: "START_ANALYSIS",
          reason: "不应允许。",
          verificationEvidence: null,
          actorId: ids.manager,
          auditContext: auditContext("issue-transition-readonly", project.id)
        })
      ).rejects.toMatchObject({ code: "PROJECT_READ_ONLY", status: 409 });
    }
  );
});
