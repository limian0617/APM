import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS, type PermissionCode } from "@/lib/auth/permissions";
import { inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import { AUDIT_ACTIONS, AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import { createUphTestBatch } from "./uph-test-batch-service";

type Client = Prisma.TransactionClient;
type Actor = AuthorizationActor;

export type UphRetestContext = {
  projectId: string;
  issueId: string;
  actorId: string;
  authorizationActor: Actor;
  projectMemberRoles?: string[];
  auditContext: AuditContext;
};

export type CreateUphRetestInput = UphRetestContext & {
  issueVersion: number;
  reason: string;
  body: {
    batchNumber: string;
    plannedProductionSeconds: number;
    planDeclarationReason: string;
    observationStartedAt: string;
    observationEndedAt: string | null;
    timezone: string;
  };
};

export class UphRetestServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 403 | 404 | 409 | 422
  ) {
    super(message);
    this.name = "UphRetestServiceError";
  }
}

function text(value: unknown, field: string, maximum = 191): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new UphRetestServiceError("UPH_RETEST_INVALID", `${field}无效。`, 422);
  }
  return value.trim();
}

async function rows<T>(client: Client, query: Prisma.Sql): Promise<T[]> {
  return client.$queryRaw<T[]>(query);
}

function assertActor(input: UphRetestContext): void {
  if (
    input.authorizationActor.id !== input.actorId ||
    input.authorizationActor.status !== "ACTIVE" ||
    input.auditContext.actorId !== input.actorId
  ) {
    throw new UphRetestServiceError("AUTHORIZATION_DENIED", "复测操作人身份无效。", 403);
  }
}

async function authorize(
  client: Client,
  input: UphRetestContext,
  permissions: readonly PermissionCode[] = [
    PERMISSIONS.PROJECT_UPH_BATCH_MANAGE,
    PERMISSIONS.PROJECT_ISSUE_UPDATE
  ]
): Promise<string[]> {
  assertActor(input);
  const members = await rows<{ role: string }>(
    client,
    Prisma.sql`SELECT member.project_role::text AS role
      FROM project_members member JOIN users actor ON actor.id = member.user_id
      WHERE member.project_id = ${input.projectId} AND member.user_id = ${input.actorId}
        AND member.left_at IS NULL AND actor.status = 'ACTIVE'
      ORDER BY member.project_role`
  );
  if (!members.length)
    throw new UphRetestServiceError("AUTHORIZATION_DENIED", "无权创建UPH复测。", 403);
  const roles = members.map((member) => member.role);
  for (const permission of permissions) {
    const decision = decideAuthorization(input.authorizationActor, permission, {
      projectId: input.projectId,
      memberRoles: roles,
      requireProjectMembership: true
    });
    if (!decision.allowed)
      throw new UphRetestServiceError("AUTHORIZATION_DENIED", "无权创建UPH复测。", 403);
  }
  return roles;
}

async function lockProject(client: Client, projectId: string, writable = true): Promise<void> {
  const rowsFound = await rows<{ id: string; status: string }>(
    client,
    Prisma.sql`SELECT id, status::text AS status FROM projects WHERE id = ${projectId} FOR UPDATE`
  );
  if (!rowsFound[0]) throw new UphRetestServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  if (writable && (rowsFound[0].status === "CLOSED" || rowsFound[0].status === "CANCELED")) {
    throw new UphRetestServiceError("PROJECT_READ_ONLY", "已关闭或取消项目不能创建复测。", 409);
  }
}

type SourceFacts = {
  issueId: string;
  sourceBatchId: string;
  topologyRootNodeId: string;
  currentLockedRevisionId: string | null;
  revisionStatus: string | null;
};

