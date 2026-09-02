import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  ISSUE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  assertPerformanceIssueCreation,
  decidePerformanceIssue
} from "../domain/uph-performance-issue";

type Client = Prisma.TransactionClient;
type RevisionStatus = "DRAFT" | "PM_CONFIRMED" | "LOCKED" | "SUPERSEDED";

export type UphPerformanceIssueAuthorizationActor = AuthorizationActor;

export type UphPerformanceIssueContext = {
  projectId: string;
  batchId: string;
  revisionId: string;
  analysisId: string;
  actorId: string;
  authorizationActor: UphPerformanceIssueAuthorizationActor;
  projectMemberRoles?: string[];
  auditContext: AuditContext;
};

export type CreateUphPerformanceIssueInput = UphPerformanceIssueContext & {
  title: string;
  confirmedText: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  reason: string;
};

export type UphPerformanceIssueResponse = {
  issue: Record<string, unknown>;
  sourceSnapshot: Record<string, unknown>;
  deduplicated: boolean;
  auditId?: string;
  outboxEventId?: string;
};

export class UphPerformanceIssueServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 403 | 404 | 409 | 422
  ) {
    super(message);
    this.name = "UphPerformanceIssueServiceError";
  }
}

type ProjectRow = {
  id: string;
  code: string;
  name: string;
  departmentId: string | null;
  status: string;
};

type BatchRow = {
  id: string;
  projectId: string;
  batchNumber: string;
  currentLockedRevisionId: string | null;
};

type RevisionRow = {
  id: string;
  projectId: string;
  batchId: string;
  revisionNumber: number;
  status: RevisionStatus;
  topologyRootNodeId: string;
  topologyVersionId: string;
  formulaVersionId: string;
  lockedAt: Date | null;
  lockedChecksum: string | null;
};

type AnalysisRow = {
  id: string;
  projectId: string;
  batchId: string;
  revisionId: string;
  lockedChecksum: string;
  formulaVersionId: string;
  formulaChecksum: string;
  engineCode: string;
  inputSnapshotJson: unknown;
  resultSnapshotJson: unknown;
  status: string;
  warningsJson: unknown;
  rootMeasuredCapacityUph: string;
  actualGoodUph: string;
  utilizationA: string;
  createdAt: Date;
};

type TargetRow = {
  targetId: string;
  targetVersionId: string;
  targetRevision: number;
  targetUph: string;
  targetChecksum: string;
  effectiveAt: Date;
  publishedAt: Date;
};

type RelationRow = {
  id: string;
  issueId: string;
  relationType: string;
  targetId: string;
  status: string;
  reason: string;
  createdById: string;
  createdAt: Date;
};

type IssueRow = {
  id: string;
  projectId: string;
  title: string;
  confirmedText: string;
  sourceType: string;
  category: string;
  severity: string;
  phenomenonDescription: string | null;
  rootCauseCategory: string | null;
  rootCauseDescription: string | null;
  status: string;
  version: number;
  createdById: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
};

type HistoryRow = {
  id: string;
  sequence: number;
  eventType: string;
  reason: string;
  snapshotJson: unknown;
  actorId: string;
  createdAt: Date;
};

const ISSUE_FIELDS = [
  ...ISSUE_AUDIT_FIELDS,
  "issueId",
  "confirmedText",
  "phenomenonDescription",
  "rootCauseDescription",
  "sourceSnapshot",
  "deduplicated"
] as const;

function text(value: unknown, field: string, maximum = 191): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new UphPerformanceIssueServiceError(
      "UPH_PERFORMANCE_ISSUE_INVALID",
      `${field}无效。`,
      422
    );
  }
  return value.trim();
}

function assertActor(input: UphPerformanceIssueContext): void {
  if (
    input.authorizationActor.id !== input.actorId ||
    input.authorizationActor.status !== "ACTIVE" ||
    input.auditContext.actorId !== input.actorId
  ) {
    throw new UphPerformanceIssueServiceError(
      "AUTHORIZATION_DENIED",
      "性能问题操作人身份无效。",
      403
    );
  }
}

