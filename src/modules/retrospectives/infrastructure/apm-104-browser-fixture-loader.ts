import { randomUUID } from "node:crypto";

import { db } from "@/lib/db";
import { addProjectMember } from "@/lib/projects/members";
import {
  publishProjectTemplate,
  publishTemplateComponent,
  saveProjectTemplateDraft,
  saveTemplateComponentDraft
} from "@/modules/configuration/application/template-service";
import { MemoryObjectStorage } from "@/modules/documents/infrastructure/memory-object-storage";
import { requestArchiveGeneration } from "@/modules/archives/application/archive-service";
import { createPrismaArchiveGenerationHandler } from "@/modules/archives/application/archive-generation-handler";
import { createArchiveIntegrityHandler } from "@/modules/archives/application/archive-integrity-handler";
import { payloadHash } from "@/modules/governance/domain/idempotency";
import { createProjectFromTemplate } from "@/modules/projects/application/create-project";

const FIXTURE_TEMPLATE_CODE = "APM104.BROWSER.FIXTURE";
const FIXTURE_SOURCE_CODE = "APM104-FIXTURE-SOURCE";
const FIXTURE_TARGET_CODE = "APM104-FIXTURE-TARGET";
const fixtureUsers = {
  managerId: "apm104-manager",
  reviewerId: "apm104-reviewer",
  knowledgeReviewerId: "apm104-knowledge-reviewer",
  targetManagerId: "apm104-target-manager"
} as const;
const browserIdentityTokens = new Map<string, string>();

type BrowserFixtureUsers = {
  authorId: string;
  reviewerId: string;
  managerId: string;
  readerId: string;
};

export type Apm104BrowserFixture = {
  sourceProjectId: string;
  targetProjectId: string;
  archiveAId: string;
  users: BrowserFixtureUsers;
  closed: false;
  workflow: readonly [
    "CREATE_RETROSPECTIVE",
    "SUBMIT_RETROSPECTIVE",
    "REVIEW_RETROSPECTIVE",
    "GENERATE_ARCHIVE_B",
    "RUN_G9",
    "CLOSE_PROJECT",
    "PUBLISH_KNOWLEDGE",
    "CONFIRM_REUSE",
    "CORRECT_REUSE"
  ];
};

export async function buildApm104BrowserFixture(input: {
  create(): Promise<Omit<Apm104BrowserFixture, "closed" | "workflow">>;
}): Promise<Apm104BrowserFixture> {
  return {
    ...(await input.create()),
    closed: false,
    workflow: [
      "CREATE_RETROSPECTIVE",
      "SUBMIT_RETROSPECTIVE",
      "REVIEW_RETROSPECTIVE",
      "GENERATE_ARCHIVE_B",
      "RUN_G9",
      "CLOSE_PROJECT",
      "PUBLISH_KNOWLEDGE",
      "CONFIRM_REUSE",
      "CORRECT_REUSE"
    ]
  };
}

function context(actorId: string, operationId: string, projectId: string | null = null) {
  return {
    actorId,
    requestId: `apm104-browser-${operationId}`,
    traceId: `apm104-browser-${operationId}`,
    source: "API" as const,
    sourceIp: null,
    userAgent: "APM-104 browser fixture",
    reason: "APM-104 development browser fixture",
    projectId,
    departmentId: "engineering",
    operationId
  };
}

function stageDefinition() {
  return {
    stages: [
      { code: "S0", name: "启动", sequence: 0 },
      { code: "S8", name: "结项", sequence: 8 }
    ]
  };
}

