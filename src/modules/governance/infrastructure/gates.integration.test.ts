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

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = { admin: `gate-admin-${suffix}` };

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
            requiredCheckerCodes: ["STAGE.AWAITING_GATE"]
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
            requiredCheckerCodes: ["DOCUMENTS.COMPLETE"]
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
    await db.user.create({
      data: {
        id: ids.admin,
        employeeNo: `GATE-ADMIN-${suffix}`,
        name: "Gate integration administrator",
        departmentId: "engineering"
      }
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
    await db.projectStage.update({
      where: { id: facts.stage.id },
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
});