async function rows<T>(client: Client, query: Prisma.Sql): Promise<T[]> {
  return client.$queryRaw<T[]>(query);
}

async function authorize(
  client: Client,
  input: UphPerformanceIssueContext,
  permissions: readonly (typeof PERMISSIONS)[keyof typeof PERMISSIONS][] = [
    PERMISSIONS.PROJECT_UPH_READ,
    PERMISSIONS.PROJECT_ISSUE_CREATE
  ]
): Promise<void> {
  assertActor(input);
  const members = await rows<{ role: string }>(
    client,
    Prisma.sql`SELECT member.project_role::text AS role
      FROM project_members member
      JOIN users actor ON actor.id = member.user_id
      WHERE member.project_id = ${input.projectId}
        AND member.user_id = ${input.actorId}
        AND member.left_at IS NULL
        AND actor.status = 'ACTIVE'
      ORDER BY member.project_role`
  );
  if (!members.length) {
    throw new UphPerformanceIssueServiceError("AUTHORIZATION_DENIED", "无权创建性能问题。", 403);
  }
  for (const permission of permissions) {
    const decision = decideAuthorization(input.authorizationActor, permission, {
      projectId: input.projectId,
      memberRoles: members.map((member) => member.role),
      requireProjectMembership: true
    });
    if (!decision.allowed) {
      throw new UphPerformanceIssueServiceError("AUTHORIZATION_DENIED", "无权创建性能问题。", 403);
    }
  }
}

async function lockProject(
  client: Client,
  projectId: string,
  writable = true
): Promise<ProjectRow> {
  const result = await rows<ProjectRow>(
    client,
    Prisma.sql`SELECT id, code, name, department_id AS "departmentId", status::text AS status
      FROM projects WHERE id = ${projectId} FOR UPDATE`
  );
  if (!result[0])
    throw new UphPerformanceIssueServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  if (writable && (result[0].status === "CLOSED" || result[0].status === "CANCELED")) {
    throw new UphPerformanceIssueServiceError(
      "PROJECT_READ_ONLY",
      "已关闭或取消项目不能写入性能问题。",
      409
    );
  }
  return result[0];
}

async function lockBatch(client: Client, projectId: string, batchId: string): Promise<BatchRow> {
  const result = await rows<BatchRow>(
    client,
    Prisma.sql`SELECT id, project_id AS "projectId", batch_number AS "batchNumber",
      current_locked_revision_id AS "currentLockedRevisionId"
      FROM project_uph_test_batches
      WHERE id = ${batchId} AND project_id = ${projectId} FOR UPDATE`
  );
  if (!result[0])
    throw new UphPerformanceIssueServiceError(
      "TEST_BATCH_NOT_FOUND",
      "测试批次不存在或不属于该项目。",
      404
    );
  return result[0];
}

async function lockRevision(
  client: Client,
  projectId: string,
  batchId: string,
  revisionId: string,
  allowSuperseded = false
): Promise<RevisionRow> {
  const result = await rows<RevisionRow>(
    client,
    Prisma.sql`SELECT id, project_id AS "projectId", batch_id AS "batchId",
      revision_number AS "revisionNumber", status::text AS status,
      topology_root_node_id AS "topologyRootNodeId", topology_version_id AS "topologyVersionId",
      formula_version_id AS "formulaVersionId", locked_at AS "lockedAt", locked_checksum AS "lockedChecksum"
      FROM project_uph_test_batch_revisions
      WHERE id = ${revisionId} AND project_id = ${projectId} AND batch_id = ${batchId}
      FOR UPDATE`
  );
  if (!result[0]) {
    throw new UphPerformanceIssueServiceError(
      "TEST_BATCH_REVISION_NOT_FOUND",
      "测试批次修订不存在或路径不一致。",
      404
    );
  }
  if (
    (!allowSuperseded && result[0].status !== "LOCKED") ||
    (allowSuperseded && !["LOCKED", "SUPERSEDED"].includes(result[0].status)) ||
    !result[0].lockedAt ||
    !result[0].lockedChecksum
  ) {
    throw new UphPerformanceIssueServiceError(
      "LOCKED_REVISION_REQUIRED",
      "只能从当前LOCKED修订创建性能问题。",
      409
    );
  }
  return result[0];
}

