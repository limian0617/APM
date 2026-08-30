import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS, type PermissionScope } from "@/lib/auth/permissions";
import { inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import { AUDIT_ACTIONS, AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  analyzeLockedUph,
  CANONICAL_UPH_FORMULA,
  type LockedUphAnalysisInput,
  UPH_ANALYSIS_ENGINE
} from "../domain/uph-analysis";

type Client = Prisma.TransactionClient;
type ProjectRole = "ENGINEER" | "PROJECT_MANAGER" | "QUALITY";
type RevisionStatus = "DRAFT" | "PM_CONFIRMED" | "LOCKED" | "SUPERSEDED";

export type UphAnalysisAuthorizationActor = Omit<AuthorizationActor, "grants"> & {
  grants: Array<{ permission: string; scope: string; systemRole: string }>;
};

export type UphAnalysisServiceContext = {
  projectId: string;
  actorId: string;
  authorizationActor: UphAnalysisAuthorizationActor;
  /** Present for an eventual Route, but never trusted in place of DB membership. */
  projectMemberRoles?: string[];
  auditContext: AuditContext;
};

export type CreateUphAnalysisInput = UphAnalysisServiceContext & {
  batchId: string;
  revisionId: string;
};

export type ListUphAnalysesInput = UphAnalysisServiceContext & {
  batchId: string;
  revisionId: string;
  cursor?: string;
  limit?: number;
};

export type GetUphAnalysisInput = UphAnalysisServiceContext & {
  batchId: string;
  revisionId: string;
  analysisId: string;
};

export type UphAnalysisSnapshotResponse = {
  analysisId: string;
  projectId: string;
  batchId: string;
  revisionId: string;
  lockedChecksum: string;
  formulaVersionId: string;
  formulaChecksum: string;
  engineCode: string;
  status: "COMPUTED" | "NO_OUTPUT";
  warnings: string[];
  rootMeasuredCapacityUph: string;
  actualGoodUph: string;
  a: string;
  resourceVersion: number;
  createdById: string;
  createdAt: Date;
  inputSnapshot: unknown;
  resultSnapshot: unknown;
};

export type UphAnalysisListResponse = {
  items: UphAnalysisSnapshotResponse[];
  nextCursor: string | null;
};

export class UphAnalysisServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 403 | 404 | 409 | 422
  ) {
    super(message);
    this.name = "UphAnalysisServiceError";
  }
}

type RevisionFacts = {
  id: string;
  projectId: string;
  batchId: string;
  status: RevisionStatus;
  topologyVersionId: string;
  topologyRootNodeId: string;
  formulaVersionId: string;
  plannedProductionSeconds: string;
  confirmedInputChecksum: string | null;
  statisticsChecksum: string | null;
  lockedChecksum: string | null;
  checksumChainValid: boolean;
};

type TopologyRow = {
  id: string;
  parentNodeId: string | null;
  parentRelation: "ROOT" | "MANDATORY" | "PARALLEL";
  sourceType: string;
  sourceId: string;
  topologyPath: string;
  sourceSnapshotJson: unknown;
  sourceChecksum: string;
  sourceWatermark: string;
};

type BindingRow = {
  id: string;
  projectModuleId: string;
  ctDefinitionId: string;
  ctVersionId: string;
  ctSourceSnapshotJson: unknown;
  ctSourceChecksum: string;
  ctSourceWatermark: string;
  exactSnapshotJson: unknown;
  exactSnapshotChecksum: string;
  exactSourceWatermark: string;
  sourceMatchesExact: boolean;
  intrinsicCtSeconds: string;
  outputPerCycleTotal: string;
  parallelChannelCount: string;
  cavityCount: string;
  qualityInputCount: string | null;
  firstPassGoodCount: string | null;
  validSampleCount: string | null;
  p90Seconds: string | null;
  statisticsMatch: boolean;
};

type FormulaRow = {
  id: string;
  formulaCode: string;
  formulaJson: unknown;
  snapshotChecksum: string;
};

type ProductionRow = {
  actualGrossOutputCount: string;
  finalGoodOutputCount: string;
};

