import { randomUUID } from "node:crypto";

import { Prisma, ProjectRole } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

import { PERMISSIONS } from "@/lib/auth/permissions";
import { authorizeProjectRequest } from "@/lib/auth/project-guard";
import { loadAuthorizationActor } from "@/lib/auth/repository";
import { db } from "@/lib/db";
import { addProjectMember, endProjectMembership } from "@/lib/projects/members";
import { queryAuditLogs } from "@/modules/audit/application/query-audit";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_RESULTS,
  PROJECT_MEMBER_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";

import { writeAudit } from "./write-audit";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);

const ids = {
  admin: `audit-admin-${suffix}`,
  lead: `audit-lead-${suffix}`,
  pm: `audit-pm-${suffix}`,
  engineer: `audit-engineer-${suffix}`,
  noAudit: `audit-no-permission-${suffix}`,
  target: `audit-target-${suffix}`,
  projectA: `audit-project-a-${suffix}`,
  projectB: `audit-project-b-${suffix}`,
  memberProject: `audit-member-project-${suffix}`
};

function context(
  actorId: string,
  operationId: string,
  projectId: string | null = null,
  departmentId: string | null = null
): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: `trace-${operationId}`,
    source: "API",
    sourceIp: "127.0.0.1",
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId,
    operationId
  };
}

async function actor(userId: string) {
  const value = await loadAuthorizationActor(userId);
  if (!value) {
    throw new Error(`Missing integration actor ${userId}`);
  }
  return value;
}

async function expectAppendOnly(
  operation: (transaction: Prisma.TransactionClient) => Promise<unknown>
) {
  await expect(
    db.$transaction(async (transaction) => {
      await operation(transaction);
      throw new Error("AUDIT_MUTATION_WAS_ALLOWED");
    })
  ).rejects.toThrow(/append-only/);
}