async function lockAnalysis(
  client: Client,
  input: UphPerformanceIssueContext,
  revision: RevisionRow
): Promise<AnalysisRow> {
  const result = await rows<AnalysisRow>(
    client,
    Prisma.sql`SELECT id, project_id AS "projectId", batch_id AS "batchId", revision_id AS "revisionId",
      locked_checksum AS "lockedChecksum", formula_version_id AS "formulaVersionId",
      formula_checksum AS "formulaChecksum", engine_code AS "engineCode",
      input_snapshot_json AS "inputSnapshotJson", result_snapshot_json AS "resultSnapshotJson",
      status::text AS status, warnings_json AS "warningsJson",
      root_capacity_uph::text AS "rootMeasuredCapacityUph", actual_good_uph::text AS "actualGoodUph",
      utilization_a::text AS "utilizationA", created_at AS "createdAt"
      FROM project_uph_analysis_snapshots
      WHERE id = ${input.analysisId} AND project_id = ${input.projectId}
        AND batch_id = ${input.batchId} AND revision_id = ${input.revisionId}
      FOR UPDATE`
  );
  if (!result[0])
    throw new UphPerformanceIssueServiceError(
      "ANALYSIS_NOT_FOUND",
      "分析快照不存在或路径不一致。",
      404
    );
  if (result[0].lockedChecksum !== revision.lockedChecksum) {
    throw new UphPerformanceIssueServiceError(
      "ANALYSIS_CONFLICT",
      "分析快照与LOCKED修订checksum不一致。",
      409
    );
  }
  if (result[0].formulaVersionId !== revision.formulaVersionId) {
    throw new UphPerformanceIssueServiceError(
      "ANALYSIS_CONFLICT",
      "分析快照与LOCKED修订公式版本不一致。",
      409
    );
  }
  if (!["COMPUTED", "NO_OUTPUT"].includes(result[0].status)) {
    throw new UphPerformanceIssueServiceError(
      "ANALYSIS_CONFLICT",
      "分析快照尚未完成确定性计算。",
      409
    );
  }
  return result[0];
}