type SnapshotRow = {
  analysisId: string;
  projectId: string;
  batchId: string;
  revisionId: string;
  lockedChecksum: string;
  formulaVersionId: string;
  formulaChecksum: string;
  engineCode: string;
  inputSnapshot: unknown;
  resultSnapshot: unknown;
  status: "COMPUTED" | "NO_OUTPUT";
  warnings: string[];
  rootMeasuredCapacityUph: string;
  actualGoodUph: string;
  a: string;
  resourceVersion: number;
  createdById: string;
  createdAt: Date;
};

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 191) {
    throw new UphAnalysisServiceError("ANALYSIS_INPUT_INVALID", `${field}无效。`, 422);
  }
  return value.trim();
}

function json(value: unknown): Prisma.Sql {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new UphAnalysisServiceError("ANALYSIS_INPUT_INVALID", "分析快照无法序列化。", 422);
  }
  return Prisma.sql`${serialized}::jsonb`;
}

async function rows<T>(client: Client, query: Prisma.Sql): Promise<T[]> {
  return client.$queryRaw<T[]>(query);
}

function actorForAuthorization(actor: UphAnalysisAuthorizationActor): AuthorizationActor {
  const scopes = new Set<PermissionScope>(["ALL", "PROJECT", "DEPARTMENT", "SELF", "ASSIGNED"]);
  return {
    ...actor,
    grants: actor.grants.filter(
      (grant): grant is { permission: string; scope: PermissionScope; systemRole: string } =>
        scopes.has(grant.scope as PermissionScope)
    )
  };
}

function assertActor(context: UphAnalysisServiceContext): void {
  if (
    context.authorizationActor.id !== context.actorId ||
    context.authorizationActor.status !== "ACTIVE" ||
    context.auditContext.actorId !== context.actorId
  ) {
    throw new UphAnalysisServiceError("AUTHORIZATION_DENIED", "分析操作人身份无效。", 403);
  }
}

async function activeRoles(
  client: Client,
  projectId: string,
  actorId: string
): Promise<ProjectRole[]> {
  const result = await rows<{ role: ProjectRole }>(
    client,
    Prisma.sql`SELECT member.project_role::text AS role
      FROM project_members member
      JOIN users actor ON actor.id = member.user_id
      WHERE member.project_id = ${projectId}
        AND member.user_id = ${actorId}
        AND member.left_at IS NULL
        AND actor.status = 'ACTIVE'
      ORDER BY member.project_role`
  );
  return result.map((item) => item.role);
}

async function authorize(
  client: Client,
  context: UphAnalysisServiceContext,
  permission: typeof PERMISSIONS.PROJECT_UPH_READ | typeof PERMISSIONS.PROJECT_UPH_ANALYZE
): Promise<ProjectRole[]> {
  assertActor(context);
  const roles = await activeRoles(client, context.projectId, context.actorId);
  const decision = decideAuthorization(
    actorForAuthorization(context.authorizationActor),
    permission,
    {
      projectId: context.projectId,
      requireProjectMembership: true,
      memberRoles: roles
    }
  );
  if (!roles.length || !decision.allowed) {
    throw new UphAnalysisServiceError("AUTHORIZATION_DENIED", "无权访问UPH分析。", 403);
  }
  return roles;
}

async function lockProjectAndCapability(client: Client, projectId: string): Promise<void> {
  const project = await rows<{ id: string }>(
    client,
    Prisma.sql`SELECT id FROM projects WHERE id = ${projectId} FOR NO KEY UPDATE`
  );
  if (!project[0]) throw new UphAnalysisServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  const capability = await rows<{ enabled: boolean }>(
    client,
    Prisma.sql`SELECT pc.selected_enabled AND pc.template_allowed AND cc.enabled AS enabled
      FROM project_capabilities pc
      JOIN company_capabilities cc ON cc.code = pc.capability_code
      WHERE pc.project_id = ${projectId} AND pc.capability_code = 'UPH_ANALYSIS'::"CapabilityCode"`
  );
  if (!capability[0]?.enabled) {
    throw new UphAnalysisServiceError("ANALYSIS_CONFLICT", "项目未启用UPH分析能力。", 409);
  }
}

async function lockBatch(client: Client, projectId: string, batchId: string) {
  const result = await rows<{ id: string; currentLockedRevisionId: string | null }>(
    client,
    Prisma.sql`SELECT id, current_locked_revision_id AS "currentLockedRevisionId"
      FROM project_uph_test_batches
      WHERE id = ${batchId} AND project_id = ${projectId}
      FOR UPDATE`
  );
  if (!result[0])
    throw new UphAnalysisServiceError("TEST_BATCH_NOT_FOUND", "测试批次不存在。", 404);
  return result[0];
}

