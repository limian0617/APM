import {
  DeliveryUnitType,
  EquipmentShape,
  Prisma,
  ProjectStatus,
  ProjectStructureNodeStatus,
  ProjectType
} from "@prisma/client";

import { inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  DELIVERY_UNIT_AUDIT_FIELDS,
  PROJECT_STRUCTURE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  buildProjectStructure,
  ProjectStructureError,
  type DeliveryUnitTypeCode,
  type EquipmentShapeCode,
  type ProjectTypeCode
} from "../domain/project-structure";

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProjectStructureError("INVALID_VERSION", `${field} 必须是正整数。`);
  }
  return value as number;
}

function commandReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new ProjectStructureError("REASON_REQUIRED", "操作原因必须是 1 到 1024 个字符。");
  }
  return value.trim();
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new ProjectStructureError(
        "PROJECT_STRUCTURE_CONFLICT",
        "交付单元或模块代码/顺序已存在。",
        409
      );
    }
    if (error.code === "P2003" || error.code === "P2004") {
      throw new ProjectStructureError(
        "PROJECT_STRUCTURE_RELATION_INVALID",
        "项目结构关系未通过数据库约束。",
        409
      );
    }
  }
  throw error;
}

export async function initializeProjectStructure(
  input: {
    projectId: string;
    projectVersion: number;
    projectType: ProjectTypeCode;
    equipmentShape: EquipmentShapeCode | null;
    deliveryUnits: Array<{
      code: string;
      name: string;
      unitType: DeliveryUnitTypeCode;
      parentCode?: string | null;
      position: number;
    }>;
    modules: Array<{
      code: string;
      name: string;
      machineCode: string;
      position: number;
    }>;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectVersion = positiveVersion(input.projectVersion, "projectVersion");
  const reason = commandReason(input.reason);
  const plan = buildProjectStructure(input);

  try {
    return await inTransaction(transaction, async (client) => {
      const current = await client.project.findUnique({ where: { id: input.projectId } });
      if (!current) {
        throw new ProjectStructureError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      }
      if (current.initializationStatus !== "READY") {
        throw new ProjectStructureError(
          "PROJECT_TEMPLATE_NOT_READY",
          "项目模板快照尚未准备完成。",
          409
        );
      }
      if (current.status === ProjectStatus.CLOSED || current.status === ProjectStatus.CANCELED) {
        throw new ProjectStructureError("PROJECT_READ_ONLY", "已关闭项目不能初始化结构。", 409);
      }
      if (current.structureStatus === "READY") {
        throw new ProjectStructureError(
          "PROJECT_STRUCTURE_ALREADY_INITIALIZED",
          "项目结构已经初始化。",
          409
        );
      }

      const projectUpdate = await client.project.updateMany({
        where: {
          id: input.projectId,
          version: projectVersion,
          structureStatus: "UNCONFIGURED"
        },
        data: {
          projectType: plan.projectType as ProjectType,
          equipmentShape: plan.equipmentShape as EquipmentShape | null,
          structureStatus: "READY",
          version: { increment: 1 }
        }
      });
      if (projectUpdate.count !== 1) {
        throw new ProjectStructureError(
          "VERSION_CONFLICT",
          "项目结构已发生变化，请刷新后重试。",
          409
        );
      }

      const unitIdByCode = new Map<string, string>();
      const deliveryUnits = [];
      for (const unit of plan.deliveryUnits) {
        const created = await client.deliveryUnit.create({
          data: {
            projectId: input.projectId,
            parentId: unit.parentCode ? unitIdByCode.get(unit.parentCode) : null,
            unitType: unit.unitType as DeliveryUnitType,
            code: unit.code,
            name: unit.name,
            position: unit.position,
            createdById: input.actorId,
            updatedById: input.actorId
          }
        });
        unitIdByCode.set(unit.code, created.id);
        deliveryUnits.push(created);
      }

      const modules = [];
      for (const moduleDefinition of plan.modules) {
        const deliveryUnitId = unitIdByCode.get(moduleDefinition.machineCode);
        if (!deliveryUnitId) {
          throw new ProjectStructureError(
            "MODULE_MACHINE_REQUIRED",
            `模块 ${moduleDefinition.code} 缺少有效单机。`,
            409
          );
        }
        modules.push(
          await client.projectModule.create({
            data: {
              projectId: input.projectId,
              deliveryUnitId,
              code: moduleDefinition.code,
              name: moduleDefinition.name,
              position: moduleDefinition.position,
              createdById: input.actorId,
              updatedById: input.actorId
            }
          })
        );
      }

      const project = await client.project.findUniqueOrThrow({ where: { id: input.projectId } });
      const auditContext = {
        ...input.auditContext,
        actorId: input.actorId,
        projectId: input.projectId,
        departmentId: current.departmentId,
        reason
      };
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PROJECT_STRUCTURE_INITIALIZED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT,
        objectId: input.projectId,
        context: auditContext,
        before: {
          value: {
            projectType: current.projectType,
            equipmentShape: current.equipmentShape,
            structureStatus: current.structureStatus,
            version: current.version
          },
          allowedFields: PROJECT_STRUCTURE_AUDIT_FIELDS
        },
        after: {
          value: {
            projectType: project.projectType,
            equipmentShape: project.equipmentShape,
            structureStatus: project.structureStatus,
            structureChecksum: plan.checksum,
            deliveryUnitCount: deliveryUnits.length,
            moduleCount: modules.length,
            version: project.version
          },
          allowedFields: PROJECT_STRUCTURE_AUDIT_FIELDS
        }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "project.structure.initialized",
        aggregateType: "PROJECT",
        aggregateId: project.id,
        idempotencyKey: project.id,
        payload: {
          projectId: project.id,
          projectType: project.projectType,
          equipmentShape: project.equipmentShape,
          structureChecksum: plan.checksum,
          deliveryUnitCount: deliveryUnits.length,
          moduleCount: modules.length,
          version: project.version
        }
      });

      return {
        project: {
          id: project.id,
          code: project.code,
          projectType: project.projectType,
          equipmentShape: project.equipmentShape,
          structureStatus: project.structureStatus
        },
        deliveryUnits,
        modules,
        structureChecksum: plan.checksum,
        resourceVersion: project.version,
        allowedActions: ["MANAGE_STRUCTURE"],
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof ProjectStructureError) throw error;
    mapDatabaseError(error);
  }
}

export async function setDeliveryUnitEnabled(
  input: {
    projectId: string;
    deliveryUnitId: string;
    version: number;
    enabled: boolean;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const version = positiveVersion(input.version, "version");
  const reason = commandReason(input.reason);
  const nextStatus = input.enabled
    ? ProjectStructureNodeStatus.ACTIVE
    : ProjectStructureNodeStatus.DISABLED;

  try {
    return await inTransaction(transaction, async (client) => {
      const project = await client.project.findUnique({ where: { id: input.projectId } });
      if (!project) throw new ProjectStructureError("PROJECT_NOT_FOUND", "项目不存在。", 404);
      if (project.status === ProjectStatus.CLOSED || project.status === ProjectStatus.CANCELED) {
        throw new ProjectStructureError("PROJECT_READ_ONLY", "已关闭项目不能修改结构。", 409);
      }
      if (project.structureStatus !== "READY") {
        throw new ProjectStructureError("PROJECT_STRUCTURE_NOT_READY", "项目结构尚未初始化。", 409);
      }
      const current = await client.deliveryUnit.findFirst({
        where: { id: input.deliveryUnitId, projectId: input.projectId }
      });
      if (!current) {
        throw new ProjectStructureError("DELIVERY_UNIT_NOT_FOUND", "交付单元不存在。", 404);
      }
      if (current.status === nextStatus) {
        throw new ProjectStructureError(
          "DELIVERY_UNIT_STATUS_UNCHANGED",
          "交付单元已经处于目标状态。",
          409
        );
      }
      const updatedRows = await client.deliveryUnit.updateMany({
        where: { id: current.id, projectId: input.projectId, version },
        data: {
          status: nextStatus,
          version: { increment: 1 },
          updatedById: input.actorId
        }
      });
      if (updatedRows.count !== 1) {
        throw new ProjectStructureError(
          "VERSION_CONFLICT",
          "交付单元已发生变化，请刷新后重试。",
          409
        );
      }
      const updated = await client.deliveryUnit.findUniqueOrThrow({ where: { id: current.id } });
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.DELIVERY_UNIT_STATUS_CHANGED,
        objectType: AUDIT_OBJECT_TYPES.DELIVERY_UNIT,
        objectId: current.id,
        context: {
          ...input.auditContext,
          actorId: input.actorId,
          projectId: input.projectId,
          departmentId: project.departmentId,
          reason
        },
        before: {
          value: {
            projectId: input.projectId,
            deliveryUnitId: current.id,
            code: current.code,
            status: current.status,
            version: current.version
          },
          allowedFields: DELIVERY_UNIT_AUDIT_FIELDS
        },
        after: {
          value: {
            projectId: input.projectId,
            deliveryUnitId: updated.id,
            code: updated.code,
            status: updated.status,
            version: updated.version
          },
          allowedFields: DELIVERY_UNIT_AUDIT_FIELDS
        }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "project.delivery-unit.status-changed",
        aggregateType: "DELIVERY_UNIT",
        aggregateId: updated.id,
        idempotencyKey: `${updated.id}:${updated.version}`,
        payload: {
          projectId: input.projectId,
          deliveryUnitId: updated.id,
          status: updated.status,
          version: updated.version
        }
      });
      return {
        deliveryUnit: updated,
        resourceVersion: updated.version,
        allowedActions: [updated.status === "ACTIVE" ? "DISABLE" : "ENABLE"],
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof ProjectStructureError) throw error;
    mapDatabaseError(error);
  }
}
