import { db } from "@/lib/db";
import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import type { ProjectAuthorizationTarget } from "@/lib/auth/repository";
import type { AuditContext, AuditEvent } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  RESOURCE_LOAD_PERSON_READ_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";

export type ResourceLoadAuthorizationDependencies = {
  recordSensitiveRead(event: AuditEvent): Promise<void>;
};

const defaultDependencies: ResourceLoadAuthorizationDependencies = {
  async recordSensitiveRead(event) {
    await writeAudit(db, event);
  }
};

export async function authorizeResourceLoadPeopleRead(
  input: {
    actor: AuthorizationActor;
    project: ProjectAuthorizationTarget;
    projectionId: string;
    peopleCount: number;
    auditContext: AuditContext;
  },
  dependencies: ResourceLoadAuthorizationDependencies = defaultDependencies
): Promise<boolean> {
  const decision = decideAuthorization(input.actor, PERMISSIONS.PROJECT_MEMBER_READ, {
    projectId: input.project.id,
    resourceDepartmentId: input.project.departmentId,
    memberRoles: input.project.memberRoles
  });
  if (!decision.allowed) return false;

  await dependencies.recordSensitiveRead({
    action: AUDIT_ACTIONS.COCKPIT_RESOURCE_LOAD_PERSON_READ,
    objectType: AUDIT_OBJECT_TYPES.COCKPIT_RESOURCE_LOAD,
    objectId: input.projectionId,
    context: {
      ...input.auditContext,
      actorId: input.actor.id,
      projectId: input.project.id,
      departmentId: input.project.departmentId
    },
    metadata: {
      value: {
        projectId: input.project.id,
        projectionId: input.projectionId,
        peopleCount: input.peopleCount,
        permission: PERMISSIONS.PROJECT_MEMBER_READ
      },
      allowedFields: RESOURCE_LOAD_PERSON_READ_AUDIT_FIELDS
    }
  });
  return true;
}