async function applicableTarget(
  client: Client,
  projectId: string,
  revision: RevisionRow
): Promise<TargetRow> {
  const result = await rows<TargetRow>(
    client,
    Prisma.sql`SELECT target.id AS "targetId", version.id AS "targetVersionId",
      version.revision AS "targetRevision", version.target_uph::text AS "targetUph",
      version.checksum AS "targetChecksum", version.effective_at AS "effectiveAt",
      version.published_at AS "publishedAt"
      FROM project_uph_performance_targets target
      JOIN project_uph_topology_nodes root
        ON root.id = target.topology_root_node_id AND root.project_id = target.project_id
        AND root.parent_relation = 'ROOT'
      JOIN project_uph_performance_target_versions version
        ON version.target_id = target.id AND version.project_id = target.project_id
      WHERE target.project_id = ${projectId}
        AND target.topology_root_node_id = ${revision.topologyRootNodeId}
        AND version.status IN ('PUBLISHED', 'SUPERSEDED')
        AND version.published_at IS NOT NULL
        AND version.published_at <= ${revision.lockedAt!}
        AND version.effective_at <= ${revision.lockedAt!}
      ORDER BY version.effective_at DESC, version.published_at DESC, version.revision DESC
      LIMIT 1 FOR UPDATE`
  );
  if (!result[0]) {
    throw new UphPerformanceIssueServiceError(
      "UPH_TARGET_NOT_CONFIGURED",
      "锁定时点未配置适用的UPH目标。",
      409
    );
  }
  return result[0];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function buildSourceSnapshot(
  project: ProjectRow,
  batch: BatchRow,
  revision: RevisionRow,
  analysis: AnalysisRow,
  target: TargetRow,
  shortfallUph: string
): Record<string, unknown> {
  const result = asRecord(analysis.resultSnapshotJson);
  const analysisInput = asRecord(analysis.inputSnapshotJson);
  const warnings = asStringArray(analysis.warningsJson).sort();
  const bottleneck = result.bottleneck ?? result.bottlenecks ?? null;
  const secondBottleneck = result.secondBottleneck ?? result.second_bottleneck ?? null;
  const formula =
    result.formula ??
    result.formulaCode ??
    analysisInput.formula ??
    analysisInput.formulaCode ??
    null;
  return {
    projectId: project.id,
    projectCode: project.code,
    projectName: project.name,
    batchId: batch.id,
    batchNumber: batch.batchNumber,
    revisionId: revision.id,
    revisionNumber: revision.revisionNumber,
    topologyRootNodeId: revision.topologyRootNodeId,
    analysisId: analysis.id,
    analysisStatus: analysis.status,
    analysisInputSnapshot: analysis.inputSnapshotJson,
    analysisResultSnapshot: analysis.resultSnapshotJson,
    createdAt: analysis.createdAt.toISOString(),
    analysisCreatedAt: analysis.createdAt.toISOString(),
    lockedChecksum: revision.lockedChecksum,
    formulaVersionId: analysis.formulaVersionId,
    formulaChecksum: analysis.formulaChecksum,
    formula,
    engineCode: analysis.engineCode,
    engine: analysis.engineCode,
    targetVersionId: target.targetVersionId,
    targetId: target.targetId,
    targetRevision: target.targetRevision,
    targetChecksum: target.targetChecksum,
    targetUph: target.targetUph,
    targetEffectiveAt: target.effectiveAt.toISOString(),
    targetPublishedAt: target.publishedAt.toISOString(),
    actualGoodUph: analysis.actualGoodUph,
    rootMeasuredCapacityUph: analysis.rootMeasuredCapacityUph,
    A: analysis.utilizationA,
    a: analysis.utilizationA,
    utilizationA: analysis.utilizationA,
    warnings,
    warningsJson: analysis.warningsJson,
    moduleFpy: result.moduleFpy ?? result.moduleFPY ?? null,
    moduleCt: result.moduleCt ?? result.moduleCT ?? null,
    parallelGroups: result.parallelGroups ?? result.parallel_groups ?? null,
    bottleneck,
    secondBottleneck,
    reductionLevels: result.reductionLevels ?? result.reduction_levels ?? null,
    bottleneckTransfer:
      result.bottleneckTransfer ?? result.bottleneck_transfer ?? result.bottleneckShift ?? null,
    shortfallUph,
    sourceAnalysisStatus: analysis.status
  };
}

function issueResponse(
  row: IssueRow,
  relations: RelationRow[],
  histories: HistoryRow[]
): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    confirmedText: row.confirmedText,
    sourceType: row.sourceType,
    category: row.category,
    severity: row.severity,
    phenomenonDescription: row.phenomenonDescription,
    rootCauseCategory: row.rootCauseCategory,
    rootCauseDescription: row.rootCauseDescription,
    status: row.status,
    version: row.version,
    createdById: row.createdById,
    updatedById: row.updatedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    relations: relations.map((relation) => ({
      id: relation.id,
      projectId: row.projectId,
      issueId: relation.issueId,
      relationType: relation.relationType,
      targetId: relation.targetId,
      status: relation.status,
      reason: relation.reason,
      createdById: relation.createdById,
      createdAt: relation.createdAt.toISOString()
    })),
    history: histories.map((history) => ({
      id: history.id,
      sequence: history.sequence,
      eventType: history.eventType,
      reason: history.reason,
      snapshot: history.snapshotJson,
      actorId: history.actorId,
      createdAt: history.createdAt.toISOString()
    }))
  };
}

