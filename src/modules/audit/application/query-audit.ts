import { Prisma } from "@prisma/client";

import type { AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS, PERMISSION_SCOPES } from "@/lib/auth/permissions";
import { db } from "@/lib/db";

import type { AuditContext } from "../contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_VALUES,
  AUDIT_OBJECT_TYPES,
  AUDIT_OBJECT_TYPE_VALUES,
  AUDIT_QUERY_FIELDS,
  AUDIT_RESULTS,
  type AuditAction,
  type AuditObjectType
} from "../domain/vocabulary";
import { writeAudit } from "../infrastructure/write-audit";

export type AuditQuery = {
  objectType?: AuditObjectType;
  objectId?: string;
  actorId?: string;
  action?: AuditAction;
  projectId?: string;
  departmentId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
};

export class AuditQueryError extends Error {
  constructor(
    readonly code: "INVALID_QUERY" | "FORBIDDEN",
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "AuditQueryError";
  }
}

function optionalText(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim();
  if (!value) {
    return undefined;
  }
  if (value.length > 191) {
    throw new AuditQueryError("INVALID_QUERY", `${name} 长度不能超过 191。`, 400);
  }
  return value;
}

function optionalDate(params: URLSearchParams, name: string): Date | undefined {
  const value = optionalText(params, name);
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AuditQueryError("INVALID_QUERY", `${name} 必须是有效的 ISO 日期时间。`, 400);
  }
  return date;
}

export function parseAuditQuery(params: URLSearchParams): AuditQuery {
  const objectType = optionalText(params, "objectType");
  const action = optionalText(params, "action");
  const limitValue = optionalText(params, "limit");
  const limit = limitValue === undefined ? 50 : Number(limitValue);

  if (
    objectType !== undefined &&
    !AUDIT_OBJECT_TYPE_VALUES.includes(objectType as AuditObjectType)
  ) {
    throw new AuditQueryError("INVALID_QUERY", "objectType 不是有效的审计对象类型。", 400);
  }
  if (action !== undefined && !AUDIT_ACTION_VALUES.includes(action as AuditAction)) {
    throw new AuditQueryError("INVALID_QUERY", "action 不是有效的审计动作。", 400);
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AuditQueryError("INVALID_QUERY", "limit 必须是 1 到 100 的整数。", 400);
  }

  const from = optionalDate(params, "from");
  const to = optionalDate(params, "to");
  if (from && to && from > to) {
    throw new AuditQueryError("INVALID_QUERY", "from 不能晚于 to。", 400);
  }

  return {
    objectType: objectType as AuditObjectType | undefined,
    objectId: optionalText(params, "objectId"),
    actorId: optionalText(params, "actorId"),
    action: action as AuditAction | undefined,
    projectId: optionalText(params, "projectId"),
    departmentId: optionalText(params, "departmentId"),
    from,
    to,
    cursor: optionalText(params, "cursor"),
    limit
  };
}

async function denyAuditRead(context: AuditContext, reason: string): Promise<never> {
  try {
    await writeAudit(db, {
      action: AUDIT_ACTIONS.AUTHORIZATION_DENIED,
      objectType: AUDIT_OBJECT_TYPES.AUDIT_LOG,
      result: AUDIT_RESULTS.DENIED,
      context: { ...context, reason },
      metadata: {
        value: { permission: PERMISSIONS.AUDIT_READ, method: "GET", path: "/api/audit" },
        allowedFields: ["permission", "method", "path"]
      }
    });
  } catch (error) {
    console.error("Unable to persist audit-read denial", error);
  }

  throw new AuditQueryError("FORBIDDEN", "当前角色无权查看审计记录。", 403);
}

function queryMetadata(query: AuditQuery, returnedCount: number) {
  return {
    objectType: query.objectType ?? null,
    objectId: query.objectId ?? null,
    actorId: query.actorId ?? null,
    action: query.action ?? null,
    projectId: query.projectId ?? null,
    departmentId: query.departmentId ?? null,
    from: query.from?.toISOString() ?? null,
    to: query.to?.toISOString() ?? null,
    limit: query.limit,
    returnedCount
  };
}

export async function queryAuditLogs(input: {
  actor: AuthorizationActor;
  query: AuditQuery;
  context: AuditContext;
}) {
  if (input.actor.status !== "ACTIVE") {
    return denyAuditRead(input.context, "ACTOR_DISABLED");
  }

  const scopes = input.actor.grants
    .filter((grant) => grant.permission === PERMISSIONS.AUDIT_READ)
    .map((grant) => grant.scope);
  if (scopes.length === 0) {
    return denyAuditRead(input.context, "PERMISSION_NOT_GRANTED");
  }

  return db.$transaction(async (transaction) => {
    const unrestricted = scopes.includes(PERMISSION_SCOPES.ALL);
    const visibility: Prisma.AuditLogWhereInput[] = [];
    if (!unrestricted) {
      if (scopes.includes(PERMISSION_SCOPES.DEPARTMENT) && input.actor.departmentId) {
        visibility.push({ departmentId: input.actor.departmentId });
      }
      if (scopes.includes(PERMISSION_SCOPES.SELF)) {
        visibility.push({ actorId: input.actor.id });
      }
      if (scopes.includes(PERMISSION_SCOPES.PROJECT)) {
        const memberships = await transaction.projectMember.findMany({
          where: { userId: input.actor.id, leftAt: null },
          select: { projectId: true }
        });
        const projectIds = [...new Set(memberships.map(({ projectId }) => projectId))];
        if (projectIds.length > 0) {
          visibility.push({ projectId: { in: projectIds } });
        }
      }
    }

    const filters: Prisma.AuditLogWhereInput = {
      ...(input.query.objectType ? { objectType: input.query.objectType } : {}),
      ...(input.query.objectId ? { objectId: input.query.objectId } : {}),
      ...(input.query.actorId ? { actorId: input.query.actorId } : {}),
      ...(input.query.action ? { action: input.query.action } : {}),
      ...(input.query.projectId ? { projectId: input.query.projectId } : {}),
      ...(input.query.departmentId ? { departmentId: input.query.departmentId } : {}),
      ...(input.query.from || input.query.to
        ? {
            occurredAt: {
              ...(input.query.from ? { gte: input.query.from } : {}),
              ...(input.query.to ? { lte: input.query.to } : {})
            }
          }
        : {})
    };

    const records =
      !unrestricted && visibility.length === 0
        ? []
        : await transaction.auditLog.findMany({
            where: unrestricted ? filters : { AND: [filters, { OR: visibility }] },
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
            ...(input.query.cursor ? { cursor: { id: input.query.cursor }, skip: 1 } : {}),
            take: input.query.limit + 1,
            include: {
              actor: { select: { id: true, employeeNo: true, name: true } },
              project: { select: { id: true, code: true, name: true } }
            }
          });

    const hasMore = records.length > input.query.limit;
    const items = hasMore ? records.slice(0, input.query.limit) : records;
    const readAudit = await writeAudit(transaction, {
      action: AUDIT_ACTIONS.AUDIT_LOG_READ,
      objectType: AUDIT_OBJECT_TYPES.AUDIT_LOG,
      context: input.context,
      metadata: {
        value: queryMetadata(input.query, items.length),
        allowedFields: AUDIT_QUERY_FIELDS
      }
    });

    return {
      items,
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
      auditId: readAudit.id
    };
  });
}