async function lockRevision(
  client: Client,
  projectId: string,
  batchId: string,
  revisionId: string
): Promise<RevisionFacts> {
  const result = await rows<RevisionFacts>(
    client,
    Prisma.sql`SELECT revision.id, revision.project_id AS "projectId", revision.batch_id AS "batchId",
      revision.status::text AS status, revision.topology_version_id AS "topologyVersionId",
      revision.topology_root_node_id AS "topologyRootNodeId", revision.formula_version_id AS "formulaVersionId",
      revision.planned_production_seconds::text AS "plannedProductionSeconds",
      revision.confirmed_input_checksum AS "confirmedInputChecksum",
      revision.statistics_checksum AS "statisticsChecksum", revision.locked_checksum AS "lockedChecksum",
      (
        revision.confirmed_input_snapshot_json IS NOT DISTINCT FROM "uph_test_batch_confirmed_input_snapshot"(revision)
        AND revision.confirmed_input_checksum IS NOT DISTINCT FROM
          "uph_test_batch_checksum"("uph_test_batch_confirmed_input_snapshot"(revision))
        AND revision.statistics_snapshot_json IS NOT DISTINCT FROM "uph_test_batch_statistics_snapshot"(revision)
        AND revision.statistics_checksum IS NOT DISTINCT FROM
          "uph_test_batch_checksum"("uph_test_batch_statistics_snapshot"(revision))
        AND revision.locked_snapshot_json IS NOT DISTINCT FROM "uph_test_batch_locked_snapshot"(revision)
        AND revision.locked_checksum IS NOT DISTINCT FROM
          "uph_test_batch_checksum"("uph_test_batch_locked_snapshot"(revision))
      ) AS "checksumChainValid"
      FROM project_uph_test_batch_revisions revision
      WHERE revision.id = ${revisionId} AND revision.project_id = ${projectId} AND revision.batch_id = ${batchId}
      FOR UPDATE`
  );
  if (!result[0]) {
    throw new UphAnalysisServiceError("TEST_BATCH_REVISION_NOT_FOUND", "测试批次修订不存在。", 404);
  }
  return result[0];
}

async function readScope(
  client: Client,
  projectId: string,
  batchId: string,
  revisionId: string
): Promise<void> {
  const scope = await rows<{ id: string }>(
    client,
    Prisma.sql`SELECT revision.id
      FROM project_uph_test_batch_revisions revision
      JOIN project_uph_test_batches batch
        ON batch.id = revision.batch_id AND batch.project_id = revision.project_id
      WHERE revision.id = ${revisionId} AND revision.batch_id = ${batchId}
        AND revision.project_id = ${projectId} AND batch.project_id = ${projectId}`
  );
  if (!scope[0]) {
    throw new UphAnalysisServiceError("TEST_BATCH_REVISION_NOT_FOUND", "测试批次修订不存在。", 404);
  }
}

async function readTopology(client: Client, revision: RevisionFacts): Promise<TopologyRow[]> {
  const topology = await rows<TopologyRow>(
    client,
    Prisma.sql`WITH RECURSIVE tree AS (
      SELECT node.id, node.parent_node_id AS "parentNodeId", node.parent_relation::text AS "parentRelation",
        node.source_type::text AS "sourceType", COALESCE(node.delivery_unit_id, node.project_module_id) AS "sourceId",
        node.source_snapshot_json AS "sourceSnapshotJson", node.source_checksum AS "sourceChecksum",
        node.source_watermark AS "sourceWatermark", node.id::text AS "topologyPath"
      FROM project_uph_topology_nodes node
      WHERE node.id = ${revision.topologyRootNodeId} AND node.topology_version_id = ${revision.topologyVersionId}
        AND node.project_id = ${revision.projectId}
      UNION ALL
      SELECT child.id, child.parent_node_id, child.parent_relation::text,
        child.source_type::text, COALESCE(child.delivery_unit_id, child.project_module_id),
        child.source_snapshot_json, child.source_checksum, child.source_watermark,
        tree."topologyPath" || '/' || child.id::text
      FROM project_uph_topology_nodes child
      JOIN tree ON child.parent_node_id = tree.id
      WHERE child.topology_version_id = ${revision.topologyVersionId} AND child.project_id = ${revision.projectId}
    ) SELECT * FROM tree ORDER BY "topologyPath", "sourceType", "sourceId", id`
  );
  if (!topology.length || topology[0]?.id !== revision.topologyRootNodeId) {
    throw new UphAnalysisServiceError("ANALYSIS_INPUT_INVALID", "冻结拓扑根无法重建。", 422);
  }
  return topology;
}