async function lockIssueSource(client: Client, input: CreateUphRetestInput): Promise<SourceFacts> {
  const found = await rows<
    Pick<SourceFacts, "issueId" | "sourceBatchId" | "currentLockedRevisionId">
  >(
    client,
    Prisma.sql`SELECT relation.issue_id AS "issueId", relation.target_id AS "sourceBatchId",
      batch.current_locked_revision_id AS "currentLockedRevisionId"
      FROM issue_relations relation
      JOIN project_uph_test_batches batch
        ON batch.id = relation.target_id AND batch.project_id = relation.project_id
      WHERE relation.project_id = ${input.projectId} AND relation.issue_id = ${input.issueId}
        AND relation.relation_type = 'UPH_SOURCE_BATCH'::"IssueRelationType"
        AND relation.status = 'ACTIVE'::"IssueRelationStatus"
      ORDER BY relation.created_at, relation.id LIMIT 1 FOR UPDATE OF relation, batch`
  );
  if (!found[0])
    throw new UphRetestServiceError(
      "UPH_SOURCE_BATCH_REQUIRED",
      "性能问题缺少源UPH批次关联。",
      409
    );
  if (!found[0].currentLockedRevisionId) {
    throw new UphRetestServiceError(
      "LOCKED_REVISION_REQUIRED",
      "源UPH批次必须存在当前LOCKED修订。",
      409
    );
  }
  const revisions = await rows<{ topologyRootNodeId: string; revisionStatus: string }>(
    client,
    Prisma.sql`SELECT topology_root_node_id AS "topologyRootNodeId", status::text AS "revisionStatus"
      FROM project_uph_test_batch_revisions
      WHERE id = ${found[0].currentLockedRevisionId} AND project_id = ${input.projectId}
        AND batch_id = ${found[0].sourceBatchId}
      FOR UPDATE`
  );
  if (!revisions[0] || revisions[0].revisionStatus !== "LOCKED") {
    throw new UphRetestServiceError(
      "LOCKED_REVISION_REQUIRED",
      "源UPH批次必须存在当前LOCKED修订。",
      409
    );
  }
  return {
    ...found[0],
    topologyRootNodeId: revisions[0].topologyRootNodeId,
    revisionStatus: revisions[0].revisionStatus
  };
}

async function assertIssuePath(client: Client, input: CreateUphRetestInput): Promise<void> {
  const found = await rows<{ id: string }>(
    client,
    Prisma.sql`SELECT id FROM issues WHERE id = ${input.issueId} AND project_id = ${input.projectId}`
  );
  if (!found[0]) {
    throw new UphRetestServiceError("ISSUE_NOT_FOUND", "问题不存在或不属于该项目。", 404);
  }
}

type IssueFact = {
  id: string;
  status: string;
  version: number;
  category: string;
  sourceType: string;
};

async function lockIssue(client: Client, input: CreateUphRetestInput): Promise<IssueFact> {
  const found = await rows<IssueFact>(
    client,
    Prisma.sql`SELECT id, status::text AS status, version, category::text AS category, source_type::text AS "sourceType"
      FROM issues WHERE id = ${input.issueId} AND project_id = ${input.projectId} FOR UPDATE`
  );
  if (!found[0])
    throw new UphRetestServiceError("ISSUE_NOT_FOUND", "问题不存在或不属于该项目。", 404);
  if (found[0].category !== "PERFORMANCE" || found[0].sourceType !== "PROJECT") {
    throw new UphRetestServiceError(
      "UPH_RETEST_ISSUE_INVALID",
      "只有项目性能问题可以创建UPH复测。",
      422
    );
  }
  if (found[0].status === "CLOSED")
    throw new UphRetestServiceError("ISSUE_CLOSED", "已关闭问题必须先重开才能创建复测。", 409);
  if (found[0].version !== input.issueVersion)
    throw new UphRetestServiceError("VERSION_CONFLICT", "问题版本已变化。", 409);
  return found[0];
}

async function nextHistorySequence(client: Client, issueId: string): Promise<number> {
  const result = await rows<{ sequence: number | null }>(
    client,
    Prisma.sql`SELECT MAX(sequence) AS sequence FROM issue_histories WHERE issue_id = ${issueId}`
  );
  return Number(result[0]?.sequence ?? 0) + 1;
}

