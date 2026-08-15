import { createHash, randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import { getArchiveSourceFormulaAdapter } from "@/modules/archives/application/archive-source-formula-registry";
import { readRetrospectiveInput } from "@/modules/archives/application/retrospective-input-reader";
import {
  publishProjectTemplate,
  publishTemplateComponent,
  saveProjectTemplateDraft,
  saveTemplateComponentDraft
} from "@/modules/configuration/application/template-service";
import {
  decideGateSubmission,
  submitGateSubmission
} from "@/modules/governance/application/gate-submission-service";
import { runGateChecks } from "@/modules/governance/application/gate-service";
import { createProjectFromTemplate } from "@/modules/projects/application/create-project";
import {
  createRetrospectiveVersion,
  reviewRetrospectiveVersion,
  submitRetrospectiveVersion
} from "@/modules/retrospectives/application/project-retrospective-service";

import { closeProject } from "./project-close-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `close-admin-${suffix}`,
  manager: `close-manager-${suffix}`,
  reviewer: `close-reviewer-${suffix}`
};

function auditContext(
  actorId: string,
  operationId: string,
  projectId: string | null = null
): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: createHash("sha256")
      .update(`integration-request-trace:${suffix}:${actorId}:${projectId ?? "global"}`)
      .digest("hex")
      .slice(0, 32),
    source: "API",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId: "engineering",
    operationId
  };
}

