import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  publishProjectTemplate,
  publishTemplateComponent,
  saveProjectTemplateDraft,
  saveTemplateComponentDraft
} from "@/modules/configuration/application/template-service";
import { createProjectFromTemplate } from "@/modules/projects/application/create-project";
import { initializeProjectStructure } from "@/modules/projects/application/project-structure";
import { executeIdempotentCommand } from "@/modules/platform-api/application/idempotent-command";

import { createGateInstance, runGateChecks } from "../application/gate-service";
import {
  decideGateSubmission,
  resubmitGateSubmission,
  submitGateSubmission,
  withdrawGateSubmission
} from "../application/gate-submission-service";
import {
  conditionallyReleaseGate,
  startResidualItem,
  submitResidualItemVerification,
  verifyResidualItem
} from "../application/gate-conditional-release-service";
import { GET as listProjectGatesRoute } from "../../../app/api/projects/[projectId]/gates/route";
import { POST as createGateInstanceRoute } from "../../../app/api/projects/[projectId]/gate-instances/route";
import { POST as runGateChecksRoute } from "../../../app/api/projects/[projectId]/gate-instances/[instanceId]/checks/route";
import { POST as submitGateSubmissionRoute } from "../../../app/api/projects/[projectId]/gate-instances/[instanceId]/submissions/route";
import { POST as approveGateSubmissionRoute } from "../../../app/api/projects/[projectId]/gate-submissions/[submissionId]/approve/route";
import { POST as conditionalReleaseRoute } from "../../../app/api/projects/[projectId]/gate-submissions/[submissionId]/conditional-release/route";
import { POST as startResidualItemRoute } from "../../../app/api/projects/[projectId]/residual-items/[residualItemId]/start/route";
import { POST as submitResidualItemVerificationRoute } from "../../../app/api/projects/[projectId]/residual-items/[residualItemId]/submit-verification/route";
import { POST as verifyResidualItemRoute } from "../../../app/api/projects/[projectId]/residual-items/[residualItemId]/verify/route";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `gate-admin-${suffix}`,
  projectManager: `gate-project-manager-${suffix}`,
  quality: `gate-quality-${suffix}`,
  departmentLead: `gate-department-lead-${suffix}`,
  outsider: `gate-outsider-${suffix}`
};