export async function createUphRetest(input: CreateUphRetestInput, transaction?: Client) {
  return inTransaction(transaction, async (client) => {
    const roles = await authorize(client, input);
    await assertIssuePath(client, input);
    await lockProject(client, input.projectId, true);
    const source = await lockIssueSource(client, input);
    const issue = await lockIssue(client, input);
    const created = await createUphTestBatch(
      {
        projectId: input.projectId,
        actorId: input.actorId,
        authorizationActor: input.authorizationActor,
        auditContext: input.auditContext,
        body: {
          ...input.body,
          topologyRootNodeId: source.topologyRootNodeId
        }
      },
      client
    );
    const relationRows = await rows<{
      id: string;
      issueId: string;
      relationType: string;
      targetId: string;
      status: string;
      createdAt: Date;
    }>(
      client,
      Prisma.sql`INSERT INTO issue_relations
        (id, project_id, issue_id, relation_type, target_id, status, reason, created_by_id, created_at)
        VALUES (${randomUUID()}, ${input.projectId}, ${input.issueId},
          'UPH_RETEST_BATCH'::"IssueRelationType", ${created.batchId}, 'ACTIVE'::"IssueRelationStatus",
          ${input.reason}, ${input.actorId}, CURRENT_TIMESTAMP)
        RETURNING id, issue_id AS "issueId", relation_type::text AS "relationType",
          target_id AS "targetId", status::text AS status, created_at AS "createdAt"`
    );
    const relation = relationRows[0];
    if (!relation)
      throw new UphRetestServiceError("UPH_RETEST_CONFLICT", "复测关联创建失败。", 409);
    const updated = await rows<{ version: number }>(
      client,
      Prisma.sql`UPDATE issues SET version = version + 1, updated_by_id = ${input.actorId}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${input.issueId} AND project_id = ${input.projectId} AND version = ${issue.version}
        RETURNING version`
    );
    if (!updated[0]) throw new UphRetestServiceError("VERSION_CONFLICT", "问题版本已变化。", 409);
    const payload = {
      projectId: input.projectId,
      issueId: input.issueId,
      sourceBatchId: source.sourceBatchId,
      retestBatchId: created.batchId,
      retestRevisionId: created.revisionId,
      relationId: relation.id,
      reason: input.reason
    };
    await client.issueHistory.create({
      data: {
        projectId: input.projectId,
        issueId: input.issueId,
        sequence: await nextHistorySequence(client, input.issueId),
        eventType: "RELATION_ADDED",
        reason: input.reason,
        snapshotJson: { relation, ...payload } as Prisma.InputJsonValue,
        actorId: input.actorId
      }
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.UPH_RETEST_BATCH_CREATED,
      objectType: AUDIT_OBJECT_TYPES.UPH_TEST_BATCH,
      objectId: created.batchId,
      context: {
        ...input.auditContext,
        actorId: input.actorId,
        projectId: input.projectId,
        reason: input.reason
      },
      after: { value: payload, allowedFields: Object.keys(payload) }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "uph.retest-batch.created",
      aggregateType: AUDIT_OBJECT_TYPES.UPH_TEST_BATCH,
      aggregateId: created.batchId,
      idempotencyKey: `uph:retest:${input.issueId}:${created.batchId}`,
      payload: { ...payload, auditId: audit.id }
    });
    return {
      ...created,
      sourceBatchId: source.sourceBatchId,
      relation,
      issueVersion: updated[0].version,
      roles,
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function listUphRetests(input: UphRetestContext) {
  return inTransaction(undefined, async (client) => {
    await authorize(client, input, [PERMISSIONS.PROJECT_ISSUE_READ, PERMISSIONS.PROJECT_UPH_READ]);
    await lockProject(client, input.projectId);
    const issue = await rows<{ id: string; category: string; sourceType: string }>(
      client,
      Prisma.sql`SELECT id, category::text AS category, source_type::text AS "sourceType"
        FROM issues WHERE id = ${input.issueId} AND project_id = ${input.projectId}`
    );
    if (!issue[0])
      throw new UphRetestServiceError("ISSUE_NOT_FOUND", "问题不存在或不属于该项目。", 404);
    if (issue[0].category !== "PERFORMANCE" || issue[0].sourceType !== "PROJECT") {
      throw new UphRetestServiceError(
        "UPH_RETEST_ISSUE_INVALID",
        "只有项目性能问题可以读取UPH复测。",
        422
      );
    }
    const items = await rows<Record<string, unknown>>(
      client,
      Prisma.sql`SELECT relation.id AS "relationId", relation.issue_id AS "issueId", relation.target_id AS "batchId",
        relation.status::text AS status, relation.reason, relation.created_at AS "createdAt",
        batch.batch_number AS "batchNumber", batch.current_work_revision_id AS "currentWorkRevisionId"
        FROM issue_relations relation
        JOIN project_uph_test_batches batch ON batch.id = relation.target_id AND batch.project_id = relation.project_id
        WHERE relation.project_id = ${input.projectId} AND relation.issue_id = ${input.issueId}
          AND relation.relation_type = 'UPH_RETEST_BATCH'::"IssueRelationType"
        ORDER BY relation.created_at, relation.id`
    );
    return { items };
  });
}