function componentContent(type: "STAGE" | "GATE" | "ROLE" | "WBS") {
  switch (type) {
    case "STAGE":
      return { stages: [{ code: "S8", name: "项目结项", sequence: 8 }] };
    case "GATE":
      return {
        gates: [
          {
            code: "G9",
            name: "项目结项 Gate",
            stageCode: "S8",
            scope: "PROJECT",
            checkers: [
              { code: "CLOSURE.ARCHIVE.G9", version: 2 },
              { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
            ],
            approval: { mode: "ALL", projectRoles: ["QUALITY"] }
          }
        ]
      };
    case "ROLE":
      return { roles: [{ code: "PROJECT_MANAGER", name: "项目经理", required: true }] };
    case "WBS":
      return {
        packages: [{ code: "S8.CLOSURE", name: "项目结项", stageCode: "S8", weight: 1 }]
      };
  }
}

async function seedClosureTemplate() {
  const components = await Promise.all(
    (["STAGE", "GATE", "ROLE", "WBS"] as const).map(async (componentType) => {
      const code = `APM104.CLOSE.${componentType}.${suffix}`.toUpperCase();
      const draft = await saveTemplateComponentDraft({
        code,
        componentType,
        name: `${componentType} project close integration`,
        content: componentContent(componentType),
        version: 0,
        reason: "创建项目结项集成测试组件",
        actorId: ids.admin,
        auditContext: auditContext(ids.admin, `component-draft-${componentType}`)
      });
      return (
        await publishTemplateComponent({
          code,
          version: draft.component.version,
          reason: "发布项目结项集成测试组件",
          actorId: ids.admin,
          auditContext: auditContext(ids.admin, `component-publish-${componentType}`)
        })
      ).publishedVersion;
    })
  );
  const code = `APM104.CLOSE.TEMPLATE.${suffix}`.toUpperCase();
  const draft = await saveProjectTemplateDraft({
    code,
    name: "APM-104 project close integration template",
    components: components.map((component, position) => ({
      componentVersionId: component.id,
      componentType: component.componentType,
      slot: `${component.componentType}.${position}`,
      position
    })),
    version: 0,
    reason: "创建项目结项集成测试模板",
    actorId: ids.admin,
    auditContext: auditContext(ids.admin, "template-draft")
  });
  const published = await publishProjectTemplate({
    code,
    version: draft.template.version,
    reason: "发布项目结项集成测试模板",
    actorId: ids.admin,
    auditContext: auditContext(ids.admin, "template-publish")
  });
  return {
    code,
    version: published.publishedVersion.version,
    checksum: published.publishedVersion.checksum
  };
}

type ClosureTemplate = Awaited<ReturnType<typeof seedClosureTemplate>>;

async function createPassedIntegrityCheck(
  projectId: string,
  archiveVersionId: string,
  label: string
) {
  const job = await db.persistentJob.create({
    data: {
      jobType: "archive.integrity.check",
      payload: { projectId, archiveVersionId },
      payloadHash: "0".repeat(64),
      idempotencyKey: `close-integrity-${label}-${suffix}`,
      maxAttempts: 1
    }
  });
  return db.projectArchiveIntegrityCheck.create({
    data: {
      projectId,
      archiveVersionId,
      sequence: 1,
      jobId: job.id,
      status: "PASSED",
      inputChecksum: "1".repeat(64),
      resultChecksum: "2".repeat(64),
      checkedAt: new Date()
    }
  });
}

async function createArchiveA(projectId: string, actorId: string, label: string) {
  const formula = getArchiveSourceFormulaAdapter("ARCHIVE.SOURCE@2");
  const [manifest, retrospectiveInput] = await Promise.all([
    formula.read({ client: db as never, projectId }).then((facts) => formula.buildManifest(facts)),
    readRetrospectiveInput({ client: db as never, projectId })
  ]);
  const archive = await db.projectArchive.create({ data: { projectId } });
  const version = await db.projectArchiveVersion.create({
    data: {
      archiveId: archive.id,
      projectId,
      version: 1,
      status: "READY",
      manifestChecksum: manifest.manifestChecksum,
      sourceWatermark: manifest.sourceWatermark,
      snapshotJson: manifest.snapshotJson as never,
      externalPublicationApplicability: "NOT_APPLICABLE",
      externalPublicationReason: manifest.externalPublication.reason,
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE",
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputSnapshotJson: retrospectiveInput.snapshot as never,
      retrospectiveInputWatermark: retrospectiveInput.watermark,
      createdById: actorId,
      manifestItems: {
        create: manifest.items.map((item) => ({
          position: item.position,
          sourceType: item.sourceType as never,
          sourceId: item.sourceId,
          sourceVersion: item.sourceVersion,
          sourceChecksum: item.sourceChecksum,
          fileObjectId: item.fileObjectId,
          fileSha256: item.fileSha256,
          fileMimeType: item.fileMimeType,
          fileSize: item.fileSize,
          snapshotJson: item.snapshotJson as never
        }))
      }
    }
  });
  await createPassedIntegrityCheck(projectId, version.id, `${label}-a`);
  return { archive, version };
}

async function createArchiveB(input: {
  projectId: string;
  archiveId: string;
  archiveA: { retrospectiveInputWatermark: string | null };
  actorId: string;
  label: string;
}) {
  const formula = getArchiveSourceFormulaAdapter("ARCHIVE.SOURCE@2");
  const [manifest, retrospectiveInput, latest] = await Promise.all([
    formula
      .read({ client: db as never, projectId: input.projectId })
      .then((facts) => formula.buildManifest(facts)),
    readRetrospectiveInput({ client: db as never, projectId: input.projectId }),
    db.projectArchiveVersion.findFirstOrThrow({
      where: { archiveId: input.archiveId, projectId: input.projectId },
      orderBy: { version: "desc" },
      select: { version: true }
    })
  ]);
  expect(retrospectiveInput.watermark).toBe(input.archiveA.retrospectiveInputWatermark);
  const version = await db.projectArchiveVersion.create({
    data: {
      archiveId: input.archiveId,
      projectId: input.projectId,
      version: latest.version + 1,
      status: "READY",
      manifestChecksum: manifest.manifestChecksum,
      sourceWatermark: manifest.sourceWatermark,
      snapshotJson: manifest.snapshotJson as never,
      externalPublicationApplicability: "NOT_APPLICABLE",
      externalPublicationReason: manifest.externalPublication.reason,
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE",
      retrospectiveInputWatermarkVersion: "RETROSPECTIVE.INPUT@1",
      retrospectiveInputSnapshotJson: retrospectiveInput.snapshot as never,
      retrospectiveInputWatermark: retrospectiveInput.watermark,
      createdById: input.actorId,
      manifestItems: {
        create: manifest.items.map((item) => ({
          position: item.position,
          sourceType: item.sourceType as never,
          sourceId: item.sourceId,
          sourceVersion: item.sourceVersion,
          sourceChecksum: item.sourceChecksum,
          fileObjectId: item.fileObjectId,
          fileSha256: item.fileSha256,
          fileMimeType: item.fileMimeType,
          fileSize: item.fileSize,
          snapshotJson: item.snapshotJson as never
        }))
      }
    }
  });
  await createPassedIntegrityCheck(input.projectId, version.id, `${input.label}-b`);
  return version;
}

async function addNonClosureGateSubmission(input: {
  projectId: string;
  actorId: string;
  approverId: string;
}) {
  const source = await db.projectGateDefinition.findFirstOrThrow({
    where: { projectId: input.projectId, code: "G9" },
    select: { sourceSnapshotComponentId: true, projectStageId: true }
  });
  const definition = await db.projectGateDefinition.create({
    data: {
      projectId: input.projectId,
      sourceSnapshotComponentId: source.sourceSnapshotComponentId,
      projectStageId: source.projectStageId,
      revision: 1,
      code: "G8",
      name: "非关项来源变更",
      scope: "PROJECT",
      definitionJson: { approval: { mode: "ALL", projectRoles: ["QUALITY"] } },
      checkerBindingsJson: [{ code: "STAGE.AWAITING_GATE", version: 1 }],
      definitionChecksum: "8".repeat(64),
      materializedById: input.actorId
    }
  });
  const instance = await db.projectGateInstance.create({
    data: {
      projectId: input.projectId,
      gateDefinitionId: definition.id,
      projectStageId: source.projectStageId,
      scope: "PROJECT",
      checkRunSequence: 1,
      createdById: input.actorId,
      updatedById: input.actorId
    }
  });
  const snapshot = await db.gateCheckSnapshot.create({
    data: {
      projectId: input.projectId,
      gateInstanceId: instance.id,
      sequence: 1,
      status: "PASSED",
      definitionSnapshot: { code: "G8", revision: 1 },
      scopeSnapshot: { scope: "PROJECT" },
      checkerBindingsJson: [{ code: "STAGE.AWAITING_GATE", version: 1 }],
      reason: "非 G9 归档来源变更",
      inputChecksum: "8".repeat(64),
      resultChecksum: "9".repeat(64),
      checkedById: input.actorId
    }
  });
  return db.$transaction(async (tx) => {
    const approverMembership = await tx.projectMember.findFirstOrThrow({
      where: {
        projectId: input.projectId,
        userId: input.approverId,
        projectRole: "QUALITY",
        leftAt: null,
        user: { status: "ACTIVE" }
      },
      select: { id: true }
    });
    const submission = await tx.gateSubmission.create({
      data: {
        projectId: input.projectId,
        gateInstanceId: instance.id,
        gateCheckSnapshotId: snapshot.id,
        sequence: 1,
        status: "APPROVED",
        approvalMode: "ALL",
        approverRolesJson: ["QUALITY"],
        submittedReason: "写入非 G9 归档来源",
        submittedById: input.actorId,
        decidedAt: new Date()
      }
    });
    await tx.gateSubmissionApprover.create({
      data: {
        projectId: input.projectId,
        gateSubmissionId: submission.id,
        userId: input.approverId,
        membershipIdsJson: [approverMembership.id],
        projectRolesJson: ["QUALITY"]
      }
    });
    return submission;
  });
}

async function seedReadyCloseFlow(template: ClosureTemplate, label: string) {
  const created = await createProjectFromTemplate({
    code: `APM104.CLOSE.${label}.${suffix}`.toUpperCase(),
    name: `${label} project close integration`,
    departmentId: "engineering",
    templateCode: template.code,
    templateVersion: template.version,
    templateChecksum: template.checksum,
    reason: "创建项目结项集成测试项目",
    actorId: ids.manager,
    auditContext: auditContext(ids.manager, `project-create-${label}`)
  });
  await db.projectMember.create({
    data: {
      projectId: created.project.id,
      userId: ids.reviewer,
      projectRole: "QUALITY",
      departmentId: "engineering",
      assignedById: ids.manager
    }
  });
  const [stage, managerMembership] = await Promise.all([
    db.projectStage.findUniqueOrThrow({
      where: { projectId_code: { projectId: created.project.id, code: "S8" } }
    }),
    db.projectMember.findFirstOrThrow({
      where: { projectId: created.project.id, userId: ids.manager, leftAt: null }
    })
  ]);
  await db.projectStage.update({
    where: { id: stage.id },
    data: { status: "AWAITING_GATE", updatedById: ids.manager, version: { increment: 1 } }
  });
  const archiveA = await createArchiveA(created.project.id, ids.manager, label);
  const draft = await createRetrospectiveVersion({
    projectId: created.project.id,
    retrospectiveInputArchiveVersionId: archiveA.version.id,
    expectedAggregateVersion: null,
    content: {
      deliverySummary: { summary: "完成交付" },
      successfulPractices: { items: ["归档事实冻结"] },
      shortcomings: { items: ["无未解决问题"] },
      improvements: { actions: ["持续执行结项复核"] },
      knowledgeDisposition: { disposition: "NONE" },
      ipDeclaration: { sanitized: true }
    },
    contributionInputs: [
      {
        scopeType: "PROJECT",
        deliveryUnitId: null,
        discipline: "QUALITY",
        contributorMembershipId: managerMembership.id,
        factText: "质量复盘事实完整。",
        impactText: "可作为结项依据。",
        reusable: false,
        required: true
      }
    ],
    participantMembershipIds: [managerMembership.id],
    issueHistoryIds: [],
    actorId: ids.manager,
    idempotencyKey: `retro-draft-${label}-${suffix}`,
    auditContext: auditContext(ids.manager, `retro-draft-${label}`, created.project.id)
  });
  const aggregateAfterDraft = await db.projectRetrospective.findUniqueOrThrow({
    where: { projectId: created.project.id }
  });
  await submitRetrospectiveVersion({
    projectId: created.project.id,
    versionId: draft.id,
    expectedAggregateVersion: aggregateAfterDraft.version,
    actorId: ids.manager,
    idempotencyKey: `retro-submit-${label}-${suffix}`,
    auditContext: auditContext(ids.manager, `retro-submit-${label}`, created.project.id)
  });
  const aggregateAfterSubmit = await db.projectRetrospective.findUniqueOrThrow({
    where: { projectId: created.project.id }
  });
  await reviewRetrospectiveVersion({
    projectId: created.project.id,
    versionId: draft.id,
    decision: "APPROVED",
    reason: "独立质量审核通过。",
    expectedAggregateVersion: aggregateAfterSubmit.version,
    actorId: ids.reviewer,
    idempotencyKey: `retro-review-${label}-${suffix}`,
    auditContext: auditContext(ids.reviewer, `retro-review-${label}`, created.project.id)
  });
  const archiveB = await createArchiveB({
    projectId: created.project.id,
    archiveId: archiveA.archive.id,
    archiveA: archiveA.version,
    actorId: ids.manager,
    label
  });
  const gate = await db.projectGateInstance.findFirstOrThrow({
    where: { projectId: created.project.id, gateDefinition: { code: "G9" } },
    include: { closurePolicyVersion: true }
  });
  const checked = await runGateChecks({
    projectId: created.project.id,
    gateInstanceId: gate.id,
    version: gate.version,
    reason: "执行结项 G9 V2 检查",
    actorId: ids.manager,
    auditContext: auditContext(ids.manager, `g9-check-${label}`, created.project.id)
  });
  expect(checked.gateCheckSnapshot.status).toBe("PASSED");
  const submitted = await submitGateSubmission({
    projectId: created.project.id,
    gateInstanceId: gate.id,
    version: checked.resourceVersion,
    reason: "提交结项 G9 V2",
    actorId: ids.manager,
    auditContext: auditContext(ids.manager, `g9-submit-${label}`, created.project.id)
  });
  const approved = await decideGateSubmission({
    projectId: created.project.id,
    submissionId: submitted.submission.gateSubmissionId,
    version: submitted.resourceVersion,
    decision: "APPROVED",
    reason: "质量审核批准结项 G9 V2",
    actorId: ids.reviewer,
    auditContext: auditContext(ids.reviewer, `g9-approve-${label}`, created.project.id)
  });
  const [project, snapshot, submission, policy] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id: created.project.id } }),
    db.gateCheckSnapshot.findUniqueOrThrow({ where: { id: checked.gateCheckSnapshot.id } }),
    db.gateSubmission.findUniqueOrThrow({ where: { id: submitted.submission.gateSubmissionId } }),
    db.projectClosurePolicy.findUniqueOrThrow({
      where: { projectId: created.project.id },
      include: { currentVersion: true }
    })
  ]);
  expect(approved.submission.status).toBe("APPROVED");
  expect(gate.closurePolicyVersionId).toBe(policy.currentVersionId);
  expect(snapshot.closurePolicyVersionId).toBe(policy.currentVersionId);
  expect(submission.closurePolicyVersionId).toBe(policy.currentVersionId);
  expect(snapshot.closurePolicyChecksum).toBe(policy.currentVersion?.policyChecksum);
  expect(submission.closurePolicyChecksum).toBe(policy.currentVersion?.policyChecksum);
  return {
    project,
    archiveA: archiveA.version,
    archiveB,
    g9SubmissionId: submission.id,
    g9SnapshotId: snapshot.id,
    policyVersionId: policy.currentVersionId
  };
}