function frozenSourceSnapshot(issue: Record<string, unknown>): Record<string, unknown> | null {
  const history = Array.isArray(issue.history) ? issue.history : [];
  for (const entry of history) {
    const snapshot = asRecord(asRecord(entry).snapshot);
    const sourceSnapshot = asRecord(snapshot.sourceSnapshot);
    if (Object.keys(sourceSnapshot).length > 0) return sourceSnapshot;
  }
  return null;
}

async function readIssue(client: Client, projectId: string, issueId: string) {
  const issueRows = await rows<IssueRow>(
    client,
    Prisma.sql`SELECT id, project_id AS "projectId", title, confirmed_text AS "confirmedText",
      source_type::text AS "sourceType", category::text AS category, severity::text AS severity,
      phenomenon_description AS "phenomenonDescription", root_cause_category::text AS "rootCauseCategory",
      root_cause_description AS "rootCauseDescription", status::text AS status, version,
      created_by_id AS "createdById", updated_by_id AS "updatedById", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM issues WHERE id = ${issueId} AND project_id = ${projectId}`
  );
  if (!issueRows[0])
    throw new UphPerformanceIssueServiceError(
      "ISSUE_NOT_FOUND",
      "性能问题不存在或不属于该项目。",
      404
    );
  const relations = await rows<RelationRow>(
    client,
    Prisma.sql`SELECT id, issue_id AS "issueId", relation_type::text AS "relationType", target_id AS "targetId",
      status::text AS status, reason, created_by_id AS "createdById", created_at AS "createdAt"
      FROM issue_relations WHERE project_id = ${projectId} AND issue_id = ${issueId} ORDER BY created_at, id`
  );
  const histories = await rows<HistoryRow>(
    client,
    Prisma.sql`SELECT id, sequence, event_type::text AS "eventType", reason,
      snapshot_json AS "snapshotJson", actor_id AS "actorId", created_at AS "createdAt"
      FROM issue_histories WHERE project_id = ${projectId} AND issue_id = ${issueId} ORDER BY sequence`
  );
  return issueResponse(issueRows[0], relations, histories);
}

async function appendRelation(
  client: Client,
  input: CreateUphPerformanceIssueInput,
  issueId: string,
  relationType: "UPH_SOURCE_BATCH" | "UPH_ANALYSIS",
  targetId: string,
  reason: string,
  sourceSnapshot: Record<string, unknown>
): Promise<RelationRow> {
  const result = await rows<RelationRow>(
    client,
    Prisma.sql`INSERT INTO issue_relations
      (id, project_id, issue_id, relation_type, target_id, status, reason, created_by_id, created_at)
      VALUES (${randomUUID()}, ${input.projectId}, ${issueId}, ${relationType}::"IssueRelationType",
        ${targetId}, 'ACTIVE'::"IssueRelationStatus", ${reason}, ${input.actorId}, CURRENT_TIMESTAMP)
      RETURNING id, issue_id AS "issueId", relation_type::text AS "relationType", target_id AS "targetId",
        status::text AS status, reason, created_by_id AS "createdById", created_at AS "createdAt"`
  );
  if (!result[0])
    throw new UphPerformanceIssueServiceError(
      "UPH_PERFORMANCE_ISSUE_CONFLICT",
      "性能问题关联创建失败。",
      409
    );
  await client.issueHistory.create({
    data: {
      projectId: input.projectId,
      issueId,
      sequence: await nextHistorySequence(client, issueId),
      eventType: "RELATION_ADDED",
      reason,
      snapshotJson: { relationType, targetId, sourceSnapshot } as Prisma.InputJsonValue,
      actorId: input.actorId
    }
  });
  return result[0];
}

async function nextHistorySequence(client: Client, issueId: string): Promise<number> {
  const result = await rows<{ sequence: number | null }>(
    client,
    Prisma.sql`SELECT MAX(sequence) AS sequence FROM issue_histories WHERE issue_id = ${issueId}`
  );
  return Number(result[0]?.sequence ?? 0) + 1;
}

