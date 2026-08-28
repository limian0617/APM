import { createHash, randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { deactivateTechnicalAsset } from "@/modules/assets/application/technical-asset-service";
import { buildAssetImpactProjectionAttemptKey } from "@/modules/assets/domain/asset-upgrade-impact";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { createGovernanceJobHandlers } from "@/workers/governance-job-handlers";
import { runJobBatch } from "@/workers/job-runner";

import {
  createProjectAlertRule,
  projectAssetImpact,
  requestProjectAlertScan,
  runProjectAlertScan,
  transitionProjectAlert,
  updateProjectAlertRule
} from "../application/alert-service";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  assetOwner: `impact-alert-asset-owner-${suffix}`,
  manager: `impact-alert-manager-${suffix}`,
  alertOwner: `impact-alert-owner-${suffix}`,
  escalation: `impact-alert-escalation-${suffix}`,
  quality: `impact-alert-quality-${suffix}`
};

const assetOwnerActor = {
  id: ids.assetOwner,
  name: "Asset owner",
  status: "ACTIVE" as const,
  departmentId: "engineering",
  systemRoles: ["TECHNICAL_ASSET_MAINTAINER"],
  grants: []
};
function checksum(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function projectionExecution(sourceJobId: string, attempt = sourceJobId) {
  return {
    sourceJobId,
    jobAttemptId: `attempt-${attempt}`,
    traceId: checksum(`trace-${sourceJobId}`).slice(0, 32)
  };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function auditContext(actorId: string | null, operationId: string, projectId: string | null) {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: null,
    source: "API",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId: "engineering",
    operationId
  } satisfies AuditContext;
}

let technicalAssetId: string;
let deactivationEvent: {
  id: string;
  sequence: number;
  snapshotJson: unknown;
};

async function seedProject(label: string) {
  const project = await db.project.create({
    data: {
      code: `APM064.ALERT.${label}.${suffix}`.toUpperCase(),
      name: `APM-064 alert ${label}`,
      departmentId: "engineering",
      createdById: ids.manager
    }
  });
  const [manager, owner, escalation, quality] = await Promise.all([
    db.projectMember.create({
      data: {
        projectId: project.id,
        userId: ids.manager,
        projectRole: "PROJECT_MANAGER",
        departmentId: "engineering",
        assignedById: ids.manager
      }
    }),
    db.projectMember.create({
      data: {
        projectId: project.id,
        userId: ids.alertOwner,
        projectRole: "ENGINEER",
        departmentId: "engineering",
        assignedById: ids.manager
      }
    }),
    db.projectMember.create({
      data: {
        projectId: project.id,
        userId: ids.escalation,
        projectRole: "DEPARTMENT_LEAD",
        departmentId: "engineering",
        assignedById: ids.manager
      }
    }),
    db.projectMember.create({
      data: {
        projectId: project.id,
        userId: ids.quality,
        projectRole: "QUALITY",
        departmentId: "quality",
        assignedById: ids.manager
      }
    })
  ]);
  const dueAt = new Date(Date.now() + 30 * 86_400_000);
  const sourceWatermark = checksum(`${project.id}:initial-watermark`);
  const snapshotJson = {
    technicalAssetEventId: deactivationEvent.id,
    technicalAssetId,
    eventSequence: deactivationEvent.sequence,
    fromStatus: "VALIDATED",
    toStatus: "DISABLED",
    eventSnapshot: deactivationEvent.snapshotJson,
    sourceWatermark,
    historicalOnly: false,
    manualAssignmentRequired: false
  };
  const ownerSnapshot = {
    membershipId: manager.id,
    userId: manager.userId,
    projectRole: manager.projectRole
  };
  const impact = await db.$transaction(async (client) => {
    const created = await client.assetProjectImpact.create({
      data: {
        projectId: project.id,
        technicalAssetId,
        sourceType: "ASSET_DEACTIVATION",
        sourceKey: `ASSET_DEACTIVATION:${deactivationEvent.id}`,
        technicalAssetEventId: deactivationEvent.id,
        ownerMembershipId: manager.id,
        dueAt
      }
    });
    const assessment = await client.assetImpactAssessmentRevision.create({
      data: {
        impactId: created.id,
        projectId: project.id,
        technicalAssetId,
        sequence: 1,
        kind: "INITIAL",
        sourceWatermark,
        snapshotChecksum: checksum(JSON.stringify(snapshotJson)),
        snapshotJson: snapshotJson as Prisma.InputJsonValue,
        frozenAt: new Date(),
        ownerMembershipId: manager.id,
        ownerMembershipSnapshotJson: ownerSnapshot,
        dueAt
      }
    });
    return client.assetProjectImpact.update({
      where: { id: created.id },
      data: { currentAssessmentRevisionId: assessment.id }
    });
  });
  return { project, manager, owner, escalation, quality, impact, dueAt, ownerSnapshot };
}

async function createRule(
  facts: Awaited<ReturnType<typeof seedProject>>,
  label: string,
  ownerMembershipId = facts.owner.id
) {
  return createProjectAlertRule({
    projectId: facts.project.id,
    code: `ASSET.IMPACT.${label}.${suffix}`.toUpperCase(),
    name: `Asset impact ${label}`,
    sourceType: "ASSET_IMPACT",
    condition: {},
    probability: "HIGH",
    impact: "HIGH",
    ownerMembershipId,
    escalationMembershipId: facts.escalation.id,
    escalationAfterDays: 1,
    actorId: ids.manager,
    auditContext: auditContext(ids.manager, `rule-${label}-${suffix}`, facts.project.id)
  });
}

function ruleUpdateInput(
  facts: Awaited<ReturnType<typeof seedProject>>,
  created: Awaited<ReturnType<typeof createRule>>,
  label: string,
  status: "ENABLED" | "DISABLED" = "DISABLED"
) {
  return {
    projectId: facts.project.id,
    ruleId: created.rule.id,
    version: created.rule.version,
    code: created.rule.code,
    name: created.rule.name,
    sourceType: "ASSET_IMPACT",
    condition: {},
    probability: created.rule.probability,
    impact: created.rule.impact,
    ownerMembershipId: created.rule.ownerMembershipId,
    escalationMembershipId: created.rule.escalationMembershipId,
    escalationAfterDays: created.rule.escalationAfterDays,
    status,
    reason: `Disable during ${label}`,
    actorId: ids.manager,
    auditContext: auditContext(ids.manager, `disable-${label}-${suffix}`, facts.project.id)
  };
}

async function refreshImpact(facts: Awaited<ReturnType<typeof seedProject>>, label: string) {
  return db.$transaction(async (client) => {
    const current = await client.assetProjectImpact.findUniqueOrThrow({
      where: { id: facts.impact.id },
      include: { currentAssessmentRevision: true }
    });
    const sequence = (current.currentAssessmentRevision?.sequence ?? 0) + 1;
    const sourceWatermark = checksum(`${facts.impact.id}:${label}:watermark`);
    const snapshotJson = {
      technicalAssetEventId: deactivationEvent.id,
      technicalAssetId,
      eventSequence: deactivationEvent.sequence,
      fromStatus: "VALIDATED",
      toStatus: "DISABLED",
      eventSnapshot: deactivationEvent.snapshotJson,
      sourceWatermark,
      historicalOnly: false,
      manualAssignmentRequired: false,
      refreshLabel: label
    };
    const assessment = await client.assetImpactAssessmentRevision.create({
      data: {
        impactId: current.id,
        projectId: current.projectId,
        technicalAssetId,
        sequence,
        kind: "REFRESH",
        sourceWatermark,
        snapshotChecksum: checksum(JSON.stringify(snapshotJson)),
        snapshotJson: snapshotJson as Prisma.InputJsonValue,
        frozenAt: new Date(),
        actorId: ids.manager,
        actorMembershipId: facts.manager.id,
        actorMembershipSnapshotJson: facts.ownerSnapshot,
        ownerMembershipId: facts.manager.id,
        ownerMembershipSnapshotJson: facts.ownerSnapshot,
        dueAt: facts.dueAt
      }
    });
    const dispositionSequence =
      (await client.assetImpactDisposition.count({ where: { impactId: current.id } })) + 1;
    await client.assetImpactDisposition.create({
      data: {
        impactId: current.id,
        projectId: current.projectId,
        technicalAssetId,
        assessmentRevisionId: assessment.id,
        sequence: dispositionSequence,
        type: "REFRESHED",
        fromStatus: current.status,
        toStatus: "OPEN",
        reason: `Refresh ${label}`,
        evidenceJson: { label },
        actorId: ids.manager,
        actorMembershipId: facts.manager.id,
        actorMembershipSnapshotJson: facts.ownerSnapshot,
        ownerMembershipId: facts.manager.id,
        ownerMembershipSnapshotJson: facts.ownerSnapshot,
        dueAt: facts.dueAt
      }
    });
    return client.assetProjectImpact.update({
      where: { id: current.id },
      data: {
        currentAssessmentRevisionId: assessment.id,
        status: "OPEN",
        version: { increment: 1 }
      }
    });
  });
}

async function applyDisposition(
  facts: Awaited<ReturnType<typeof seedProject>>,
  input: {
    type: "ACKNOWLEDGED" | "ASSESSING" | "UPGRADE_PLANNED";
    fromStatus: "OPEN" | "ACKNOWLEDGED" | "ASSESSING";
    toStatus: "ACKNOWLEDGED" | "ASSESSING" | "UPGRADE_PLANNED";
  }
) {
  return db.$transaction(async (client) => {
    const impact = await client.assetProjectImpact.findUniqueOrThrow({
      where: { id: facts.impact.id }
    });
    await client.assetImpactDisposition.create({
      data: {
        impactId: impact.id,
        projectId: impact.projectId,
        technicalAssetId,
        assessmentRevisionId: impact.currentAssessmentRevisionId as string,
        sequence:
          (await client.assetImpactDisposition.count({ where: { impactId: impact.id } })) + 1,
        type: input.type,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        reason: `Apply ${input.type}`,
        evidenceJson: { step: input.type },
        actorId: ids.manager,
        actorMembershipId: facts.manager.id,
        actorMembershipSnapshotJson: facts.ownerSnapshot,
        ownerMembershipId: facts.manager.id,
        ownerMembershipSnapshotJson: facts.ownerSnapshot,
        dueAt: facts.dueAt
      }
    });
    return client.assetProjectImpact.update({
      where: { id: impact.id },
      data: { status: input.toStatus, version: { increment: 1 } }
    });
  });
}

async function acceptRisk(facts: Awaited<ReturnType<typeof seedProject>>) {
  await applyDisposition(facts, {
    type: "ACKNOWLEDGED",
    fromStatus: "OPEN",
    toStatus: "ACKNOWLEDGED"
  });
  await applyDisposition(facts, {
    type: "ASSESSING",
    fromStatus: "ACKNOWLEDGED",
    toStatus: "ASSESSING"
  });
  const riskRequest = await db.$transaction(async (client) => {
    const impact = await client.assetProjectImpact.findUniqueOrThrow({
      where: { id: facts.impact.id }
    });
    const request = await client.assetImpactRiskAcceptanceRequest.create({
      data: {
        impactId: impact.id,
        projectId: impact.projectId,
        technicalAssetId,
        requestedById: ids.manager,
        requestedMembershipId: facts.manager.id,
        requestedMembershipSnapshotJson: facts.ownerSnapshot,
        sourceActorId: ids.assetOwner,
        sourceActorSnapshotJson: { actorId: ids.assetOwner },
        evidenceJson: { risk: "documented" },
        reason: "Request independent risk acceptance",
        requestedAt: new Date(),
        updatedAt: new Date()
      }
    });
    await client.assetImpactDisposition.create({
      data: {
        impactId: impact.id,
        projectId: impact.projectId,
        technicalAssetId,
        assessmentRevisionId: impact.currentAssessmentRevisionId as string,
        sequence:
          (await client.assetImpactDisposition.count({ where: { impactId: impact.id } })) + 1,
        type: "RISK_ACCEPTANCE_REQUESTED",
        fromStatus: "ASSESSING",
        toStatus: "RISK_ACCEPTANCE_PENDING",
        reason: "Request independent risk acceptance",
        evidenceJson: { risk: "documented" },
        actorId: ids.manager,
        actorMembershipId: facts.manager.id,
        actorMembershipSnapshotJson: facts.ownerSnapshot,
        ownerMembershipId: facts.manager.id,
        ownerMembershipSnapshotJson: facts.ownerSnapshot,
        dueAt: facts.dueAt,
        riskAcceptanceRequestId: request.id
      }
    });
    await client.assetProjectImpact.update({
      where: { id: impact.id },
      data: { status: "RISK_ACCEPTANCE_PENDING", version: { increment: 1 } }
    });
    return request;
  });
  return db.$transaction(async (client) => {
    const impact = await client.assetProjectImpact.findUniqueOrThrow({
      where: { id: facts.impact.id }
    });
    const qualitySnapshot = {
      membershipId: facts.quality.id,
      userId: facts.quality.userId,
      projectRole: facts.quality.projectRole
    };
    const decision = await client.assetImpactRiskAcceptanceDecision.create({
      data: {
        requestId: riskRequest.id,
        impactId: impact.id,
        projectId: impact.projectId,
        technicalAssetId,
        decision: "APPROVED",
        actorId: ids.quality,
        actorMembershipId: facts.quality.id,
        actorMembershipSnapshotJson: qualitySnapshot,
        evidenceJson: { approval: "QA-1" },
        reason: "Independent quality approval",
        decidedAt: new Date()
      }
    });
    await client.assetImpactRiskAcceptanceRequest.update({
      where: { id: riskRequest.id },
      data: { status: "APPROVED", version: { increment: 1 } }
    });
    await client.assetImpactDisposition.create({
      data: {
        impactId: impact.id,
        projectId: impact.projectId,
        technicalAssetId,
        assessmentRevisionId: impact.currentAssessmentRevisionId as string,
        sequence:
          (await client.assetImpactDisposition.count({ where: { impactId: impact.id } })) + 1,
        type: "RISK_ACCEPTANCE_APPROVED",
        fromStatus: "RISK_ACCEPTANCE_PENDING",
        toStatus: "ACCEPTED_RISK",
        reason: "Independent quality approval",
        evidenceJson: { approval: "QA-1" },
        actorId: ids.quality,
        actorMembershipId: facts.quality.id,
        actorMembershipSnapshotJson: qualitySnapshot,
        ownerMembershipId: facts.manager.id,
        ownerMembershipSnapshotJson: facts.ownerSnapshot,
        dueAt: facts.dueAt,
        riskAcceptanceRequestId: riskRequest.id,
        riskAcceptanceDecisionId: decision.id
      }
    });
    return client.assetProjectImpact.update({
      where: { id: impact.id },
      data: { status: "ACCEPTED_RISK", version: { increment: 1 } }
    });
  });
}

describeDatabase("APM-064 PostgreSQL asset-impact alert projection", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.assetOwner,
          employeeNo: `APM064-AO-${suffix}`,
          name: "Asset owner",
          departmentId: "engineering"
        },
        {
          id: ids.manager,
          employeeNo: `APM064-PM-${suffix}`,
          name: "Project manager",
          departmentId: "engineering"
        },
        {
          id: ids.alertOwner,
          employeeNo: `APM064-OWN-${suffix}`,
          name: "Alert owner",
          departmentId: "engineering"
        },
        {
          id: ids.escalation,
          employeeNo: `APM064-ESC-${suffix}`,
          name: "Escalation owner",
          departmentId: "engineering"
        },
        {
          id: ids.quality,
          employeeNo: `APM064-QA-${suffix}`,
          name: "Quality approver",
          departmentId: "quality"
        }
      ]
    });
    const rndProject = await db.rndProject.create({
      data: {
        code: `RND.ALERT.${suffix}`.toUpperCase(),
        name: "Alert projection source",
        ownerId: ids.assetOwner,
        createdById: ids.assetOwner
      }
    });
    const asset = await db.technicalAsset.create({
      data: {
        rndProjectId: rndProject.id,
        assetNumber: `AST.ALERT.${suffix}`.toUpperCase(),
        assetType: "SOFTWARE",
        name: "Alert projection asset",
        ownerId: ids.assetOwner,
        status: "VALIDATED",
        createdById: ids.assetOwner
      }
    });
    technicalAssetId = asset.id;
    await deactivateTechnicalAsset({
      assetId: asset.id,
      version: asset.version,
      reason: "Exercise event-driven impact alerts",
      actorId: ids.assetOwner,
      authorizationActor: assetOwnerActor,
      auditContext: auditContext(ids.assetOwner, `deactivate-${suffix}`, null)
    });
    deactivationEvent = await db.technicalAssetEvent.findFirstOrThrow({
      where: { technicalAssetId: asset.id, fromStatus: "VALIDATED", toStatus: "DISABLED" },
      select: { id: true, sequence: true, snapshotJson: true }
    });
  });

  it("records a non-retrying blocked attempt when no enabled rule exists", async () => {
    const facts = await seedProject("NO-RULE");
    await expect(
      projectAssetImpact({
        projectId: facts.project.id,
        impactId: facts.impact.id,
        eventAssessmentRevisionId: facts.impact.currentAssessmentRevisionId,
        sourceEventType: "asset.impact.assessed",
        ...projectionExecution(`job-no-rule-${suffix}`)
      })
    ).resolves.toEqual({ deliveredCount: 0, blockedCount: 1, repeatedCount: 0 });
    const attempt = await db.assetImpactAlertProjectionAttempt.findFirstOrThrow({
      where: { impactId: facts.impact.id }
    });
    expect(attempt).toMatchObject({
      result: "BLOCKED_CONFIGURATION",
      ruleId: null,
      blockedReason: "ASSET_IMPACT_ALERT_RULE_MISSING",
      assessmentSequence: 1,
      sourceJobId: `job-no-rule-${suffix}`,
      sourceEventType: "asset.impact.assessed"
    });
    await expect(
      projectAssetImpact({
        projectId: facts.project.id,
        impactId: facts.impact.id,
        eventAssessmentRevisionId: facts.impact.currentAssessmentRevisionId,
        sourceEventType: "asset.impact.assessed",
        ...projectionExecution(`job-no-rule-${suffix}`, `job-no-rule-replay-${suffix}`)
      })
    ).resolves.toEqual({ deliveredCount: 0, blockedCount: 1, repeatedCount: 1 });
    await expect(
      db.assetImpactAlertProjectionAttempt.count({
        where: { impactId: facts.impact.id }
      })
    ).resolves.toBe(1);
    await expect(db.projectAlert.count({ where: { projectId: facts.project.id } })).resolves.toBe(
      0
    );
    await expect(
      db.assetImpactAlertProjectionAttempt.update({
        where: { id: attempt.id },
        data: { blockedReason: "tampered" }
      })
    ).rejects.toThrow(/append-only/u);
  });

  it("creates, updates, retriggers, and resolves one stable alert from authoritative revisions", async () => {
    const facts = await seedProject("LIFECYCLE");
    const createdRule = await createRule(facts, "LIFECYCLE");
    const initial = await projectAssetImpact({
      projectId: facts.project.id,
      impactId: facts.impact.id,
      eventAssessmentRevisionId: facts.impact.currentAssessmentRevisionId,
      sourceEventType: "asset.impact.assessed",
      ...projectionExecution(`job-create-${suffix}`)
    });
    expect(initial).toEqual({ deliveredCount: 1, blockedCount: 0, repeatedCount: 0 });
    const alert = await db.projectAlert.findFirstOrThrow({
      where: { projectId: facts.project.id, ruleId: createdRule.rule.id }
    });
    expect(alert).toMatchObject({
      sourceType: "ASSET_IMPACT",
      sourceKey: `ASSET_IMPACT:${facts.impact.id}`,
      status: "TRIGGERED",
      version: 1,
      sourceSnapshot: expect.objectContaining({
        ownerMembershipId: facts.manager.id,
        dueAt: facts.dueAt.toISOString(),
        historicalOnly: false,
        manualAssignmentRequired: false,
        sourceJobId: `job-create-${suffix}`,
        sourceEventType: "asset.impact.assessed"
      })
    });
    const initialAttempt = await db.assetImpactAlertProjectionAttempt.findFirstOrThrow({
      where: { impactId: facts.impact.id, sourceJobId: `job-create-${suffix}` }
    });
    await expect(
      db.auditLog.findFirstOrThrow({
        where: {
          action: "ASSET_IMPACT_ALERT_PROJECTED",
          objectId: initialAttempt.id
        }
      })
    ).resolves.toMatchObject({
      requestId: `job-create-${suffix}`,
      operationId: `attempt-job-create-${suffix}`,
      traceId: checksum(`trace-job-create-${suffix}`).slice(0, 32),
      afterJson: expect.objectContaining({
        sourceJobId: `job-create-${suffix}`,
        sourceEventType: "asset.impact.assessed"
      })
    });

    const scan = await requestProjectAlertScan({
      projectId: facts.project.id,
      idempotencyKey: `scan-${suffix}`,
      actorId: ids.manager,
      auditContext: auditContext(ids.manager, `scan-${suffix}`, facts.project.id)
    });
    await expect(
      runProjectAlertScan({ projectId: facts.project.id, scanId: scan.scan.id })
    ).resolves.toMatchObject({ triggeredCount: 0, scan: { status: "SUCCEEDED" } });
    await expect(
      projectAssetImpact({
        projectId: facts.project.id,
        impactId: facts.impact.id,
        eventAssessmentRevisionId: facts.impact.currentAssessmentRevisionId,
        sourceEventType: "asset.impact.assessed",
        ...projectionExecution(`job-create-${suffix}`, `job-replay-${suffix}`)
      })
    ).resolves.toEqual({ deliveredCount: 0, blockedCount: 0, repeatedCount: 1 });
    await expect(
      db.assetImpactAlertProjectionAttempt.count({ where: { impactId: facts.impact.id } })
    ).resolves.toBe(1);

    for (const transition of [
      {
        type: "ACKNOWLEDGED" as const,
        fromStatus: "OPEN" as const,
        toStatus: "ACKNOWLEDGED" as const,
        eventType: "asset.impact.disposition-recorded" as const
      },
      {
        type: "ASSESSING" as const,
        fromStatus: "ACKNOWLEDGED" as const,
        toStatus: "ASSESSING" as const,
        eventType: "asset.impact.disposition-recorded" as const
      },
      {
        type: "UPGRADE_PLANNED" as const,
        fromStatus: "ASSESSING" as const,
        toStatus: "UPGRADE_PLANNED" as const,
        eventType: "project.asset-upgrade.adopted" as const
      }
    ]) {
      const advanced = await applyDisposition(facts, transition);
      if (transition.type === "ACKNOWLEDGED") {
        await expect(
          projectAssetImpact({
            projectId: facts.project.id,
            impactId: facts.impact.id,
            eventAssessmentRevisionId: advanced.currentAssessmentRevisionId,
            sourceEventType: "asset.impact.assessed",
            ...projectionExecution(`job-create-${suffix}`, `job-create-after-advance-${suffix}`)
          })
        ).resolves.toEqual({ deliveredCount: 0, blockedCount: 0, repeatedCount: 1 });
        await expect(
          db.projectAlert.findUniqueOrThrow({ where: { id: alert.id } })
        ).resolves.toMatchObject({
          sourceSnapshot: expect.objectContaining({ impactStatus: "OPEN" })
        });
        await expect(
          db.assetImpactAlertProjectionAttempt.count({ where: { impactId: facts.impact.id } })
        ).resolves.toBe(1);
      }
      await expect(
        projectAssetImpact({
          projectId: facts.project.id,
          impactId: facts.impact.id,
          eventAssessmentRevisionId: advanced.currentAssessmentRevisionId,
          sourceEventType: transition.eventType,
          ...projectionExecution(`job-${transition.type.toLowerCase()}-${suffix}`)
        })
      ).resolves.toEqual({ deliveredCount: 1, blockedCount: 0, repeatedCount: 0 });
      await expect(
        db.projectAlert.findUniqueOrThrow({ where: { id: alert.id } })
      ).resolves.toMatchObject({
        status: "TRIGGERED",
        version: 1,
        sourceSnapshot: expect.objectContaining({
          impactStatus: transition.toStatus,
          impactVersion: advanced.version
        })
      });
    }
    await expect(
      db.assetImpactAlertProjectionAttempt.count({ where: { impactId: facts.impact.id } })
    ).resolves.toBe(4);
    await expect(
      db.projectAlertEvent.count({ where: { alertId: alert.id, eventType: "TRIGGERED" } })
    ).resolves.toBe(1);

    await refreshImpact(facts, "updated");
    await projectAssetImpact({
      projectId: facts.project.id,
      impactId: facts.impact.id,
      eventAssessmentRevisionId: facts.impact.currentAssessmentRevisionId,
      sourceEventType: "asset.impact.assessed",
      ...projectionExecution(`job-update-${suffix}`)
    });
    await expect(
      db.projectAlert.findUniqueOrThrow({ where: { id: alert.id } })
    ).resolves.toMatchObject({ status: "TRIGGERED", version: 1 });
    const refreshedImpact = await db.assetProjectImpact.findUniqueOrThrow({
      where: { id: facts.impact.id }
    });
    const refreshedAlert = await db.projectAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(refreshedAlert.sourceSnapshot).toMatchObject({
      assessmentRevisionId: refreshedImpact.currentAssessmentRevisionId,
      assessmentSequence: 2
    });

    const observed = await db.projectAlert.findUniqueOrThrow({ where: { id: alert.id } });
    await transitionProjectAlert({
      projectId: facts.project.id,
      alertId: alert.id,
      action: "RESOLVE",
      version: observed.version,
      reason: "Temporarily resolved before a new assessment revision",
      actorId: ids.alertOwner,
      auditContext: auditContext(ids.alertOwner, `manual-resolve-${suffix}`, facts.project.id)
    });
    await refreshImpact(facts, "retriggered");
    await projectAssetImpact({
      projectId: facts.project.id,
      impactId: facts.impact.id,
      eventAssessmentRevisionId: null,
      sourceEventType: "asset.impact.assessed",
      ...projectionExecution(`job-retrigger-${suffix}`)
    });
    await expect(
      db.projectAlert.findUniqueOrThrow({ where: { id: alert.id } })
    ).resolves.toMatchObject({ status: "TRIGGERED" });

    let impact = await acceptRisk(facts);
    expect(impact.status).toBe("ACCEPTED_RISK");
    await projectAssetImpact({
      projectId: facts.project.id,
      impactId: facts.impact.id,
      eventAssessmentRevisionId: impact.currentAssessmentRevisionId,
      sourceEventType: "asset.impact.risk-acceptance.decided",
      ...projectionExecution(`job-resolve-${suffix}`)
    });
    await expect(
      db.projectAlert.findUniqueOrThrow({ where: { id: alert.id } })
    ).resolves.toMatchObject({ status: "RESOLVED" });
  });

  it("preserves CLOSED while recording one recurrence for a new authoritative revision", async () => {
    const facts = await seedProject("CLOSED-RECURRENCE");
    const createdRule = await createRule(facts, "CLOSED-RECURRENCE");
    const initialAssessmentId = facts.impact.currentAssessmentRevisionId as string;
    await projectAssetImpact({
      projectId: facts.project.id,
      impactId: facts.impact.id,
      eventAssessmentRevisionId: initialAssessmentId,
      sourceEventType: "asset.impact.assessed",
      ...projectionExecution(`job-closed-create-${suffix}`)
    });
    let alert = await db.projectAlert.findFirstOrThrow({
      where: { projectId: facts.project.id, ruleId: createdRule.rule.id }
    });
    alert = (
      await transitionProjectAlert({
        projectId: facts.project.id,
        alertId: alert.id,
        action: "RESOLVE",
        version: alert.version,
        reason: "Resolve before controlled closure",
        actorId: ids.alertOwner,
        auditContext: auditContext(ids.alertOwner, `close-resolve-${suffix}`, facts.project.id)
      })
    ).alert;
    alert = (
      await transitionProjectAlert({
        projectId: facts.project.id,
        alertId: alert.id,
        action: "CLOSE",
        version: alert.version,
        reason: "Close the observed alert",
        actorId: ids.manager,
        auditContext: auditContext(ids.manager, `close-final-${suffix}`, facts.project.id)
      })
    ).alert;
    const closedAt = alert.closedAt;
    const closedVersion = alert.version;

    const refreshed = await refreshImpact(facts, "closed-recurrence");
    await projectAssetImpact({
      projectId: facts.project.id,
      impactId: facts.impact.id,
      eventAssessmentRevisionId: refreshed.currentAssessmentRevisionId,
      sourceEventType: "asset.impact.assessed",
      ...projectionExecution(`job-closed-recurrence-${suffix}`)
    });
    const recurred = await db.projectAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(recurred).toMatchObject({
      status: "CLOSED",
      closedAt,
      version: closedVersion + 1,
      sourceSnapshot: expect.objectContaining({
        assessmentRevisionId: refreshed.currentAssessmentRevisionId,
        impactStatus: "OPEN"
      })
    });
    await expect(
      db.projectAlertEvent.count({ where: { alertId: alert.id, eventType: "RETRIGGERED" } })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({
        where: { aggregateId: alert.id, eventType: "governance.alert.recurred" }
      })
    ).resolves.toBe(1);

    await projectAssetImpact({
      projectId: facts.project.id,
      impactId: facts.impact.id,
      eventAssessmentRevisionId: initialAssessmentId,
      sourceEventType: "asset.impact.assessed",
      ...projectionExecution(`job-closed-old-event-${suffix}`)
    });
    await expect(
      db.projectAlert.findUniqueOrThrow({ where: { id: alert.id } })
    ).resolves.toMatchObject({ status: "CLOSED", closedAt, version: closedVersion + 1 });
    await expect(
      db.projectAlertEvent.count({ where: { alertId: alert.id, eventType: "RETRIGGERED" } })
    ).resolves.toBe(1);
  });

  it("blocks an invalid configured membership without writing an alert or success Outbox", async () => {
    const facts = await seedProject("INVALID-MEMBER");
    await createRule(facts, "INVALID-MEMBER");
    await db.user.update({ where: { id: ids.alertOwner }, data: { status: "DISABLED" } });
    try {
      await expect(createRule(facts, "INACTIVE-CREATE")).rejects.toMatchObject({
        code: "MEMBERSHIP_INVALID"
      });
      await expect(
        projectAssetImpact({
          projectId: facts.project.id,
          impactId: facts.impact.id,
          eventAssessmentRevisionId: null,
          sourceEventType: "asset.impact.assessed",
          ...projectionExecution(`job-invalid-member-${suffix}`)
        })
      ).resolves.toEqual({ deliveredCount: 0, blockedCount: 1, repeatedCount: 0 });
    } finally {
      await db.user.update({ where: { id: ids.alertOwner }, data: { status: "ACTIVE" } });
    }
    await expect(db.projectAlert.count({ where: { projectId: facts.project.id } })).resolves.toBe(
      0
    );
    await expect(
      db.auditLog.findFirstOrThrow({
        where: {
          projectId: facts.project.id,
          action: "ASSET_IMPACT_ALERT_PROJECTION_BLOCKED"
        }
      })
    ).resolves.toMatchObject({ result: "FAILURE" });
    await expect(
      db.outboxEvent.count({
        where: {
          aggregateType: "PROJECT_ALERT",
          payload: { path: ["projectId"], equals: facts.project.id }
        }
      })
    ).resolves.toBe(0);
  });

  it("recovers one blocked job after the same rule is corrected to a new version", async () => {
    const facts = await seedProject("RULE-CORRECTION");
    const createdRule = await createRule(facts, "RULE-CORRECTION");
    await db.projectAlertRule.update({
      where: { id: createdRule.rule.id },
      data: { conditionJson: { invalid: true } }
    });
    const sourceJobId = `job-rule-correction-${suffix}`;
    await expect(
      projectAssetImpact({
        projectId: facts.project.id,
        impactId: facts.impact.id,
        eventAssessmentRevisionId: facts.impact.currentAssessmentRevisionId,
        sourceEventType: "asset.impact.assessed",
        ...projectionExecution(sourceJobId, `${sourceJobId}-blocked`)
      })
    ).resolves.toEqual({ deliveredCount: 0, blockedCount: 1, repeatedCount: 0 });
    const blocked = await db.assetImpactAlertProjectionAttempt.findFirstOrThrow({
      where: { impactId: facts.impact.id, sourceJobId, result: "BLOCKED_CONFIGURATION" }
    });
    expect(blocked).toMatchObject({
      ruleId: createdRule.rule.id,
      ruleVersion: 1,
      blockedReason: "ASSET_IMPACT_ALERT_RULE_CONDITION_INVALID"
    });

    const corrected = await updateProjectAlertRule(
      ruleUpdateInput(facts, createdRule, "rule-correction", "ENABLED")
    );
    expect(corrected.rule.version).toBe(2);
    await expect(
      projectAssetImpact({
        projectId: facts.project.id,
        impactId: facts.impact.id,
        eventAssessmentRevisionId: facts.impact.currentAssessmentRevisionId,
        sourceEventType: "asset.impact.assessed",
        ...projectionExecution(sourceJobId, `${sourceJobId}-delivered`)
      })
    ).resolves.toEqual({ deliveredCount: 1, blockedCount: 0, repeatedCount: 0 });
    const delivered = await db.assetImpactAlertProjectionAttempt.findFirstOrThrow({
      where: { impactId: facts.impact.id, sourceJobId, result: "DELIVERED" }
    });
    expect(delivered).toMatchObject({ ruleId: corrected.rule.id, ruleVersion: 2 });
    expect(delivered.idempotencyKey).not.toBe(blocked.idempotencyKey);
    await expect(
      db.assetImpactAlertProjectionAttempt.findUniqueOrThrow({ where: { id: blocked.id } })
    ).resolves.toMatchObject({
      result: "BLOCKED_CONFIGURATION",
      ruleVersion: 1,
      blockedReason: "ASSET_IMPACT_ALERT_RULE_CONDITION_INVALID"
    });

    const alert = await db.projectAlert.findFirstOrThrow({
      where: { projectId: facts.project.id, ruleId: corrected.rule.id }
    });
    await expect(
      projectAssetImpact({
        projectId: facts.project.id,
        impactId: facts.impact.id,
        eventAssessmentRevisionId: facts.impact.currentAssessmentRevisionId,
        sourceEventType: "asset.impact.assessed",
        ...projectionExecution(sourceJobId, `${sourceJobId}-replay`)
      })
    ).resolves.toEqual({ deliveredCount: 0, blockedCount: 0, repeatedCount: 1 });
    await expect(
      db.assetImpactAlertProjectionAttempt.count({ where: { impactId: facts.impact.id } })
    ).resolves.toBe(2);
    await expect(db.projectAlert.count({ where: { projectId: facts.project.id } })).resolves.toBe(
      1
    );
    await expect(db.projectAlertEvent.count({ where: { alertId: alert.id } })).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({
        where: { aggregateId: alert.id, eventType: "governance.alert.triggered" }
      })
    ).resolves.toBe(1);
  });

  it("projects every enabled rule independently", async () => {
    const facts = await seedProject("MULTI-RULE");
    await createRule(facts, "MULTI-A");
    await createRule(facts, "MULTI-B");
    await expect(
      projectAssetImpact({
        projectId: facts.project.id,
        impactId: facts.impact.id,
        eventAssessmentRevisionId: null,
        sourceEventType: "asset.impact.assessed",
        ...projectionExecution(`job-multi-${suffix}`)
      })
    ).resolves.toEqual({ deliveredCount: 2, blockedCount: 0, repeatedCount: 0 });
    await expect(db.projectAlert.count({ where: { projectId: facts.project.id } })).resolves.toBe(
      2
    );
    await expect(
      db.assetImpactAlertProjectionAttempt.count({ where: { impactId: facts.impact.id } })
    ).resolves.toBe(2);
    const attempt = await db.assetImpactAlertProjectionAttempt.findFirstOrThrow({
      where: { impactId: facts.impact.id, ruleId: { not: null } }
    });
    await expect(
      db.assetImpactAlertProjectionAttempt.create({
        data: {
          impactId: attempt.impactId,
          projectId: attempt.projectId,
          technicalAssetId: attempt.technicalAssetId,
          assessmentRevisionId: attempt.assessmentRevisionId,
          assessmentSequence: attempt.assessmentSequence,
          assessmentSnapshotChecksum: "f".repeat(64),
          assessmentSourceWatermark: attempt.assessmentSourceWatermark,
          sourceKey: attempt.sourceKey,
          desiredState: attempt.desiredState,
          sourceJobId: `direct-bad-fk-${suffix}`,
          sourceEventType: "asset.impact.assessed",
          ruleId: attempt.ruleId,
          ruleVersion: attempt.ruleVersion,
          result: "FAILED_TRANSIENT",
          idempotencyKey: `asset-impact-projection:${checksum(`bad-fk-${randomUUID()}`)}`
        }
      })
    ).rejects.toThrow(/foreign key constraint/iu);
    const databaseTimed = await db.assetImpactAlertProjectionAttempt.create({
      data: {
        impactId: attempt.impactId,
        projectId: attempt.projectId,
        technicalAssetId: attempt.technicalAssetId,
        assessmentRevisionId: attempt.assessmentRevisionId,
        assessmentSequence: attempt.assessmentSequence,
        assessmentSnapshotChecksum: attempt.assessmentSnapshotChecksum,
        assessmentSourceWatermark: attempt.assessmentSourceWatermark,
        sourceKey: attempt.sourceKey,
        desiredState: attempt.desiredState,
        sourceJobId: `direct-db-time-${suffix}`,
        sourceEventType: "asset.impact.assessed",
        ruleId: attempt.ruleId,
        ruleVersion: attempt.ruleVersion,
        result: "FAILED_TRANSIENT",
        idempotencyKey: `asset-impact-projection:${checksum(`db-time-${randomUUID()}`)}`,
        createdAt: new Date("2000-01-01T00:00:00.000Z")
      }
    });
    expect(databaseTimed.createdAt.getUTCFullYear()).toBeGreaterThan(2025);
  });

  it("serializes rule disablement with projection in either commit order", async () => {
    const projectionFirstFacts = await seedProject("RULE-RACE-PROJECTION");
    const projectionFirstRule = await createRule(projectionFirstFacts, "RULE-RACE-PROJECTION");
    const projectionLocked = gate();
    const releaseProjection = gate();
    const projectionFirst = db.$transaction(async (client) => {
      await client.$queryRaw`
        SELECT "id" FROM "projects"
        WHERE "id" = ${projectionFirstFacts.project.id}
        FOR UPDATE
      `;
      await client.$queryRaw`
        SELECT "id" FROM "project_alert_rules"
        WHERE "id" = ${projectionFirstRule.rule.id}
        FOR UPDATE
      `;
      projectionLocked.release();
      await releaseProjection.promise;
      return projectAssetImpact(
        {
          projectId: projectionFirstFacts.project.id,
          impactId: projectionFirstFacts.impact.id,
          eventAssessmentRevisionId: projectionFirstFacts.impact.currentAssessmentRevisionId,
          sourceEventType: "asset.impact.assessed",
          ...projectionExecution(`job-rule-race-projection-${suffix}`)
        },
        client
      );
    });
    await projectionLocked.promise;
    const disableAfterProjection = updateProjectAlertRule(
      ruleUpdateInput(projectionFirstFacts, projectionFirstRule, "projection-first")
    );
    releaseProjection.release();
    await expect(Promise.all([projectionFirst, disableAfterProjection])).resolves.toBeDefined();
    await expect(
      db.projectAlert.count({
        where: {
          projectId: projectionFirstFacts.project.id,
          status: { in: ["TRIGGERED", "ACKNOWLEDGED", "IN_PROGRESS"] }
        }
      })
    ).resolves.toBe(0);

    const disableFirstFacts = await seedProject("RULE-RACE-DISABLE");
    const disableFirstRule = await createRule(disableFirstFacts, "RULE-RACE-DISABLE");
    const disableLocked = gate();
    const releaseDisable = gate();
    const disableFirst = db.$transaction(async (client) => {
      await client.$queryRaw`
        SELECT "id" FROM "projects"
        WHERE "id" = ${disableFirstFacts.project.id}
        FOR UPDATE
      `;
      await client.$queryRaw`
        SELECT "id" FROM "project_alert_rules"
        WHERE "id" = ${disableFirstRule.rule.id}
        FOR UPDATE
      `;
      disableLocked.release();
      await releaseDisable.promise;
      return updateProjectAlertRule(
        ruleUpdateInput(disableFirstFacts, disableFirstRule, "disable-first"),
        client
      );
    });
    await disableLocked.promise;
    const projectionAfterDisable = projectAssetImpact({
      projectId: disableFirstFacts.project.id,
      impactId: disableFirstFacts.impact.id,
      eventAssessmentRevisionId: disableFirstFacts.impact.currentAssessmentRevisionId,
      sourceEventType: "asset.impact.assessed",
      ...projectionExecution(`job-rule-race-disable-${suffix}`)
    });
    releaseDisable.release();
    await expect(Promise.all([disableFirst, projectionAfterDisable])).resolves.toBeDefined();
    await expect(
      db.projectAlert.count({ where: { projectId: disableFirstFacts.project.id } })
    ).resolves.toBe(0);
  });

  it("rolls back Alert, event, audit, and attempt when success Outbox conflicts", async () => {
    const facts = await seedProject("ROLLBACK");
    const createdRule = await createRule(facts, "ROLLBACK");
    const assessment = await db.assetImpactAssessmentRevision.findUniqueOrThrow({
      where: { id: facts.impact.currentAssessmentRevisionId as string }
    });
    const attemptKey = buildAssetImpactProjectionAttemptKey({
      impactId: facts.impact.id,
      assessmentRevisionId: assessment.id,
      assessmentSequence: assessment.sequence,
      snapshotChecksum: assessment.snapshotChecksum,
      sourceWatermark: assessment.sourceWatermark,
      desiredState: "ACTIVE",
      sourceJobId: `job-rollback-${suffix}`,
      sourceEventType: "asset.impact.assessed",
      ruleId: createdRule.rule.id,
      ruleVersion: createdRule.rule.version
    });
    await db.$transaction((client) =>
      appendOutboxEvent(client, {
        eventType: "governance.alert.triggered",
        aggregateType: "CONFLICT",
        aggregateId: "conflict",
        idempotencyKey: `${attemptKey}:triggered`,
        payload: { conflict: true }
      })
    );
    await expect(
      projectAssetImpact({
        projectId: facts.project.id,
        impactId: facts.impact.id,
        eventAssessmentRevisionId: null,
        sourceEventType: "asset.impact.assessed",
        ...projectionExecution(`job-rollback-${suffix}`)
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(db.projectAlert.count({ where: { projectId: facts.project.id } })).resolves.toBe(
      0
    );
    await expect(
      db.assetImpactAlertProjectionAttempt.count({ where: { impactId: facts.impact.id } })
    ).resolves.toBe(0);
    await expect(
      db.auditLog.count({
        where: {
          projectId: facts.project.id,
          action: { in: ["ALERT_TRIGGERED", "ASSET_IMPACT_ALERT_PROJECTED"] }
        }
      })
    ).resolves.toBe(0);
  });

  it("materializes an AST Outbox identity payload through the registered worker", async () => {
    const facts = await seedProject("WORKER");
    await createRule(facts, "WORKER");
    const sourceEvent = await db.$transaction((client) =>
      appendOutboxEvent(client, {
        eventType: "asset.impact.assessed",
        aggregateType: "ASSET_PROJECT_IMPACT",
        aggregateId: facts.impact.id,
        idempotencyKey: `worker-source-${facts.impact.id}`,
        traceId: checksum(`worker-trace-${facts.impact.id}`).slice(0, 32),
        payload: {
          projectId: facts.project.id,
          impactId: facts.impact.id,
          assessmentRevisionId: facts.impact.currentAssessmentRevisionId,
          toStatus: "CLOSED",
          ownerMembershipId: "untrusted"
        }
      })
    );
    const batch = await runJobBatch({
      workerId: `asset-impact-worker-${suffix}`,
      handlers: createGovernanceJobHandlers(),
      policy: {
        claimBatchSize: 500,
        leaseSeconds: 60,
        retryBaseSeconds: 1,
        retryMaxSeconds: 10,
        defaultMaxAttempts: 5
      }
    });
    expect(batch.outcomes).toContainEqual(expect.objectContaining({ status: "SUCCEEDED" }));
    const job = await db.persistentJob.findUniqueOrThrow({
      where: { sourceOutboxEventId: sourceEvent.id }
    });
    expect(job).toMatchObject({ status: "SUCCEEDED" });
    const jobAttempt = await db.jobAttempt.findFirstOrThrow({ where: { jobId: job.id } });
    await expect(
      db.auditLog.findFirstOrThrow({
        where: { action: "ASSET_IMPACT_ALERT_PROJECTED", requestId: job.id }
      })
    ).resolves.toMatchObject({
      operationId: jobAttempt.id,
      traceId: job.traceId,
      afterJson: expect.objectContaining({
        sourceJobId: job.id,
        sourceEventType: "asset.impact.assessed"
      })
    });
    await expect(db.projectAlert.count({ where: { projectId: facts.project.id } })).resolves.toBe(
      1
    );
  });
});