describeDatabase("APM-003 PostgreSQL audit integration", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        { id: ids.admin, employeeNo: `ADMIN-${suffix}`, name: "审计管理员", departmentId: "hq" },
        {
          id: ids.lead,
          employeeNo: `LEAD-${suffix}`,
          name: "机械负责人",
          departmentId: "mechanical"
        },
        { id: ids.pm, employeeNo: `PM-${suffix}`, name: "项目经理", departmentId: "mechanical" },
        {
          id: ids.engineer,
          employeeNo: `ENG-${suffix}`,
          name: "工程师",
          departmentId: "electrical"
        },
        { id: ids.noAudit, employeeNo: `PROC-${suffix}`, name: "采购", departmentId: "mechanical" },
        {
          id: ids.target,
          employeeNo: `TARGET-${suffix}`,
          name: "待分配用户",
          departmentId: "quality"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `ur-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        { id: `ur-lead-${suffix}`, userId: ids.lead, roleId: "role-department-lead" },
        { id: `ur-pm-${suffix}`, userId: ids.pm, roleId: "role-project-manager" },
        { id: `ur-engineer-${suffix}`, userId: ids.engineer, roleId: "role-engineer" },
        { id: `ur-no-audit-${suffix}`, userId: ids.noAudit, roleId: "role-procurement" }
      ]
    });
    await db.project.createMany({
      data: [
        {
          id: ids.projectA,
          code: `AUDIT-A-${suffix}`,
          name: "机械项目",
          departmentId: "mechanical",
          createdById: ids.admin
        },
        {
          id: ids.projectB,
          code: `AUDIT-B-${suffix}`,
          name: "电气项目",
          departmentId: "electrical",
          createdById: ids.admin
        },
        {
          id: ids.memberProject,
          code: `AUDIT-MEMBER-${suffix}`,
          name: "成员事务项目",
          departmentId: "quality",
          createdById: ids.admin
        }
      ]
    });
    await db.projectMember.createMany({
      data: [
        {
          id: `membership-pm-a-${suffix}`,
          projectId: ids.projectA,
          userId: ids.pm,
          projectRole: ProjectRole.PROJECT_MANAGER,
          departmentId: "mechanical",
          assignedById: ids.admin
        },
        {
          id: `membership-no-audit-a-${suffix}`,
          projectId: ids.projectA,
          userId: ids.noAudit,
          projectRole: ProjectRole.PROCUREMENT,
          departmentId: "mechanical",
          assignedById: ids.admin
        },
        {
          id: `membership-pm-member-${suffix}`,
          projectId: ids.memberProject,
          userId: ids.pm,
          projectRole: ProjectRole.PROJECT_MANAGER,
          departmentId: "quality",
          assignedById: ids.admin
        }
      ]
    });
  });

  it("writes member add/end facts in their business transactions", async () => {
    const added = await addProjectMember({
      projectId: ids.memberProject,
      actorId: ids.pm,
      member: {
        userId: ids.target,
        projectRole: "QUALITY",
        departmentId: "quality",
        projectVersion: 1
      },
      auditContext: context(ids.pm, `member-add-${suffix}`, ids.memberProject, "quality")
    });

    const addedAudit = await db.auditLog.findUniqueOrThrow({ where: { id: added.auditId } });
    expect(addedAudit).toMatchObject({
      action: "PROJECT_MEMBER_ADDED",
      objectId: added.membership.id,
      projectId: ids.memberProject,
      departmentId: "quality",
      result: "SUCCESS"
    });

    const ended = await endProjectMembership({
      projectId: ids.memberProject,
      membershipId: added.membership.id,
      actorId: ids.pm,
      projectVersion: 2,
      auditContext: context(ids.pm, `member-end-${suffix}`, ids.memberProject, "quality")
    });
    const endedAudit = await db.auditLog.findUniqueOrThrow({ where: { id: ended.auditId } });
    expect(endedAudit).toMatchObject({
      action: "PROJECT_MEMBER_ENDED",
      objectId: added.membership.id,
      projectId: ids.memberProject,
      result: "SUCCESS"
    });
  });

  it("uses the unified writer for authorization denials", async () => {
    const requestId = `denial-${suffix}`;
    const result = await authorizeProjectRequest(
      new Request(`http://localhost/api/projects/${ids.projectA}/members`, {
        method: "POST",
        headers: {
          "x-apm-user-id": ids.noAudit,
          "x-request-id": requestId,
          "x-forwarded-for": "10.1.2.3"
        }
      }),
      ids.projectA,
      PERMISSIONS.PROJECT_MEMBER_MANAGE
    );

    expect(result.authorized).toBe(false);
    const denial = await db.auditLog.findFirstOrThrow({
      where: { operationId: requestId, action: "AUTHORIZATION_DENIED" }
    });
    expect(denial).toMatchObject({
      actorId: ids.noAudit,
      objectType: "PROJECT",
      objectId: ids.projectA,
      projectId: ids.projectA,
      departmentId: "mechanical",
      sourceIp: "10.1.2.3",
      reason: "PERMISSION_NOT_GRANTED",
      result: "DENIED"
    });
  });

  it("rolls back a success audit with its failed business transaction", async () => {
    const operationId = `rollback-${suffix}`;
    await expect(
      db.$transaction(async (transaction) => {
        await writeAudit(transaction, {
          action: AUDIT_ACTIONS.PROJECT_MEMBER_ADDED,
          objectType: AUDIT_OBJECT_TYPES.PROJECT_MEMBER,
          objectId: `rolled-back-member-${suffix}`,
          context: context(ids.admin, operationId, ids.projectA, "mechanical"),
          after: {
            value: { projectId: ids.projectA, userId: ids.target },
            allowedFields: PROJECT_MEMBER_AUDIT_FIELDS
          }
        });
        throw new Error("BUSINESS_WRITE_FAILED");
      })
    ).rejects.toThrow("BUSINESS_WRITE_FAILED");

    await expect(db.auditLog.count({ where: { operationId } })).resolves.toBe(0);
  });

  it("deduplicates successful facts while retaining repeated failures", async () => {
    const operationId = `duplicate-${suffix}`;
    const event = {
      action: AUDIT_ACTIONS.PROJECT_MEMBER_ADDED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_MEMBER,
      objectId: `duplicate-member-${suffix}`,
      context: context(ids.admin, operationId, ids.projectA, "mechanical")
    } as const;

    await writeAudit(db, event);
    await expect(writeAudit(db, event)).rejects.toMatchObject({ code: "P2002" });
    await writeAudit(db, { ...event, result: AUDIT_RESULTS.FAILURE });
    await writeAudit(db, { ...event, result: AUDIT_RESULTS.FAILURE });

    await expect(
      db.auditLog.count({ where: { operationId, result: AUDIT_RESULTS.FAILURE } })
    ).resolves.toBe(2);
  });

  it("rejects update, delete and truncate at the database boundary", async () => {
    const audit = await writeAudit(db, {
      action: AUDIT_ACTIONS.PROJECT_MEMBER_ADDED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_MEMBER,
      objectId: `immutable-${suffix}`,
      context: context(ids.admin, `immutable-${suffix}`, ids.projectA, "mechanical")
    });

    await expectAppendOnly((transaction) =>
      transaction.auditLog.update({ where: { id: audit.id }, data: { reason: "changed" } })
    );
    await expectAppendOnly((transaction) =>
      transaction.auditLog.delete({ where: { id: audit.id } })
    );
    await expectAppendOnly((transaction) =>
      transaction.$executeRawUnsafe('TRUNCATE TABLE "audit_logs"')
    );
  });

  it("enforces ALL, DEPARTMENT, PROJECT and SELF audit visibility", async () => {
    const facts = await Promise.all([
      writeAudit(db, {
        action: AUDIT_ACTIONS.PROJECT_MEMBER_ADDED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_MEMBER,
        objectId: `scope-mechanical-admin-${suffix}`,
        context: context(ids.admin, `scope-1-${suffix}`, ids.projectA, "mechanical")
      }),
      writeAudit(db, {
        action: AUDIT_ACTIONS.PROJECT_MEMBER_ADDED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_MEMBER,
        objectId: `scope-electrical-engineer-${suffix}`,
        context: context(ids.engineer, `scope-2-${suffix}`, ids.projectB, "electrical")
      }),
      writeAudit(db, {
        action: AUDIT_ACTIONS.PROJECT_MEMBER_ADDED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_MEMBER,
        objectId: `scope-mechanical-engineer-${suffix}`,
        context: context(ids.engineer, `scope-3-${suffix}`, ids.projectA, "mechanical")
      }),
      writeAudit(db, {
        action: AUDIT_ACTIONS.PROJECT_MEMBER_ADDED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_MEMBER,
        objectId: `scope-electrical-pm-${suffix}`,
        context: context(ids.pm, `scope-4-${suffix}`, ids.projectB, "electrical")
      })
    ]);
    const factIds = facts.map(({ id }) => id);
    const query = { action: AUDIT_ACTIONS.PROJECT_MEMBER_ADDED, limit: 100 };

    const all = await queryAuditLogs({
      actor: await actor(ids.admin),
      query,
      context: context(ids.admin, `query-all-${suffix}`)
    });
    expect(all.items.map(({ id }) => id)).toEqual(expect.arrayContaining(factIds));

    const department = await queryAuditLogs({
      actor: await actor(ids.lead),
      query,
      context: context(ids.lead, `query-department-${suffix}`)
    });
    expect(department.items.map(({ id }) => id)).toEqual(
      expect.arrayContaining([facts[0].id, facts[2].id])
    );
    expect(department.items.map(({ id }) => id)).not.toContain(facts[1].id);

    const project = await queryAuditLogs({
      actor: await actor(ids.pm),
      query,
      context: context(ids.pm, `query-project-${suffix}`)
    });
    expect(project.items.map(({ id }) => id)).toEqual(
      expect.arrayContaining([facts[0].id, facts[2].id])
    );
    expect(project.items.map(({ id }) => id)).not.toContain(facts[3].id);

    const self = await queryAuditLogs({
      actor: await actor(ids.engineer),
      query,
      context: context(ids.engineer, `query-self-${suffix}`)
    });
    expect(self.items.map(({ id }) => id)).toEqual(
      expect.arrayContaining([facts[1].id, facts[2].id])
    );
    expect(self.items.map(({ id }) => id)).not.toContain(facts[0].id);
  });

  it("denies actors without AUDIT_READ and preserves the denied attempt", async () => {
    const operationId = `query-denied-${suffix}`;
    await expect(
      queryAuditLogs({
        actor: await actor(ids.noAudit),
        query: { limit: 20 },
        context: context(ids.noAudit, operationId)
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    await expect(
      db.auditLog.findFirstOrThrow({
        where: {
          operationId,
          action: "AUTHORIZATION_DENIED",
          objectType: "AUDIT_LOG",
          result: "DENIED"
        }
      })
    ).resolves.toMatchObject({ reason: "PERMISSION_NOT_GRANTED" });
  });
});