async function writePerformanceFacts(
  client: Client,
  input: CreateUphPerformanceIssueInput,
  issueId: string,
  sourceSnapshot: Record<string, unknown>,
  deduplicated: boolean
) {
  const payload = { projectId: input.projectId, issueId, sourceSnapshot, deduplicated };
  const audit = await writeAudit(client, {
    action: AUDIT_ACTIONS.UPH_PERFORMANCE_ISSUE_CREATED,
    objectType: AUDIT_OBJECT_TYPES.ISSUE,
    objectId: issueId,
    context: {
      ...input.auditContext,
      actorId: input.actorId,
      projectId: input.projectId,
      reason: input.reason
    },
    after: {
      value: payload,
      // Audit sanitization applies the allow-list recursively. Include the
      // frozen snapshot keys so the audit retains the same evidence as the
      // Issue history and Outbox payload.
      allowedFields: [...ISSUE_FIELDS, ...Object.keys(sourceSnapshot)]
    }
  });
  const outbox = await appendOutboxEvent(client, {
    eventType: "uph.performance-issue.created",
    aggregateType: AUDIT_OBJECT_TYPES.ISSUE,
    aggregateId: issueId,
    idempotencyKey: `uph-performance-issue:${issueId}:${deduplicated ? "deduplicated" : "created"}`,
    payload: { ...payload, auditId: audit.id }
  });
  return { auditId: audit.id, outboxEventId: outbox.id };
}

