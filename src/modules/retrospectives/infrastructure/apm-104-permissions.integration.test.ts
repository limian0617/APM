import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { decideAuthorization } from "@/lib/auth/authorize";
import { loadAuthorizationActor } from "@/lib/auth/repository";
import { PERMISSIONS, PROJECT_ROLES } from "@/lib/auth/permissions";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const createdUserIds = [
  `apm104-permission-manager-${suffix}`,
  `apm104-permission-quality-${suffix}`,
  `apm104-permission-department-lead-${suffix}`,
  `apm104-permission-knowledge-reviewer-${suffix}`,
  `apm104-permission-ordinary-${suffix}`
];

const expectedRolePermissions = [
  ["role-project-manager", "permission-project-retrospective-read", "PROJECT"],
  ["role-department-lead", "permission-project-retrospective-read", "DEPARTMENT"],
  ["role-quality", "permission-project-retrospective-read", "PROJECT"],
  ["role-admin", "permission-project-retrospective-read", "ALL"],
  ["role-project-manager", "permission-project-retrospective-manage", "PROJECT"],
  ["role-department-lead", "permission-project-retrospective-manage", "DEPARTMENT"],
  ["role-admin", "permission-project-retrospective-manage", "ALL"],
  ["role-department-lead", "permission-project-retrospective-review", "DEPARTMENT"],
  ["role-quality", "permission-project-retrospective-review", "PROJECT"],
  ["role-admin", "permission-project-retrospective-review", "ALL"],
  ["role-project-manager", "permission-knowledge-read", "ALL"],
  ["role-department-lead", "permission-knowledge-read", "ALL"],
  ["role-engineer", "permission-knowledge-read", "ALL"],
  ["role-procurement", "permission-knowledge-read", "ALL"],
  ["role-quality", "permission-knowledge-read", "ALL"],
  ["role-technical-asset-maintainer", "permission-knowledge-read", "ALL"],
  ["role-executive", "permission-knowledge-read", "ALL"],
  ["role-admin", "permission-knowledge-read", "ALL"],
  ["role-department-lead", "permission-knowledge-review", "ALL"],
  ["role-quality", "permission-knowledge-review", "ALL"],
  ["role-admin", "permission-knowledge-review", "ALL"],
  ["role-project-manager", "permission-knowledge-reuse-confirm", "PROJECT"],
  ["role-quality", "permission-knowledge-reuse-confirm", "PROJECT"],
  ["role-admin", "permission-knowledge-reuse-confirm", "ALL"]
] as const;

describeDatabase("APM-104 PostgreSQL runtime authorization seeds", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: createdUserIds[0],
          employeeNo: `APM104-PM-${suffix}`,
          name: "APM-104 PM",
          departmentId: "engineering"
        },
        {
          id: createdUserIds[1],
          employeeNo: `APM104-QA-${suffix}`,
          name: "APM-104 QA",
          departmentId: "engineering"
        },
        {
          id: createdUserIds[2],
          employeeNo: `APM104-DL-${suffix}`,
          name: "APM-104 Department Lead",
          departmentId: "engineering"
        },
        {
          id: createdUserIds[3],
          employeeNo: `APM104-KR-${suffix}`,
          name: "APM-104 Knowledge Reviewer",
          departmentId: "electrical"
        },
        {
          id: createdUserIds[4],
          employeeNo: `APM104-ORDINARY-${suffix}`,
          name: "APM-104 Ordinary"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        {
          id: `apm104-pm-role-${suffix}`,
          userId: createdUserIds[0],
          roleId: "role-project-manager"
        },
        { id: `apm104-qa-role-${suffix}`, userId: createdUserIds[1], roleId: "role-quality" },
        {
          id: `apm104-dl-role-${suffix}`,
          userId: createdUserIds[2],
          roleId: "role-department-lead"
        },
        {
          id: `apm104-kr-role-${suffix}`,
          userId: createdUserIds[3],
          roleId: "role-department-lead"
        }
      ]
    });
  });

  afterAll(async () => {
    await db.userRole.deleteMany({ where: { userId: { in: createdUserIds } } });
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("persists exactly the six permissions and frozen role scope matrix", async () => {
    const permissions = await db.permission.findMany({
      where: {
        code: {
          in: [
            "PROJECT_RETROSPECTIVE_READ",
            "PROJECT_RETROSPECTIVE_MANAGE",
            "PROJECT_RETROSPECTIVE_REVIEW",
            "KNOWLEDGE_READ",
            "KNOWLEDGE_REVIEW",
            "KNOWLEDGE_REUSE_CONFIRM"
          ]
        }
      },
      include: { roles: { include: { role: true } } }
    });
    expect(permissions).toHaveLength(6);
    const actual = permissions
      .flatMap((permission) =>
        permission.roles.map((rolePermission) => [
          rolePermission.roleId,
          permission.id,
          rolePermission.scope
        ])
      )
      .sort();
    expect(actual).toEqual([...expectedRolePermissions].sort());
  });

  it("loads real grants: manager manages, quality/department lead review, ordinary users are forbidden", async () => {
    const [manager, quality, departmentLead, knowledgeReviewer, ordinary] = await Promise.all(
      createdUserIds.map(loadAuthorizationActor)
    );
    expect(manager).not.toBeNull();
    expect(quality).not.toBeNull();
    expect(departmentLead).not.toBeNull();
    expect(knowledgeReviewer).not.toBeNull();
    expect(ordinary).not.toBeNull();
    expect(
      decideAuthorization(manager!, PERMISSIONS.PROJECT_RETROSPECTIVE_MANAGE, {
        projectId: "project-1",
        memberRoles: [PROJECT_ROLES.PROJECT_MANAGER]
      })
    ).toMatchObject({ allowed: true });
    expect(
      decideAuthorization(quality!, PERMISSIONS.PROJECT_RETROSPECTIVE_REVIEW, {
        projectId: "project-1",
        memberRoles: [PROJECT_ROLES.QUALITY]
      })
    ).toMatchObject({ allowed: true });
    expect(
      decideAuthorization(departmentLead!, PERMISSIONS.PROJECT_RETROSPECTIVE_REVIEW, {
        projectId: "project-1",
        resourceDepartmentId: "engineering",
        memberRoles: [PROJECT_ROLES.DEPARTMENT_LEAD]
      })
    ).toMatchObject({ allowed: true });
    expect(decideAuthorization(knowledgeReviewer!, PERMISSIONS.KNOWLEDGE_REVIEW)).toMatchObject({
      allowed: true
    });
    expect(
      decideAuthorization(knowledgeReviewer!, PERMISSIONS.PROJECT_RETROSPECTIVE_READ, {
        projectId: "source-project",
        resourceDepartmentId: "engineering",
        memberRoles: [PROJECT_ROLES.DEPARTMENT_LEAD]
      })
    ).toEqual({
      allowed: false,
      reason: "DEPARTMENT_SCOPE_MISMATCH"
    });
    expect(decideAuthorization(ordinary!, PERMISSIONS.PROJECT_RETROSPECTIVE_READ)).toEqual({
      allowed: false,
      reason: "PERMISSION_NOT_GRANTED"
    });
  });
});
