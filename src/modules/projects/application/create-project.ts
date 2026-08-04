import { Prisma, ProjectRole } from "@prisma/client";

import { inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  PROJECT_CREATION_AUDIT_FIELDS,
  PROJECT_MEMBER_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import {
  TEMPLATE_MASTER_STATUSES,
  type TemplateComponentContent,
  type TemplateComponentTypeCode
} from "@/modules/configuration/domain/template-policy";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { instantiateProjectGateDefinitions } from "@/modules/governance/application/project-gate-definition-service";

import {
  buildProjectTemplateSnapshot,
  extractProjectStageDefinitions,
  ProjectCreationError,
  validateProjectIdentity
} from "../domain/project-template-snapshot";
import { instantiateProjectMilestones } from "./milestone-service";

function positiveVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ProjectCreationError("INVALID_TEMPLATE_VERSION", "模板版本号无效。", 422);
  }
  return value as number;
}

function checksum(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new ProjectCreationError("INVALID_TEMPLATE_CHECKSUM", "模板校验和格式无效。", 422);
  }
  return value;
}

function reason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new ProjectCreationError("REASON_REQUIRED", "创建原因必须是 1 到 1024 个字符。", 422);
  }
  return value.trim();
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

export async function createProjectFromTemplate(
  input: {
    code: string;
    name: string;
    departmentId?: string | null;
    templateCode: string;
    templateVersion: number;
    templateChecksum: string;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const identity = validateProjectIdentity(input);
  const templateCode = input.templateCode.trim();
  if (!/^[A-Z][A-Z0-9_.-]{2,100}$/u.test(templateCode)) {
    throw new ProjectCreationError("INVALID_TEMPLATE_CODE", "模板代码无效。", 422);
  }
  const templateVersion = positiveVersion(input.templateVersion);
  const suppliedChecksum = checksum(input.templateChecksum);
  const creationReason = reason(input.reason);

  try {
    return await inTransaction(transaction, async (client) => {
      const template = await client.projectTemplate.findUnique({
        where: { code: templateCode },
        include: {
          versions: {
            where: { version: templateVersion },
            include: {
              components: {
                include: { componentVersion: { include: { component: true } } },
                orderBy: [{ position: "asc" }, { slot: "asc" }]
              }
            }
          }
        }
      });
      if (!template) {
        throw new ProjectCreationError("TEMPLATE_NOT_FOUND", "模板不存在。", 404);
      }
      if (template.status === TEMPLATE_MASTER_STATUSES.DRAFT) {
        throw new ProjectCreationError("TEMPLATE_NOT_PUBLISHED", "模板尚未发布。", 409);
      }
      if (template.status !== TEMPLATE_MASTER_STATUSES.ACTIVE) {
        throw new ProjectCreationError("TEMPLATE_DISABLED", "模板未启用，不能创建项目。", 409);
      }
      const source = template.versions[0];
      if (!source || source.status !== "PUBLISHED") {
        throw new ProjectCreationError(
          "TEMPLATE_VERSION_NOT_FOUND",
          "模板版本不存在或尚未发布。",
          404
        );
      }
      const snapshot = buildProjectTemplateSnapshot({
        sourceTemplateVersionId: source.id,
        suppliedTemplateChecksum: suppliedChecksum,
        storedTemplateChecksum: source.checksum,
        templateCode: template.code,
        templateName: source.name,
        templateDescription: source.description,
        templateVersion: source.version,
        templatePublishedAt: source.publishedAt,
        components: source.components.map((reference) => ({
          sourceComponentVersionId: reference.componentVersionId,
          componentCode: reference.componentVersion.component.code,
          componentType: reference.componentType as TemplateComponentTypeCode,
          componentName: reference.componentVersion.name,
          componentVersion: reference.componentVersion.version,
          description: reference.componentVersion.description,
          content: reference.componentVersion.contentJson as TemplateComponentContent,
          sourceChecksum: reference.componentVersion.checksum,
          slot: reference.slot,
          position: reference.position
        }))
      });
      const initializedAt = await databaseNow(client);
      let project: Prisma.ProjectGetPayload<{}>;
      try {
        project = await client.project.create({
          data: {
            code: identity.code,
            name: identity.name,
            departmentId: identity.departmentId,
            initializationStatus: "READY",
            sourceTemplateVersionId: source.id,
            sourceTemplateChecksum: source.checksum,
            initializedAt,
            createdById: input.actorId
          }
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new ProjectCreationError("PROJECT_CODE_CONFLICT", "项目号已存在。", 409);
        }
        throw error;
      }
      const membership = await client.projectMember.create({
        data: {
          projectId: project.id,
          userId: input.actorId,
          projectRole: ProjectRole.PROJECT_MANAGER,
          departmentId: identity.departmentId,
          assignedById: input.actorId
        }
      });
      const storedSnapshot = await client.projectTemplateSnapshot.create({
        data: {
          projectId: project.id,
          sourceTemplateVersionId: snapshot.sourceTemplateVersionId,
          sourceTemplateChecksum: snapshot.sourceTemplateChecksum,
          snapshotChecksum: snapshot.snapshotChecksum,
          templateCode: snapshot.templateCode,
          templateName: snapshot.templateName,
          templateVersion: snapshot.templateVersion,
          templatePublishedAt: snapshot.templatePublishedAt,
          components: {
            create: snapshot.components.map((component) => ({
              sourceComponentVersionId: component.sourceComponentVersionId,
              componentType: component.componentType,
              slot: component.slot,
              position: component.position,
              sourceChecksum: component.sourceChecksum,
              componentCode: component.componentCode,
              componentName: component.componentName,
              componentVersion: component.componentVersion,
              description: component.description,
              contentJson: component.content as Prisma.InputJsonValue
            }))
          }
        },
        include: { components: { orderBy: [{ position: "asc" }, { slot: "asc" }] } }
      });
      const stageComponent = storedSnapshot.components.find(
        ({ componentType }) => componentType === "STAGE"
      );
      if (!stageComponent) {
        throw new ProjectCreationError(
          "STAGE_COMPONENT_NOT_FOUND",
          "项目模板快照必须包含阶段组件。",
          409
        );
      }
      const stageDefinitions = extractProjectStageDefinitions({
        id: stageComponent.id,
        componentType: stageComponent.componentType,
        contentJson: stageComponent.contentJson
      });
      await client.projectStage.createMany({
        data: stageDefinitions.map((stage) => ({
          projectId: project.id,
          sourceSnapshotComponentId: stage.sourceSnapshotComponentId,
          code: stage.code,
          name: stage.name,
          description: stage.description,
          sequence: stage.sequence,
          createdById: input.actorId,
          updatedById: input.actorId
        }))
      });
      const projectStages = await client.projectStage.findMany({
        where: { projectId: project.id },
        orderBy: { sequence: "asc" }
      });
      const mainControlStage = projectStages[0];
      if (!mainControlStage) {
        throw new ProjectCreationError("STAGE_COMPONENT_EMPTY", "阶段组件不能为空。", 409);
      }
      await client.projectStageEvent.createMany({
        data: projectStages.map((stage) => ({
          projectId: project.id,
          projectStageId: stage.id,
          sequence: 1,
          eventType: "CREATED" as const,
          fromStatus: null,
          toStatus: "NOT_STARTED" as const,
          reason: creationReason,
          snapshotJson: {
            projectId: project.id,
            projectStageId: stage.id,
            code: stage.code,
            name: stage.name,
            description: stage.description,
            sequence: stage.sequence,
            status: stage.status,
            version: stage.version
          },
          actorId: input.actorId
        }))
      });
      project = await client.project.update({
        where: { id: project.id },
        data: {
          mainControlStageId: mainControlStage.id,
          mainControlStageProjectId: project.id,
          mainControlStageCode: mainControlStage.code,
          mainControlStageStatus: mainControlStage.status,
          mainControlStageSequence: mainControlStage.sequence,
          mainControlStageUpdatedAt: mainControlStage.statusChangedAt
        }
      });
      const projectMilestones = await instantiateProjectMilestones(client, {
        projectId: project.id,
        project,
        actorId: input.actorId,
        auditContext: {
          ...input.auditContext,
          actorId: input.actorId,
          projectId: project.id,
          departmentId: identity.departmentId,
          reason: creationReason
        },
        components: storedSnapshot.components
      });
      const auditContext = {
        ...input.auditContext,
        actorId: input.actorId,
        reason: creationReason,
        projectId: project.id,
        departmentId: identity.departmentId
      };
      const projectGates = await instantiateProjectGateDefinitions(client, {
        projectId: project.id,
        actorId: input.actorId,
        auditContext,
        components: storedSnapshot.components,
        stages: projectStages
      });
      const membershipAudit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PROJECT_MEMBER_ADDED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_MEMBER,
        objectId: membership.id,
        context: auditContext,
        after: {
          value: {
            projectId: project.id,
            userId: input.actorId,
            projectRole: membership.projectRole,
            departmentId: membership.departmentId,
            version: membership.version
          },
          allowedFields: PROJECT_MEMBER_AUDIT_FIELDS
        }
      });
      const projectAudit = await writeAudit(client, {
        action: AUDIT_ACTIONS.PROJECT_CREATED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT,
        objectId: project.id,
        context: auditContext,
        after: {
          value: {
            projectId: project.id,
            projectCode: project.code,
            projectName: project.name,
            departmentId: project.departmentId,
            status: project.status,
            initializationStatus: project.initializationStatus,
            sourceTemplateVersionId: source.id,
            sourceTemplateChecksum: source.checksum,
            snapshotId: storedSnapshot.id,
            snapshotChecksum: storedSnapshot.snapshotChecksum,
            referenceCount: storedSnapshot.components.length,
            milestoneCount: projectMilestones.length,
            gateDefinitionCount: projectGates.length,
            version: project.version
          },
          allowedFields: PROJECT_CREATION_AUDIT_FIELDS
        }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "project.created",
        aggregateType: "PROJECT",
        aggregateId: project.id,
        idempotencyKey: project.id,
        payload: {
          projectId: project.id,
          projectCode: project.code,
          sourceTemplateVersionId: source.id,
          sourceTemplateChecksum: source.checksum,
          snapshotId: storedSnapshot.id,
          snapshotChecksum: storedSnapshot.snapshotChecksum
        }
      });
      return {
        project,
        snapshot: {
          id: storedSnapshot.id,
          checksum: storedSnapshot.snapshotChecksum,
          referenceCount: storedSnapshot.components.length
        },
        resourceVersion: project.version,
        allowedActions: ["EDIT_BASICS", "MANAGE_MEMBERS"],
        auditId: projectAudit.id,
        membershipAuditId: membershipAudit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ProjectCreationError(
        "PROJECT_CREATION_CONFLICT",
        "项目创建发生并发冲突，请刷新后重试。",
        409
      );
    }
    throw error;
  }
}