function commandRequest(url: string, body: unknown, key: string, actorId?: string) {
  const headers = new Headers({
    "content-type": "application/json",
    "idempotency-key": key,
    "x-request-id": `request-${key}`
  });
  if (actorId) headers.set("x-apm-user-id", actorId);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

function readRequest(url: string, actorId?: string) {
  const headers = new Headers({ "x-request-id": `request-gate-list-${suffix}` });
  if (actorId) headers.set("x-apm-user-id", actorId);
  return new Request(url, { method: "GET", headers });
}

function auditContext(operationId: string, projectId: string | null = null): AuditContext {
  return {
    actorId: ids.admin,
    requestId: `request-${operationId}`,
    traceId: `trace-${operationId}`,
    source: "API",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId,
    departmentId: "engineering",
    operationId
  };
}

function componentDefinition(type: "STAGE" | "GATE" | "ROLE" | "WBS") {
  switch (type) {
    case "STAGE":
      return {
        stages: [
          { code: "S0", name: "Project kickoff", sequence: 0 },
          { code: "S1", name: "Requirements freeze", sequence: 1 }
        ]
      };
    case "GATE":
      return {
        gates: [
          {
            code: "G.PROJECT",
            name: "Project baseline",
            stageCode: "S0",
            requiredCheckerCodes: ["STAGE.AWAITING_GATE"],
            approval: { mode: "ALL", projectRoles: ["QUALITY", "DEPARTMENT_LEAD"] }
          },
          {
            code: "G.ANY",
            name: "Project fast approval",
            stageCode: "S0",
            requiredCheckerCodes: ["STAGE.AWAITING_GATE"],
            approval: { mode: "ANY", projectRoles: ["QUALITY", "DEPARTMENT_LEAD"] }
          },
          {
            code: "G.DU",
            name: "Delivery-unit check",
            stageCode: "S0",
            scope: "DELIVERY_UNIT",
            checkers: [{ code: "STAGE.AWAITING_GATE", version: 1 }]
          },
          {
            code: "G.MODULE",
            name: "Module check",
            stageCode: "S0",
            scope: "MODULE",
            checkers: [{ code: "STAGE.AWAITING_GATE", version: 1 }]
          },
          {
            code: "G.DEPENDENCY",
            name: "Unavailable dependency",
            stageCode: "S0",
            scope: "DELIVERY_UNIT",
            checkers: [{ code: "DOCUMENTS.COMPLETE", version: 1 }]
          }
        ]
      };
    case "ROLE":
      return { roles: [{ code: "PROJECT_MANAGER", name: "Project manager", required: true }] };
    case "WBS":
      return {
        packages: [{ code: "S0.KICKOFF", name: "Project kickoff", stageCode: "S0", weight: 1 }]
      };
  }
}

async function seedTemplate() {
  const components = await Promise.all(
    (["STAGE", "GATE", "ROLE", "WBS"] as const).map(async (componentType) => {
      const code = `APM031.GATE.${componentType}.${suffix}`.toUpperCase();
      const draft = await saveTemplateComponentDraft({
        code,
        componentType,
        name: `${componentType} Gate integration`,
        content: componentDefinition(componentType),
        version: 0,
        reason: "Create Gate integration component",
        actorId: ids.admin,
        auditContext: auditContext(`component-draft-${componentType}`)
      });
      return (
        await publishTemplateComponent({
          code,
          version: draft.component.version,
          reason: "Publish Gate integration component",
          actorId: ids.admin,
          auditContext: auditContext(`component-publish-${componentType}`)
        })
      ).publishedVersion;
    })
  );
  const code = `APM031.GATE.TEMPLATE.${suffix}`.toUpperCase();
  const draft = await saveProjectTemplateDraft({
    code,
    name: "APM-031 Gate integration template",
    components: components.map((component, position) => ({
      componentVersionId: component.id,
      componentType: component.componentType,
      slot: `${component.componentType}.${position}`,
      position
    })),
    version: 0,
    reason: "Create Gate integration template",
    actorId: ids.admin,
    auditContext: auditContext("template-draft")
  });
  return {
    code,
    ...(await publishProjectTemplate({
      code,
      version: draft.template.version,
      reason: "Publish Gate integration template",
      actorId: ids.admin,
      auditContext: auditContext("template-publish")
    }))
  };
}

async function seedProject(label: string) {
  const created = await createProjectFromTemplate({
    code: `P31.GATE.${label}.${suffix}`.toUpperCase(),
    name: `${label} Gate project`,
    departmentId: "engineering",
    templateCode: template.code,
    templateVersion: template.publishedVersion.version,
    templateChecksum: template.publishedVersion.checksum,
    reason: "Create Gate integration project",
    actorId: ids.admin,
    auditContext: auditContext(`project-create-${label}`)
  });
  await db.projectMember.create({
    data: {
      projectId: created.project.id,
      userId: ids.projectManager,
      projectRole: "PROJECT_MANAGER",
      departmentId: "engineering",
      assignedById: ids.admin
    }
  });
  const structure = await initializeProjectStructure({
    projectId: created.project.id,
    projectVersion: created.project.version,
    projectType: "CUSTOMER_DELIVERY",
    equipmentShape: "SINGLE_MACHINE",
    deliveryUnits: [
      {
        code: `MACHINE.${label}`.toUpperCase(),
        name: `${label} machine`,
        unitType: "MACHINE",
        parentCode: null,
        position: 0
      }
    ],
    modules: [
      {
        code: `MODULE.${label}`.toUpperCase(),
        name: `${label} module`,
        machineCode: `MACHINE.${label}`.toUpperCase(),
        position: 0
      }
    ],
    reason: "Initialize Gate integration structure",
    actorId: ids.admin,
    auditContext: auditContext(`structure-${label}`, created.project.id)
  });
  const [stage, projectModule] = await Promise.all([
    db.projectStage.findFirstOrThrow({ where: { projectId: created.project.id, code: "S0" } }),
    db.projectModule.findFirstOrThrow({ where: { projectId: created.project.id } })
  ]);
  const deliveryUnit = structure.deliveryUnits[0];
  if (!deliveryUnit) throw new Error("Gate integration seed requires a delivery unit.");
  return { project: created.project, stage, deliveryUnit, projectModule };
}

let template: Awaited<ReturnType<typeof seedTemplate>>;

describeDatabase("APM-031 PostgreSQL Gate instances and check snapshots", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `GATE-ADMIN-${suffix}`,
          name: "Gate integration administrator",
          departmentId: "engineering"
        },
        {
          id: ids.projectManager,
          employeeNo: `GATE-PM-${suffix}`,
          name: "Gate integration project manager",
          departmentId: "engineering"
        },
        {
          id: ids.quality,
          employeeNo: `GATE-QUALITY-${suffix}`,
          name: "Gate integration quality reviewer",
          departmentId: "engineering"
        },
        {
          id: ids.departmentLead,
          employeeNo: `GATE-LEAD-${suffix}`,
          name: "Gate integration department reviewer",
          departmentId: "engineering"
        },
        {
          id: ids.outsider,
          employeeNo: `GATE-OUTSIDER-${suffix}`,
          name: "Gate integration outsider",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `gate-role-admin-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        {
          id: `gate-role-project-manager-${suffix}`,
          userId: ids.projectManager,
          roleId: "role-project-manager"
        },
        { id: `gate-role-quality-${suffix}`, userId: ids.quality, roleId: "role-quality" },
        {
          id: `gate-role-department-lead-${suffix}`,
          userId: ids.departmentLead,
          roleId: "role-department-lead"
        },
        { id: `gate-role-outsider-${suffix}`, userId: ids.outsider, roleId: "role-engineer" }
      ]
    });
    template = await seedTemplate();
  });

  it("creates only same-project delivery-unit and module instances, then rejects invalid or duplicate targets", async () => {
    const facts = await seedProject("INSTANCE");
    const [duDefinition, moduleDefinition, projectDefinition] = await Promise.all([
      db.projectGateDefinition.findFirstOrThrow({
        where: { projectId: facts.project.id, code: "G.DU" }
      }),
      db.projectGateDefinition.findFirstOrThrow({
        where: { projectId: facts.project.id, code: "G.MODULE" }
      }),
      db.projectGateDefinition.findFirstOrThrow({
        where: { projectId: facts.project.id, code: "G.PROJECT" }
      })
    ]);
    const du = await createGateInstance({
      projectId: facts.project.id,
      gateDefinitionId: duDefinition.id,
      scope: "DELIVERY_UNIT",
      deliveryUnitId: facts.deliveryUnit.id,
      moduleId: null,
      actorId: ids.admin,
      auditContext: auditContext("create-du", facts.project.id)
    });
    const moduleInstance = await createGateInstance({
      projectId: facts.project.id,
      gateDefinitionId: moduleDefinition.id,
      scope: "MODULE",
      deliveryUnitId: facts.deliveryUnit.id,
      moduleId: facts.projectModule.id,
      actorId: ids.admin,
      auditContext: auditContext("create-module", facts.project.id)
    });
    expect(du.gateInstance).toMatchObject({
      scope: "DELIVERY_UNIT",
      deliveryUnitId: facts.deliveryUnit.id,
      moduleId: null,
      version: 1
    });
    expect(moduleInstance.gateInstance).toMatchObject({
      scope: "MODULE",
      deliveryUnitId: facts.deliveryUnit.id,
      moduleId: facts.projectModule.id,
      version: 1
    });
    await expect(
      createGateInstance({
        projectId: facts.project.id,
        gateDefinitionId: projectDefinition.id,
        scope: "PROJECT",
        deliveryUnitId: null,
        moduleId: null,
        actorId: ids.admin,
        auditContext: auditContext("manual-project", facts.project.id)
      })
    ).rejects.toMatchObject({ code: "GATE_PROJECT_INSTANCE_MANUAL_FORBIDDEN", status: 409 });
    await expect(
      createGateInstance({
        projectId: facts.project.id,
        gateDefinitionId: duDefinition.id,
        scope: "DELIVERY_UNIT",
        deliveryUnitId: facts.deliveryUnit.id,
        moduleId: facts.projectModule.id,
        actorId: ids.admin,
        auditContext: auditContext("bad-shape", facts.project.id)
      })
    ).rejects.toMatchObject({ code: "GATE_SCOPE_TARGET_INVALID", status: 422 });
    await expect(
      createGateInstance({
        projectId: facts.project.id,
        gateDefinitionId: duDefinition.id,
        scope: "DELIVERY_UNIT",
        deliveryUnitId: facts.deliveryUnit.id,
        moduleId: null,
        actorId: ids.admin,
        auditContext: auditContext("duplicate", facts.project.id)
      })
    ).rejects.toMatchObject({ code: "GATE_INSTANCE_CONFLICT", status: 409 });
  });

  it("hides foreign Gate definitions and targets and rolls their attempted facts back", async () => {
    const local = await seedProject("LOCAL");
    const foreign = await seedProject("FOREIGN");
    const localDefinition = await db.projectGateDefinition.findFirstOrThrow({
      where: { projectId: local.project.id, code: "G.DU" }
    });
    const foreignDefinition = await db.projectGateDefinition.findFirstOrThrow({
      where: { projectId: foreign.project.id, code: "G.DU" }
    });
    const auditsBefore = await db.auditLog.count({
      where: { projectId: local.project.id, action: "GATE_INSTANCE_CREATED" }
    });
    await expect(
      createGateInstance({
        projectId: local.project.id,
        gateDefinitionId: foreignDefinition.id,
        scope: "DELIVERY_UNIT",
        deliveryUnitId: local.deliveryUnit.id,
        moduleId: null,
        actorId: ids.admin,
        auditContext: auditContext("foreign-definition", local.project.id)
      })
    ).rejects.toMatchObject({ code: "GATE_DEFINITION_NOT_FOUND", status: 404 });
    await expect(
      createGateInstance({
        projectId: local.project.id,
        gateDefinitionId: localDefinition.id,
        scope: "DELIVERY_UNIT",
        deliveryUnitId: foreign.deliveryUnit.id,
        moduleId: null,
        actorId: ids.admin,
        auditContext: auditContext("foreign-target", local.project.id)
      })
    ).rejects.toMatchObject({ code: "GATE_SCOPE_TARGET_INVALID", status: 409 });
    await expect(
      db.projectGateInstance.count({
        where: { projectId: local.project.id, gateDefinitionId: localDefinition.id }
      })
    ).resolves.toBe(0);
    await expect(
      db.auditLog.count({ where: { projectId: local.project.id, action: "GATE_INSTANCE_CREATED" } })
    ).resolves.toBe(auditsBefore);
  });

  it("requires an awaiting stage, appends immutable deterministic snapshots, and reports unavailable dependencies", async () => {
    const facts = await seedProject("CHECKS");
    const [duDefinition, dependencyDefinition] = await Promise.all([
      db.projectGateDefinition.findFirstOrThrow({
        where: { projectId: facts.project.id, code: "G.DU" }
      }),
      db.projectGateDefinition.findFirstOrThrow({
        where: { projectId: facts.project.id, code: "G.DEPENDENCY" }
      })
    ]);
    const instance = await createGateInstance({
      projectId: facts.project.id,
      gateDefinitionId: duDefinition.id,
      scope: "DELIVERY_UNIT",
      deliveryUnitId: facts.deliveryUnit.id,
      moduleId: null,
      actorId: ids.admin,
      auditContext: auditContext("check-instance", facts.project.id)
    });
    await expect(
      runGateChecks({
        projectId: facts.project.id,
        gateInstanceId: instance.gateInstance.id,
        version: instance.resourceVersion,
        reason: "Run Gate checks too early",
        actorId: ids.admin,
        auditContext: auditContext("check-early", facts.project.id)
      })
    ).rejects.toMatchObject({ code: "GATE_STAGE_NOT_AWAITING", status: 409 });
    await db.deliveryUnitStage.updateMany({
      where: {
        projectId: facts.project.id,
        deliveryUnitId: facts.deliveryUnit.id,
        projectStageId: facts.stage.id
      },
      data: { status: "AWAITING_GATE", updatedById: ids.admin, version: { increment: 1 } }
    });
    const first = await runGateChecks({
      projectId: facts.project.id,
      gateInstanceId: instance.gateInstance.id,
      version: instance.resourceVersion,
      reason: "Run frozen Gate checks",
      actorId: ids.admin,
      auditContext: auditContext("check-first", facts.project.id)
    });
    const second = await runGateChecks({
      projectId: facts.project.id,
      gateInstanceId: instance.gateInstance.id,
      version: first.resourceVersion,
      reason: "Run frozen Gate checks",
      actorId: ids.admin,
      auditContext: auditContext("check-second", facts.project.id)
    });
    expect(first.gateCheckSnapshot).toMatchObject({ sequence: 1, status: "PASSED" });
    expect(second.gateCheckSnapshot).toMatchObject({
      sequence: 2,
      status: "PASSED",
      inputChecksum: first.gateCheckSnapshot.inputChecksum,
      resultChecksum: first.gateCheckSnapshot.resultChecksum
    });
    await expect(
      runGateChecks({
        projectId: facts.project.id,
        gateInstanceId: instance.gateInstance.id,
        version: instance.resourceVersion,
        reason: "Stale optimistic check",
        actorId: ids.admin,
        auditContext: auditContext("check-stale", facts.project.id)
      })
    ).rejects.toMatchObject({ code: "GATE_VERSION_CONFLICT", status: 409 });
    const unavailable = await createGateInstance({
      projectId: facts.project.id,
      gateDefinitionId: dependencyDefinition.id,
      scope: "DELIVERY_UNIT",
      deliveryUnitId: facts.deliveryUnit.id,
      moduleId: null,
      actorId: ids.admin,
      auditContext: auditContext("dependency-instance", facts.project.id)
    });
    const dependency = await runGateChecks({
      projectId: facts.project.id,
      gateInstanceId: unavailable.gateInstance.id,
      version: unavailable.resourceVersion,
      reason: "Check unavailable dependency",
      actorId: ids.admin,
      auditContext: auditContext("dependency-check", facts.project.id)
    });
    expect(dependency.gateCheckSnapshot.status).toBe("HARD_FAILED");
    expect(dependency.results).toEqual([
      expect.objectContaining({
        failureCode: "CHECKER_DEPENDENCY_UNAVAILABLE",
        status: "HARD_FAILED"
      })
    ]);
    await expect(
      db.gateCheckSnapshot.update({
        where: { id: first.gateCheckSnapshot.id },
        data: { reason: "mutate" }
      })
    ).rejects.toThrow(/append-only/u);
    await expect(
      db.gateCheckResult.deleteMany({ where: { gateCheckSnapshotId: first.gateCheckSnapshot.id } })
    ).rejects.toThrow(/append-only|durable/u);
  });

  it("keeps Gate facts, audit, Outbox, and idempotent replay in the same transaction", async () => {
    const facts = await seedProject("TRANSACTION");
    const definition = await db.projectGateDefinition.findFirstOrThrow({
      where: { projectId: facts.project.id, code: "G.DU" }
    });
    const auditOperation = `gate-rollback-${suffix}`;
    const before = await Promise.all([
      db.projectGateInstance.count({
        where: { projectId: facts.project.id, gateDefinitionId: definition.id }
      }),
      db.auditLog.count({ where: { operationId: auditOperation } }),
      db.outboxEvent.count({ where: { eventType: "gate.instance.created" } })
    ]);
    await expect(
      db.$transaction(async (transaction) => {
        await createGateInstance(
          {
            projectId: facts.project.id,
            gateDefinitionId: definition.id,
            scope: "DELIVERY_UNIT",
            deliveryUnitId: facts.deliveryUnit.id,
            moduleId: null,
            actorId: ids.admin,
            auditContext: auditContext(auditOperation, facts.project.id)
          },
          transaction
        );
        throw new Error("force Gate rollback");
      })
    ).rejects.toThrow("force Gate rollback");
    await expect(
      Promise.all([
        db.projectGateInstance.count({
          where: { projectId: facts.project.id, gateDefinitionId: definition.id }
        }),
        db.auditLog.count({ where: { operationId: auditOperation } }),
        db.outboxEvent.count({ where: { eventType: "gate.instance.created" } })
      ])
    ).resolves.toEqual(before);
    const operation = `gate-create-${suffix}`;
    const request = {
      definitionId: definition.id,
      scope: "DELIVERY_UNIT",
      deliveryUnitId: facts.deliveryUnit.id
    };
    const command = () =>
      executeIdempotentCommand({
        actorId: ids.admin,
        operation,
        idempotencyKey: `gate-key-${suffix}`,
        request,
        execute: async (transaction) => {
          const result = await createGateInstance(
            {
              projectId: facts.project.id,
              gateDefinitionId: definition.id,
              scope: "DELIVERY_UNIT",
              deliveryUnitId: facts.deliveryUnit.id,
              moduleId: null,
              actorId: ids.admin,
              auditContext: auditContext(operation, facts.project.id)
            },
            transaction
          );
          return { status: 201, body: result };
        }
      });
    const [first, replay] = await Promise.all([command(), command()]);
    expect(replay.replayed || first.replayed).toBe(true);
    expect(first.body).toEqual(replay.body);
    await expect(
      db.projectGateInstance.count({
        where: { projectId: facts.project.id, gateDefinitionId: definition.id }
      })
    ).resolves.toBe(1);
    await expect(
      db.auditLog.count({ where: { operationId: operation, action: "GATE_INSTANCE_CREATED" } })
    ).resolves.toBe(1);
    await expect(
      db.outboxEvent.count({ where: { eventType: "gate.instance.created" } })
    ).resolves.toBeGreaterThanOrEqual(1);
  });

  it("rolls back and idempotently replays a Gate check run as one fact set", async () => {
    const facts = await seedProject("CHECK-TRANSACTION");
    const definition = await db.projectGateDefinition.findFirstOrThrow({
      where: { projectId: facts.project.id, code: "G.DU" }
    });
    const instance = await createGateInstance({
      projectId: facts.project.id,
      gateDefinitionId: definition.id,
      scope: "DELIVERY_UNIT",
      deliveryUnitId: facts.deliveryUnit.id,
      moduleId: null,
      actorId: ids.admin,
      auditContext: auditContext("check-transaction-instance", facts.project.id)
    });
    await db.deliveryUnitStage.updateMany({
      where: {
        projectId: facts.project.id,
        deliveryUnitId: facts.deliveryUnit.id,
        projectStageId: facts.stage.id
      },
      data: { status: "AWAITING_GATE", updatedById: ids.admin, version: { increment: 1 } }
    });

    const rollbackOperation = `gate-check-rollback-${suffix}`;
    const beforeRollback = await Promise.all([
      db.gateCheckSnapshot.count({ where: { gateInstanceId: instance.gateInstance.id } }),
      db.gateCheckResult.count({ where: { projectId: facts.project.id } }),
      db.auditLog.count({ where: { operationId: rollbackOperation } }),
      db.outboxEvent.count({ where: { eventType: "gate.check-run.completed" } })
    ]);
    await expect(
      db.$transaction(async (transaction) => {
        await runGateChecks(
          {
            projectId: facts.project.id,
            gateInstanceId: instance.gateInstance.id,
            version: instance.resourceVersion,
            reason: "Run Gate checks before forcing a rollback",
            actorId: ids.admin,
            auditContext: auditContext(rollbackOperation, facts.project.id)
          },
          transaction
        );
        throw new Error("force Gate check rollback");
      })
    ).rejects.toThrow("force Gate check rollback");
    await expect(
      Promise.all([
        db.gateCheckSnapshot.count({ where: { gateInstanceId: instance.gateInstance.id } }),
        db.gateCheckResult.count({ where: { projectId: facts.project.id } }),
        db.auditLog.count({ where: { operationId: rollbackOperation } }),
        db.outboxEvent.count({ where: { eventType: "gate.check-run.completed" } })
      ])
    ).resolves.toEqual(beforeRollback);
    await expect(
      db.projectGateInstance.findUniqueOrThrow({ where: { id: instance.gateInstance.id } })
    ).resolves.toMatchObject({ checkRunSequence: 0, version: instance.resourceVersion });

    const operation = `gate-check-${suffix}`;
    const request = {
      gateInstanceId: instance.gateInstance.id,
      version: instance.resourceVersion,
      reason: "Run Gate checks through the idempotency boundary"
    };
    const command = () =>
      executeIdempotentCommand({
        actorId: ids.admin,
        operation,
        idempotencyKey: `gate-check-key-${suffix}`,
        request,
        execute: async (transaction) => ({
          status: 200,
          body: await runGateChecks(
            {
              projectId: facts.project.id,
              ...request,
              actorId: ids.admin,
              auditContext: auditContext(operation, facts.project.id)
            },
            transaction
          )
        })
      });
    const [first, replay] = await Promise.all([command(), command()]);
    expect(replay.replayed || first.replayed).toBe(true);
    expect(first.body).toEqual(replay.body);

    const snapshot = await db.gateCheckSnapshot.findFirstOrThrow({
      where: { gateInstanceId: instance.gateInstance.id }
    });
    await expect(
      Promise.all([
        db.gateCheckSnapshot.count({ where: { gateInstanceId: instance.gateInstance.id } }),
        db.gateCheckResult.count({ where: { gateCheckSnapshotId: snapshot.id } }),
        db.auditLog.count({
          where: { operationId: operation, action: "GATE_CHECK_RUN_COMPLETED" }
        }),
        db.outboxEvent.count({
          where: { eventType: "gate.check-run.completed", aggregateId: snapshot.id }
        }),
        db.projectGateInstance.findUniqueOrThrow({ where: { id: instance.gateInstance.id } })
      ])
    ).resolves.toEqual([
      1,
      1,
      1,
      1,
      expect.objectContaining({ checkRunSequence: 1, version: instance.resourceVersion + 1 })
    ]);
  });

  it("enforces Gate list authorization and keeps returned definitions project-scoped", async () => {
    const local = await seedProject("LIST");
    const foreign = await seedProject("LIST-FOREIGN");
    const url = `http://localhost/api/projects/${local.project.id}/gates`;
    const context = { params: Promise.resolve({ projectId: local.project.id }) };

    const unauthenticated = await listProjectGatesRoute(new Request(url), context);
    const forbidden = await listProjectGatesRoute(readRequest(url, ids.outsider), context);
    const authorized = await listProjectGatesRoute(readRequest(url, ids.admin), context);

    expect(unauthenticated.status).toBe(401);
    expect(forbidden.status).toBe(403);
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({
      definitions: expect.arrayContaining([
        expect.objectContaining({ projectId: local.project.id, code: "G.PROJECT" })
      ])
    });
    const listResponse = await listProjectGatesRoute(readRequest(url, ids.admin), context);
    const body = (await listResponse.json()) as { definitions: Array<{ projectId: string }> };
    expect(body.definitions).toHaveLength(5);
    expect(body.definitions).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ projectId: foreign.project.id })])
    );
  });

  it("enforces internal Gate API authorization, hidden relations, conflicts, and replay", async () => {
    const facts = await seedProject("API");
    const foreign = await seedProject("API-FOREIGN");
    const definition = await db.projectGateDefinition.findFirstOrThrow({
      where: { projectId: facts.project.id, code: "G.DU" }
    });
    await db.projectMember.create({
      data: {
        projectId: facts.project.id,
        userId: ids.outsider,
        projectRole: "ENGINEER",
        departmentId: "engineering",
        assignedById: ids.admin
      }
    });
    const instanceUrl = `http://localhost/api/projects/${facts.project.id}/gate-instances`;
    const instanceContext = { params: Promise.resolve({ projectId: facts.project.id }) };
    const payload = {
      definitionId: definition.id,
      scope: "DELIVERY_UNIT" as const,
      deliveryUnitId: facts.deliveryUnit.id
    };
    const unauthenticated = await createGateInstanceRoute(
      commandRequest(instanceUrl, payload, `gate-api-unauth-${suffix}`),
      instanceContext
    );
    const forbidden = await createGateInstanceRoute(
      commandRequest(instanceUrl, payload, `gate-api-forbidden-${suffix}`, ids.outsider),
      instanceContext
    );
    const administratorForbidden = await createGateInstanceRoute(
      commandRequest(instanceUrl, payload, `gate-api-administrator-${suffix}`, ids.admin),
      instanceContext
    );
    expect(unauthenticated.status).toBe(401);
    expect(forbidden.status).toBe(403);
    expect(administratorForbidden.status).toBe(403);

    const key = `gate-api-create-${suffix}`;
    const first = await createGateInstanceRoute(
      commandRequest(instanceUrl, payload, key, ids.projectManager),
      instanceContext
    );
    const replay = await createGateInstanceRoute(
      commandRequest(instanceUrl, payload, key, ids.projectManager),
      instanceContext
    );
    const duplicate = await createGateInstanceRoute(
      commandRequest(instanceUrl, payload, `gate-api-duplicate-${suffix}`, ids.projectManager),
      instanceContext
    );
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(duplicate.status).toBe(409);
    const created = (await first.json()) as {
      gateInstance: { id: string; version: number };
      auditId: string;
    };
    expect(created.auditId).toEqual(expect.any(String));

    const crossProject = await runGateChecksRoute(
      commandRequest(
        `http://localhost/api/projects/${foreign.project.id}/gate-instances/${created.gateInstance.id}/checks`,
        { version: created.gateInstance.version, reason: "Attempt foreign Gate check" },
        `gate-api-cross-project-${suffix}`,
        ids.projectManager
      ),
      {
        params: Promise.resolve({
          projectId: foreign.project.id,
          instanceId: created.gateInstance.id
        })
      }
    );
    expect(crossProject.status).toBe(404);

    await db.deliveryUnitStage.updateMany({
      where: {
        projectId: facts.project.id,
        deliveryUnitId: facts.deliveryUnit.id,
        projectStageId: facts.stage.id
      },
      data: { status: "AWAITING_GATE", updatedById: ids.admin, version: { increment: 1 } }
    });
    const checkUrl = `http://localhost/api/projects/${facts.project.id}/gate-instances/${created.gateInstance.id}/checks`;
    const checkContext = {
      params: Promise.resolve({ projectId: facts.project.id, instanceId: created.gateInstance.id })
    };
    const checkPayload = {
      version: created.gateInstance.version,
      reason: "Run Gate checks from API"
    };
    const checkKey = `gate-api-check-${suffix}`;
    const checked = await runGateChecksRoute(
      commandRequest(checkUrl, checkPayload, checkKey, ids.projectManager),
      checkContext
    );
    const checkedReplay = await runGateChecksRoute(
      commandRequest(checkUrl, checkPayload, checkKey, ids.projectManager),
      checkContext
    );
    expect(checked.status).toBe(200);
    expect(checkedReplay.status).toBe(200);
    expect(checkedReplay.headers.get("idempotency-replayed")).toBe("true");
    await expect(
      db.auditLog.count({
        where: { projectId: facts.project.id, action: "GATE_CHECK_RUN_COMPLETED" }
      })
    ).resolves.toBe(1);
  });

  it("freezes configured active project roles and supports ALL approval decisions", async () => {
    const facts = await seedProject("SUBMISSION-ALL");
    await db.projectMember.createMany({
      data: [
        {
          projectId: facts.project.id,
          userId: ids.quality,
          projectRole: "QUALITY",
          departmentId: "engineering",
          assignedById: ids.admin
        },
        {
          projectId: facts.project.id,
          userId: ids.departmentLead,
          projectRole: "DEPARTMENT_LEAD",
          departmentId: "engineering",
          assignedById: ids.admin
        }
      ]
    });
    await db.projectStage.updateMany({
      where: { id: facts.stage.id, projectId: facts.project.id },
      data: { status: "AWAITING_GATE", updatedById: ids.admin, version: { increment: 1 } }
    });
    const instance = await db.projectGateInstance.findFirstOrThrow({
      where: { projectId: facts.project.id, gateDefinition: { code: "G.PROJECT" } }
    });
    const checked = await runGateChecks({
      projectId: facts.project.id,
      gateInstanceId: instance.id,
      version: instance.version,
      reason: "Run ALL Gate checks",
      actorId: ids.projectManager,
      auditContext: auditContext("submission-all-check", facts.project.id)
    });
    const submitted = await submitGateSubmission({
      projectId: facts.project.id,
      gateInstanceId: instance.id,
      version: checked.resourceVersion,
      reason: "Submit ALL Gate application",
      actorId: ids.projectManager,
      auditContext: auditContext("submission-all-submit", facts.project.id)
    });
    expect(submitted.submission).toMatchObject({
      approvalMode: "ALL",
      approverProjectRoles: ["QUALITY", "DEPARTMENT_LEAD"],
      approvers: expect.arrayContaining([
        expect.objectContaining({ userId: ids.quality, projectRoles: ["QUALITY"] }),
        expect.objectContaining({ userId: ids.departmentLead, projectRoles: ["DEPARTMENT_LEAD"] })
      ])
    });
    await expect(
      db.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          UPDATE "gate_submissions"
          SET "status" = 'APPROVED'::"GateSubmissionStatus",
              "decided_at" = CURRENT_TIMESTAMP,
              "version" = "version" + 1
          WHERE "id" = ${submitted.submission.gateSubmissionId}
        `;
        throw new Error("roll back direct Gate submission update");
      })
    ).rejects.toThrow(/Gate submission approval state does not match frozen decisions/u);
    const firstDecision = await decideGateSubmission({
      projectId: facts.project.id,
      submissionId: submitted.submission.gateSubmissionId,
      version: submitted.resourceVersion,
      decision: "APPROVED",
      reason: "Quality approval",
      actorId: ids.quality,
      auditContext: auditContext("submission-all-quality", facts.project.id)
    });
    expect(firstDecision.submission.status).toBe("PENDING");
    await expect(
      decideGateSubmission({
        projectId: facts.project.id,
        submissionId: submitted.submission.gateSubmissionId,
        version: firstDecision.resourceVersion,
        decision: "APPROVED",
        reason: "Attempt duplicate quality approval",
        actorId: ids.quality,
        auditContext: auditContext("submission-all-quality-duplicate", facts.project.id)
      })
    ).rejects.toMatchObject({ code: "GATE_APPROVAL_ALREADY_RECORDED", status: 409 });
    const finalDecision = await decideGateSubmission({
      projectId: facts.project.id,
      submissionId: submitted.submission.gateSubmissionId,
      version: firstDecision.resourceVersion,
      decision: "APPROVED",
      reason: "Department approval",
      actorId: ids.departmentLead,
      auditContext: auditContext("submission-all-lead", facts.project.id)
    });
    expect(finalDecision.submission).toMatchObject({ status: "APPROVED", version: 3 });
    await expect(
      db.gateSubmissionApprover.findMany({
        where: { gateSubmissionId: submitted.submission.gateSubmissionId },
        orderBy: { userId: "asc" }
      })
    ).resolves.toHaveLength(2);
    await expect(
      db.gateSubmission.update({
        where: { id: submitted.submission.gateSubmissionId },
        data: { approverRolesJson: ["ENGINEER"] }
      })
    ).rejects.toThrow(/immutable|transition/u);
  });

  it("approves ANY on one reviewer and appends a new fact after rejection or withdrawal", async () => {
    const facts = await seedProject("SUBMISSION-ANY");
    await db.projectMember.createMany({
      data: [
        {
          projectId: facts.project.id,
          userId: ids.quality,
          projectRole: "QUALITY",
          departmentId: "engineering",
          assignedById: ids.admin
        },
        {
          projectId: facts.project.id,
          userId: ids.departmentLead,
          projectRole: "DEPARTMENT_LEAD",
          departmentId: "engineering",
          assignedById: ids.admin
        }
      ]
    });
    await db.projectStage.updateMany({
      where: { id: facts.stage.id, projectId: facts.project.id },
      data: { status: "AWAITING_GATE", updatedById: ids.admin, version: { increment: 1 } }
    });
    const instance = await db.projectGateInstance.findFirstOrThrow({
      where: { projectId: facts.project.id, gateDefinition: { code: "G.ANY" } }
    });
    const checked = await runGateChecks({
      projectId: facts.project.id,
      gateInstanceId: instance.id,
      version: instance.version,
      reason: "Run ANY Gate checks",
      actorId: ids.projectManager,
      auditContext: auditContext("submission-any-check", facts.project.id)
    });
    const submitted = await submitGateSubmission({
      projectId: facts.project.id,
      gateInstanceId: instance.id,
      version: checked.resourceVersion,
      reason: "Submit ANY Gate application",
      actorId: ids.projectManager,
      auditContext: auditContext("submission-any-submit", facts.project.id)
    });
    const rejected = await decideGateSubmission({
      projectId: facts.project.id,
      submissionId: submitted.submission.gateSubmissionId,
      version: submitted.resourceVersion,
      decision: "REJECTED",
      reason: "Reject the first submission",
      actorId: ids.quality,
      auditContext: auditContext("submission-any-reject", facts.project.id)
    });
    expect(rejected.submission.status).toBe("REJECTED");
    const resubmitted = await resubmitGateSubmission({
      projectId: facts.project.id,
      submissionId: submitted.submission.gateSubmissionId,
      version: rejected.resourceVersion,
      reason: "Submit corrected Gate evidence",
      actorId: ids.projectManager,
      auditContext: auditContext("submission-any-resubmit", facts.project.id)
    });
    expect(resubmitted.submission).toMatchObject({
      previousSubmissionId: submitted.submission.gateSubmissionId,
      sequence: 2,
      status: "PENDING"
    });
    const withdrawn = await withdrawGateSubmission({
      projectId: facts.project.id,
      submissionId: resubmitted.submission.gateSubmissionId,
      version: resubmitted.resourceVersion,
      reason: "Withdraw corrected submission",
      actorId: ids.projectManager,
      auditContext: {
        ...auditContext("submission-any-withdraw", facts.project.id),
        departmentId: "spoofed-department"
      }
    });
    expect(withdrawn.submission.status).toBe("WITHDRAWN");
    await expect(
      db.auditLog.findFirstOrThrow({
        where: {
          projectId: facts.project.id,
          action: "GATE_SUBMISSION_WITHDRAWN",
          objectId: withdrawn.submission.gateSubmissionId
        }
      })
    ).resolves.toMatchObject({ departmentId: facts.project.departmentId });
    await expect(
      db.gateSubmission.findUniqueOrThrow({ where: { id: submitted.submission.gateSubmissionId } })
    ).resolves.toMatchObject({ status: "REJECTED", version: rejected.resourceVersion });
    await expect(
      db.auditLog.count({
        where: {
          projectId: facts.project.id,
          action: {
            in: [
              "GATE_SUBMISSION_SUBMITTED",
              "GATE_APPROVAL_RECORDED",
              "GATE_SUBMISSION_REJECTED",
              "GATE_SUBMISSION_WITHDRAWN"
            ]
          }
        }
      })
    ).resolves.toBe(5);
  });

  it("enforces Gate submission API permissions, cross-project hiding, and idempotent approval replay", async () => {
    const facts = await seedProject("SUBMISSION-API");
    const foreign = await seedProject("SUBMISSION-API-FOREIGN");
    await db.projectMember.createMany({
      data: [
        {
          projectId: facts.project.id,
          userId: ids.quality,
          projectRole: "QUALITY",
          departmentId: "engineering",
          assignedById: ids.admin
        },
        {
          projectId: facts.project.id,
          userId: ids.outsider,
          projectRole: "ENGINEER",
          departmentId: "engineering",
          assignedById: ids.admin
        }
      ]
    });
    await db.projectStage.updateMany({
      where: { id: facts.stage.id, projectId: facts.project.id },
      data: { status: "AWAITING_GATE", updatedById: ids.admin, version: { increment: 1 } }
    });
    const instance = await db.projectGateInstance.findFirstOrThrow({
      where: { projectId: facts.project.id, gateDefinition: { code: "G.ANY" } }
    });
    const checked = await runGateChecks({
      projectId: facts.project.id,
      gateInstanceId: instance.id,
      version: instance.version,
      reason: "Prepare Gate submission API test",
      actorId: ids.projectManager,
      auditContext: auditContext("submission-api-check", facts.project.id)
    });
    const submissionUrl = `http://localhost/api/projects/${facts.project.id}/gate-instances/${instance.id}/submissions`;
    const submissionContext = {
      params: Promise.resolve({ projectId: facts.project.id, instanceId: instance.id })
    };
    const body = { version: checked.resourceVersion, reason: "Submit Gate through API" };
    expect(
      (
        await submitGateSubmissionRoute(
          commandRequest(submissionUrl, body, `gate-submission-unauth-${suffix}`),
          submissionContext
        )
      ).status
    ).toBe(401);
    expect(
      (
        await submitGateSubmissionRoute(
          commandRequest(submissionUrl, body, `gate-submission-admin-${suffix}`, ids.admin),
          submissionContext
        )
      ).status
    ).toBe(403);
    const submitKey = `gate-submission-submit-${suffix}`;
    const submitted = await submitGateSubmissionRoute(
      commandRequest(submissionUrl, body, submitKey, ids.projectManager),
      submissionContext
    );
    const submitReplay = await submitGateSubmissionRoute(
      commandRequest(submissionUrl, body, submitKey, ids.projectManager),
      submissionContext
    );
    expect(submitted.status).toBe(201);
    expect(submitReplay.headers.get("idempotency-replayed")).toBe("true");
    const submittedBody = (await submitted.json()) as {
      submission: { gateSubmissionId: string; version: number };
    };
    const foreignResponse = await submitGateSubmissionRoute(
      commandRequest(
        `http://localhost/api/projects/${foreign.project.id}/gate-instances/${instance.id}/submissions`,
        body,
        `gate-submission-foreign-${suffix}`,
        ids.projectManager
      ),
      { params: Promise.resolve({ projectId: foreign.project.id, instanceId: instance.id }) }
    );
    expect(foreignResponse.status).toBe(404);
    const approvalUrl = `http://localhost/api/projects/${facts.project.id}/gate-submissions/${submittedBody.submission.gateSubmissionId}/approve`;
    const approvalContext = {
      params: Promise.resolve({
        projectId: facts.project.id,
        submissionId: submittedBody.submission.gateSubmissionId
      })
    };
    const approvalBody = { version: submittedBody.submission.version, reason: "Quality approves" };
    expect(
      (
        await approveGateSubmissionRoute(
          commandRequest(
            approvalUrl,
            approvalBody,
            `gate-approval-forbidden-${suffix}`,
            ids.outsider
          ),
          approvalContext
        )
      ).status
    ).toBe(403);
    const approvalKey = `gate-approval-${suffix}`;
    const approved = await approveGateSubmissionRoute(
      commandRequest(approvalUrl, approvalBody, approvalKey, ids.quality),
      approvalContext
    );
    const approvalReplay = await approveGateSubmissionRoute(
      commandRequest(approvalUrl, approvalBody, approvalKey, ids.quality),
      approvalContext
    );
    expect(approved.status).toBe(200);
    expect(approvalReplay.headers.get("idempotency-replayed")).toBe("true");
    await expect(
      db.gateApproval.count({
        where: { gateSubmissionId: submittedBody.submission.gateSubmissionId }
      })
    ).resolves.toBe(1);
  });

  it("conditionally releases an approved Gate and completes its stage only after verifier closure", async () => {
    const facts = await seedProject("CONDITIONAL-RELEASE");
    await db.projectMember.createMany({
      data: [
        {
          projectId: facts.project.id,
          userId: ids.quality,
          projectRole: "QUALITY",
          departmentId: "engineering",
          assignedById: ids.admin
        },
        {
          projectId: facts.project.id,
          userId: ids.departmentLead,
          projectRole: "DEPARTMENT_LEAD",
          departmentId: "engineering",
          assignedById: ids.admin
        }
      ]
    });
    await db.projectStage.updateMany({
      where: { id: facts.stage.id, projectId: facts.project.id },
      data: { status: "AWAITING_GATE", updatedById: ids.admin, version: { increment: 1 } }
    });
    const instance = await db.projectGateInstance.findFirstOrThrow({
      where: { projectId: facts.project.id, gateDefinition: { code: "G.ANY" } }
    });
    const checked = await runGateChecks({
      projectId: facts.project.id,
      gateInstanceId: instance.id,
      version: instance.version,
      reason: "Prepare conditional release",
      actorId: ids.projectManager,
      auditContext: auditContext("conditional-release-check", facts.project.id)
    });
    const submitted = await submitGateSubmission({
      projectId: facts.project.id,
      gateInstanceId: instance.id,
      version: checked.resourceVersion,
      reason: "Submit conditional Gate",
      actorId: ids.projectManager,
      auditContext: auditContext("conditional-release-submit", facts.project.id)
    });
    const approved = await decideGateSubmission({
      projectId: facts.project.id,
      submissionId: submitted.submission.gateSubmissionId,
      version: submitted.resourceVersion,
      decision: "APPROVED",
      reason: "Quality approves conditional release",
      actorId: ids.quality,
      auditContext: auditContext("conditional-release-approve", facts.project.id)
    });
    const [ownerMembership, verifierMembership] = await Promise.all([
      db.projectMember.findFirstOrThrow({
        where: { projectId: facts.project.id, userId: ids.projectManager, leftAt: null }
      }),
      db.projectMember.findFirstOrThrow({
        where: { projectId: facts.project.id, userId: ids.quality, leftAt: null }
      })
    ]);
    const released = await conditionallyReleaseGate({
      projectId: facts.project.id,
      submissionId: submitted.submission.gateSubmissionId,
      version: approved.resourceVersion,
      reason: "客户现场确认后补齐照片",
      residualItems: [
        {
          title: "补充安全防护照片",
          ownerMembershipId: ownerMembership.id,
          verifierMembershipId: verifierMembership.id,
          dueAt: new Date("2030-01-10T00:00:00.000Z"),
          evidence: "FAT 检查记录 12",
          escalationRule: "逾期后升级给项目经理"
        },
        {
          title: "补充线缆标识照片",
          ownerMembershipId: ownerMembership.id,
          verifierMembershipId: verifierMembership.id,
          dueAt: new Date("2030-01-11T00:00:00.000Z"),
          evidence: "FAT 检查记录 13",
          escalationRule: "逾期后升级给项目经理"
        }
      ],
      actorId: ids.quality,
      auditContext: auditContext("conditional-release", facts.project.id)
    });
    expect(released.stage.status).toBe("CONDITIONALLY_RELEASED");
    expect(released.residualItems).toHaveLength(2);
    const [firstResidual, secondResidual] = released.residualItems;
    if (!firstResidual || !secondResidual) throw new Error("Expected two residual items.");
    await expect(
      db.$executeRaw`
        UPDATE "residual_items" SET "title" = ${"tampered title"}
        WHERE "id" = ${firstResidual.residualItemId}
      `
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`
        UPDATE "residual_item_events" SET "reason" = ${"tampered event"}
        WHERE "residual_item_id" = ${firstResidual.residualItemId}
      `
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`
        UPDATE "project_stages"
        SET "status" = 'COMPLETED'::"ProjectStageExecutionStatus"
        WHERE "id" = ${facts.stage.id}
      `
    ).rejects.toThrow();
    const [firstStarted, secondStarted] = await Promise.all(
      [firstResidual, secondResidual].map((residualItem, index) =>
        startResidualItem({
          projectId: facts.project.id,
          residualItemId: residualItem.residualItemId,
          version: residualItem.version,
          reason: `Owner starts evidence collection ${index + 1}`,
          actorId: ids.projectManager,
          auditContext: auditContext(`residual-start-${index + 1}`, facts.project.id)
        })
      )
    );
    const [firstSubmitted, secondSubmitted] = await Promise.all(
      [firstStarted, secondStarted].map((started, index) =>
        submitResidualItemVerification({
          projectId: facts.project.id,
          residualItemId: [firstResidual, secondResidual][index].residualItemId,
          version: started.resourceVersion,
          reason: `Owner submits evidence for verification ${index + 1}`,
          actorId: ids.projectManager,
          auditContext: auditContext(`residual-submit-verification-${index + 1}`, facts.project.id)
        })
      )
    );
    const verified = await Promise.all(
      [firstSubmitted, secondSubmitted].map((submittedForVerification, index) =>
        verifyResidualItem({
          projectId: facts.project.id,
          residualItemId: [firstResidual, secondResidual][index].residualItemId,
          version: submittedForVerification.resourceVersion,
          decision: "VERIFY",
          reason: `Verifier confirms supplied evidence ${index + 1}`,
          actorId: ids.quality,
          auditContext: auditContext(`residual-verify-${index + 1}`, facts.project.id)
        })
      )
    );
    expect(verified.map((result) => result.residualItem.status)).toEqual(["CLOSED", "CLOSED"]);
    expect(verified.map((result) => result.stage?.status)).toContain("COMPLETED");
    await expect(
      db.projectStage.findUniqueOrThrow({ where: { id: facts.stage.id } })
    ).resolves.toMatchObject({
      status: "COMPLETED"
    });
    await expect(
      db.residualItemEvent.count({
        where: {
          residualItemId: { in: [firstResidual.residualItemId, secondResidual.residualItemId] }
        }
      })
    ).resolves.toBe(8);
  });

  it("enforces conditional release API authorization and idempotent residual closure", async () => {
    const facts = await seedProject("CONDITIONAL-API");
    await db.projectMember.createMany({
      data: [
        {
          projectId: facts.project.id,
          userId: ids.quality,
          projectRole: "QUALITY",
          departmentId: "engineering",
          assignedById: ids.admin
        },
        {
          projectId: facts.project.id,
          userId: ids.departmentLead,
          projectRole: "DEPARTMENT_LEAD",
          departmentId: "engineering",
          assignedById: ids.admin
        }
      ]
    });
    await db.projectStage.updateMany({
      where: { id: facts.stage.id, projectId: facts.project.id },
      data: { status: "AWAITING_GATE", updatedById: ids.admin, version: { increment: 1 } }
    });
    const instance = await db.projectGateInstance.findFirstOrThrow({
      where: { projectId: facts.project.id, gateDefinition: { code: "G.ANY" } }
    });
    const checked = await runGateChecks({
      projectId: facts.project.id,
      gateInstanceId: instance.id,
      version: instance.version,
      reason: "Prepare conditional API release",
      actorId: ids.projectManager,
      auditContext: auditContext("conditional-api-check", facts.project.id)
    });
    const submitted = await submitGateSubmission({
      projectId: facts.project.id,
      gateInstanceId: instance.id,
      version: checked.resourceVersion,
      reason: "Submit conditional API Gate",
      actorId: ids.projectManager,
      auditContext: auditContext("conditional-api-submit", facts.project.id)
    });
    const approved = await decideGateSubmission({
      projectId: facts.project.id,
      submissionId: submitted.submission.gateSubmissionId,
      version: submitted.resourceVersion,
      decision: "APPROVED",
      reason: "Quality approves conditional API Gate",
      actorId: ids.quality,
      auditContext: auditContext("conditional-api-approve", facts.project.id)
    });
    const [ownerMembership, verifierMembership] = await Promise.all([
      db.projectMember.findFirstOrThrow({
        where: { projectId: facts.project.id, userId: ids.projectManager, leftAt: null }
      }),
      db.projectMember.findFirstOrThrow({
        where: { projectId: facts.project.id, userId: ids.quality, leftAt: null }
      })
    ]);
    const releaseUrl = `http://localhost/api/projects/${facts.project.id}/gate-submissions/${submitted.submission.gateSubmissionId}/conditional-release`;
    const releaseContext = {
      params: Promise.resolve({
        projectId: facts.project.id,
        submissionId: submitted.submission.gateSubmissionId
      })
    };
    const releaseBody = {
      version: approved.resourceVersion,
      reason: "客户确认后补齐照片",
      residualItems: [
        {
          title: "补充照片",
          ownerMembershipId: ownerMembership.id,
          verifierMembershipId: verifierMembership.id,
          dueAt: "2030-01-10T00:00:00.000Z",
          evidence: "FAT 记录 12",
          escalationRule: "逾期升级给项目经理"
        }
      ]
    };
    expect(
      (
        await conditionalReleaseRoute(
          commandRequest(releaseUrl, releaseBody, `conditional-api-unauth-${suffix}`),
          releaseContext
        )
      ).status
    ).toBe(401);
    const releaseKey = `conditional-api-release-${suffix}`;
    const released = await conditionalReleaseRoute(
      commandRequest(releaseUrl, releaseBody, releaseKey, ids.quality),
      releaseContext
    );
    const releaseReplay = await conditionalReleaseRoute(
      commandRequest(releaseUrl, releaseBody, releaseKey, ids.quality),
      releaseContext
    );
    expect(released.status).toBe(200);
    expect(releaseReplay.headers.get("idempotency-replayed")).toBe("true");
    const releasedBody = (await released.json()) as {
      residualItems: Array<{ residualItemId: string; version: number }>;
    };
    const residual = releasedBody.residualItems[0];
    if (!residual) throw new Error("Expected API residual item.");
    const residualUrl = `http://localhost/api/projects/${facts.project.id}/residual-items/${residual.residualItemId}`;
    const residualContext = {
      params: Promise.resolve({
        projectId: facts.project.id,
        residualItemId: residual.residualItemId
      })
    };
    const started = await startResidualItemRoute(
      commandRequest(
        `${residualUrl}/start`,
        { version: residual.version, reason: "开始处理" },
        `conditional-api-start-${suffix}`,
        ids.projectManager
      ),
      residualContext
    );
    expect(started.status).toBe(200);
    const startedBody = (await started.json()) as { resourceVersion: number };
    const submittedForVerification = await submitResidualItemVerificationRoute(
      commandRequest(
        `${residualUrl}/submit-verification`,
        { version: startedBody.resourceVersion, reason: "提交验证" },
        `conditional-api-submit-verification-${suffix}`,
        ids.projectManager
      ),
      residualContext
    );
    expect(submittedForVerification.status).toBe(200);
    const submittedBody = (await submittedForVerification.json()) as { resourceVersion: number };
    const verified = await verifyResidualItemRoute(
      commandRequest(
        `${residualUrl}/verify`,
        { version: submittedBody.resourceVersion, decision: "VERIFY", reason: "验证通过" },
        `conditional-api-verify-${suffix}`,
        ids.quality
      ),
      residualContext
    );
    expect(verified.status).toBe(200);
    await expect(
      db.projectStage.findUniqueOrThrow({ where: { id: facts.stage.id } })
    ).resolves.toMatchObject({ status: "COMPLETED" });
  });
});
