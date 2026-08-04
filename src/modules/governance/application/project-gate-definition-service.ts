import { Prisma } from "@prisma/client";

import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  PROJECT_GATE_DEFINITION_AUDIT_FIELDS,
  PROJECT_GATE_INSTANCE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { parseGateDefinitionRules } from "@/modules/configuration/domain/template-policy";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";

export type ProjectGateMaterialization = {
  sourceSnapshotComponentId: string;
  projectStageId: string;
  code: string;
  name: string;
  scope: "PROJECT" | "DELIVERY_UNIT" | "MODULE";
  definitionJson: JsonValue;
  checkerBindings: Array<{ code: string; version: number }>;
  createProjectInstance: boolean;
};

export function buildProjectGateMaterialization(input: {
  components: Array<{ id: string; componentType: string; contentJson: unknown }>;
  stages: Array<{ id: string; code: string }>;
}): ProjectGateMaterialization[] {
  const stageIds = new Map(input.stages.map((stage) => [stage.code, stage.id]));
  return input.components
    .filter((component) => component.componentType === "GATE")
    .flatMap((component) =>
      parseGateDefinitionRules(component.contentJson).map((gate) => {
        const projectStageId = stageIds.get(gate.stageCode);
        if (!projectStageId) {
          throw new Error(`Gate ${gate.code} 引用的阶段 ${gate.stageCode} 不存在。`);
        }
        return {
          sourceSnapshotComponentId: component.id,
          projectStageId,
          code: gate.code,
          name: gate.name,
          scope: gate.scope,
          definitionJson: gate.definitionJson,
          checkerBindings: gate.checkerBindings,
          createProjectInstance: gate.scope === "PROJECT"
        };
      })
    );
}

export function buildGateDefinitionMaterializedOutboxPayload(input: {
  projectId: string;
  gateDefinitionId: string;
  gateInstanceId?: string;
}) {
  return {
    projectId: input.projectId,
    gateDefinitionId: input.gateDefinitionId,
    ...(input.gateInstanceId === undefined ? {} : { gateInstanceId: input.gateInstanceId })
  };
}

export async function instantiateProjectGateDefinitions(
  client: Prisma.TransactionClient,
  input: {
    projectId: string;
    actorId: string;
    auditContext: AuditContext;
    components: Array<{ id: string; componentType: string; contentJson: unknown }>;
    stages: Array<{ id: string; code: string }>;
  }
) {
  const materialized = buildProjectGateMaterialization(input);
  const created = [] as Array<{ definitionId: string; instanceId?: string }>;

  for (const gate of materialized) {
    const definitionSnapshot = payloadHash(gate.definitionJson);
    const definition = await client.projectGateDefinition.create({
      data: {
        projectId: input.projectId,
        sourceSnapshotComponentId: gate.sourceSnapshotComponentId,
        projectStageId: gate.projectStageId,
        code: gate.code,
        name: gate.name,
        scope: gate.scope,
        definitionJson: definitionSnapshot.value as Prisma.InputJsonValue,
        checkerBindingsJson: payloadHash(gate.checkerBindings).value as Prisma.InputJsonValue,
        definitionChecksum: definitionSnapshot.hash,
        materializedById: input.actorId
      }
    });
    await writeAudit(client, {
      action: AUDIT_ACTIONS.GATE_DEFINITION_MATERIALIZED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_GATE_DEFINITION,
      objectId: definition.id,
      context: input.auditContext,
      after: {
        value: { gateDefinitionId: definition.id, ...definition },
        allowedFields: PROJECT_GATE_DEFINITION_AUDIT_FIELDS
      }
    });
    let instanceId: string | undefined;
    if (gate.createProjectInstance) {
      const instance = await client.projectGateInstance.create({
        data: {
          projectId: input.projectId,
          gateDefinitionId: definition.id,
          projectStageId: gate.projectStageId,
          scope: "PROJECT",
          createdById: input.actorId,
          updatedById: input.actorId
        }
      });
      instanceId = instance.id;
      await writeAudit(client, {
        action: AUDIT_ACTIONS.GATE_INSTANCE_CREATED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_GATE_INSTANCE,
        objectId: instance.id,
        context: input.auditContext,
        after: {
          value: { gateInstanceId: instance.id, ...instance },
          allowedFields: PROJECT_GATE_INSTANCE_AUDIT_FIELDS
        }
      });
    }
    await appendOutboxEvent(client, {
      eventType: "gate.definition.materialized",
      aggregateType: "PROJECT_GATE_DEFINITION",
      aggregateId: definition.id,
      idempotencyKey: definition.id,
      payload: buildGateDefinitionMaterializedOutboxPayload({
        projectId: input.projectId,
        gateDefinitionId: definition.id,
        gateInstanceId: instanceId
      })
    });
    created.push({ definitionId: definition.id, ...(instanceId ? { instanceId } : {}) });
  }
  return created;
}