async function readBindings(client: Client, revision: RevisionFacts): Promise<BindingRow[]> {
  const bindings = await rows<BindingRow>(
    client,
    Prisma.sql`SELECT binding.id, binding.project_module_id AS "projectModuleId",
      binding.ct_definition_id AS "ctDefinitionId", binding.ct_version_id AS "ctVersionId",
      binding.ct_source_snapshot_json AS "ctSourceSnapshotJson",
      binding.ct_source_checksum AS "ctSourceChecksum", binding.ct_source_watermark AS "ctSourceWatermark",
      version.snapshot_json AS "exactSnapshotJson", version.snapshot_checksum AS "exactSnapshotChecksum",
      version.source_watermark AS "exactSourceWatermark", version.intrinsic_ct_seconds::text AS "intrinsicCtSeconds",
      version.output_per_cycle_total::text AS "outputPerCycleTotal",
      version.parallel_channel_count::text AS "parallelChannelCount", version.cavity_count::text AS "cavityCount",
      binding.quality_input_count::text AS "qualityInputCount",
      binding.first_pass_good_count::text AS "firstPassGoodCount",
      statistics.valid_sample_count::text AS "validSampleCount", statistics.p90_seconds::text AS "p90Seconds",
      (
        binding.ct_source_snapshot_json IS NOT DISTINCT FROM version.snapshot_json
        AND binding.ct_source_checksum IS NOT DISTINCT FROM version.snapshot_checksum
        AND binding.ct_source_watermark IS NOT DISTINCT FROM version.source_watermark
      ) AS "sourceMatchesExact",
      (
        binding.valid_sample_count IS NOT DISTINCT FROM statistics.valid_sample_count
        AND binding.excluded_sample_count IS NOT DISTINCT FROM statistics.excluded_sample_count
        AND binding.arithmetic_mean_seconds IS NOT DISTINCT FROM statistics.arithmetic_mean_seconds
        AND binding.p50_seconds IS NOT DISTINCT FROM statistics.p50_seconds
        AND binding.p90_seconds IS NOT DISTINCT FROM statistics.p90_seconds
        AND binding.max_seconds IS NOT DISTINCT FROM statistics.max_seconds
        AND binding.spread_p90_minus_p50_seconds IS NOT DISTINCT FROM statistics.spread_p90_minus_p50_seconds
      ) AS "statisticsMatch"
      FROM project_uph_test_batch_revision_module_bindings binding
      JOIN project_uph_test_batch_revisions revision
        ON revision.id = binding.revision_id AND revision.project_id = binding.project_id
      JOIN "uph_test_batch_rebuilt_module_statistics"(revision) statistics
        ON statistics.binding_id = binding.id
      JOIN project_uph_ct_definition_versions version
        ON version.id = binding.ct_version_id AND version.ct_definition_id = binding.ct_definition_id
        AND version.project_id = binding.project_id
      WHERE binding.revision_id = ${revision.id} AND binding.project_id = ${revision.projectId}
      ORDER BY binding.project_module_id, binding.id`
  );
  if (!bindings.length) {
    throw new UphAnalysisServiceError("ANALYSIS_INPUT_INVALID", "冻结模块CT来源缺失。", 422);
  }
  for (const binding of bindings) {
    if (!binding.sourceMatchesExact) {
      throw new UphAnalysisServiceError("ANALYSIS_INPUT_INVALID", "冻结CT来源校验失败。", 422);
    }
    if (!binding.statisticsMatch) {
      throw new UphAnalysisServiceError("ANALYSIS_INPUT_INVALID", "冻结P90统计校验失败。", 422);
    }
  }
  return bindings;
}

