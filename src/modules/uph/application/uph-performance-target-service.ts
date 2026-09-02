import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";

import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import { AUDIT_ACTIONS, AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { normalizePositiveTargetUph } from "../domain/uph-performance-target";

export class UphPerformanceTargetServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
  }
}

type Input = {
  projectId: string;
  actorId: string;
  authorizationActor: AuthorizationActor;
  projectMemberRoles: string[];
  auditContext: AuditContext;
};
type Client = Prisma.TransactionClient;

function auth(input: Input, permission: string) {
  if (
    input.authorizationActor.id !== input.actorId ||
    input.authorizationActor.status !== "ACTIVE" ||
    input.auditContext.actorId !== input.actorId
  ) {
    throw new UphPerformanceTargetServiceError("ACTOR_INVALID", "操作人身份无效。", 403);
  }
  const result = decideAuthorization(input.authorizationActor, permission as never, {
    projectId: input.projectId,
    memberRoles: input.projectMemberRoles,
    requireProjectMembership: true
  });
  if (!result.allowed)
    throw new UphPerformanceTargetServiceError("FORBIDDEN", "无权执行UPH目标操作。", 403);
}

async function assertActiveMembership(client: Client | typeof db, input: Input): Promise<void> {
  const rows = await client.$queryRaw<Array<{ role: string }>>(
    Prisma.sql`SELECT member.project_role::text AS role FROM project_members member JOIN users actor ON actor.id = member.user_id WHERE member.project_id = ${input.projectId} AND member.user_id = ${input.actorId} AND member.left_at IS NULL AND actor.status = 'ACTIVE'`
  );
  if (!rows.length)
    throw new UphPerformanceTargetServiceError("FORBIDDEN", "当前成员不属于该项目。", 403);
  input.projectMemberRoles = rows.map((row) => row.role);
}

function checksum(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requiredText(value: unknown, field: string, maximum = 1_024): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new UphPerformanceTargetServiceError("UPH_TARGET_INVALID", `${field}无效。`, 422);
  }
  return value.trim();
}

async function lockWritableProject(client: Client, projectId: string): Promise<void> {
  const projects = await client.$queryRaw<Array<{ id: string; status: string }>>(
    Prisma.sql`SELECT id, status::text AS status FROM projects WHERE id = ${projectId} FOR UPDATE`
  );
  if (!projects[0])
    throw new UphPerformanceTargetServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  if (projects[0].status === "CLOSED" || projects[0].status === "CANCELED") {
    throw new UphPerformanceTargetServiceError(
      "PROJECT_READ_ONLY",
      "已关闭或取消项目不能写入UPH目标。",
      409
    );
  }
}

async function command<T>(transaction: Client | undefined, fn: (client: Client) => Promise<T>) {
  return inTransaction(transaction, fn);
}