export async function createUphPerformanceIssue(
  input: CreateUphPerformanceIssueInput,
  transaction?: Client
): Promise<UphPerformanceIssueResponse> {
  const normalized: CreateUphPerformanceIssueInput = {
    ...input,
    projectId: text(input.projectId, "projectId"),
    batchId: text(input.batchId, "batchId"),
    revisionId: text(input.revisionId, "revisionId"),
    analysisId: text(input.analysisId, "analysisId"),
    title: text(input.title, "title"),
    confirmedText: text(input.confirmedText, "confirmedText", 10_000),
    reason: text(input.reason, "reason", 1_024)
  };
  if (!["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(normalized.severity)) {
    throw new UphPerformanceIssueServiceError(
      "UPH_PERFORMANCE_ISSUE_INVALID",
      "severity无效。",
      422
    );
  }
  return inTransaction(transaction, async (client) => {
    await authorize(client, normalized);
    const project = await lockProject(client, normalized.projectId);
    const batch = await lockBatch(client, normalized.projectId, normalized.batchId);
    const revision = await lockRevision(
      client,
      normalized.projectId,
      normalized.batchId,
      normalized.revisionId
    );
    if (batch.currentLockedRevisionId !== revision.id) {
      throw new UphPerformanceIssueServiceError(
        "LOCKED_REVISION_REQUIRED",
        "只能从batch当前LOCKED修订创建性能问题。",
        409
      );
    }
    const analysis = await lockAnalysis(client, normalized, revision);
    const target = await applicableTarget(client, normalized.projectId, revision);
    const decision = decidePerformanceIssue({
      actualGoodUph: analysis.actualGoodUph,
      targetUph: target.targetUph,
      status: analysis.status
    });

    const existingSource = await rows<RelationRow>(
      client,
      Prisma.sql`SELECT id, issue_id AS "issueId", relation_type::text AS "relationType", target_id AS "targetId",
        status::text AS status, reason, created_by_id AS "createdById", created_at AS "createdAt"
        FROM issue_relations
        WHERE project_id = ${normalized.projectId} AND relation_type = 'UPH_SOURCE_BATCH'::"IssueRelationType"
          AND target_id = ${normalized.batchId}
        ORDER BY created_at, id LIMIT 1 FOR UPDATE`
    );

    const sourceSnapshot = buildSourceSnapshot(
      project,
      batch,
      revision,
      analysis,
      target,
      decision.shortfallUph
    );
    if (existingSource[0]) {
      const existingIssueId = existingSource[0].issueId;
      let existingIssue = await readIssue(client, normalized.projectId, existingIssueId);
      if (existingIssue.category !== "PERFORMANCE" || existingIssue.sourceType !== "PROJECT") {
        throw new UphPerformanceIssueServiceError(
          "UPH_PERFORMANCE_ISSUE_CONFLICT",
          "源批次已关联非性能项目问题，无法创建性能问题。",
          409
        );
      }
      const frozen = frozenSourceSnapshot(existingIssue) ?? sourceSnapshot;
      const existingVersion = Number(existingIssue.version);
      if (!Number.isSafeInteger(existingVersion) || existingVersion < 1) {
        throw new UphPerformanceIssueServiceError(
          "UPH_PERFORMANCE_ISSUE_CONFLICT",
          "已有性能问题版本事实无效。",
          409
        );
      }
      const issueStatus = String(existingIssue.status);
      const analysisRelation = await rows<RelationRow>(
        client,
        Prisma.sql`SELECT id, issue_id AS "issueId", relation_type::text AS "relationType", target_id AS "targetId",
          status::text AS status, reason, created_by_id AS "createdById", created_at AS "createdAt"
          FROM issue_relations WHERE project_id = ${normalized.projectId}
            AND relation_type = 'UPH_ANALYSIS'::"IssueRelationType" AND target_id = ${normalized.analysisId}
          ORDER BY created_at, id LIMIT 1 FOR UPDATE`
      );
      if (analysisRelation[0] && analysisRelation[0].issueId !== existingIssueId) {
        throw new UphPerformanceIssueServiceError(
          "UPH_PERFORMANCE_ISSUE_CONFLICT",
          "分析快照已关联其他性能问题。",
          409
        );
      }
      if (!analysisRelation[0] && issueStatus !== "CLOSED") {
        const updated = await client.issue.updateMany({
          where: {
            id: existingIssueId,
            projectId: normalized.projectId,
            version: existingVersion
          },
          data: { updatedById: normalized.actorId, version: { increment: 1 } }
        });
        if (updated.count !== 1) {
          throw new UphPerformanceIssueServiceError(
            "VERSION_CONFLICT",
            "性能问题已被其他操作更新。",
            409
          );
        }
        await appendRelation(
          client,
          normalized,
          existingIssueId,
          "UPH_ANALYSIS",
          normalized.analysisId,
          normalized.reason,
          frozen
        );
        await writePerformanceFacts(client, normalized, existingIssueId, frozen, true);
        existingIssue = await readIssue(client, normalized.projectId, existingIssueId);
      }
      return { issue: existingIssue, sourceSnapshot: frozen, deduplicated: true };
    }

    try {
      assertPerformanceIssueCreation(decision);
    } catch (error) {
      if (error instanceof Error && error.message === "UPH_TARGET_MET") {
        throw new UphPerformanceIssueServiceError(
          "UPH_TARGET_MET",
          "实际良品UPH已达到目标，无需创建性能问题。",
          409
        );
      }
      throw error;
    }
    const issueId = randomUUID();
    await client.$executeRaw(
      Prisma.sql`INSERT INTO issues
        (id, project_id, title, confirmed_text, source_type, category, severity,
         phenomenon_description, root_cause_category, root_cause_description, status, version,
         created_by_id, updated_by_id, created_at, updated_at)
        VALUES (${issueId}, ${normalized.projectId}, ${normalized.title}, ${normalized.confirmedText},
          'PROJECT'::"IssueSourceType", 'PERFORMANCE'::"IssueCategory", ${normalized.severity}::"IssueSeverity",
          ${normalized.confirmedText}, NULL, NULL, 'PENDING_ACCEPTANCE'::"IssueStatus", 1,
          ${normalized.actorId}, ${normalized.actorId}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    );
    const snapshotHistory = {
      projectId: normalized.projectId,
      issueId,
      title: normalized.title,
      sourceType: "PROJECT",
      category: "PERFORMANCE",
      severity: normalized.severity,
      rootCauseCategory: null,
      rootCauseDescription: null,
      eventType: "CREATED",
      reason: normalized.reason,
      sourceSnapshot
    };
    await client.issueHistory.create({
      data: {
        projectId: normalized.projectId,
        issueId,
        sequence: 1,
        eventType: "CREATED",
        reason: normalized.reason,
        snapshotJson: snapshotHistory as Prisma.InputJsonValue,
        actorId: normalized.actorId
      }
    });
    await appendRelation(
      client,
      normalized,
      issueId,
      "UPH_SOURCE_BATCH",
      normalized.batchId,
      normalized.reason,
      sourceSnapshot
    );
    await appendRelation(
      client,
      normalized,
      issueId,
      "UPH_ANALYSIS",
      normalized.analysisId,
      normalized.reason,
      sourceSnapshot
    );
    const facts = await writePerformanceFacts(client, normalized, issueId, sourceSnapshot, false);
    const issue = await readIssue(client, normalized.projectId, issueId);
    return { issue, sourceSnapshot, deduplicated: false, ...facts };
  });
}

export async function getUphPerformanceIssue(
  input: UphPerformanceIssueContext
): Promise<UphPerformanceIssueResponse> {
  return inTransaction(undefined, async (client) => {
    await authorize(client, input, [PERMISSIONS.PROJECT_UPH_READ]);
    await lockProject(client, input.projectId, false);
    const batch = await lockBatch(client, input.projectId, input.batchId);
    const revision = await lockRevision(
      client,
      input.projectId,
      input.batchId,
      input.revisionId,
      true
    );
    const analysis = await lockAnalysis(client, input, revision);
    const target = await applicableTarget(client, input.projectId, revision);
    const decision = decidePerformanceIssue({
      actualGoodUph: analysis.actualGoodUph,
      targetUph: target.targetUph,
      status: analysis.status
    });
    const source = await rows<RelationRow>(
      client,
      Prisma.sql`SELECT id, issue_id AS "issueId", relation_type::text AS "relationType", target_id AS "targetId",
        status::text AS status, reason, created_by_id AS "createdById", created_at AS "createdAt"
        FROM issue_relations WHERE project_id = ${input.projectId}
          AND relation_type = 'UPH_SOURCE_BATCH'::"IssueRelationType" AND target_id = ${input.batchId}
        ORDER BY created_at, id LIMIT 1`
    );
    if (!source[0])
      throw new UphPerformanceIssueServiceError(
        "UPH_PERFORMANCE_ISSUE_NOT_FOUND",
        "该批次尚未创建性能问题。",
        404
      );
    const analysisRelation = await rows<RelationRow>(
      client,
      Prisma.sql`SELECT id, issue_id AS "issueId", relation_type::text AS "relationType", target_id AS "targetId",
        status::text AS status, reason, created_by_id AS "createdById", created_at AS "createdAt"
        FROM issue_relations WHERE project_id = ${input.projectId}
          AND relation_type = 'UPH_ANALYSIS'::"IssueRelationType" AND target_id = ${input.analysisId}
        ORDER BY created_at, id LIMIT 1`
    );
    if (analysisRelation[0] && analysisRelation[0].issueId !== source[0].issueId) {
      throw new UphPerformanceIssueServiceError(
        "UPH_PERFORMANCE_ISSUE_CONFLICT",
        "分析快照已关联其他性能问题。",
        409
      );
    }
    if (!analysisRelation[0]) {
      throw new UphPerformanceIssueServiceError(
        "UPH_PERFORMANCE_ISSUE_NOT_FOUND",
        "该分析快照尚未关联性能问题。",
        404
      );
    }
    const issue = await readIssue(client, input.projectId, source[0].issueId);
    if (issue.category !== "PERFORMANCE" || issue.sourceType !== "PROJECT") {
      throw new UphPerformanceIssueServiceError(
        "UPH_PERFORMANCE_ISSUE_NOT_FOUND",
        "该批次关联的问题不是项目性能问题。",
        404
      );
    }
    const frozen = frozenSourceSnapshot(issue);
    return {
      issue,
      sourceSnapshot:
        frozen ??
        buildSourceSnapshot(
          { id: input.projectId, code: "", name: "", departmentId: null, status: "ACTIVE" },
          batch,
          revision,
          analysis,
          target,
          decision.shortfallUph
        ),
      deduplicated: false
    };
  });
}