async function readFormula(client: Client, revision: RevisionFacts): Promise<FormulaRow> {
  const formula = await rows<FormulaRow>(
    client,
    Prisma.sql`SELECT id, formula_code AS "formulaCode", formula_json AS "formulaJson",
      snapshot_checksum AS "snapshotChecksum"
      FROM project_uph_formula_versions
      WHERE id = ${revision.formulaVersionId} AND project_id = ${revision.projectId}`
  );
  if (!formula[0] || formula[0].formulaCode !== CANONICAL_UPH_FORMULA) {
    throw new UphAnalysisServiceError(
      "ANALYSIS_FORMULA_UNSUPPORTED",
      "冻结公式不支持UPH_ANALYSIS@1。",
      422
    );
  }
  return formula[0];
}

async function readProduction(client: Client, revision: RevisionFacts): Promise<ProductionRow> {
  const production = await rows<ProductionRow>(
    client,
    Prisma.sql`SELECT actual_gross_output_count::text AS "actualGrossOutputCount",
      final_good_output_count::text AS "finalGoodOutputCount"
      FROM project_uph_test_batch_revision_production_counts
      WHERE revision_id = ${revision.id} AND project_id = ${revision.projectId}`
  );
  if (!production[0]) {
    throw new UphAnalysisServiceError("ANALYSIS_INPUT_INVALID", "冻结root产量计数缺失。", 422);
  }
  return production[0];
}

function rebuildInput(
  revision: RevisionFacts,
  topology: TopologyRow[],
  bindings: BindingRow[],
  formula: FormulaRow,
  production: ProductionRow
): LockedUphAnalysisInput {
  if (
    revision.status !== "LOCKED" ||
    !revision.lockedChecksum ||
    !revision.confirmedInputChecksum ||
    !revision.statisticsChecksum ||
    !revision.checksumChainValid
  ) {
    throw new UphAnalysisServiceError("ANALYSIS_INPUT_INVALID", "冻结checksum链无法重建。", 422);
  }
  const moduleNodes = topology
    .filter((node) => node.sourceType === "PROJECT_MODULE")
    .map((node) => node.sourceId)
    .sort();
  const bindingModules = bindings.map((binding) => binding.projectModuleId).sort();
  if (
    moduleNodes.length !== bindingModules.length ||
    moduleNodes.some((moduleId, index) => moduleId !== bindingModules[index])
  ) {
    throw new UphAnalysisServiceError("ANALYSIS_INPUT_INVALID", "冻结拓扑与模块绑定不完整。", 422);
  }
  const bindingByModule = new Map(bindings.map((binding) => [binding.projectModuleId, binding]));
  const leaves = topology
    .filter((node) => node.sourceType === "PROJECT_MODULE")
    .map((node) => {
      const binding = bindingByModule.get(node.sourceId);
      if (!binding) {
        throw new UphAnalysisServiceError("ANALYSIS_INPUT_INVALID", "冻结模块绑定缺失。", 422);
      }
      return {
        topologyNodeId: node.id,
        p90Seconds: binding.p90Seconds,
        intrinsicCtSeconds: binding.intrinsicCtSeconds,
        outputPerCycleTotal: binding.outputPerCycleTotal,
        parallelChannelCount: binding.parallelChannelCount,
        cavityCount: binding.cavityCount,
        includedSampleCount: binding.validSampleCount ?? "0"
      };
    })
    .sort((left, right) => left.topologyNodeId.localeCompare(right.topologyNodeId));
  const moduleQuality = bindings
    .map((binding) => ({
      moduleId: binding.projectModuleId,
      qualityInputCount: binding.qualityInputCount ?? "-1",
      firstPassGoodCount: binding.firstPassGoodCount ?? "-1"
    }))
    .sort((left, right) => left.moduleId.localeCompare(right.moduleId));
  return {
    engineCode: UPH_ANALYSIS_ENGINE,
    formulaCode: formula.formulaCode,
    lockedChecksum: revision.lockedChecksum,
    confirmedInputChecksum: revision.confirmedInputChecksum,
    statisticsChecksum: revision.statisticsChecksum,
    minimumIncludedSampleCount: "10",
    topologyRootNodeId: revision.topologyRootNodeId,
    topologyNodes: topology.map((node) => ({
      id: node.id,
      parentNodeId: node.parentNodeId,
      parentRelation: node.parentRelation,
      topologyPath: node.topologyPath,
      sourceType: node.sourceType,
      sourceId: node.sourceId
    })),
    leaves,
    rootProduction: { ...production, plannedProductionSeconds: revision.plannedProductionSeconds },
    moduleQuality
  };
}