export async function listUphPerformanceTargets(
  input: Input & { topologyRootNodeId?: string; revisionId?: string }
) {
  await assertActiveMembership(db, input);
  auth(input, PERMISSIONS.PROJECT_UPH_READ);
  if (input.revisionId) {
    const revision = await db.$queryRaw<Array<{ id: string; topologyRootNodeId: string }>>(
      Prisma.sql`SELECT id, topology_root_node_id AS "topologyRootNodeId" FROM project_uph_test_batch_revisions WHERE id = ${input.revisionId} AND project_id = ${input.projectId}`
    );
    if (!revision[0])
      throw new UphPerformanceTargetServiceError(
        "UPH_REVISION_NOT_FOUND",
        "UPH修订不存在或不属于该项目。",
        404
      );
    if (input.topologyRootNodeId && revision[0].topologyRootNodeId !== input.topologyRootNodeId)
      throw new UphPerformanceTargetServiceError(
        "UPH_ROOT_MISMATCH",
        "查询拓扑根与修订不一致。",
        404
      );
    if (!input.topologyRootNodeId) input.topologyRootNodeId = revision[0].topologyRootNodeId;
  }
  const rows = await db.$queryRaw<Array<Record<string, unknown>>>(
    Prisma.sql`WITH requested_revision AS (SELECT topology_root_node_id, locked_at FROM project_uph_test_batch_revisions WHERE id = ${input.revisionId ?? null} AND project_id = ${input.projectId}) SELECT t.id, t.project_id AS "projectId", t.topology_root_node_id AS "topologyRootNodeId", t.current_published_version_id AS "currentPublishedVersionId", t.version, v.id AS "versionId", v.revision, v.status::text AS status, v.target_uph::text AS "targetUph", v.reason, v.checksum, v.effective_at AS "effectiveAt", v.resource_version AS "resourceVersion", v.created_at AS "createdAt", v.published_at AS "publishedAt" FROM project_uph_performance_targets t LEFT JOIN LATERAL (SELECT vv.* FROM project_uph_performance_target_versions vv WHERE vv.target_id = t.id AND vv.project_id = t.project_id AND vv.status IN ('PUBLISHED','SUPERSEDED') AND vv.published_at IS NOT NULL AND vv.effective_at <= COALESCE(${null}::timestamptz, (SELECT locked_at FROM requested_revision WHERE topology_root_node_id = t.topology_root_node_id)) AND vv.published_at <= COALESCE(${null}::timestamptz, (SELECT locked_at FROM requested_revision WHERE topology_root_node_id = t.topology_root_node_id)) ORDER BY vv.effective_at DESC, vv.published_at DESC, vv.revision DESC LIMIT 1) v ON true WHERE t.project_id = ${input.projectId} AND (${input.topologyRootNodeId ?? null}::text IS NULL OR t.topology_root_node_id = ${input.topologyRootNodeId ?? null}) ORDER BY t.topology_root_node_id`
  );
  if (!input.revisionId) {
    const current = await db.$queryRaw<Array<Record<string, unknown>>>(
      Prisma.sql`SELECT t.id, t.project_id AS "projectId", t.topology_root_node_id AS "topologyRootNodeId", t.current_published_version_id AS "currentPublishedVersionId", t.version, v.id AS "versionId", v.revision, v.status::text AS status, v.target_uph::text AS "targetUph", v.reason, v.checksum, v.effective_at AS "effectiveAt", v.resource_version AS "resourceVersion", v.created_at AS "createdAt", v.published_at AS "publishedAt" FROM project_uph_performance_targets t LEFT JOIN project_uph_performance_target_versions v ON v.id = t.current_published_version_id AND v.project_id = t.project_id WHERE t.project_id = ${input.projectId} AND (${input.topologyRootNodeId ?? null}::text IS NULL OR t.topology_root_node_id = ${input.topologyRootNodeId ?? null}) ORDER BY t.topology_root_node_id`
    );
    return { items: current };
  }
  return { items: rows };
}

