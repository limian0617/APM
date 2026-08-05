import { ProjectRole, Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  RESOURCE_LOAD_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { payloadHash } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  deriveResourceLoad,
  plannedLoadDays,
  type ResourceLoadSourceRow
} from "../domain/resource-load";
import { loadResourceLoadProjectionSource } from "../infrastructure/prisma-resource-load-source";

const projectionInclude = {
  people: {
    include: {
      tasks: { orderBy: [{ plannedStartAt: "asc" }, { taskCode: "asc" }, { taskId: "asc" }] }
    },
    orderBy: [{ departmentId: "asc" }, { discipline: "asc" }, { ownerMembershipId: "asc" }]
  }
} satisfies Prisma.ResourceLoadProjectionInclude;

type ResourceLoadProjection = Prisma.ResourceLoadProjectionGetPayload<{
  include: typeof projectionInclude;
}>;

export class ResourceLoadProjectionError extends Error {
  constructor(
    readonly code: "PROJECT_NOT_FOUND",
    message: string,
    readonly status = 404
  ) {
    super(message);
  }
}

function stableReason(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1024) {
    throw new TypeError("reason must contain 1 to 1024 characters");
  }
  return normalized;
}

function normalizedDepartmentId(value: string | null): string {
  const normalized = value?.trim();
  return normalized || "UNASSIGNED";
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  return clock.now;
}

function groupSourceRows(rows: readonly ResourceLoadSourceRow[]) {
  const people = new Map<
    string,
    {
      ownerMembershipId: string;
      personId: string;
      personName: string;
      departmentId: string;
      discipline: string;
      plannedDays: number;
      tasks: Array<{
        taskId: string;
        taskCode: string;
        taskName: string;
        plannedStartAt: Date;
        plannedFinishAt: Date;
        plannedDays: number;
      }>;
    }
  >();

  for (const row of rows) {
    let person = people.get(row.ownerMembershipId);
    if (!person) {
      person = {
        ownerMembershipId: row.ownerMembershipId,
        personId: row.personId,
        personName: row.personName,
        departmentId: normalizedDepartmentId(row.departmentId),
        discipline: row.discipline,
        plannedDays: 0,
        tasks: []
      };
      people.set(row.ownerMembershipId, person);
    }
    const plannedDays = plannedLoadDays(row.plannedStartAt, row.plannedFinishAt);
    person.plannedDays += plannedDays;
    person.tasks.push({
      taskId: row.taskId,
      taskCode: row.taskCode,
      taskName: row.taskName,
      plannedStartAt: row.plannedStartAt,
      plannedFinishAt: row.plannedFinishAt,
      plannedDays
    });
  }

  return [...people.values()]
    .sort((left, right) => left.ownerMembershipId.localeCompare(right.ownerMembershipId))
    .map((person) => ({
      ...person,
      tasks: person.tasks.sort(
        (left, right) =>
          left.plannedStartAt.getTime() - right.plannedStartAt.getTime() ||
          left.taskCode.localeCompare(right.taskCode) ||
          left.taskId.localeCompare(right.taskId)
      )
    }));
}

function projectionRows(projection: ResourceLoadProjection): ResourceLoadSourceRow[] {
  return projection.people.flatMap((person) =>
    person.tasks.map((task) => ({
      ownerMembershipId: person.ownerMembershipId,
      personId: person.personId,
      personName: person.personName,
      departmentId: person.departmentId,
      discipline: person.discipline,
      taskId: task.taskId,
      taskCode: task.taskCode,
      taskName: task.taskName,
      plannedStartAt: task.plannedStartAt,
      plannedFinishAt: task.plannedFinishAt
    }))
  );
}

function serializeProjection(projection: ResourceLoadProjection, includePeople: boolean) {
  return {
    projectionId: projection.id,
    projectId: projection.projectId,
    sourceChecksum: projection.sourceChecksum,
    calculatedAt: projection.calculatedAt,
    peopleCount: projection.people.length,
    departments: deriveResourceLoad(projectionRows(projection), includePeople)
  };
}

async function readProjectionOrThrow(
  client: Prisma.TransactionClient,
  projectId: string,
  sourceChecksum: string
): Promise<ResourceLoadProjection> {
  const projection = await client.resourceLoadProjection.findUnique({
    where: { projectId_sourceChecksum: { projectId, sourceChecksum } },
    include: projectionInclude
  });
  if (!projection) throw new Error("resource-load projection not found");
  return projection;
}

