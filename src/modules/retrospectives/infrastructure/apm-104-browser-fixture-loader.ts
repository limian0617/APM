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
import { createProjectFromTemplate } from "@/modules/projects/application/create-project";
import { createArchiveJobHandlers } from "@/workers/archive-job-handlers";
import { runJobBatch } from "@/workers/job-runner";

const FIXTURE_TEMPLATE_CODE = "APM104.BROWSER.FIXTURE";
const FIXTURE_SOURCE_CODE = "APM104-FIXTURE-SOURCE";
const FIXTURE_TARGET_CODE = "APM104-FIXTURE-TARGET";
const fixtureUsers = {
  sourceManagerId: "apm104-source-manager",
  retrospectiveReviewerId: "apm104-retrospective-reviewer",
  knowledgeReviewerId: "apm104-knowledge-reviewer",
  targetManagerId: "apm104-target-manager"
} as const;
const browserIdentityTokens = new Map<string, string>();
const FIXTURE_WORKER_POLICY = {
  claimBatchSize: 1,
  leaseSeconds: 60,
  retryBaseSeconds: 1,
  retryMaxSeconds: 10,
  defaultMaxAttempts: 1
} as const;

type BrowserFixtureUsers = {
  sourceManagerId: string;
  retrospectiveReviewerId: string;
  knowledgeReviewerId: string;
  targetManagerId: string;
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

export function validateApm104FixtureEnvironment(input: {
  enabled: boolean;
  databaseName: string;
}): void {
  if (!input.enabled) throw new Error("APM104_BROWSER_FIXTURE_DISABLED");
  if (!/^apm104_fixture_[a-z0-9_]+$/i.test(input.databaseName)) {
    throw new Error("APM104_BROWSER_FIXTURE_DATABASE_NOT_DISPOSABLE");
  }
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
        id: fixtureUsers.sourceManagerId,
        employeeNo: "APM104-SOURCE-MANAGER",
        name: "APM-104 项目经理",
        departmentId: "engineering"
      },
      {
        id: fixtureUsers.retrospectiveReviewerId,
        employeeNo: "APM104-RETROSPECTIVE-REVIEWER",
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
  await Promise.all(
    [
      { userId: fixtureUsers.sourceManagerId, roleId: "role-project-manager" },
      { userId: fixtureUsers.retrospectiveReviewerId, roleId: "role-quality" },
      { userId: fixtureUsers.knowledgeReviewerId, roleId: "role-department-lead" },
      { userId: fixtureUsers.targetManagerId, roleId: "role-project-manager" }
    ].map(({ userId, roleId }) =>
      db.userRole.upsert({
        where: { id: `apm104-browser-role-${userId}` },
        create: { id: `apm104-browser-role-${userId}`, userId, roleId },
        update: { roleId, revokedAt: null }
      })
    )
  );
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
    actorId: fixtureUsers.sourceManagerId,
    auditContext: context(fixtureUsers.sourceManagerId, `component-${type}`)
  });
  return (
    await publishTemplateComponent({
      code,
      version: draft.component.version,
      reason: "发布 APM-104 浏览器受控 fixture 组件",
      actorId: fixtureUsers.sourceManagerId,
      auditContext: context(fixtureUsers.sourceManagerId, `component-publish-${type}`)
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
    actorId: fixtureUsers.sourceManagerId,
    auditContext: context(fixtureUsers.sourceManagerId, "template-draft")
  });
  return (
    await publishProjectTemplate({
      code: FIXTURE_TEMPLATE_CODE,
      version: draft.template.version,
      reason: "发布 APM-104 浏览器受控 fixture 模板",
      actorId: fixtureUsers.sourceManagerId,
      auditContext: context(fixtureUsers.sourceManagerId, "template-publish")
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
    actorId: fixtureUsers.sourceManagerId,
    member: {
      userId,
      projectRole: role,
      departmentId: "engineering",
      projectVersion: project.version
    },
    auditContext: context(fixtureUsers.sourceManagerId, `member-${projectId}-${userId}`, projectId)
  });
}

type FixtureArchiveEventType = "archive.generate" | "archive.integrity.check";

export async function runApm104FixtureArchiveWorkerStage(input: {
  eventType: FixtureArchiveEventType;
  projectId: string;
  storage: MemoryObjectStorage;
}): Promise<string> {
  const registeredHandlers =
    input.eventType === "archive.generate"
      ? createArchiveJobHandlers()
      : createArchiveJobHandlers({ storage: input.storage });
  const handler = registeredHandlers[input.eventType];
  if (!handler) {
    throw new Error("APM104_BROWSER_FIXTURE_ARCHIVE_WORKER_HANDLER_MISSING");
  }
  const batch = await runJobBatch({
    workerId: `apm104-browser-fixture-${input.projectId}-${input.eventType.replaceAll(".", "-")}`,
    handlers: { [input.eventType]: handler },
    policy: FIXTURE_WORKER_POLICY
  });
  const [jobId] = batch.materializedJobIds;
  const succeeded =
    batch.materializedJobIds.length === 1 &&
    batch.claimedCount === 1 &&
    batch.outcomes.length === 1 &&
    batch.outcomes[0]?.jobId === jobId &&
    batch.outcomes[0]?.status === "SUCCEEDED";
  if (!jobId || !succeeded) {
    throw new Error("APM104_BROWSER_FIXTURE_ARCHIVE_WORKER_STAGE_FAILED");
  }
  return jobId;
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
    actorId: fixtureUsers.sourceManagerId,
    auditContext: context(fixtureUsers.sourceManagerId, `archive-request-${projectId}`, projectId)
  });
  const storage = new MemoryObjectStorage();
  const generationId = await runApm104FixtureArchiveWorkerStage({
    eventType: "archive.generate",
    projectId,
    storage
  });
  const created = await db.projectArchiveVersion.findUniqueOrThrow({
    where: { generationJobId: generationId }
  });
  await runApm104FixtureArchiveWorkerStage({
    eventType: "archive.integrity.check",
    projectId,
    storage
  });
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
  const databaseResult = await db.$queryRaw<Array<{ current_database: string }>>`
    SELECT current_database()
  `;
  validateApm104FixtureEnvironment({
    enabled: process.env.APM104_BROWSER_FIXTURE_ENABLED === "true",
    databaseName: databaseResult[0]?.current_database ?? ""
  });
  await ensureFixtureUsers();
  const template = await ensureFixtureTemplate();
  const source = await ensureFixtureProject({
    code: FIXTURE_SOURCE_CODE,
    name: "APM-104 复盘源项目",
    actorId: fixtureUsers.sourceManagerId,
    template
  });
  await ensureMembership(source.id, fixtureUsers.retrospectiveReviewerId, "QUALITY");
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
          sourceManagerId: fixtureUsers.sourceManagerId,
          retrospectiveReviewerId: fixtureUsers.retrospectiveReviewerId,
          knowledgeReviewerId: fixtureUsers.knowledgeReviewerId,
          targetManagerId: fixtureUsers.targetManagerId
        }
      };
    }
  });
}