export async function createUphPerformanceTarget(
  input: Input & { topologyRootNodeId: string; targetUph: string; reason: string },
  transaction?: Client
) {
  const topologyRootNodeId = requiredText(input.topologyRootNodeId, "topologyRootNodeId");
  const reason = requiredText(input.reason, "reason");
  let targetUph: string;
  try {
    targetUph = normalizePositiveTargetUph(input.targetUph);
  } catch (error) {
    throw new UphPerformanceTargetServiceError(
      error instanceof Error && error.message === "UPH_TARGET_MUST_BE_POSITIVE"
        ? "UPH_TARGET_MUST_BE_POSITIVE"
        : "UPH_TARGET_INVALID",
      "targetUph必须是正的六位十进制UPH值。",
      422
    );
  }
  return command(transaction, async (client) => {
    await assertActiveMembership(client, input);
    auth(input, PERMISSIONS.PROJECT_UPH_DEFINITION_MANAGE);
    await lockWritableProject(client, input.projectId);
    const root = await client.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM project_uph_topology_nodes WHERE id = ${topologyRootNodeId} AND project_id = ${input.projectId} AND parent_relation = 'ROOT' FOR SHARE`
    );
    if (!root[0])
      throw new UphPerformanceTargetServiceError(
        "UPH_ROOT_NOT_FOUND",
        "UPH拓扑根不存在或不属于该项目。",
        404
      );
    const target = await client.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`INSERT INTO project_uph_performance_targets (id, project_id, topology_root_node_id, created_by_id) VALUES (${randomUUID()}, ${input.projectId}, ${topologyRootNodeId}, ${input.actorId}) ON CONFLICT (project_id, topology_root_node_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP RETURNING id`
    );
    const targetId = target[0]!.id;
    const revision = await client.$queryRaw<Array<{ revision: number }>>(
      Prisma.sql`SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM project_uph_performance_target_versions WHERE target_id = ${targetId} AND project_id = ${input.projectId}`
    );
    const rev = Number(revision[0]?.revision ?? 1);
    const payload = {
      projectId: input.projectId,
      targetId,
      topologyRootNodeId,
      revision: rev,
      targetUph,
      reason
    };
    const inserted = await client.$queryRaw<Array<Record<string, unknown>>>(
      Prisma.sql`INSERT INTO project_uph_performance_target_versions (id, project_id, target_id, revision, status, target_uph, reason, checksum, effective_at, created_by_id) VALUES (${randomUUID()}, ${input.projectId}, ${targetId}, ${rev}, 'DRAFT', ${targetUph}::numeric(20,6), ${reason}, ${checksum(payload)}, CURRENT_TIMESTAMP, ${input.actorId}) RETURNING id, project_id AS "projectId", target_id AS "targetId", revision, status::text AS status, target_uph::text AS "targetUph", reason, checksum, effective_at AS "effectiveAt", resource_version AS "resourceVersion"`
    );
    const version = inserted[0]!;
    await writeAudit(client, {
      action: AUDIT_ACTIONS.UPH_PERFORMANCE_TARGET_DRAFT_CREATED,
      objectType: AUDIT_OBJECT_TYPES.UPH_PERFORMANCE_TARGET_VERSION,
      objectId: String(version.id),
      context: input.auditContext,
      after: { value: payload, allowedFields: Object.keys(payload) }
    });
    await appendOutboxEvent(client, {
      eventType: "uph.performance-target.draft-created",
      aggregateType: "UPH_PERFORMANCE_TARGET_VERSION",
      aggregateId: String(version.id),
      idempotencyKey: `uph-target:${version.id}`,
      payload
    });
    return version;
  });
}

export async function publishUphPerformanceTarget(
  input: Input & { targetVersionId: string; resourceVersion: number; reason: string },
  transaction?: Client
) {
  return command(transaction, async (client) => {
    await assertActiveMembership(client, input);
    auth(input, PERMISSIONS.PROJECT_UPH_PUBLISH);
    await lockWritableProject(client, input.projectId);
    const target = await client.$queryRaw<
      Array<{ id: string; currentPublishedVersionId: string | null }>
    >(
      Prisma.sql`SELECT target.id, target.current_published_version_id AS "currentPublishedVersionId"
        FROM project_uph_performance_targets target
        WHERE target.project_id = ${input.projectId}
          AND target.id = (SELECT target_id FROM project_uph_performance_target_versions
            WHERE id = ${input.targetVersionId} AND project_id = ${input.projectId})
        FOR UPDATE`
    );
    if (!target[0])
      throw new UphPerformanceTargetServiceError(
        "UPH_TARGET_VERSION_NOT_FOUND",
        "UPH目标版本不存在。",
        404
      );
    const version = await client.$queryRaw<
      Array<{
        id: string;
        targetId: string;
        targetUph: string;
        checksum: string;
        revision: number;
        resourceVersion: number;
        status: string;
      }>
    >(
      Prisma.sql`SELECT id, target_id AS "targetId", target_uph::text AS "targetUph", checksum, revision, resource_version AS "resourceVersion", status::text AS status FROM project_uph_performance_target_versions WHERE id = ${input.targetVersionId} AND project_id = ${input.projectId} FOR UPDATE`
    );
    const current = version[0];
    if (!current)
      throw new UphPerformanceTargetServiceError(
        "UPH_TARGET_VERSION_NOT_FOUND",
        "UPH目标版本不存在。",
        404
      );
    if (current.status !== "DRAFT")
      throw new UphPerformanceTargetServiceError(
        "UPH_TARGET_VERSION_IMMUTABLE",
        "目标版本已发布或替代。",
        409
      );
    if (current.resourceVersion !== input.resourceVersion)
      throw new UphPerformanceTargetServiceError(
        "VERSION_CONFLICT",
        "目标版本已被其他操作更新。",
        409
      );
    await client.$executeRaw(
      Prisma.sql`UPDATE project_uph_performance_target_versions SET status = 'SUPERSEDED' WHERE project_id = ${input.projectId} AND target_id = ${current.targetId} AND status = 'PUBLISHED'`
    );
    await client.$executeRaw(
      Prisma.sql`UPDATE project_uph_performance_target_versions SET status = 'PUBLISHED', published_by_id = ${input.actorId}, published_at = CURRENT_TIMESTAMP WHERE id = ${current.id} AND project_id = ${input.projectId}`
    );
    await client.$executeRaw(
      Prisma.sql`UPDATE project_uph_performance_targets SET current_published_version_id = ${current.id}, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ${current.targetId} AND project_id = ${input.projectId}`
    );
    await writeAudit(client, {
      action: AUDIT_ACTIONS.UPH_PERFORMANCE_TARGET_PUBLISHED,
      objectType: AUDIT_OBJECT_TYPES.UPH_PERFORMANCE_TARGET_VERSION,
      objectId: current.id,
      context: input.auditContext,
      after: {
        value: { ...current, reason: input.reason },
        allowedFields: ["id", "targetId", "targetUph", "checksum", "revision", "status", "reason"]
      }
    });
    await appendOutboxEvent(client, {
      eventType: "uph.performance-target.published",
      aggregateType: "UPH_PERFORMANCE_TARGET_VERSION",
      aggregateId: current.id,
      idempotencyKey: `uph-target-publish:${current.id}`,
      payload: { ...current, reason: input.reason }
    });
    return { ...current, status: "PUBLISHED", publishedById: input.actorId };
  });
}