function componentContent(type: "STAGE" | "GATE" | "ROLE" | "WBS") {
  switch (type) {
    case "STAGE":
      return stageDefinition();
    case "GATE":
      return {
        gates: [
          {
            code: "G9",
            name: "结项复盘 Gate",
            stageCode: "S8",
            scope: "PROJECT",
            checkers: [
              { code: "CLOSURE.ARCHIVE.G9", version: 2 },
              { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
            ]
          }
        ]
      };
    case "ROLE":
      return { roles: [{ code: "PROJECT_MANAGER", name: "项目经理", required: true }] };
    case "WBS":
      return { packages: [{ code: "S0.KICKOFF", name: "启动", stageCode: "S0", weight: 100 }] };
  }
}

async function ensureFixtureUsers() {
  await db.user.createMany({
    data: [
      {
        id: fixtureUsers.managerId,
        employeeNo: "APM104-MANAGER",
        name: "APM-104 项目经理",
        departmentId: "engineering"
      },
      {
        id: fixtureUsers.reviewerId,
        employeeNo: "APM104-REVIEWER",
        name: "APM-104 复盘审核人",
        departmentId: "engineering"
      },
      {
        id: fixtureUsers.knowledgeReviewerId,
        employeeNo: "APM104-KNOWLEDGE",
        name: "APM-104 知识审核人",
        departmentId: "engineering"
      },
      {
        id: fixtureUsers.targetManagerId,
        employeeNo: "APM104-TARGET",
        name: "APM-104 目标项目经理",
        departmentId: "engineering"
      }
    ],
    skipDuplicates: true
  });
  await db.userRole.createMany({
    data: Object.values(fixtureUsers).map((userId) => ({
      id: `apm104-browser-role-${userId}`,
      userId,
      roleId: "role-admin"
    })),
    skipDuplicates: true
  });
}

async function ensureComponent(type: "STAGE" | "GATE" | "ROLE" | "WBS") {
  const code = `${FIXTURE_TEMPLATE_CODE}.${type}`;
  const existing = await db.templateComponent.findUnique({ where: { code } });
  if (existing?.status === "ACTIVE" && existing.currentVersion > 0) {
    const published = await db.templateComponentVersion.findFirst({
      where: { componentId: existing.id, version: existing.currentVersion, status: "PUBLISHED" }
    });
    if (published) return published;
  }
  const draft = await saveTemplateComponentDraft({
    code,
    componentType: type,
    name: `APM-104 浏览器 ${type}`,
    content: componentContent(type),
    version: existing?.version ?? 0,
    reason: "建立 APM-104 浏览器受控 fixture 组件",
    actorId: fixtureUsers.managerId,
    auditContext: context(fixtureUsers.managerId, `component-${type}`)
  });
  return (
    await publishTemplateComponent({
      code,
      version: draft.component.version,
      reason: "发布 APM-104 浏览器受控 fixture 组件",
      actorId: fixtureUsers.managerId,
      auditContext: context(fixtureUsers.managerId, `component-publish-${type}`)
    })
  ).publishedVersion;
}

async function ensureFixtureTemplate() {
  const existing = await db.projectTemplate.findUnique({ where: { code: FIXTURE_TEMPLATE_CODE } });
  if (existing?.status === "ACTIVE" && existing.currentVersion > 0) {
    const published = await db.projectTemplateVersion.findFirst({
      where: { templateId: existing.id, version: existing.currentVersion, status: "PUBLISHED" }
    });
    if (published) return published;
  }
  const components = await Promise.all(
    (["STAGE", "GATE", "ROLE", "WBS"] as const).map((type) => ensureComponent(type))
  );
  const draft = await saveProjectTemplateDraft({
    code: FIXTURE_TEMPLATE_CODE,
    name: "APM-104 浏览器测试模板",
    components: components.map((component, position) => ({
      componentVersionId: component.id,
      componentType: component.componentType,
      slot: `APM104.${component.componentType}`,
      position
    })),
    version: existing?.version ?? 0,
    reason: "建立 APM-104 浏览器受控 fixture 模板",
    actorId: fixtureUsers.managerId,
    auditContext: context(fixtureUsers.managerId, "template-draft")
  });
  return (
    await publishProjectTemplate({
      code: FIXTURE_TEMPLATE_CODE,
      version: draft.template.version,
      reason: "发布 APM-104 浏览器受控 fixture 模板",
      actorId: fixtureUsers.managerId,
      auditContext: context(fixtureUsers.managerId, "template-publish")
    })
  ).publishedVersion;
}

async function ensureFixtureProject(input: {
  code: string;
  name: string;
  actorId: string;
  template: { version: number; checksum: string };
}) {
  const existing = await db.project.findUnique({ where: { code: input.code } });
  if (existing) return existing;
  return (
    await createProjectFromTemplate({
      code: input.code,
      name: input.name,
      departmentId: "engineering",
      templateCode: FIXTURE_TEMPLATE_CODE,
      templateVersion: input.template.version,
      templateChecksum: input.template.checksum,
      reason: "创建 APM-104 浏览器受控 fixture 项目",
      actorId: input.actorId,
      auditContext: context(input.actorId, `project-${input.code}`)
    })
  ).project;
}

async function ensureMembership(
  projectId: string,
  userId: string,
  role: "QUALITY" | "DEPARTMENT_LEAD"
) {
  const existing = await db.projectMember.findFirst({ where: { projectId, userId, leftAt: null } });
  if (existing) return;
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { version: true }
  });
  await addProjectMember({
    projectId,
    actorId: fixtureUsers.managerId,
    member: {
      userId,
      projectRole: role,
      departmentId: "engineering",
      projectVersion: project.version
    },
    auditContext: context(fixtureUsers.managerId, `member-${projectId}-${userId}`, projectId)
  });
}

