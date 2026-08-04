import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  COCKPIT_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { payloadHash } from "@/modules/governance/domain/idempotency";

import { deriveCockpitHealth } from "../domain/cockpit-health";
import { loadCockpitProjectionSource } from "../infrastructure/prisma-cockpit-source";

const projectionInclude = {
  exceptions: { orderBy: { position: "asc" } }
} satisfies Prisma.CockpitProjectionInclude;

export class CockpitProjectionError extends Error {
  constructor(
    readonly code: "PROJECT_NOT_FOUND",
    message: string,
    readonly status = 404
  ) {
    super(message);
  }
}

function stableReason(value: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1024) {
    throw new TypeError("reason 必须是 1 到 1024 个字符。");
  }
  return normalized;
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  return clock.now;
}

function serializeProjection(
  projection: Prisma.CockpitProjectionGetPayload<{ include: typeof projectionInclude }>
) {
  return {
    projectionId: projection.id,
    projectId: projection.projectId,
    sourceChecksum: projection.sourceChecksum,
    sourceVersions: projection.sourceVersionsJson,
    health: projection.health,
    calculatedAt: projection.calculatedAt,
    exceptions: projection.exceptions.map((exception) => ({
      exceptionId: exception.id,
      kind: exception.kind,
      sourceKey: exception.sourceKey,
      severity: exception.severity,
      summary: exception.summary,
      occurredAt: exception.occurredAt,
      drilldownPath: exception.drilldownPath,
      position: exception.position
    }))
  };
}

async function readProjectionOrThrow(
  client: Prisma.TransactionClient,
  projectId: string,
  sourceChecksum: string
) {
  const projection = await client.cockpitProjection.findUnique({
    where: { projectId_sourceChecksum: { projectId, sourceChecksum } },
    include: projectionInclude
  });
  if (!projection) throw new Error("驾驶舱投影未找到。");
  return projection;
}

async function refreshInTransaction(
  client: Prisma.TransactionClient,
  input: {
    projectId: string;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  }
) {
  const reason = stableReason(input.reason);
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.projectId}))`;
  const calculatedAt = await databaseNow(client);
  const source = await loadCockpitProjectionSource(client, input.projectId, calculatedAt);
  if (!source) throw new CockpitProjectionError("PROJECT_NOT_FOUND", "项目不存在。", 404);

  const sourcePayload = payloadHash(source.sourceVersions);
  const existing = await client.cockpitProjection.findUnique({
    where: {
      projectId_sourceChecksum: { projectId: input.projectId, sourceChecksum: sourcePayload.hash }
    },
    include: projectionInclude
  });
  if (existing) return { reused: true, projection: serializeProjection(existing), auditId: null };

  const derived = deriveCockpitHealth(source.healthInput);
  const projection = await client.cockpitProjection.create({
    data: {
      projectId: input.projectId,
      sourceChecksum: sourcePayload.hash,
      sourceVersionsJson: sourcePayload.value as Prisma.InputJsonValue,
      health: derived.health,
      calculatedAt,
      exceptions: {
        create: derived.exceptions.map((exception, index) => ({
          kind: exception.kind,
          sourceKey: exception.sourceKey,
          severity: exception.severity,
          summary: exception.summary,
          occurredAt: exception.occurredAt,
          drilldownPath: exception.drilldownPath,
          position: index + 1
        }))
      }
    },
    include: projectionInclude
  });
  const serialized = serializeProjection(projection);
  const audit = await writeAudit(client, {
    action: AUDIT_ACTIONS.COCKPIT_PROJECTION_REFRESHED,
    objectType: AUDIT_OBJECT_TYPES.COCKPIT_PROJECTION,
    objectId: projection.id,
    context: { ...input.auditContext, projectId: input.projectId, reason },
    after: {
      value: {
        projectId: input.projectId,
        projectionId: projection.id,
        sourceChecksum: projection.sourceChecksum,
        health: projection.health,
        calculatedAt,
        exceptionCount: projection.exceptions.length,
        reused: false
      },
      allowedFields: COCKPIT_AUDIT_FIELDS
    }
  });
  await appendOutboxEvent(client, {
    eventType: "cockpit.projection.refreshed",
    aggregateType: "COCKPIT_PROJECTION",
    aggregateId: projection.id,
    idempotencyKey: `${input.projectId}:${projection.sourceChecksum}`,
    payload: {
      projectionId: projection.id,
      projectId: input.projectId,
      sourceChecksum: projection.sourceChecksum,
      health: projection.health,
      calculatedAt: projection.calculatedAt.toISOString(),
      exceptionCount: projection.exceptions.length
    }
  });
  return { reused: false, projection: serialized, auditId: audit.id };
}

export async function refreshProjectCockpitProjection(
  input: {
    projectId: string;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  return transaction
    ? refreshInTransaction(transaction, input)
    : db.$transaction((client) => refreshInTransaction(client, input));
}

export async function getLatestCockpitProjection(projectId: string) {
  const projection = await db.cockpitProjection.findFirst({
    where: { projectId },
    orderBy: [{ calculatedAt: "desc" }, { id: "desc" }],
    include: projectionInclude
  });
  if (projection) return { status: "READY" as const, projection: serializeProjection(projection) };

  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) throw new CockpitProjectionError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  return { status: "NOT_AVAILABLE" as const, projection: null };
}