async function refreshInTransaction(
  client: Prisma.TransactionClient,
  input: { projectId: string; actorId: string; reason: string; auditContext: AuditContext }
) {
  const reason = stableReason(input.reason);
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.projectId}))`;
  const calculatedAt = await databaseNow(client);
  const source = await loadResourceLoadProjectionSource(client, input.projectId);
  if (!source) {
    throw new ResourceLoadProjectionError("PROJECT_NOT_FOUND", "project not found", 404);
  }

  const sourcePayload = payloadHash(source.sourceVersions);
  const existing = await client.resourceLoadProjection.findUnique({
    where: {
      projectId_sourceChecksum: { projectId: input.projectId, sourceChecksum: sourcePayload.hash }
    },
    include: projectionInclude
  });
  if (existing) {
    return { reused: true, projection: serializeProjection(existing, false), auditId: null };
  }

  const people = groupSourceRows(source.rows);
  const data: Prisma.ResourceLoadProjectionUncheckedCreateInput = {
    projectId: input.projectId,
    sourceChecksum: sourcePayload.hash,
    sourceVersionsJson: sourcePayload.value as Prisma.InputJsonValue,
    calculatedAt,
    people: {
      create: people.map((person) => ({
        ownerMembershipId: person.ownerMembershipId,
        personId: person.personId,
        personName: person.personName,
        departmentId: person.departmentId,
        discipline: person.discipline as ProjectRole,
        plannedDays: person.plannedDays,
        activeTaskCount: person.tasks.length,
        tasks: { create: person.tasks }
      }))
    }
  };
  const projection = await client.resourceLoadProjection.create({
    data,
    include: projectionInclude
  });
  const serialized = serializeProjection(projection, false);
  const activeTaskCount = people.reduce((total, person) => total + person.tasks.length, 0);
  const audit = await writeAudit(client, {
    action: AUDIT_ACTIONS.COCKPIT_RESOURCE_LOAD_REFRESHED,
    objectType: AUDIT_OBJECT_TYPES.COCKPIT_RESOURCE_LOAD,
    objectId: projection.id,
    context: { ...input.auditContext, projectId: input.projectId, reason },
    after: {
      value: {
        projectId: input.projectId,
        projectionId: projection.id,
        sourceChecksum: projection.sourceChecksum,
        calculatedAt,
        peopleCount: people.length,
        activeTaskCount,
        reused: false
      },
      allowedFields: RESOURCE_LOAD_AUDIT_FIELDS
    }
  });
  await appendOutboxEvent(client, {
    eventType: "cockpit.resource-load.refreshed",
    aggregateType: "COCKPIT_RESOURCE_LOAD",
    aggregateId: projection.id,
    idempotencyKey: `${input.projectId}:${projection.sourceChecksum}`,
    payload: {
      projectionId: projection.id,
      projectId: input.projectId,
      sourceChecksum: projection.sourceChecksum,
      calculatedAt: projection.calculatedAt.toISOString(),
      peopleCount: people.length,
      activeTaskCount
    }
  });
  return { reused: false, projection: serialized, auditId: audit.id };
}

export function refreshProjectResourceLoad(
  input: { projectId: string; actorId: string; reason: string; auditContext: AuditContext },
  transaction?: Prisma.TransactionClient
) {
  return transaction
    ? refreshInTransaction(transaction, input)
    : db.$transaction((client) => refreshInTransaction(client, input));
}

export async function getLatestProjectResourceLoad(projectId: string, includePeople: boolean) {
  const projection = await db.resourceLoadProjection.findFirst({
    where: { projectId },
    orderBy: [{ calculatedAt: "desc" }, { id: "desc" }],
    include: projectionInclude
  });
  if (!projection) {
    const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) {
      throw new ResourceLoadProjectionError("PROJECT_NOT_FOUND", "project not found", 404);
    }
    return { status: "NOT_AVAILABLE" as const, projection: null };
  }

  const currentSource = await loadResourceLoadProjectionSource(
    db as unknown as Prisma.TransactionClient,
    projectId
  );
  const currentChecksum = currentSource ? payloadHash(currentSource.sourceVersions).hash : null;
  return {
    status: currentChecksum === projection.sourceChecksum ? ("READY" as const) : ("STALE" as const),
    projection: serializeProjection(projection, includePeople)
  };
}

export async function getProjectResourceLoadById(
  projectId: string,
  projectionId: string,
  includePeople: boolean
) {
  const projection = await db.resourceLoadProjection.findUnique({
    where: { id_projectId: { id: projectionId, projectId } },
    include: projectionInclude
  });
  if (!projection) {
    throw new ResourceLoadProjectionError(
      "PROJECT_NOT_FOUND",
      "resource-load projection not found",
      404
    );
  }
  return serializeProjection(projection, includePeople);
}