function snapshotResponse(row: SnapshotRow): UphAnalysisSnapshotResponse {
  return {
    analysisId: row.analysisId,
    projectId: row.projectId,
    batchId: row.batchId,
    revisionId: row.revisionId,
    lockedChecksum: row.lockedChecksum,
    formulaVersionId: row.formulaVersionId,
    formulaChecksum: row.formulaChecksum,
    engineCode: row.engineCode,
    status: row.status,
    warnings: [...row.warnings].sort(),
    rootMeasuredCapacityUph: row.rootMeasuredCapacityUph,
    actualGoodUph: row.actualGoodUph,
    a: row.a,
    resourceVersion: row.resourceVersion,
    createdById: row.createdById,
    createdAt: row.createdAt,
    inputSnapshot: row.inputSnapshot,
    resultSnapshot: row.resultSnapshot
  };
}

const snapshotProjection = Prisma.sql`id AS "analysisId", project_id AS "projectId", batch_id AS "batchId",
  revision_id AS "revisionId", locked_checksum AS "lockedChecksum", formula_version_id AS "formulaVersionId",
  formula_checksum AS "formulaChecksum", engine_code AS "engineCode", input_snapshot_json AS "inputSnapshot",
  result_snapshot_json AS "resultSnapshot", status::text AS status, warnings_json AS warnings,
  root_capacity_uph::text AS "rootMeasuredCapacityUph", actual_good_uph::text AS "actualGoodUph",
  utilization_a::text AS a, resource_version AS "resourceVersion", created_by_id AS "createdById",
  created_at AS "createdAt"`;

async function existingSnapshot(
  client: Client,
  projectId: string,
  revisionId: string,
  lockedChecksum: string
): Promise<UphAnalysisSnapshotResponse | null> {
  const existing = await rows<SnapshotRow>(
    client,
    Prisma.sql`SELECT ${snapshotProjection} FROM project_uph_analysis_snapshots
      WHERE project_id = ${projectId} AND revision_id = ${revisionId}
        AND locked_checksum = ${lockedChecksum} AND engine_code = ${UPH_ANALYSIS_ENGINE}
      FOR UPDATE`
  );
  return existing[0] ? snapshotResponse(existing[0]) : null;
}

async function snapshotChecksum(client: Client, snapshot: unknown): Promise<string> {
  const value = await rows<{ checksum: string }>(
    client,
    Prisma.sql`SELECT "uph_analysis_snapshot_checksum"(${json(snapshot)}) AS checksum`
  );
  if (!value[0]?.checksum) throw new Error("分析快照checksum计算失败。");
  return value[0].checksum;
}

async function insertSnapshot(
  client: Client,
  context: CreateUphAnalysisInput,
  revision: RevisionFacts,
  formula: FormulaRow,
  inputSnapshot: unknown,
  resultSnapshot: Extract<ReturnType<typeof analyzeLockedUph>, { ok: true }>
): Promise<UphAnalysisSnapshotResponse | null> {
  const inputChecksum = await snapshotChecksum(client, inputSnapshot);
  const resultChecksum = await snapshotChecksum(client, resultSnapshot);
  const warnings = [...resultSnapshot.warnings].sort();
  const snapshotId = randomUUID();
  const inserted = await rows<SnapshotRow>(
    client,
    Prisma.sql`INSERT INTO project_uph_analysis_snapshots (
      id, project_id, batch_id, revision_id, locked_checksum, formula_version_id, formula_checksum, engine_code,
      input_snapshot_json, input_checksum, result_snapshot_json, result_checksum, status, warnings_json,
      root_capacity_uph, actual_good_uph, utilization_a, resource_version, created_by_id
    ) VALUES (
      ${snapshotId}, ${context.projectId}, ${context.batchId}, ${context.revisionId}, ${revision.lockedChecksum!},
      ${formula.id}, ${formula.snapshotChecksum}, ${UPH_ANALYSIS_ENGINE}, ${json(inputSnapshot)}, ${inputChecksum},
      ${json(resultSnapshot)}, ${resultChecksum}, ${resultSnapshot.status}::"UphAnalysisSnapshotStatus", ${json(warnings)},
      ${resultSnapshot.rootMeasuredCapacityUph}::numeric(20,6), ${resultSnapshot.actualGoodUph}::numeric(20,6),
      ${resultSnapshot.a}::numeric(20,6), 1, ${context.actorId}
    ) ON CONFLICT (project_id, revision_id, locked_checksum, engine_code) DO NOTHING
      RETURNING ${snapshotProjection}`
  );
  return inserted[0] ? snapshotResponse(inserted[0]) : null;
}