function workerJob(id: string, projectId: string, payload: Record<string, string>) {
  return {
    id,
    jobType: "archive.generate",
    payload: payloadHash(payload).value,
    payloadHash: payloadHash(payload).hash,
    idempotencyKey: id,
    traceId: id,
    attemptId: `${id}-attempt`,
    attemptNumber: 1,
    maxAttempts: 1,
    isReplay: false,
    workerId: "apm104-browser-fixture"
  } as const;
}

async function ensureArchiveA(projectId: string) {
  const ready = await db.projectArchiveVersion.findFirst({
    where: {
      projectId,
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE",
      status: "READY"
    },
    include: { integrityChecks: { orderBy: { sequence: "desc" }, take: 1 } },
    orderBy: { version: "desc" }
  });
  if (ready?.integrityChecks[0]?.status === "PASSED") return ready;
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { version: true }
  });
  await requestArchiveGeneration({
    projectId,
    version: project.version,
    actorId: fixtureUsers.managerId,
    auditContext: context(fixtureUsers.managerId, `archive-request-${projectId}`, projectId)
  });
  const generationId = `apm104-browser-archive-${projectId}`;
  await createPrismaArchiveGenerationHandler()(
    workerJob(generationId, projectId, {
      projectId,
      requestedById: fixtureUsers.managerId,
      archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2"
    })
  );
  const created = await db.projectArchiveVersion.findUniqueOrThrow({
    where: { generationJobId: generationId }
  });
  await createArchiveIntegrityHandler({ storage: new MemoryObjectStorage() })(
    workerJob(`${generationId}-integrity`, projectId, { projectId, archiveVersionId: created.id })
  );
  return db.projectArchiveVersion.findUniqueOrThrow({
    where: { id: created.id },
    include: { integrityChecks: { orderBy: { sequence: "desc" }, take: 1 } }
  });
}

export function issueApm104BrowserIdentityToken(userId: string): string {
  const token = randomUUID();
  browserIdentityTokens.set(token, userId);
  return token;
}

export function consumeApm104BrowserIdentityToken(token: string): string | null {
  const userId = browserIdentityTokens.get(token) ?? null;
  browserIdentityTokens.delete(token);
  return userId;
}

/** Development/test-only provisioning; it only creates its deterministic APM104 fixture records. */
export async function provisionApm104BrowserFixture(): Promise<Apm104BrowserFixture> {
  await ensureFixtureUsers();
  const template = await ensureFixtureTemplate();
  const source = await ensureFixtureProject({
    code: FIXTURE_SOURCE_CODE,
    name: "APM-104 复盘源项目",
    actorId: fixtureUsers.managerId,
    template
  });
  await ensureMembership(source.id, fixtureUsers.reviewerId, "QUALITY");
  await ensureMembership(source.id, fixtureUsers.knowledgeReviewerId, "DEPARTMENT_LEAD");
  const target = await ensureFixtureProject({
    code: FIXTURE_TARGET_CODE,
    name: "APM-104 知识复用目标项目",
    actorId: fixtureUsers.targetManagerId,
    template
  });
  const archiveA = await ensureArchiveA(source.id);
  if (archiveA.status !== "READY" || archiveA.integrityChecks[0]?.status !== "PASSED") {
    throw new Error("APM-104 浏览器 fixture 的 Archive A 完整性检查未通过。");
  }
  return buildApm104BrowserFixture({
    async create() {
      return {
        sourceProjectId: source.id,
        targetProjectId: target.id,
        archiveAId: archiveA.id,
        users: {
          authorId: fixtureUsers.managerId,
          reviewerId: fixtureUsers.reviewerId,
          managerId: fixtureUsers.managerId,
          readerId: fixtureUsers.knowledgeReviewerId
        }
      };
    }
  });
}