describeDatabase("APM-104 project close PostgreSQL integration", () => {
  let template: ClosureTemplate;

  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `APM104-CLOSE-ADMIN-${suffix}`.toUpperCase(),
          name: "结项集成管理员",
          departmentId: "engineering"
        },
        {
          id: ids.manager,
          employeeNo: `APM104-CLOSE-MANAGER-${suffix}`.toUpperCase(),
          name: "结项集成项目经理",
          departmentId: "engineering"
        },
        {
          id: ids.reviewer,
          employeeNo: `APM104-CLOSE-QUALITY-${suffix}`.toUpperCase(),
          name: "结项集成质量审核人",
          departmentId: "engineering"
        }
      ]
    });
    template = await seedClosureTemplate();
  });

  it("runs Archive A -> approved retrospective -> Archive B -> G9 -> close once, replays only the same key, and keeps B current after G9 facts", async () => {
    const flow = await seedReadyCloseFlow(template, "SUCCESS");
    const formula = getArchiveSourceFormulaAdapter("ARCHIVE.SOURCE@2");
    const currentAfterApproval = formula.buildManifest(
      await formula.read({ client: db as never, projectId: flow.project.id })
    );
    expect(currentAfterApproval.sourceWatermark).toBe(flow.archiveB.sourceWatermark);
    expect(currentAfterApproval.manifestChecksum).toBe(flow.archiveB.manifestChecksum);

    const input = {
      projectId: flow.project.id,
      archiveVersionId: flow.archiveB.id,
      g9SubmissionId: flow.g9SubmissionId,
      expectedProjectVersion: flow.project.version,
      actorId: ids.reviewer,
      operationId: `close-success-${suffix}`,
      idempotencyKey: `close-success-${suffix}`,
      auditContext: auditContext(ids.reviewer, `close-success-${suffix}`, flow.project.id)
    };
    const [first, replay] = await Promise.all([closeProject(input), closeProject(input)]);
    expect([first.idempotent, replay.idempotent].filter(Boolean)).toHaveLength(1);
    expect([first.idempotent, replay.idempotent].filter((value) => !value)).toHaveLength(1);
    expect(first).toMatchObject({
      projectId: flow.project.id,
      status: "CLOSED",
      finalArchiveVersionId: flow.archiveB.id
    });
    expect(replay).toMatchObject({
      projectId: flow.project.id,
      status: "CLOSED",
      finalArchiveVersionId: flow.archiveB.id
    });
    await expect(
      closeProject({ ...input, operationId: `close-key-reused-${suffix}` })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
    await expect(
      closeProject({
        ...input,
        expectedProjectVersion: flow.project.version,
        operationId: `close-with-new-key-${suffix}`,
        idempotencyKey: `close-with-new-key-${suffix}`
      })
    ).rejects.toMatchObject({ code: "PROJECT_VERSION_CONFLICT", status: 409 });
    await expect(
      db.projectClosureRecord.count({ where: { projectId: flow.project.id } })
    ).resolves.toBe(1);
    await expect(
      db.project.findUniqueOrThrow({ where: { id: flow.project.id } })
    ).resolves.toMatchObject({
      status: "CLOSED",
      finalArchiveVersionId: flow.archiveB.id
    });
    await expect(
      db.projectArchiveVersion.findUniqueOrThrow({ where: { id: flow.archiveB.id } })
    ).resolves.toMatchObject({ status: "FINALIZED" });
    const closeOutbox = await db.outboxEvent.findFirst({
      where: {
        eventType: "project.closed",
        idempotencyKey: `${flow.project.id}:closed:${flow.archiveB.id}`
      },
      select: { traceId: true }
    });
    expect(closeOutbox).toMatchObject({ traceId: input.auditContext.traceId });
    expect(closeOutbox?.traceId).not.toBe(input.operationId);
    await expect(
      db.apiIdempotencyRecord.count({
        where: { actorId: ids.reviewer, operation: "projects.close", completedAt: { not: null } }
      })
    ).resolves.toBeGreaterThanOrEqual(1);
  });

  it("rejects a cross-project G9 submission and a non-G9 source change without creating close facts", async () => {
    const [local, foreign] = await Promise.all([
      seedReadyCloseFlow(template, "STALE"),
      seedReadyCloseFlow(template, "FOREIGN")
    ]);
    await expect(
      closeProject({
        projectId: local.project.id,
        archiveVersionId: local.archiveB.id,
        g9SubmissionId: foreign.g9SubmissionId,
        expectedProjectVersion: local.project.version,
        actorId: ids.reviewer,
        operationId: `close-cross-project-${suffix}`,
        idempotencyKey: `close-cross-project-${suffix}`,
        auditContext: auditContext(ids.reviewer, `close-cross-project-${suffix}`, local.project.id)
      })
    ).rejects.toMatchObject({ code: "CLOSURE_SUBMISSION_PROJECT_MISMATCH", status: 409 });
    await addNonClosureGateSubmission({
      projectId: local.project.id,
      actorId: ids.manager,
      approverId: ids.reviewer
    });
    const formula = getArchiveSourceFormulaAdapter("ARCHIVE.SOURCE@2");
    const currentAfterNonG9Change = formula.buildManifest(
      await formula.read({ client: db as never, projectId: local.project.id })
    );
    expect(currentAfterNonG9Change.sourceWatermark).not.toBe(local.archiveB.sourceWatermark);
    await expect(
      closeProject({
        projectId: local.project.id,
        archiveVersionId: local.archiveB.id,
        g9SubmissionId: local.g9SubmissionId,
        expectedProjectVersion: local.project.version,
        actorId: ids.reviewer,
        operationId: `close-stale-${suffix}`,
        idempotencyKey: `close-stale-${suffix}`,
        auditContext: auditContext(ids.reviewer, `close-stale-${suffix}`, local.project.id)
      })
    ).rejects.toMatchObject({ code: "PROJECT_ARCHIVE_FACTS_STALE", status: 409 });
    await expect(
      db.projectClosureRecord.count({ where: { projectId: local.project.id } })
    ).resolves.toBe(0);
  });

  it("rolls back closure, audit, Outbox, and successful idempotency facts when the final close Outbox has an idempotency conflict", async () => {
    const flow = await seedReadyCloseFlow(template, "ROLLBACK");
    const closeOutboxKey = `${flow.project.id}:closed:${flow.archiveB.id}`;
    const preexistingConflict = await db.outboxEvent.create({
      data: {
        eventType: "project.closed",
        aggregateType: "PROJECT",
        aggregateId: flow.project.id,
        payload: { projectId: flow.project.id, fixture: "preexisting-conflict" },
        payloadHash: "f".repeat(64),
        idempotencyKey: closeOutboxKey
      }
    });
    const idempotencyKey = `close-rollback-${suffix}`;
    await expect(
      closeProject({
        projectId: flow.project.id,
        archiveVersionId: flow.archiveB.id,
        g9SubmissionId: flow.g9SubmissionId,
        expectedProjectVersion: flow.project.version,
        actorId: ids.reviewer,
        operationId: `close-rollback-${suffix}`,
        idempotencyKey,
        auditContext: auditContext(ids.reviewer, `close-rollback-${suffix}`, flow.project.id)
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(
      db.project.findUniqueOrThrow({ where: { id: flow.project.id } })
    ).resolves.toMatchObject({
      status: "DRAFT",
      finalArchiveVersionId: null
    });
    await expect(
      db.projectArchiveVersion.findUniqueOrThrow({ where: { id: flow.archiveB.id } })
    ).resolves.toMatchObject({ status: "READY" });
    await expect(
      db.projectClosureRecord.count({ where: { projectId: flow.project.id } })
    ).resolves.toBe(0);
    await expect(
      db.auditLog.count({
        where: {
          projectId: flow.project.id,
          action: { in: ["PROJECT_CLOSED", "PROJECT_CLOSURE_RECORD_CREATED"] }
        }
      })
    ).resolves.toBe(0);
    await expect(
      db.apiIdempotencyRecord.count({
        where: { actorId: ids.reviewer, operation: "projects.close", idempotencyKey }
      })
    ).resolves.toBe(0);
    await expect(
      db.outboxEvent.findUniqueOrThrow({
        where: {
          eventType_idempotencyKey: { eventType: "project.closed", idempotencyKey: closeOutboxKey }
        }
      })
    ).resolves.toMatchObject({
      id: preexistingConflict.id,
      aggregateType: "PROJECT",
      aggregateId: flow.project.id,
      payload: { projectId: flow.project.id, fixture: "preexisting-conflict" },
      payloadHash: "f".repeat(64)
    });
    await expect(
      db.outboxEvent.count({
        where: { eventType: "project.closed", idempotencyKey: closeOutboxKey }
      })
    ).resolves.toBe(1);
  });
});