async function writeCreatedFacts(
  client: Client,
  context: CreateUphAnalysisInput,
  snapshot: UphAnalysisSnapshotResponse
): Promise<void> {
  const payload = {
    projectId: snapshot.projectId,
    batchId: snapshot.batchId,
    revisionId: snapshot.revisionId,
    analysisId: snapshot.analysisId,
    lockedChecksum: snapshot.lockedChecksum,
    engineCode: snapshot.engineCode,
    status: snapshot.status,
    resourceVersion: snapshot.resourceVersion
  };
  await writeAudit(client, {
    action: AUDIT_ACTIONS.UPH_ANALYSIS_SNAPSHOT_CREATED,
    objectType: AUDIT_OBJECT_TYPES.UPH_ANALYSIS_SNAPSHOT,
    objectId: snapshot.analysisId,
    context: { ...context.auditContext, actorId: context.actorId, projectId: context.projectId },
    after: { value: payload, allowedFields: Object.keys(payload) }
  });
  await appendOutboxEvent(client, {
    eventType: "uph.analysis-snapshot.created",
    aggregateType: AUDIT_OBJECT_TYPES.UPH_ANALYSIS_SNAPSHOT,
    aggregateId: snapshot.analysisId,
    idempotencyKey: `uph:analysis-snapshot:${snapshot.analysisId}`,
    payload
  });
}

async function validateDeferredSnapshotConstraints(client: Client): Promise<void> {
  await client.$executeRaw(
    Prisma.sql`SET CONSTRAINTS "project_uph_analysis_snapshot_commit_guard" IMMEDIATE`
  );
}

function databaseCode(error: unknown): string {
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return String(candidate?.meta?.code ?? candidate?.code ?? "");
}

function databaseMessage(error: unknown): string {
  const candidate = error as { message?: unknown; meta?: { message?: unknown } };
  return [candidate?.meta?.message, candidate?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof UphAnalysisServiceError) throw error;
  const code = databaseCode(error);
  if (["23505", "40P01", "55P03", "P2002", "P2034"].includes(code)) {
    throw new UphAnalysisServiceError("ANALYSIS_CONFLICT", "分析快照并发冲突。", 409);
  }
  if (code === "23514") {
    const message = databaseMessage(error);
    if (/current LOCKED revision/u.test(message)) {
      throw new UphAnalysisServiceError("LOCKED_REVISION_REQUIRED", "当前LOCKED修订已变化。", 409);
    }
    if (
      /(?:checksum|canonical snapshot|canonical input and result|formula checksum|exact current LOCKED source facts)/u.test(
        message
      )
    ) {
      throw new UphAnalysisServiceError("ANALYSIS_INPUT_INVALID", "冻结分析输入校验失败。", 422);
    }
  }
  throw error;
}

async function command<T>(
  transaction: Client | undefined,
  operation: (client: Client) => Promise<T>
): Promise<T> {
  try {
    return await inTransaction(transaction, operation);
  } catch (error) {
    return mapDatabaseError(error);
  }
}

export async function createUphAnalysis(input: CreateUphAnalysisInput, transaction?: Client) {
  return command(transaction, async (client) => {
    await authorize(client, input, PERMISSIONS.PROJECT_UPH_ANALYZE);
    await lockProjectAndCapability(client, input.projectId);
    const batch = await lockBatch(client, input.projectId, input.batchId);
    const revision = await lockRevision(client, input.projectId, input.batchId, input.revisionId);
    if (batch.currentLockedRevisionId !== input.revisionId || revision.status !== "LOCKED") {
      throw new UphAnalysisServiceError(
        "LOCKED_REVISION_REQUIRED",
        "只能分析batch当前LOCKED修订。",
        409
      );
    }
    if (
      !revision.lockedChecksum ||
      !revision.confirmedInputChecksum ||
      !revision.statisticsChecksum ||
      !revision.checksumChainValid
    ) {
      throw new UphAnalysisServiceError("ANALYSIS_INPUT_INVALID", "冻结checksum链缺失。", 422);
    }
    const existing = await existingSnapshot(
      client,
      input.projectId,
      input.revisionId,
      revision.lockedChecksum
    );
    if (existing) return existing;

    // Frozen APM-080/081 sources are immutable and deliberately read in a
    // stable sequence; no current-PUBLISHED pointer is consulted or locked.
    const topology = await readTopology(client, revision);
    const bindings = await readBindings(client, revision);
    const formula = await readFormula(client, revision);
    const production = await readProduction(client, revision);
    const analysisInput = rebuildInput(revision, topology, bindings, formula, production);
    const analysis = analyzeLockedUph(analysisInput);
    if (!analysis.ok) {
      const issue = analysis.issues[0];
      throw new UphAnalysisServiceError(
        issue?.code === "ANALYSIS_FORMULA_UNSUPPORTED"
          ? "ANALYSIS_FORMULA_UNSUPPORTED"
          : "ANALYSIS_INPUT_INVALID",
        issue?.message ?? "分析输入无效。",
        422
      );
    }
    const inputSnapshot = {
      projectId: input.projectId,
      batchId: input.batchId,
      revisionId: input.revisionId,
      lockedChecksum: revision.lockedChecksum,
      confirmedInputChecksum: revision.confirmedInputChecksum,
      statisticsChecksum: revision.statisticsChecksum,
      formulaVersionId: formula.id,
      formulaChecksum: formula.snapshotChecksum,
      engineCode: UPH_ANALYSIS_ENGINE,
      topology: topology.map((node) => ({
        ...node,
        sourceSnapshotJson: node.sourceSnapshotJson
      })),
      formula: formula.formulaJson,
      bindings: bindings.map((binding) => ({ ...binding })),
      production,
      analysisInput
    };
    const snapshot = await insertSnapshot(
      client,
      input,
      revision,
      formula,
      inputSnapshot,
      analysis
    );
    if (!snapshot) {
      const existing = await existingSnapshot(
        client,
        input.projectId,
        input.revisionId,
        revision.lockedChecksum
      );
      if (existing) return existing;
      throw new UphAnalysisServiceError("ANALYSIS_CONFLICT", "分析快照并发冲突。", 409);
    }
    await writeCreatedFacts(client, input, snapshot);
    await validateDeferredSnapshotConstraints(client);
    return snapshot;
  });
}

export async function listUphAnalyses(
  input: ListUphAnalysesInput
): Promise<UphAnalysisListResponse> {
  return command(undefined, async (client) => {
    await authorize(client, input, PERMISSIONS.PROJECT_UPH_READ);
    await readScope(client, input.projectId, input.batchId, input.revisionId);
    const limit = input.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new UphAnalysisServiceError("ANALYSIS_INPUT_INVALID", "分页参数无效。", 422);
    }
    const cursor = input.cursor ? text(input.cursor, "cursor") : null;
    const snapshots = await rows<SnapshotRow>(
      client,
      Prisma.sql`SELECT ${snapshotProjection} FROM project_uph_analysis_snapshots
        WHERE project_id = ${input.projectId} AND batch_id = ${input.batchId} AND revision_id = ${input.revisionId}
          AND (${cursor}::text IS NULL OR id > ${cursor}::text)
        ORDER BY id ASC LIMIT ${limit + 1}`
    );
    const page = snapshots.slice(0, limit).map(snapshotResponse);
    return {
      items: page,
      nextCursor: snapshots.length > limit ? (page.at(-1)?.analysisId ?? null) : null
    };
  });
}

export async function getUphAnalysis(
  input: GetUphAnalysisInput
): Promise<UphAnalysisSnapshotResponse> {
  return command(undefined, async (client) => {
    await authorize(client, input, PERMISSIONS.PROJECT_UPH_READ);
    await readScope(client, input.projectId, input.batchId, input.revisionId);
    const snapshots = await rows<SnapshotRow>(
      client,
      Prisma.sql`SELECT ${snapshotProjection} FROM project_uph_analysis_snapshots
        WHERE id = ${input.analysisId} AND project_id = ${input.projectId} AND batch_id = ${input.batchId}
          AND revision_id = ${input.revisionId}`
    );
    if (!snapshots[0]) {
      throw new UphAnalysisServiceError("ANALYSIS_NOT_FOUND", "分析快照不存在。", 404);
    }
    return snapshotResponse(snapshots[0]);
  });
}
