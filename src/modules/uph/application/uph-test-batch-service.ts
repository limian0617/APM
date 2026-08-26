import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS, type PermissionScope } from "@/lib/auth/permissions";
import { inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  type AuditAction,
  type AuditObjectType
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import { deriveTestBatchAllowedActions } from "../domain/uph-test-batch";

type Client = Prisma.TransactionClient;
type ProjectRole = "ENGINEER" | "PROJECT_MANAGER" | "QUALITY";
type RevisionStatus = "DRAFT" | "PM_CONFIRMED" | "LOCKED" | "SUPERSEDED";
type SampleCaptureMethod = "DEVICE_EVENT" | "MANUAL_ENTRY";
type SampleDisposition = "INCLUDED" | "EXCLUDED";
type EvidencePurpose =
  "ROOT_PRODUCTION" | "MODULE_QUALITY" | "CYCLE_SAMPLE" | "PROTOCOL" | "OBSERVATION_WINDOW";
type ExclusionReasonCode =
  | "SETUP_OR_CHANGEOVER"
  | "EXTERNAL_WAITING"
  | "UPSTREAM_MATERIAL_STARVATION"
  | "DOWNSTREAM_BLOCKAGE"
  | "SAFETY_INTERLOCK"
  | "CAPTURE_DEVICE_FAULT"
  | "OBSERVATION_INTERRUPTED"
  | "MANUAL_ENTRY_CORRECTION";

type ServiceAuthorizationActor = Omit<AuthorizationActor, "grants"> & {
  grants: Array<{ permission: string; scope: string; systemRole: string }>;
};

type CommandContext = {
  projectId: string;
  actorId: string;
  authorizationActor: ServiceAuthorizationActor;
  auditContext: AuditContext;
};

type RevisionCommandContext = CommandContext & {
  batchId: string;
  revisionId: string;
  resourceVersion: number;
};

type SampleBody = {
  projectModuleId: string;
  ordinal: number;
  sourceEventId?: string | null;
  cycleDurationSeconds: string;
  observedAt: string;
  captureMethod: SampleCaptureMethod;
  disposition: SampleDisposition;
  exclusionReasonCode?: ExclusionReasonCode;
};

type RevisionFacts = {
  revisionId: string;
  projectId: string;
  batchId: string;
  revisionNumber: number;
  status: RevisionStatus;
  resourceVersion: number;
  topologyVersionId: string;
  topologyRootNodeId: string;
  formulaVersionId: string;
  supersedesRevisionId: string | null;
  processOwnerUserId: string;
  pmConfirmerUserId: string | null;
  qualityLockerUserId: string | null;
  currentWorkRevisionId: string | null;
  currentLockedRevisionId: string | null;
  batchResourceVersion: number;
};

type MembershipFacts = {
  id: string;
  userId: string;
  role: ProjectRole;
};

type BindingFacts = {
  id: string;
  projectModuleId: string;
  ctDefinitionId: string;
  ctVersionId: string;
  ctSnapshot: unknown;
  ctChecksum: string;
  ctWatermark: string;
};

type FrozenSource = {
  topologyVersionId: string;
  topologyRootNodeId: string;
  formulaVersionId: string;
  sourceSnapshot: unknown;
  sourceChecksum: string;
  sourceWatermark: string;
  bindings: BindingFacts[];
};

type SourceLockKey = {
  sourceType: "DELIVERY_UNIT" | "PROJECT_MODULE";
  sourceId: string;
  projectModuleId: string | null;
};

type ExactVersionLockKey = {
  id: string;
  type: "TOPOLOGY" | "CT" | "FORMULA";
};

type CurrentSourceLockSet = {
  topologyRootId: string;
  topologyVersionId: string;
  rootNode: { id: string; snapshot: unknown; checksum: string; watermark: string };
  sourceNodes: SourceLockKey[];
  moduleIds: string[];
  ctRoots: Array<{ id: string; projectModuleId: string; currentPublishedVersionId: string }>;
  formulaRootId: string;
  formulaVersionId: string;
};

type FrozenSourceLockSet = {
  topologyRootId: string;
  formulaRootId: string;
  topologyVersionId: string;
  topologyRootNodeId: string;
  formulaVersionId: string;
  bindingRows: Array<{ projectModuleId: string; ctDefinitionId: string; ctVersionId: string }>;
  sourceNodes: SourceLockKey[];
};

type LockedExactVersions = {
  topology?: { snapshot: unknown; checksum: string; watermark: string };
  formula?: { formula: unknown; checksum: string; resourceVersion: number };
  bindings: BindingFacts[];
};

const PROTOCOL_SNAPSHOT = Prisma.sql`jsonb_build_object(
  'code', 'UPH_TEST_PROTOCOL',
  'version', 1,
  'unit', 'seconds/cycle',
  'secondsPerCycle', true,
  'decimalScale', 6,
  'rounding', 'HALF_UP',
  'captureMethods', jsonb_build_array('MANUAL_ENTRY', 'DEVICE_EVENT'),
  'minimumIncludedCycleSamplesPerModule', 10,
  'statisticsEligibility', jsonb_build_object('eligibleForStatistics', 'disposition=INCLUDED'),
  'statistics', jsonb_build_object(
    'arithmeticMean', 'MEAN', 'maximum', 'MAXIMUM', 'percentile', 'R-7', 'spread', 'P90_MINUS_P50'
  ),
  'exclusionReasonCodes', jsonb_build_array(
    'SETUP_OR_CHANGEOVER', 'EXTERNAL_WAITING', 'UPSTREAM_MATERIAL_STARVATION',
    'DOWNSTREAM_BLOCKAGE', 'SAFETY_INTERLOCK', 'CAPTURE_DEVICE_FAULT',
    'OBSERVATION_INTERRUPTED', 'MANUAL_ENTRY_CORRECTION'
  )
)`;

const DRAFT_ACTIONS = new Set([
  "PATCH_DRAFT_METADATA",
  "APPEND_CYCLE_SAMPLE",
  "CORRECT_CYCLE_SAMPLE",
  "UPDATE_PRODUCTION_COUNT",
  "UPDATE_MODULE_QUALITY_COUNT",
  "ATTACH_EVIDENCE"
]);

export class UphTestBatchServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "UphTestBatchServiceError";
  }
}

function text(value: unknown, field: string, maximum = 191): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new UphTestBatchServiceError("VALIDATION_FAILED", `${field}格式无效。`, 422);
  }
  return value.trim();
}

function positiveSafeInteger(value: unknown, field: string, allowZero = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    throw new UphTestBatchServiceError("VALIDATION_FAILED", `${field}必须是安全整数。`, 422);
  }
  return value;
}

function cycleDuration(value: unknown): string {
  const duration = text(value, "cycleDurationSeconds", 21);
  if (!/^\d{1,14}(?:\.\d{1,6})?$/u.test(duration) || /^0+(?:\.0+)?$/u.test(duration)) {
    throw new UphTestBatchServiceError(
      "CYCLE_DURATION_INVALID",
      "周期时长必须是正的numeric(20,6)十进制字符串。",
      422
    );
  }
  return duration;
}

function timestamp(value: unknown, field: string): Date {
  const parsed = typeof value === "string" ? new Date(value) : new Date("invalid");
  if (Number.isNaN(parsed.valueOf())) {
    throw new UphTestBatchServiceError("VALIDATION_FAILED", `${field}必须是有效时间戳。`, 422);
  }
  return parsed;
}

function json(value: unknown): Prisma.Sql {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new UphTestBatchServiceError("VALIDATION_FAILED", "JSON快照无效。", 422);
  }
  return Prisma.sql`${serialized}::jsonb`;
}

async function rows<T>(client: Client, query: Prisma.Sql): Promise<T[]> {
  return client.$queryRaw<T[]>(query);
}

async function databaseNow(client: Client): Promise<Date> {
  const result = await rows<{ now: Date }>(client, Prisma.sql`SELECT CURRENT_TIMESTAMP AS now`);
  if (!result[0]) throw new Error("无法读取数据库时间。");
  return result[0].now;
}

function assertActor(input: CommandContext): void {
  if (
    input.authorizationActor.id !== input.actorId ||
    input.authorizationActor.status !== "ACTIVE" ||
    input.auditContext.actorId !== input.actorId
  ) {
    throw new UphTestBatchServiceError("ACTOR_INVALID", "操作人身份无效。", 403);
  }
}

async function activeMembership(
  client: Client,
  projectId: string,
  actorId: string,
  role: ProjectRole
): Promise<MembershipFacts> {
  const result = await rows<MembershipFacts>(
    client,
    Prisma.sql`SELECT member.id, member.user_id AS "userId", member.project_role::text AS role
      FROM project_members member
      JOIN users actor ON actor.id = member.user_id
      WHERE member.project_id = ${projectId}
        AND member.user_id = ${actorId}
        AND member.project_role = ${role}::"ProjectRole"
        AND member.left_at IS NULL
        AND actor.status = 'ACTIVE'
      ORDER BY member.id
      LIMIT 1
      FOR UPDATE OF member, actor`
  );
  if (!result[0]) {
    throw new UphTestBatchServiceError(
      "PROJECT_ROLE_REQUIRED",
      "当前成员不具备该UPH测试批次操作所需的项目角色。",
      403
    );
  }
  return result[0];
}

async function activeRoles(client: Client, projectId: string, actorId: string): Promise<string[]> {
  const result = await rows<{ role: string }>(
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
  return result.map((row) => row.role);
}

async function projectLock(
  client: Client,
  projectId: string
): Promise<{ departmentId: string | null }> {
  const project = await rows<{
    departmentId: string | null;
    status: string;
    structureStatus: string;
  }>(
    client,
    Prisma.sql`SELECT department_id AS "departmentId", status::text AS status,
      structure_status::text AS "structureStatus"
      FROM projects WHERE id = ${projectId} FOR NO KEY UPDATE`
  );
  const result = project[0];
  if (!result) throw new UphTestBatchServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  if (result.status === "CLOSED" || result.status === "CANCELED") {
    throw new UphTestBatchServiceError("PROJECT_READ_ONLY", "项目已关闭或取消。", 409);
  }
  if (result.structureStatus !== "READY") {
    throw new UphTestBatchServiceError("PROJECT_STRUCTURE_NOT_READY", "项目结构尚未就绪。", 409);
  }
  const capability = await rows<{ enabled: boolean }>(
    client,
    Prisma.sql`SELECT pc.selected_enabled AND pc.template_allowed AND cc.enabled AS enabled
      FROM project_capabilities pc
      JOIN company_capabilities cc ON cc.code = pc.capability_code
      WHERE pc.project_id = ${projectId} AND pc.capability_code = 'UPH_ANALYSIS'::"CapabilityCode"`
  );
  if (!capability[0]?.enabled) {
    throw new UphTestBatchServiceError("UPH_CAPABILITY_REQUIRED", "项目未启用UPH分析能力。", 409);
  }
  return { departmentId: result.departmentId };
}

function assertAuthorization(
  input: CommandContext,
  permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS],
  projectId: string,
  memberRoles: string[]
): void {
  const decision = decideAuthorization(asAuthorizationActor(input.authorizationActor), permission, {
    projectId,
    requireProjectMembership: true,
    memberRoles
  });
  if (!decision.allowed) {
    throw new UphTestBatchServiceError("AUTHORIZATION_DENIED", "无权执行UPH测试批次操作。", 403);
  }
}

function assertReadAuthorization(
  actor: ServiceAuthorizationActor,
  projectId: string,
  memberRoles: string[]
): void {
  const decision = decideAuthorization(asAuthorizationActor(actor), PERMISSIONS.PROJECT_UPH_READ, {
    projectId,
    requireProjectMembership: true,
    memberRoles
  });
  if (!decision.allowed) {
    throw new UphTestBatchServiceError("AUTHORIZATION_DENIED", "无权读取UPH测试批次。", 403);
  }
}

async function authorizedReadRoles(
  client: Client,
  projectId: string,
  actor: ServiceAuthorizationActor
): Promise<string[]> {
  if (actor.status !== "ACTIVE") {
    throw new UphTestBatchServiceError("AUTHORIZATION_DENIED", "读取身份无效。", 403);
  }
  const roles = await activeRoles(client, projectId, actor.id);
  if (!roles.length) {
    throw new UphTestBatchServiceError("AUTHORIZATION_DENIED", "项目成员资格已失效。", 403);
  }
  assertReadAuthorization(actor, projectId, roles);
  return roles;
}

function allowedBatchGrants(
  actor: ServiceAuthorizationActor,
  projectId: string,
  memberRoles: string[]
): string[] {
  return [
    PERMISSIONS.PROJECT_UPH_BATCH_MANAGE,
    PERMISSIONS.PROJECT_UPH_BATCH_CONFIRM,
    PERMISSIONS.PROJECT_UPH_BATCH_LOCK
  ].filter(
    (permission) =>
      decideAuthorization(asAuthorizationActor(actor), permission, {
        projectId,
        requireProjectMembership: true,
        memberRoles
      }).allowed
  );
}

function asAuthorizationActor(actor: ServiceAuthorizationActor): AuthorizationActor {
  const scopes = new Set<PermissionScope>(["ALL", "PROJECT", "DEPARTMENT", "SELF", "ASSIGNED"]);
  const grants = actor.grants.filter(
    (grant): grant is { permission: string; scope: PermissionScope; systemRole: string } =>
      scopes.has(grant.scope as PermissionScope)
  );
  return { ...actor, grants };
}

function stableExactVersionLocks(keys: ExactVersionLockKey[]): ExactVersionLockKey[] {
  return [...new Map(keys.map((key) => [`${key.id}:${key.type}`, key])).values()].sort(
    (left, right) => left.id.localeCompare(right.id) || left.type.localeCompare(right.type)
  );
}

function stableSourceLocks(nodes: SourceLockKey[]): SourceLockKey[] {
  return [
    ...new Map(nodes.map((node) => [`${node.sourceType}:${node.sourceId}`, node])).values()
  ].sort(
    (left, right) =>
      left.sourceType.localeCompare(right.sourceType) || left.sourceId.localeCompare(right.sourceId)
  );
}

async function locateTopologyRootSources(
  client: Client,
  projectId: string,
  topologyVersionId: string,
  topologyRootNodeId: string
): Promise<SourceLockKey[]> {
  return rows<SourceLockKey>(
    client,
    Prisma.sql`WITH RECURSIVE tree AS (
      SELECT id, source_type::text AS "sourceType",
        COALESCE(delivery_unit_id, project_module_id) AS "sourceId", project_module_id AS "projectModuleId"
      FROM project_uph_topology_nodes
      WHERE id = ${topologyRootNodeId} AND topology_version_id = ${topologyVersionId}
        AND project_id = ${projectId}
      UNION ALL
      SELECT child.id, child.source_type::text,
        COALESCE(child.delivery_unit_id, child.project_module_id), child.project_module_id
      FROM project_uph_topology_nodes child
      JOIN tree ON child.parent_node_id = tree.id
      WHERE child.topology_version_id = ${topologyVersionId} AND child.project_id = ${projectId}
    ) SELECT "sourceType", "sourceId", "projectModuleId" FROM tree
      WHERE "sourceId" IS NOT NULL`
  );
}

async function locateCurrentPublishedSourceLockSet(
  client: Client,
  projectId: string,
  topologyRootNodeId: string
): Promise<CurrentSourceLockSet> {
  const topologyRoots = await rows<{ id: string; currentPublishedVersionId: string | null }>(
    client,
    Prisma.sql`SELECT id, current_published_version_id AS "currentPublishedVersionId"
      FROM project_uph_topologies WHERE project_id = ${projectId}`
  );
  const topologyRoot = topologyRoots[0];
  if (topologyRoots.length !== 1 || !topologyRoot?.currentPublishedVersionId) {
    throw new UphTestBatchServiceError(
      "PUBLISHED_TOPOLOGY_REQUIRED",
      "项目缺少当前已发布拓扑。",
      409
    );
  }
  const topologyVersionId = topologyRoot.currentPublishedVersionId;
  const rootNodes = await rows<CurrentSourceLockSet["rootNode"]>(
    client,
    Prisma.sql`SELECT id, source_snapshot_json AS snapshot, source_checksum AS checksum,
      source_watermark AS watermark
      FROM project_uph_topology_nodes
      WHERE id = ${topologyRootNodeId} AND topology_version_id = ${topologyVersionId}
        AND project_id = ${projectId} AND parent_relation = 'ROOT'::"UphTopologyNodeRelation"`
  );
  const rootNode = rootNodes[0];
  if (!rootNode) {
    throw new UphTestBatchServiceError(
      "TOPOLOGY_ROOT_SCOPE_REQUIRED",
      "测试批次必须选择已发布拓扑的ROOT节点。",
      422
    );
  }
  const sourceNodes = await locateTopologyRootSources(
    client,
    projectId,
    topologyVersionId,
    topologyRootNodeId
  );
  const moduleIds = [
    ...new Set(
      sourceNodes
        .map((node) => node.projectModuleId)
        .filter((value): value is string => typeof value === "string")
    )
  ].sort();
  if (!moduleIds.length) {
    throw new UphTestBatchServiceError(
      "TOPOLOGY_MODULE_BINDING_REQUIRED",
      "ROOT范围内必须存在项目模块。",
      409
    );
  }
  const ctRootRows = await rows<{
    id: string;
    projectModuleId: string;
    currentPublishedVersionId: string | null;
  }>(
    client,
    Prisma.sql`SELECT id, project_module_id AS "projectModuleId",
      current_published_version_id AS "currentPublishedVersionId"
      FROM project_uph_ct_definitions
      WHERE project_id = ${projectId}
        AND project_module_id IN (${Prisma.join(moduleIds.map((id) => Prisma.sql`${id}`))})
      ORDER BY project_module_id, id`
  );
  if (
    ctRootRows.length !== moduleIds.length ||
    ctRootRows.some((root) => root.currentPublishedVersionId === null)
  ) {
    throw new UphTestBatchServiceError(
      "PUBLISHED_CT_REQUIRED",
      "每个ROOT模块必须有当前已发布CT版本。",
      409
    );
  }
  const formulaRoots = await rows<{ id: string; currentPublishedVersionId: string | null }>(
    client,
    Prisma.sql`SELECT id, current_published_version_id AS "currentPublishedVersionId"
      FROM project_uph_formulas WHERE project_id = ${projectId}`
  );
  const formulaRoot = formulaRoots[0];
  if (formulaRoots.length !== 1 || !formulaRoot?.currentPublishedVersionId) {
    throw new UphTestBatchServiceError(
      "PUBLISHED_FORMULA_REQUIRED",
      "项目缺少当前已发布公式。",
      409
    );
  }
  return {
    topologyRootId: topologyRoot.id,
    topologyVersionId,
    rootNode,
    sourceNodes,
    moduleIds,
    ctRoots: ctRootRows.map((root) => ({
      ...root,
      currentPublishedVersionId: root.currentPublishedVersionId!
    })),
    formulaRootId: formulaRoot.id,
    formulaVersionId: formulaRoot.currentPublishedVersionId
  };
}

function sameCurrentSourceLockSet(
  discovered: CurrentSourceLockSet,
  verified: CurrentSourceLockSet
): boolean {
  const discoveredCt = discovered.ctRoots.map(
    (root) => `${root.projectModuleId}:${root.id}:${root.currentPublishedVersionId}`
  );
  const verifiedCt = verified.ctRoots.map(
    (root) => `${root.projectModuleId}:${root.id}:${root.currentPublishedVersionId}`
  );
  const discoveredSources = stableSourceLocks(discovered.sourceNodes).map(
    (node) => `${node.sourceType}:${node.sourceId}:${node.projectModuleId ?? ""}`
  );
  const verifiedSources = stableSourceLocks(verified.sourceNodes).map(
    (node) => `${node.sourceType}:${node.sourceId}:${node.projectModuleId ?? ""}`
  );
  return (
    discovered.topologyRootId === verified.topologyRootId &&
    discovered.topologyVersionId === verified.topologyVersionId &&
    discovered.rootNode.id === verified.rootNode.id &&
    discovered.formulaRootId === verified.formulaRootId &&
    discovered.formulaVersionId === verified.formulaVersionId &&
    discoveredCt.join("|") === verifiedCt.join("|") &&
    discoveredSources.join("|") === verifiedSources.join("|")
  );
}

async function lockCurrentSourceRoots(
  client: Client,
  projectId: string,
  lockSet: CurrentSourceLockSet
): Promise<void> {
  const topologyRoots = await rows<{ id: string }>(
    client,
    Prisma.sql`SELECT id FROM project_uph_topologies
      WHERE id = ${lockSet.topologyRootId} AND project_id = ${projectId} FOR UPDATE`
  );
  if (topologyRoots.length !== 1) {
    throw new UphTestBatchServiceError("PUBLISHED_SOURCE_CHANGED", "拓扑根已变化。", 409);
  }
  const ctRoots = await rows<{ id: string }>(
    client,
    Prisma.sql`SELECT id FROM project_uph_ct_definitions
      WHERE project_id = ${projectId}
        AND id IN (${Prisma.join(lockSet.ctRoots.map((root) => Prisma.sql`${root.id}`))})
      ORDER BY project_module_id, id FOR UPDATE`
  );
  if (ctRoots.length !== lockSet.ctRoots.length) {
    throw new UphTestBatchServiceError("PUBLISHED_SOURCE_CHANGED", "CT根已变化。", 409);
  }
  const formulaRoots = await rows<{ id: string }>(
    client,
    Prisma.sql`SELECT id FROM project_uph_formulas
      WHERE id = ${lockSet.formulaRootId} AND project_id = ${projectId} FOR UPDATE`
  );
  if (formulaRoots.length !== 1) {
    throw new UphTestBatchServiceError("PUBLISHED_SOURCE_CHANGED", "公式根已变化。", 409);
  }
}

async function lockExactVersions(
  client: Client,
  projectId: string,
  keys: ExactVersionLockKey[],
  requirePublished: boolean
): Promise<LockedExactVersions> {
  const locked: LockedExactVersions = { bindings: [] };
  for (const key of stableExactVersionLocks(keys)) {
    if (key.type === "TOPOLOGY") {
      const rowsForVersion = await rows<{
        snapshot: unknown;
        checksum: string;
        watermark: string;
        status: string;
      }>(
        client,
        Prisma.sql`SELECT snapshot_json AS snapshot, snapshot_checksum AS checksum,
          source_watermark AS watermark, status::text AS status
          FROM project_uph_topology_versions
          WHERE id = ${key.id} AND project_id = ${projectId} FOR UPDATE`
      );
      if (!rowsForVersion[0] || (requirePublished && rowsForVersion[0].status !== "PUBLISHED")) {
        throw new UphTestBatchServiceError("PUBLISHED_TOPOLOGY_REQUIRED", "拓扑版本无效。", 409);
      }
      locked.topology = rowsForVersion[0];
      continue;
    }
    if (key.type === "CT") {
      const rowsForVersion = await rows<BindingFacts & { status: string }>(
        client,
        Prisma.sql`SELECT version.id, definition.project_module_id AS "projectModuleId",
          version.ct_definition_id AS "ctDefinitionId", version.id AS "ctVersionId",
          version.snapshot_json AS "ctSnapshot", version.snapshot_checksum AS "ctChecksum",
          version.source_watermark AS "ctWatermark", version.status::text AS status
          FROM project_uph_ct_definition_versions version
          JOIN project_uph_ct_definitions definition
            ON definition.id = version.ct_definition_id AND definition.project_id = version.project_id
          WHERE version.id = ${key.id} AND version.project_id = ${projectId} FOR UPDATE OF version`
      );
      if (!rowsForVersion[0] || (requirePublished && rowsForVersion[0].status !== "PUBLISHED")) {
        throw new UphTestBatchServiceError("PUBLISHED_CT_REQUIRED", "CT版本无效。", 409);
      }
      locked.bindings.push(rowsForVersion[0]);
      continue;
    }
    const rowsForVersion = await rows<{
      formula: unknown;
      checksum: string;
      resourceVersion: number;
      status: string;
    }>(
      client,
      Prisma.sql`SELECT formula_json AS formula, snapshot_checksum AS checksum,
        resource_version AS "resourceVersion", status::text AS status
        FROM project_uph_formula_versions
        WHERE id = ${key.id} AND project_id = ${projectId} FOR UPDATE`
    );
    if (!rowsForVersion[0] || (requirePublished && rowsForVersion[0].status !== "PUBLISHED")) {
      throw new UphTestBatchServiceError("PUBLISHED_FORMULA_REQUIRED", "公式版本无效。", 409);
    }
    locked.formula = rowsForVersion[0];
  }
  return locked;
}

async function lockSelectedSources(
  client: Client,
  projectId: string,
  nodes: SourceLockKey[]
): Promise<void> {
  for (const source of stableSourceLocks(nodes)) {
    const locked =
      source.sourceType === "DELIVERY_UNIT"
        ? await rows<{ id: string }>(
            client,
            Prisma.sql`SELECT id FROM delivery_units
              WHERE id = ${source.sourceId} AND project_id = ${projectId} FOR UPDATE`
          )
        : await rows<{ id: string }>(
            client,
            Prisma.sql`SELECT id FROM project_modules
              WHERE id = ${source.sourceId} AND project_id = ${projectId} FOR UPDATE`
          );
    if (!locked[0]) {
      throw new UphTestBatchServiceError("PUBLISHED_SOURCE_CHANGED", "拓扑来源已变化。", 409);
    }
  }
}

async function lockCurrentPublishedSource(
  client: Client,
  projectId: string,
  topologyRootNodeId: string
): Promise<FrozenSource> {
  const discovered = await locateCurrentPublishedSourceLockSet(
    client,
    projectId,
    topologyRootNodeId
  );
  await lockCurrentSourceRoots(client, projectId, discovered);
  const verified = await locateCurrentPublishedSourceLockSet(client, projectId, topologyRootNodeId);
  if (!sameCurrentSourceLockSet(discovered, verified)) {
    throw new UphTestBatchServiceError(
      "PUBLISHED_SOURCE_CHANGED",
      "冻结来源在取得锁后已变化。",
      409
    );
  }
  const exactVersions = await lockExactVersions(
    client,
    projectId,
    [
      { id: verified.topologyVersionId, type: "TOPOLOGY" },
      ...verified.ctRoots.map((root) => ({
        id: root.currentPublishedVersionId,
        type: "CT" as const
      })),
      { id: verified.formulaVersionId, type: "FORMULA" }
    ],
    true
  );
  const expectedCtDefinitionByVersion = new Map(
    verified.ctRoots.map((root) => [root.currentPublishedVersionId, root.id])
  );
  if (
    !exactVersions.topology ||
    !exactVersions.formula ||
    exactVersions.bindings.length !== expectedCtDefinitionByVersion.size ||
    exactVersions.bindings.some(
      (binding) => expectedCtDefinitionByVersion.get(binding.ctVersionId) !== binding.ctDefinitionId
    )
  ) {
    throw new UphTestBatchServiceError("PUBLISHED_SOURCE_CHANGED", "冻结版本集合已变化。", 409);
  }
  await lockSelectedSources(client, projectId, verified.sourceNodes);
  const bindings = exactVersions.bindings
    .map((version) => ({ ...version, id: randomUUID() }))
    .sort((left, right) => left.projectModuleId.localeCompare(right.projectModuleId));
  const sourceSnapshot = {
    topology: {
      topologyVersionId: verified.topologyVersionId,
      topologySnapshot: exactVersions.topology.snapshot,
      topologyChecksum: exactVersions.topology.checksum,
      topologyWatermark: exactVersions.topology.watermark,
      topologyRootNodeId,
      topologyRootSnapshot: verified.rootNode.snapshot,
      topologyRootChecksum: verified.rootNode.checksum,
      topologyRootWatermark: verified.rootNode.watermark
    },
    formula: {
      formulaVersionId: verified.formulaVersionId,
      formulaSnapshot: exactVersions.formula.formula,
      formulaChecksum: exactVersions.formula.checksum,
      formulaWatermark: `${verified.formulaVersionId}:${exactVersions.formula.resourceVersion}:${exactVersions.formula.checksum}`
    },
    moduleBindings: bindings.map((binding) => ({
      projectModuleId: binding.projectModuleId,
      ctDefinitionId: binding.ctDefinitionId,
      ctVersionId: binding.ctVersionId,
      ctSnapshot: binding.ctSnapshot,
      ctChecksum: binding.ctChecksum,
      ctWatermark: binding.ctWatermark
    }))
  };
  const checksum = await rows<{ checksum: string }>(
    client,
    Prisma.sql`SELECT "uph_test_batch_checksum"(${json(sourceSnapshot)}) AS checksum`
  );
  if (!checksum[0]) throw new Error("无法生成UPH冻结来源校验和。");
  return {
    topologyVersionId: verified.topologyVersionId,
    topologyRootNodeId,
    formulaVersionId: verified.formulaVersionId,
    sourceSnapshot,
    sourceChecksum: checksum[0].checksum,
    sourceWatermark: checksum[0].checksum,
    bindings
  };
}

async function locateFrozenSourceLockSet(
  client: Client,
  projectId: string,
  revisionId: string
): Promise<FrozenSourceLockSet | null> {
  const revisions = await rows<{
    topologyVersionId: string;
    topologyRootNodeId: string;
    formulaVersionId: string;
  }>(
    client,
    Prisma.sql`SELECT topology_version_id AS "topologyVersionId", topology_root_node_id AS "topologyRootNodeId",
      formula_version_id AS "formulaVersionId"
      FROM project_uph_test_batch_revisions WHERE id = ${revisionId} AND project_id = ${projectId}`
  );
  const revision = revisions[0];
  if (!revision) return null;
  const bindingRows = await rows<FrozenSourceLockSet["bindingRows"][number]>(
    client,
    Prisma.sql`SELECT project_module_id AS "projectModuleId", ct_definition_id AS "ctDefinitionId",
      ct_version_id AS "ctVersionId"
      FROM project_uph_test_batch_revision_module_bindings
      WHERE revision_id = ${revisionId} AND project_id = ${projectId}
      ORDER BY project_module_id, ct_definition_id`
  );
  const topologyRoots = await rows<{ id: string }>(
    client,
    Prisma.sql`SELECT id FROM project_uph_topologies WHERE project_id = ${projectId}`
  );
  const formulaRoots = await rows<{ id: string }>(
    client,
    Prisma.sql`SELECT id FROM project_uph_formulas WHERE project_id = ${projectId}`
  );
  if (topologyRoots.length !== 1 || formulaRoots.length !== 1) {
    throw new UphTestBatchServiceError("FROZEN_SOURCE_INVALID", "冻结来源根不存在。", 409);
  }
  return {
    topologyRootId: topologyRoots[0]!.id,
    formulaRootId: formulaRoots[0]!.id,
    topologyVersionId: revision.topologyVersionId,
    topologyRootNodeId: revision.topologyRootNodeId,
    formulaVersionId: revision.formulaVersionId,
    bindingRows,
    sourceNodes: await locateTopologyRootSources(
      client,
      projectId,
      revision.topologyVersionId,
      revision.topologyRootNodeId
    )
  };
}

function sameFrozenSourceLockSet(
  discovered: FrozenSourceLockSet,
  verified: FrozenSourceLockSet
): boolean {
  const bindingValues = (lockSet: FrozenSourceLockSet) =>
    lockSet.bindingRows.map(
      (binding) => `${binding.projectModuleId}:${binding.ctDefinitionId}:${binding.ctVersionId}`
    );
  const sourceValues = (lockSet: FrozenSourceLockSet) =>
    stableSourceLocks(lockSet.sourceNodes).map(
      (node) => `${node.sourceType}:${node.sourceId}:${node.projectModuleId ?? ""}`
    );
  return (
    discovered.topologyRootId === verified.topologyRootId &&
    discovered.formulaRootId === verified.formulaRootId &&
    discovered.topologyVersionId === verified.topologyVersionId &&
    discovered.topologyRootNodeId === verified.topologyRootNodeId &&
    discovered.formulaVersionId === verified.formulaVersionId &&
    bindingValues(discovered).join("|") === bindingValues(verified).join("|") &&
    sourceValues(discovered).join("|") === sourceValues(verified).join("|")
  );
}

async function lockFrozenSourceRoots(
  client: Client,
  projectId: string,
  lockSet: FrozenSourceLockSet
): Promise<void> {
  const topologyRoots = await rows<{ id: string }>(
    client,
    Prisma.sql`SELECT id FROM project_uph_topologies
      WHERE id = ${lockSet.topologyRootId} AND project_id = ${projectId} FOR UPDATE`
  );
  const ctDefinitionIds = [
    ...new Set(lockSet.bindingRows.map((binding) => binding.ctDefinitionId))
  ];
  const ctRoots = await rows<{ id: string }>(
    client,
    Prisma.sql`SELECT id FROM project_uph_ct_definitions
      WHERE project_id = ${projectId}
        AND id IN (${Prisma.join(ctDefinitionIds.map((id) => Prisma.sql`${id}`))})
      ORDER BY project_module_id, id FOR UPDATE`
  );
  const formulaRoots = await rows<{ id: string }>(
    client,
    Prisma.sql`SELECT id FROM project_uph_formulas
      WHERE id = ${lockSet.formulaRootId} AND project_id = ${projectId} FOR UPDATE`
  );
  if (
    topologyRoots.length !== 1 ||
    ctRoots.length !== ctDefinitionIds.length ||
    formulaRoots.length !== 1
  ) {
    throw new UphTestBatchServiceError("FROZEN_SOURCE_CHANGED", "冻结来源根已变化。", 409);
  }
}

async function lockFrozenSource(
  client: Client,
  projectId: string,
  revisionId: string
): Promise<void> {
  const discovered = await locateFrozenSourceLockSet(client, projectId, revisionId);
  if (!discovered) return;
  await lockFrozenSourceRoots(client, projectId, discovered);
  const verified = await locateFrozenSourceLockSet(client, projectId, revisionId);
  if (!verified || !sameFrozenSourceLockSet(discovered, verified)) {
    throw new UphTestBatchServiceError("FROZEN_SOURCE_CHANGED", "冻结来源在取得锁后已变化。", 409);
  }
  const exactVersions = await lockExactVersions(
    client,
    projectId,
    [
      { id: verified.topologyVersionId, type: "TOPOLOGY" },
      ...verified.bindingRows.map((binding) => ({ id: binding.ctVersionId, type: "CT" as const })),
      { id: verified.formulaVersionId, type: "FORMULA" }
    ],
    false
  );
  const expectedCtDefinitionByVersion = new Map(
    verified.bindingRows.map((binding) => [binding.ctVersionId, binding.ctDefinitionId])
  );
  if (
    !exactVersions.topology ||
    !exactVersions.formula ||
    exactVersions.bindings.length !== expectedCtDefinitionByVersion.size ||
    exactVersions.bindings.some(
      (binding) => expectedCtDefinitionByVersion.get(binding.ctVersionId) !== binding.ctDefinitionId
    )
  ) {
    throw new UphTestBatchServiceError("FROZEN_SOURCE_CHANGED", "冻结版本集合已变化。", 409);
  }
  await lockSelectedSources(client, projectId, verified.sourceNodes);
}

async function lockedRevision(
  client: Client,
  projectId: string,
  batchId: string,
  revisionId: string
): Promise<RevisionFacts> {
  const result = await rows<RevisionFacts>(
    client,
    Prisma.sql`SELECT revision.id AS "revisionId", revision.project_id AS "projectId", revision.batch_id AS "batchId",
      revision.revision_number AS "revisionNumber", revision.status::text AS status,
      revision.resource_version AS "resourceVersion", revision.topology_version_id AS "topologyVersionId",
      revision.topology_root_node_id AS "topologyRootNodeId", revision.formula_version_id AS "formulaVersionId",
      revision.supersedes_revision_id AS "supersedesRevisionId",
      revision.process_owner_user_id AS "processOwnerUserId",
      revision.pm_confirmer_user_id AS "pmConfirmerUserId",
      revision.quality_locker_user_id AS "qualityLockerUserId",
      batch.current_work_revision_id AS "currentWorkRevisionId",
      batch.current_locked_revision_id AS "currentLockedRevisionId",
      batch.resource_version AS "batchResourceVersion"
      FROM project_uph_test_batch_revisions revision
      JOIN project_uph_test_batches batch ON batch.id = revision.batch_id AND batch.project_id = revision.project_id
      WHERE revision.project_id = ${projectId} AND revision.batch_id = ${batchId} AND revision.id = ${revisionId}
      FOR UPDATE OF batch, revision`
  );
  if (!result[0])
    throw new UphTestBatchServiceError(
      "TEST_BATCH_REVISION_NOT_FOUND",
      "测试批次修订不存在。",
      404
    );
  return result[0];
}

function requireExpectedVersion(revision: RevisionFacts, expected: number): void {
  if (!Number.isInteger(expected) || expected < 1 || revision.batchResourceVersion !== expected) {
    throw new UphTestBatchServiceError(
      "RESOURCE_VERSION_CONFLICT",
      "测试批次资源版本已变化。",
      409
    );
  }
}

function requireDraftOwner(revision: RevisionFacts, actorId: string): void {
  if (revision.status !== "DRAFT") {
    throw new UphTestBatchServiceError("DRAFT_REQUIRED", "该操作仅允许在DRAFT修订执行。", 409);
  }
  if (revision.processOwnerUserId !== actorId) {
    throw new UphTestBatchServiceError(
      "PROCESS_OWNER_REQUIRED",
      "只有工艺负责人可修改DRAFT事实。",
      403
    );
  }
}

async function bumpRoot(
  client: Client,
  revision: RevisionFacts,
  expectedVersion: number,
  pointers: { currentWorkRevisionId: string | null; currentLockedRevisionId: string | null }
): Promise<number> {
  const changed = await rows<{ resourceVersion: number }>(
    client,
    Prisma.sql`UPDATE project_uph_test_batches
      SET current_work_revision_id = ${pointers.currentWorkRevisionId},
          current_locked_revision_id = ${pointers.currentLockedRevisionId},
          resource_version = resource_version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ${revision.batchId} AND project_id = ${revision.projectId}
        AND resource_version = ${expectedVersion}
      RETURNING resource_version AS "resourceVersion"`
  );
  if (!changed[0]) {
    throw new UphTestBatchServiceError(
      "RESOURCE_VERSION_CONFLICT",
      "测试批次资源版本已变化。",
      409
    );
  }
  return changed[0].resourceVersion;
}

function auditContext(input: CommandContext): AuditContext {
  return { ...input.auditContext, actorId: input.actorId, projectId: input.projectId };
}

async function writeCommandFacts(
  client: Client,
  input: CommandContext,
  values: {
    action: AuditAction;
    objectType: AuditObjectType;
    objectId: string;
    eventType: string;
    aggregateId: string;
    resourceVersion: number;
    payload: Record<string, unknown>;
    reason?: string;
  }
): Promise<{ auditId: string; outboxEventId: string }> {
  const audit = await writeAudit(client, {
    action: values.action,
    objectType: values.objectType,
    objectId: values.objectId,
    context: { ...auditContext(input), reason: values.reason ?? auditContext(input).reason },
    after: {
      value: values.payload,
      allowedFields: [
        "projectId",
        "batchId",
        "revisionId",
        "sampleId",
        "replacementSampleId",
        "correctedSampleId",
        "supersedesRevisionId",
        "successorRevisionId",
        "reason",
        "status",
        "resourceVersion"
      ]
    }
  });
  const outbox = await appendOutboxEvent(client, {
    eventType: values.eventType,
    aggregateType: AUDIT_OBJECT_TYPES.UPH_TEST_BATCH,
    aggregateId: values.aggregateId,
    idempotencyKey: `uph:test-batch:${values.eventType}:${values.aggregateId}:${values.resourceVersion}`,
    payload: values.payload
  });
  return { auditId: audit.id, outboxEventId: outbox.id };
}

function isApm081DeferredConstraintError(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    meta?: { code?: unknown; message?: unknown };
  };
  const code = candidate?.meta?.code ?? candidate?.code;
  if (String(code) !== "23514") return false;
  const message = [candidate?.meta?.message, candidate?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /(?:UPH|PM_CONFIRM|rebuild confirmed input|rebuild statistics)/u.test(message);
}

async function validateDeferredUphConstraints(client: Client): Promise<void> {
  await client.$executeRaw(
    Prisma.sql`SET CONSTRAINTS
      "project_uph_test_batch_binding_guard",
      "project_uph_test_batch_revision_checksum_guard",
      "project_uph_test_batch_sample_append_guard",
      "project_uph_test_batch_pointer_commit_guard",
      "project_uph_test_batch_revision_successor_guard"
      IMMEDIATE`
  );
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof UphTestBatchServiceError) throw error;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  const code = candidate?.meta?.code ?? candidate?.code;
  if (isApm081DeferredConstraintError(error)) {
    throw new UphTestBatchServiceError(
      "UPH_CONSTRAINT_VIOLATION",
      "UPH测试批次事实未满足提交约束。",
      422
    );
  }
  if (["23505", "40P01", "55P03", "P2002", "P2034"].includes(String(code))) {
    throw new UphTestBatchServiceError(
      "RESOURCE_VERSION_CONFLICT",
      "并发写入冲突，请刷新后重试。",
      409
    );
  }
  throw error;
}

async function command<T>(
  transaction: Client | undefined,
  operation: (client: Client) => Promise<T>
): Promise<T> {
  try {
    return await inTransaction(transaction, async (client) => {
      const result = await operation(client);
      if (transaction) {
        await validateDeferredUphConstraints(client);
      }
      return result;
    });
  } catch (error) {
    return mapDatabaseError(error);
  }
}

async function responseForRevision(
  client: Client,
  projectId: string,
  batchId: string,
  revisionId: string,
  access?: { actor: ServiceAuthorizationActor; memberRoles: string[] }
) {
  const records = await rows<{
    id: string;
    projectId: string;
    batchId: string;
    revisionNumber: number;
    status: RevisionStatus;
    resourceVersion: number;
    topologyRootNodeId: string;
    topologyVersionId: string;
    formulaVersionId: string;
    processOwnerUserId: string;
    pmConfirmerUserId: string | null;
    qualityLockerUserId: string | null;
    moduleBindings: Array<{
      id: string;
      projectModuleId: string;
      ctDefinitionId: string;
      ctVersionId: string;
    }>;
  }>(
    client,
    Prisma.sql`SELECT revision.id, revision.project_id AS "projectId", revision.batch_id AS "batchId",
      revision.revision_number AS "revisionNumber", revision.status::text AS status,
      batch.resource_version AS "resourceVersion", revision.topology_root_node_id AS "topologyRootNodeId",
      revision.topology_version_id AS "topologyVersionId", revision.formula_version_id AS "formulaVersionId",
      revision.process_owner_user_id AS "processOwnerUserId",
      revision.pm_confirmer_user_id AS "pmConfirmerUserId",
      revision.quality_locker_user_id AS "qualityLockerUserId",
      COALESCE(jsonb_agg(jsonb_build_object(
        'id', binding.id, 'projectModuleId', binding.project_module_id,
        'ctDefinitionId', binding.ct_definition_id, 'ctVersionId', binding.ct_version_id
      ) ORDER BY binding.project_module_id, binding.id)
        FILTER (WHERE binding.id IS NOT NULL), '[]'::jsonb) AS "moduleBindings"
      FROM project_uph_test_batch_revisions revision
      JOIN project_uph_test_batches batch ON batch.id = revision.batch_id AND batch.project_id = revision.project_id
      LEFT JOIN project_uph_test_batch_revision_module_bindings binding
        ON binding.revision_id = revision.id AND binding.project_id = revision.project_id
      WHERE revision.project_id = ${projectId} AND revision.batch_id = ${batchId} AND revision.id = ${revisionId}
      GROUP BY revision.id, batch.resource_version`
  );
  const revision = records[0];
  if (!revision)
    throw new UphTestBatchServiceError(
      "TEST_BATCH_REVISION_NOT_FOUND",
      "测试批次修订不存在。",
      404
    );
  const allowedActions = access
    ? deriveTestBatchAllowedActions({
        revisionStatus: revision.status,
        actor: {
          userId: access.actor.id,
          memberRoles: access.memberRoles,
          grants: allowedBatchGrants(access.actor, projectId, access.memberRoles),
          activeProjectMembership: access.memberRoles.length > 0
        },
        responsibilities: {
          processOwnerUserId: revision.processOwnerUserId,
          pmConfirmerUserId: revision.pmConfirmerUserId,
          qualityLockerUserId: revision.qualityLockerUserId
        }
      })
    : [];
  return { ...revision, allowedActions };
}

export async function createUphTestBatch(
  input: CommandContext & {
    body: {
      batchNumber: string;
      topologyRootNodeId: string;
      plannedProductionSeconds: number;
      planDeclarationReason: string;
      observationStartedAt: string;
      observationEndedAt: string | null;
      timezone: string;
    };
  },
  transaction?: Client
) {
  return command(transaction, async (client) => {
    assertActor(input);
    await projectLock(client, input.projectId);
    const membership = await activeMembership(client, input.projectId, input.actorId, "ENGINEER");
    assertAuthorization(input, PERMISSIONS.PROJECT_UPH_BATCH_MANAGE, input.projectId, [
      membership.role
    ]);
    const batchNumber = text(input.body.batchNumber, "batchNumber");
    const planDeclarationReason = text(
      input.body.planDeclarationReason,
      "planDeclarationReason",
      1024
    );
    const plannedProductionSeconds = positiveSafeInteger(
      input.body.plannedProductionSeconds,
      "plannedProductionSeconds"
    );
    const observationStartedAt = timestamp(input.body.observationStartedAt, "observationStartedAt");
    const observationEndedAt =
      input.body.observationEndedAt === null
        ? null
        : timestamp(input.body.observationEndedAt, "observationEndedAt");
    if (observationEndedAt && observationEndedAt <= observationStartedAt) {
      throw new UphTestBatchServiceError(
        "OBSERVATION_WINDOW_INVALID",
        "观察结束时间必须晚于开始时间。",
        422
      );
    }
    const timezone = text(input.body.timezone, "timezone", 100);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    } catch {
      throw new UphTestBatchServiceError(
        "PLAN_DECLARATION_INVALID",
        "时区必须是有效IANA时区。",
        422
      );
    }
    const source = await lockCurrentPublishedSource(
      client,
      input.projectId,
      text(input.body.topologyRootNodeId, "topologyRootNodeId")
    );
    const now = await databaseNow(client);
    const batchId = randomUUID();
    const revisionId = randomUUID();
    await client.$executeRaw(
      Prisma.sql`INSERT INTO project_uph_test_batches
        (id, project_id, batch_number, scope, current_work_revision_id, current_locked_revision_id,
         resource_version, created_at, updated_at)
        VALUES (${batchId}, ${input.projectId}, ${batchNumber}, 'TOPOLOGY_ROOT'::"UphTestBatchScope",
          ${revisionId}, NULL, 1, ${now}, ${now})`
    );
    await client.$executeRaw(
      Prisma.sql`INSERT INTO project_uph_test_batch_revisions (
        id, project_id, batch_id, revision_number, supersedes_revision_id, status, resource_version,
        topology_version_id, topology_root_node_id, formula_version_id,
        plan_declaration_reason, planned_production_seconds, plan_snapshot_json, plan_checksum, plan_declared_at,
        observation_started_at, observation_ended_at, timezone,
        test_protocol_code, test_protocol_version, protocol_snapshot_json, protocol_checksum,
        source_binding_snapshot_json, source_watermark, source_checksum,
        process_owner_membership_id, process_owner_user_id, process_owner_role,
        process_owner_snapshot_json, process_owner_checksum, created_by_id, created_at
      ) VALUES (
        ${revisionId}, ${input.projectId}, ${batchId}, 1, NULL, 'DRAFT'::"UphTestBatchRevisionStatus", 1,
        ${source.topologyVersionId}, ${source.topologyRootNodeId}, ${source.formulaVersionId},
        ${planDeclarationReason}, ${BigInt(plannedProductionSeconds)},
        jsonb_build_object(
          'planDeclarationReason', ${planDeclarationReason},
          'plannedProductionSeconds', ${BigInt(plannedProductionSeconds)},
          'planDeclaredAt', ${now}::timestamptz,
          'processOwnerMembershipId', ${membership.id}, 'processOwnerUserId', ${input.actorId},
          'processOwnerRole', 'ENGINEER'
        ),
        "uph_test_batch_checksum"(jsonb_build_object(
          'planDeclarationReason', ${planDeclarationReason},
          'plannedProductionSeconds', ${BigInt(plannedProductionSeconds)},
          'planDeclaredAt', ${now}::timestamptz,
          'processOwnerMembershipId', ${membership.id}, 'processOwnerUserId', ${input.actorId},
          'processOwnerRole', 'ENGINEER'
        )), ${now}, ${observationStartedAt}, ${observationEndedAt}, ${timezone},
        'UPH_TEST_PROTOCOL', 1, ${PROTOCOL_SNAPSHOT}, "uph_test_batch_checksum"(${PROTOCOL_SNAPSHOT}),
        ${json(source.sourceSnapshot)}, ${source.sourceWatermark}, ${source.sourceChecksum},
        ${membership.id}, ${input.actorId}, 'ENGINEER'::"ProjectRole",
        "uph_test_batch_responsibility_snapshot"(${membership.id}, ${input.actorId}, 'ENGINEER'::"ProjectRole", ${now}, NULL),
        "uph_test_batch_responsibility_checksum"(${membership.id}, ${input.actorId}, 'ENGINEER'::"ProjectRole", ${now}, NULL),
        ${input.actorId}, ${now}
      )`
    );
    for (const binding of source.bindings) {
      await client.$executeRaw(
        Prisma.sql`INSERT INTO project_uph_test_batch_revision_module_bindings
          (id, project_id, revision_id, project_module_id, ct_definition_id, ct_version_id,
           ct_source_snapshot_json, ct_source_checksum, ct_source_watermark)
          VALUES (${binding.id}, ${input.projectId}, ${revisionId}, ${binding.projectModuleId},
            ${binding.ctDefinitionId}, ${binding.ctVersionId}, ${json(binding.ctSnapshot)},
            ${binding.ctChecksum}, ${binding.ctWatermark})`
      );
    }
    const response = await responseForRevision(client, input.projectId, batchId, revisionId);
    const facts = await writeCommandFacts(client, input, {
      action: AUDIT_ACTIONS.UPH_TEST_BATCH_CREATED,
      objectType: AUDIT_OBJECT_TYPES.UPH_TEST_BATCH,
      objectId: batchId,
      eventType: "uph.test-batch.created",
      aggregateId: batchId,
      resourceVersion: response.resourceVersion,
      payload: {
        projectId: input.projectId,
        batchId,
        revisionId,
        status: response.status,
        resourceVersion: response.resourceVersion
      }
    });
    return { ...response, batchId, revisionId, ...facts };
  });
}

export async function listUphTestBatches(input: {
  projectId: string;
  authorizationActor: ServiceAuthorizationActor;
  projectMemberRoles: string[];
  cursor?: string;
  limit?: number;
  status?: RevisionStatus;
  topologyRootNodeId?: string;
}) {
  return command(undefined, async (client) => {
    const roles = await authorizedReadRoles(client, input.projectId, input.authorizationActor);
    await projectLock(client, input.projectId);
    const limit = input.limit ?? 25;
    const batches = await rows<{
      id: string;
      batchNumber: string;
      currentWorkRevisionId: string | null;
      currentLockedRevisionId: string | null;
      resourceVersion: number;
    }>(
      client,
      Prisma.sql`SELECT batch.id, batch.batch_number AS "batchNumber",
        batch.current_work_revision_id AS "currentWorkRevisionId",
        batch.current_locked_revision_id AS "currentLockedRevisionId",
        batch.resource_version AS "resourceVersion"
        FROM project_uph_test_batches batch
        WHERE batch.project_id = ${input.projectId}
          AND (${input.cursor ?? null}::text IS NULL OR batch.id > ${input.cursor ?? null})
          AND (${input.topologyRootNodeId ?? null}::text IS NULL OR EXISTS (
            SELECT 1 FROM project_uph_test_batch_revisions revision
            WHERE revision.batch_id = batch.id AND revision.project_id = batch.project_id
              AND revision.topology_root_node_id = ${input.topologyRootNodeId ?? null}
          ))
          AND (${input.status ?? null}::"UphTestBatchRevisionStatus" IS NULL OR EXISTS (
            SELECT 1 FROM project_uph_test_batch_revisions revision
            WHERE revision.batch_id = batch.id AND revision.project_id = batch.project_id
              AND revision.status = ${input.status ?? null}::"UphTestBatchRevisionStatus"
          ))
        ORDER BY batch.id LIMIT ${limit}`
    );
    return {
      batches,
      allowedActions: allowedBatchGrants(input.authorizationActor, input.projectId, roles).includes(
        PERMISSIONS.PROJECT_UPH_BATCH_MANAGE
      )
        ? ["CREATE"]
        : []
    };
  });
}

export async function getUphTestBatchRevision(input: {
  projectId: string;
  batchId: string;
  revisionId: string;
  topologyRootNodeId?: string;
  authorizationActor: ServiceAuthorizationActor;
  projectMemberRoles: string[];
}) {
  return command(undefined, async (client) => {
    const roles = await authorizedReadRoles(client, input.projectId, input.authorizationActor);
    await projectLock(client, input.projectId);
    return responseForRevision(client, input.projectId, input.batchId, input.revisionId, {
      actor: input.authorizationActor,
      memberRoles: roles
    });
  });
}

export async function getUphTestBatch(input: {
  projectId: string;
  batchId: string;
  selection: "exact" | "currentWork" | "currentLocked";
  revisionId?: string;
  authorizationActor: ServiceAuthorizationActor;
  projectMemberRoles: string[];
}) {
  return command(undefined, async (client) => {
    const roles = await authorizedReadRoles(client, input.projectId, input.authorizationActor);
    await projectLock(client, input.projectId);
    const pointers = await rows<{ revisionId: string | null }>(
      client,
      Prisma.sql`SELECT ${
        input.selection === "currentWork"
          ? Prisma.sql`current_work_revision_id`
          : input.selection === "currentLocked"
            ? Prisma.sql`current_locked_revision_id`
            : Prisma.sql`${input.revisionId ?? null}::text`
      } AS "revisionId"
      FROM project_uph_test_batches WHERE id = ${input.batchId} AND project_id = ${input.projectId}`
    );
    const revisionId = pointers[0]?.revisionId;
    if (!revisionId)
      throw new UphTestBatchServiceError(
        "TEST_BATCH_REVISION_NOT_FOUND",
        "测试批次修订不存在。",
        404
      );
    return responseForRevision(client, input.projectId, input.batchId, revisionId, {
      actor: input.authorizationActor,
      memberRoles: roles
    });
  });
}

export async function patchUphTestBatchRevision(
  input: RevisionCommandContext & {
    body: {
      plannedProductionSeconds: number;
      planDeclarationReason: string;
      observationStartedAt: string;
      observationEndedAt: string | null;
      timezone: string;
    };
  },
  transaction?: Client
) {
  return command(transaction, async (client) => {
    assertActor(input);
    await projectLock(client, input.projectId);
    await lockFrozenSource(client, input.projectId, input.revisionId);
    const revision = await lockedRevision(client, input.projectId, input.batchId, input.revisionId);
    requireExpectedVersion(revision, input.resourceVersion);
    requireDraftOwner(revision, input.actorId);
    const membership = await activeMembership(client, input.projectId, input.actorId, "ENGINEER");
    assertAuthorization(input, PERMISSIONS.PROJECT_UPH_BATCH_MANAGE, input.projectId, [
      membership.role
    ]);
    const plannedProductionSeconds = positiveSafeInteger(
      input.body.plannedProductionSeconds,
      "plannedProductionSeconds"
    );
    const reason = text(input.body.planDeclarationReason, "planDeclarationReason", 1024);
    const startedAt = timestamp(input.body.observationStartedAt, "observationStartedAt");
    const endedAt =
      input.body.observationEndedAt === null
        ? null
        : timestamp(input.body.observationEndedAt, "observationEndedAt");
    if (endedAt && endedAt <= startedAt)
      throw new UphTestBatchServiceError("OBSERVATION_WINDOW_INVALID", "观察窗口无效。", 422);
    const timezone = text(input.body.timezone, "timezone", 100);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    } catch {
      throw new UphTestBatchServiceError(
        "PLAN_DECLARATION_INVALID",
        "时区必须是有效IANA时区。",
        422
      );
    }
    const now = await databaseNow(client);
    const changed = await client.$executeRaw(
      Prisma.sql`UPDATE project_uph_test_batch_revisions SET
        plan_declaration_reason = ${reason}, planned_production_seconds = ${BigInt(plannedProductionSeconds)},
        plan_declared_at = ${now}, observation_started_at = ${startedAt}, observation_ended_at = ${endedAt}, timezone = ${timezone},
        plan_snapshot_json = jsonb_build_object(
          'planDeclarationReason', ${reason}, 'plannedProductionSeconds', ${BigInt(plannedProductionSeconds)},
          'planDeclaredAt', ${now}::timestamptz, 'processOwnerMembershipId', process_owner_membership_id,
          'processOwnerUserId', process_owner_user_id, 'processOwnerRole', process_owner_role::text
        ),
        plan_checksum = "uph_test_batch_checksum"(jsonb_build_object(
          'planDeclarationReason', ${reason}, 'plannedProductionSeconds', ${BigInt(plannedProductionSeconds)},
          'planDeclaredAt', ${now}::timestamptz, 'processOwnerMembershipId', process_owner_membership_id,
          'processOwnerUserId', process_owner_user_id, 'processOwnerRole', process_owner_role::text
        )), resource_version = resource_version + 1
        WHERE id = ${revision.revisionId} AND project_id = ${revision.projectId} AND status = 'DRAFT'::"UphTestBatchRevisionStatus"`
    );
    if (changed !== 1)
      throw new UphTestBatchServiceError("RESOURCE_VERSION_CONFLICT", "修订已变化。", 409);
    const version = await bumpRoot(client, revision, input.resourceVersion, {
      currentWorkRevisionId: revision.currentWorkRevisionId,
      currentLockedRevisionId: revision.currentLockedRevisionId
    });
    const response = await responseForRevision(
      client,
      input.projectId,
      input.batchId,
      input.revisionId
    );
    const facts = await writeCommandFacts(client, input, {
      action: AUDIT_ACTIONS.UPH_TEST_BATCH_REVISION_METADATA_UPDATED,
      objectType: AUDIT_OBJECT_TYPES.UPH_TEST_BATCH_REVISION,
      objectId: input.revisionId,
      eventType: "uph.test-batch.revision.metadata-updated",
      aggregateId: input.revisionId,
      resourceVersion: version,
      payload: {
        projectId: input.projectId,
        batchId: input.batchId,
        revisionId: input.revisionId,
        status: response.status,
        resourceVersion: version
      }
    });
    return { ...response, resourceVersion: version, ...facts };
  });
}

async function insertSample(
  client: Client,
  input: RevisionCommandContext,
  membership: MembershipFacts,
  values: {
    id: string;
    moduleBindingId: string;
    ordinal: number;
    correctionOfSampleId: string | null;
    sourceEventId: string | null;
    cycleDurationSeconds: string;
    observedAt: Date;
    captureMethod: SampleCaptureMethod;
    disposition: SampleDisposition;
    exclusionReasonCode: ExclusionReasonCode | null;
  }
) {
  const recordedAt = await databaseNow(client);
  await client.$executeRaw(
    Prisma.sql`INSERT INTO project_uph_module_cycle_samples (
      id, project_id, revision_id, module_binding_id, ordinal, correction_of_sample_id, source_event_id,
      cycle_duration_seconds, observed_at, recorded_at, capture_method,
      captured_by_membership_id, captured_by_user_id, captured_by_role, captured_by_snapshot_json, captured_by_checksum,
      disposition, exclusion_reason_code
    ) VALUES (
      ${values.id}, ${input.projectId}, ${input.revisionId}, ${values.moduleBindingId}, ${values.ordinal},
      ${values.correctionOfSampleId}, ${values.sourceEventId}, ${values.cycleDurationSeconds}::numeric,
      ${values.observedAt}, ${recordedAt}, ${values.captureMethod}::"UphTestBatchSampleCaptureMethod",
      ${membership.id}, ${input.actorId}, 'ENGINEER'::"ProjectRole",
      "uph_test_batch_responsibility_snapshot"(${membership.id}, ${input.actorId}, 'ENGINEER'::"ProjectRole", ${recordedAt}, NULL),
      "uph_test_batch_responsibility_checksum"(${membership.id}, ${input.actorId}, 'ENGINEER'::"ProjectRole", ${recordedAt}, NULL),
      ${values.disposition}::"UphTestBatchSampleDisposition", ${values.exclusionReasonCode}::"UphTestBatchExclusionReasonCode"
    )`
  );
}

export async function appendUphCycleSample(
  input: RevisionCommandContext & { body: SampleBody },
  transaction?: Client
) {
  return command(transaction, async (client) => {
    assertActor(input);
    await projectLock(client, input.projectId);
    await lockFrozenSource(client, input.projectId, input.revisionId);
    const revision = await lockedRevision(client, input.projectId, input.batchId, input.revisionId);
    requireExpectedVersion(revision, input.resourceVersion);
    requireDraftOwner(revision, input.actorId);
    const membership = await activeMembership(client, input.projectId, input.actorId, "ENGINEER");
    assertAuthorization(input, PERMISSIONS.PROJECT_UPH_BATCH_MANAGE, input.projectId, [
      membership.role
    ]);
    const body = input.body;
    const ordinal = positiveSafeInteger(body.ordinal, "ordinal");
    const sourceEventId =
      body.sourceEventId == null ? null : text(body.sourceEventId, "sourceEventId");
    if (body.captureMethod === "DEVICE_EVENT" && !sourceEventId) {
      throw new UphTestBatchServiceError(
        "SOURCE_EVENT_REQUIRED",
        "DEVICE_EVENT必须带sourceEventId。",
        422
      );
    }
    const exclusionReasonCode = body.exclusionReasonCode ?? null;
    if (
      (body.disposition === "INCLUDED" && exclusionReasonCode !== null) ||
      (body.disposition === "EXCLUDED" && exclusionReasonCode === null) ||
      exclusionReasonCode === "MANUAL_ENTRY_CORRECTION"
    ) {
      throw new UphTestBatchServiceError("EXCLUSION_REASON_INVALID", "周期样本排除原因无效。", 422);
    }
    const bindings = await rows<{ id: string }>(
      client,
      Prisma.sql`SELECT id FROM project_uph_test_batch_revision_module_bindings
        WHERE revision_id = ${input.revisionId} AND project_id = ${input.projectId}
          AND project_module_id = ${text(body.projectModuleId, "projectModuleId")}
        FOR UPDATE`
    );
    const binding = bindings[0];
    if (!binding)
      throw new UphTestBatchServiceError(
        "MODULE_BINDING_NOT_FOUND",
        "模块不属于该冻结批次范围。",
        404
      );
    const sampleId = randomUUID();
    await insertSample(client, input, membership, {
      id: sampleId,
      moduleBindingId: binding.id,
      ordinal,
      correctionOfSampleId: null,
      sourceEventId,
      cycleDurationSeconds: cycleDuration(body.cycleDurationSeconds),
      observedAt: timestamp(body.observedAt, "observedAt"),
      captureMethod: body.captureMethod,
      disposition: body.disposition,
      exclusionReasonCode
    });
    const version = await bumpRoot(client, revision, input.resourceVersion, {
      currentWorkRevisionId: revision.currentWorkRevisionId,
      currentLockedRevisionId: revision.currentLockedRevisionId
    });
    const facts = await writeCommandFacts(client, input, {
      action: AUDIT_ACTIONS.UPH_CYCLE_SAMPLE_APPENDED,
      objectType: AUDIT_OBJECT_TYPES.UPH_MODULE_CYCLE_SAMPLE,
      objectId: sampleId,
      eventType: "uph.test-batch.cycle-sample.appended",
      aggregateId: input.revisionId,
      resourceVersion: version,
      payload: {
        projectId: input.projectId,
        batchId: input.batchId,
        revisionId: input.revisionId,
        sampleId,
        status: revision.status,
        resourceVersion: version
      }
    });
    return {
      id: sampleId,
      sampleId,
      batchId: input.batchId,
      revisionId: input.revisionId,
      resourceVersion: version,
      ...facts
    };
  });
}

export async function correctUphCycleSample(
  input: RevisionCommandContext & {
    sampleId: string;
    body: {
      replacement: {
        cycleDurationSeconds: string;
        observedAt: string;
        captureMethod: "MANUAL_ENTRY";
      };
    };
  },
  transaction?: Client
) {
  return command(transaction, async (client) => {
    assertActor(input);
    await projectLock(client, input.projectId);
    await lockFrozenSource(client, input.projectId, input.revisionId);
    const revision = await lockedRevision(client, input.projectId, input.batchId, input.revisionId);
    requireExpectedVersion(revision, input.resourceVersion);
    requireDraftOwner(revision, input.actorId);
    const membership = await activeMembership(client, input.projectId, input.actorId, "ENGINEER");
    assertAuthorization(input, PERMISSIONS.PROJECT_UPH_BATCH_MANAGE, input.projectId, [
      membership.role
    ]);
    if (input.body.replacement.captureMethod !== "MANUAL_ENTRY") {
      throw new UphTestBatchServiceError(
        "CYCLE_SAMPLE_CORRECTION_INVALID",
        "人工修正只能追加MANUAL_ENTRY样本。",
        422
      );
    }
    const originals = await rows<{
      moduleBindingId: string;
      ordinal: number;
      disposition: SampleDisposition;
      exclusionReasonCode: string | null;
    }>(
      client,
      Prisma.sql`SELECT module_binding_id AS "moduleBindingId", ordinal, disposition::text AS disposition,
        exclusion_reason_code::text AS "exclusionReasonCode"
        FROM project_uph_module_cycle_samples
        WHERE id = ${input.sampleId} AND project_id = ${input.projectId} AND revision_id = ${input.revisionId}
        FOR UPDATE`
    );
    const original = originals[0];
    if (!original)
      throw new UphTestBatchServiceError("CYCLE_SAMPLE_NOT_FOUND", "周期样本不存在。", 404);
    if (original.disposition !== "INCLUDED" || original.exclusionReasonCode !== null) {
      throw new UphTestBatchServiceError(
        "CYCLE_SAMPLE_CORRECTION_INVALID",
        "仅可修正未排除的原始样本。",
        409
      );
    }
    const next = await rows<{ ordinal: number }>(
      client,
      Prisma.sql`SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
        FROM project_uph_module_cycle_samples
        WHERE project_id = ${input.projectId} AND revision_id = ${input.revisionId}
          AND module_binding_id = ${original.moduleBindingId}`
    );
    const replacementId = randomUUID();
    await client.$executeRaw(
      Prisma.sql`UPDATE project_uph_module_cycle_samples
        SET disposition = 'EXCLUDED'::"UphTestBatchSampleDisposition",
            exclusion_reason_code = 'MANUAL_ENTRY_CORRECTION'::"UphTestBatchExclusionReasonCode"
        WHERE id = ${input.sampleId} AND project_id = ${input.projectId} AND revision_id = ${input.revisionId}`
    );
    await insertSample(client, input, membership, {
      id: replacementId,
      moduleBindingId: original.moduleBindingId,
      ordinal: next[0]!.ordinal,
      correctionOfSampleId: input.sampleId,
      sourceEventId: null,
      cycleDurationSeconds: cycleDuration(input.body.replacement.cycleDurationSeconds),
      observedAt: timestamp(input.body.replacement.observedAt, "observedAt"),
      captureMethod: "MANUAL_ENTRY",
      disposition: "INCLUDED",
      exclusionReasonCode: null
    });
    const version = await bumpRoot(client, revision, input.resourceVersion, {
      currentWorkRevisionId: revision.currentWorkRevisionId,
      currentLockedRevisionId: revision.currentLockedRevisionId
    });
    const facts = await writeCommandFacts(client, input, {
      action: AUDIT_ACTIONS.UPH_CYCLE_SAMPLE_CORRECTED,
      objectType: AUDIT_OBJECT_TYPES.UPH_MODULE_CYCLE_SAMPLE,
      objectId: replacementId,
      eventType: "uph.test-batch.cycle-sample.corrected",
      aggregateId: input.revisionId,
      resourceVersion: version,
      payload: {
        projectId: input.projectId,
        batchId: input.batchId,
        revisionId: input.revisionId,
        sampleId: input.sampleId,
        correctedSampleId: input.sampleId,
        replacementSampleId: replacementId,
        status: revision.status,
        resourceVersion: version
      }
    });
    return {
      id: replacementId,
      sampleId: replacementId,
      correctedSampleId: input.sampleId,
      ordinal: next[0]!.ordinal,
      resourceVersion: version,
      ...facts
    };
  });
}

export async function updateUphTestBatchProductionCount(
  input: RevisionCommandContext & {
    body: { actualGrossOutputCount: number; finalGoodOutputCount: number };
  },
  transaction?: Client
) {
  return command(transaction, async (client) => {
    assertActor(input);
    await projectLock(client, input.projectId);
    await lockFrozenSource(client, input.projectId, input.revisionId);
    const revision = await lockedRevision(client, input.projectId, input.batchId, input.revisionId);
    requireExpectedVersion(revision, input.resourceVersion);
    requireDraftOwner(revision, input.actorId);
    const membership = await activeMembership(client, input.projectId, input.actorId, "ENGINEER");
    assertAuthorization(input, PERMISSIONS.PROJECT_UPH_BATCH_MANAGE, input.projectId, [
      membership.role
    ]);
    const gross = positiveSafeInteger(
      input.body.actualGrossOutputCount,
      "actualGrossOutputCount",
      true
    );
    const finalGood = positiveSafeInteger(
      input.body.finalGoodOutputCount,
      "finalGoodOutputCount",
      true
    );
    if (finalGood > gross)
      throw new UphTestBatchServiceError(
        "ROOT_PRODUCTION_COUNT_INVALID",
        "最终良品数不得超过毛产出。",
        422
      );
    await client.$executeRaw(
      Prisma.sql`INSERT INTO project_uph_test_batch_revision_production_counts
        (id, project_id, revision_id, actual_gross_output_count, final_good_output_count)
        VALUES (${randomUUID()}, ${input.projectId}, ${input.revisionId}, ${BigInt(gross)}, ${BigInt(finalGood)})
        ON CONFLICT (revision_id, project_id) DO UPDATE SET
          actual_gross_output_count = EXCLUDED.actual_gross_output_count,
          final_good_output_count = EXCLUDED.final_good_output_count`
    );
    const version = await bumpRoot(client, revision, input.resourceVersion, {
      currentWorkRevisionId: revision.currentWorkRevisionId,
      currentLockedRevisionId: revision.currentLockedRevisionId
    });
    const facts = await writeCommandFacts(client, input, {
      action: AUDIT_ACTIONS.UPH_TEST_BATCH_PRODUCTION_COUNT_UPDATED,
      objectType: AUDIT_OBJECT_TYPES.UPH_TEST_BATCH_REVISION,
      objectId: input.revisionId,
      eventType: "uph.test-batch.production-count.updated",
      aggregateId: input.revisionId,
      resourceVersion: version,
      payload: {
        projectId: input.projectId,
        batchId: input.batchId,
        revisionId: input.revisionId,
        status: revision.status,
        resourceVersion: version
      }
    });
    return {
      batchId: input.batchId,
      revisionId: input.revisionId,
      resourceVersion: version,
      ...facts
    };
  });
}

export async function updateUphTestBatchModuleQualityCount(
  input: RevisionCommandContext & {
    moduleId: string;
    body: {
      qualityInputCount: number;
      firstPassGoodCount: number;
      firstPassNonconformingCount: number;
      reworkInputCount: number;
      reworkRecoveredGoodCount: number;
    };
  },
  transaction?: Client
) {
  return command(transaction, async (client) => {
    assertActor(input);
    await projectLock(client, input.projectId);
    await lockFrozenSource(client, input.projectId, input.revisionId);
    const revision = await lockedRevision(client, input.projectId, input.batchId, input.revisionId);
    requireExpectedVersion(revision, input.resourceVersion);
    requireDraftOwner(revision, input.actorId);
    const membership = await activeMembership(client, input.projectId, input.actorId, "ENGINEER");
    assertAuthorization(input, PERMISSIONS.PROJECT_UPH_BATCH_MANAGE, input.projectId, [
      membership.role
    ]);
    const counts = {
      qualityInputCount: positiveSafeInteger(
        input.body.qualityInputCount,
        "qualityInputCount",
        true
      ),
      firstPassGoodCount: positiveSafeInteger(
        input.body.firstPassGoodCount,
        "firstPassGoodCount",
        true
      ),
      firstPassNonconformingCount: positiveSafeInteger(
        input.body.firstPassNonconformingCount,
        "firstPassNonconformingCount",
        true
      ),
      reworkInputCount: positiveSafeInteger(input.body.reworkInputCount, "reworkInputCount", true),
      reworkRecoveredGoodCount: positiveSafeInteger(
        input.body.reworkRecoveredGoodCount,
        "reworkRecoveredGoodCount",
        true
      )
    };
    if (
      counts.qualityInputCount !== counts.firstPassGoodCount + counts.firstPassNonconformingCount ||
      counts.reworkRecoveredGoodCount > counts.reworkInputCount ||
      counts.reworkInputCount > counts.firstPassNonconformingCount
    ) {
      throw new UphTestBatchServiceError(
        "MODULE_QUALITY_COUNT_INVALID",
        "模块质量计数不满足冻结等式。",
        422
      );
    }
    const binding = await rows<{ id: string }>(
      client,
      Prisma.sql`SELECT id FROM project_uph_test_batch_revision_module_bindings
        WHERE revision_id = ${input.revisionId} AND project_id = ${input.projectId}
          AND project_module_id = ${text(input.moduleId, "moduleId")} FOR UPDATE`
    );
    if (!binding[0])
      throw new UphTestBatchServiceError(
        "MODULE_BINDING_NOT_FOUND",
        "模块不属于该冻结批次范围。",
        404
      );
    await client.$executeRaw(
      Prisma.sql`UPDATE project_uph_test_batch_revision_module_bindings SET
        quality_input_count = ${BigInt(counts.qualityInputCount)}, first_pass_good_count = ${BigInt(counts.firstPassGoodCount)},
        first_pass_nonconforming_count = ${BigInt(counts.firstPassNonconformingCount)}, rework_input_count = ${BigInt(counts.reworkInputCount)},
        rework_recovered_good_count = ${BigInt(counts.reworkRecoveredGoodCount)}
        WHERE id = ${binding[0].id} AND revision_id = ${input.revisionId} AND project_id = ${input.projectId}`
    );
    const version = await bumpRoot(client, revision, input.resourceVersion, {
      currentWorkRevisionId: revision.currentWorkRevisionId,
      currentLockedRevisionId: revision.currentLockedRevisionId
    });
    const facts = await writeCommandFacts(client, input, {
      action: AUDIT_ACTIONS.UPH_TEST_BATCH_MODULE_QUALITY_COUNT_UPDATED,
      objectType: AUDIT_OBJECT_TYPES.UPH_TEST_BATCH_REVISION,
      objectId: input.revisionId,
      eventType: "uph.test-batch.module-quality-count.updated",
      aggregateId: input.revisionId,
      resourceVersion: version,
      payload: {
        projectId: input.projectId,
        batchId: input.batchId,
        revisionId: input.revisionId,
        status: revision.status,
        resourceVersion: version
      }
    });
    return {
      batchId: input.batchId,
      revisionId: input.revisionId,
      moduleBindingId: binding[0].id,
      resourceVersion: version,
      ...facts
    };
  });
}

export async function attachUphTestBatchEvidence(
  input: RevisionCommandContext & {
    body: { fileObjectId: string; purpose?: string; sampleId?: string };
  },
  transaction?: Client
) {
  return command(transaction, async (client) => {
    assertActor(input);
    const project = await projectLock(client, input.projectId);
    await lockFrozenSource(client, input.projectId, input.revisionId);
    const revision = await lockedRevision(client, input.projectId, input.batchId, input.revisionId);
    requireExpectedVersion(revision, input.resourceVersion);
    requireDraftOwner(revision, input.actorId);
    const membership = await activeMembership(client, input.projectId, input.actorId, "ENGINEER");
    assertAuthorization(input, PERMISSIONS.PROJECT_UPH_BATCH_MANAGE, input.projectId, [
      membership.role
    ]);
    const file = await rows<{
      id: string;
      sha256: string | null;
      status: string;
      storageArea: string;
      scannedAt: Date | null;
      sensitivity: "INTERNAL" | "RESTRICTED";
      uploadedById: string;
    }>(
      client,
      Prisma.sql`SELECT id, sha256, status::text AS status, storage_area::text AS "storageArea",
      scanned_at AS "scannedAt", sensitivity::text AS sensitivity, uploaded_by_id AS "uploadedById"
        FROM file_objects WHERE id = ${text(input.body.fileObjectId, "fileObjectId")} AND project_id = ${input.projectId}
        FOR UPDATE`
    );
    const evidenceFile = file[0];
    if (!evidenceFile)
      throw new UphTestBatchServiceError("FILE_OBJECT_NOT_FOUND", "证据文件不存在。", 404);
    if (
      evidenceFile.status !== "AVAILABLE" ||
      evidenceFile.storageArea !== "CONTROLLED" ||
      !evidenceFile.scannedAt ||
      !evidenceFile.sha256
    ) {
      throw new UphTestBatchServiceError("FILE_OBJECT_INELIGIBLE", "证据文件尚不可引用。", 422);
    }
    if (evidenceFile.sensitivity === "RESTRICTED") {
      const decision = decideAuthorization(
        asAuthorizationActor(input.authorizationActor),
        PERMISSIONS.SENSITIVE_FILE_READ,
        {
          projectId: input.projectId,
          resourceDepartmentId: project.departmentId,
          resourceOwnerId: evidenceFile.uploadedById,
          requireProjectMembership: true,
          memberRoles: [membership.role]
        }
      );
      if (!decision.allowed) {
        throw new UphTestBatchServiceError(
          "SENSITIVE_FILE_READ_DENIED",
          "无权引用受限证据文件。",
          403
        );
      }
      await writeAudit(client, {
        action: AUDIT_ACTIONS.SENSITIVE_FILE_READ,
        objectType: AUDIT_OBJECT_TYPES.FILE_OBJECT,
        objectId: evidenceFile.id,
        context: auditContext(input),
        after: {
          value: { projectId: input.projectId, fileObjectId: evidenceFile.id },
          allowedFields: ["projectId", "fileObjectId"]
        }
      });
    }
    if (input.body.sampleId) {
      const sample = await rows<{ id: string }>(
        client,
        Prisma.sql`SELECT id FROM project_uph_module_cycle_samples
          WHERE id = ${text(input.body.sampleId, "sampleId")} AND revision_id = ${input.revisionId} AND project_id = ${input.projectId}`
      );
      if (!sample[0])
        throw new UphTestBatchServiceError("CYCLE_SAMPLE_NOT_FOUND", "证据样本不属于该修订。", 404);
    }
    const purpose = input.body.purpose ?? null;
    if (
      purpose !== null &&
      ![
        "ROOT_PRODUCTION",
        "MODULE_QUALITY",
        "CYCLE_SAMPLE",
        "PROTOCOL",
        "OBSERVATION_WINDOW"
      ].includes(purpose)
    ) {
      throw new UphTestBatchServiceError("VALIDATION_FAILED", "证据purpose无效。", 422);
    }
    const evidenceId = randomUUID();
    await client.$executeRaw(
      Prisma.sql`INSERT INTO project_uph_test_batch_revision_evidence
        (id, project_id, revision_id, file_object_id, sample_id, purpose, file_sha256, sensitivity)
        VALUES (${evidenceId}, ${input.projectId}, ${input.revisionId}, ${evidenceFile.id}, ${input.body.sampleId ?? null},
          ${purpose}::"UphTestBatchEvidencePurpose", ${evidenceFile.sha256}, ${evidenceFile.sensitivity}::"FileSensitivity")`
    );
    const version = await bumpRoot(client, revision, input.resourceVersion, {
      currentWorkRevisionId: revision.currentWorkRevisionId,
      currentLockedRevisionId: revision.currentLockedRevisionId
    });
    const facts = await writeCommandFacts(client, input, {
      action: AUDIT_ACTIONS.UPH_TEST_BATCH_EVIDENCE_REFERENCED,
      objectType: AUDIT_OBJECT_TYPES.UPH_TEST_BATCH_EVIDENCE,
      objectId: evidenceId,
      eventType: "uph.test-batch.evidence.referenced",
      aggregateId: input.revisionId,
      resourceVersion: version,
      payload: {
        projectId: input.projectId,
        batchId: input.batchId,
        revisionId: input.revisionId,
        status: revision.status,
        resourceVersion: version
      }
    });
    return {
      id: evidenceId,
      evidenceId,
      batchId: input.batchId,
      revisionId: input.revisionId,
      resourceVersion: version,
      ...facts
    };
  });
}

async function promoteConfirmed(
  client: Client,
  revision: RevisionFacts,
  membership: MembershipFacts
) {
  const now = await databaseNow(client);
  const changed = await client.$executeRaw(
    Prisma.sql`WITH snapshot AS (
      SELECT "uph_test_batch_confirmed_input_snapshot"(revision) AS value
      FROM project_uph_test_batch_revisions revision
      WHERE revision.id = ${revision.revisionId} AND revision.project_id = ${revision.projectId}
    ), checks AS (
      SELECT value, "uph_test_batch_checksum"(value) AS checksum FROM snapshot
    ) UPDATE project_uph_test_batch_revisions revision SET
      status = 'PM_CONFIRMED'::"UphTestBatchRevisionStatus",
      pm_confirmer_membership_id = ${membership.id}, pm_confirmer_user_id = ${membership.userId},
      pm_confirmer_role = 'PROJECT_MANAGER'::"ProjectRole", pm_confirmed_at = ${now},
      confirmed_input_snapshot_json = checks.value, confirmed_input_checksum = checks.checksum,
      pm_confirmer_snapshot_json = "uph_test_batch_responsibility_snapshot"(
        ${membership.id}, ${membership.userId}, 'PROJECT_MANAGER'::"ProjectRole", ${now}, checks.checksum
      ),
      pm_confirmer_checksum = "uph_test_batch_responsibility_checksum"(
        ${membership.id}, ${membership.userId}, 'PROJECT_MANAGER'::"ProjectRole", ${now}, checks.checksum
      ), resource_version = resource_version + 1
      FROM checks WHERE revision.id = ${revision.revisionId} AND revision.project_id = ${revision.projectId}
        AND revision.status = 'DRAFT'::"UphTestBatchRevisionStatus"`
  );
  if (changed !== 1)
    throw new UphTestBatchServiceError("PM_CONFIRMATION_INVALID", "修订无法确认。", 409);
}

export async function confirmUphTestBatch(input: RevisionCommandContext, transaction?: Client) {
  return command(transaction, async (client) => {
    assertActor(input);
    await projectLock(client, input.projectId);
    await lockFrozenSource(client, input.projectId, input.revisionId);
    const revision = await lockedRevision(client, input.projectId, input.batchId, input.revisionId);
    requireExpectedVersion(revision, input.resourceVersion);
    if (revision.status !== "DRAFT" || revision.currentWorkRevisionId !== revision.revisionId) {
      throw new UphTestBatchServiceError(
        "PM_CONFIRMATION_INVALID",
        "仅当前DRAFT修订可由PM确认。",
        409
      );
    }
    if (revision.processOwnerUserId === input.actorId) {
      throw new UphTestBatchServiceError(
        "RESPONSIBILITY_INDEPENDENCE_REQUIRED",
        "PM确认人必须独立于工艺负责人。",
        403
      );
    }
    const membership = await activeMembership(
      client,
      input.projectId,
      input.actorId,
      "PROJECT_MANAGER"
    );
    assertAuthorization(input, PERMISSIONS.PROJECT_UPH_BATCH_CONFIRM, input.projectId, [
      membership.role
    ]);
    await promoteConfirmed(client, revision, membership);
    const version = await bumpRoot(client, revision, input.resourceVersion, {
      currentWorkRevisionId: revision.revisionId,
      currentLockedRevisionId: revision.currentLockedRevisionId
    });
    const response = await responseForRevision(
      client,
      input.projectId,
      input.batchId,
      input.revisionId
    );
    const facts = await writeCommandFacts(client, input, {
      action: AUDIT_ACTIONS.UPH_TEST_BATCH_PM_CONFIRMED,
      objectType: AUDIT_OBJECT_TYPES.UPH_TEST_BATCH_REVISION,
      objectId: input.revisionId,
      eventType: "uph.test-batch.pm-confirmed",
      aggregateId: input.revisionId,
      resourceVersion: version,
      payload: {
        projectId: input.projectId,
        batchId: input.batchId,
        revisionId: input.revisionId,
        status: response.status,
        resourceVersion: version
      }
    });
    return { ...response, resourceVersion: version, ...facts };
  });
}

async function promoteLocked(client: Client, revision: RevisionFacts, membership: MembershipFacts) {
  await client.$executeRaw(
    Prisma.sql`UPDATE project_uph_test_batch_revision_module_bindings binding SET
      valid_sample_count = rebuilt.valid_sample_count, excluded_sample_count = rebuilt.excluded_sample_count,
      arithmetic_mean_seconds = rebuilt.arithmetic_mean_seconds, p50_seconds = rebuilt.p50_seconds,
      p90_seconds = rebuilt.p90_seconds, max_seconds = rebuilt.max_seconds,
      spread_p90_minus_p50_seconds = rebuilt.spread_p90_minus_p50_seconds
      FROM "uph_test_batch_rebuilt_module_statistics"((
        SELECT revision FROM project_uph_test_batch_revisions revision
        WHERE revision.id = ${revision.revisionId} AND revision.project_id = ${revision.projectId}
      )) rebuilt
      WHERE binding.id = rebuilt.binding_id AND binding.revision_id = ${revision.revisionId}
        AND binding.project_id = ${revision.projectId}`
  );
  const now = await databaseNow(client);
  const changed = await client.$executeRaw(
    Prisma.sql`WITH stats AS (
      SELECT "uph_test_batch_statistics_snapshot"(revision) AS value, revision.confirmed_input_checksum AS "confirmedInputChecksum"
      FROM project_uph_test_batch_revisions revision
      WHERE revision.id = ${revision.revisionId} AND revision.project_id = ${revision.projectId}
    ), checks AS (
      SELECT value, "confirmedInputChecksum", "uph_test_batch_checksum"(value) AS "statisticsChecksum" FROM stats
    ), locked AS (
      SELECT jsonb_build_object('confirmedInputChecksum', "confirmedInputChecksum", 'statisticsChecksum', "statisticsChecksum") AS value,
        "statisticsChecksum" FROM checks
    ), final AS (
      SELECT checks.value AS "statisticsSnapshot", checks."statisticsChecksum", locked.value AS "lockedSnapshot",
        "uph_test_batch_checksum"(locked.value) AS "lockedChecksum" FROM checks JOIN locked ON true
    ) UPDATE project_uph_test_batch_revisions revision SET
      status = 'LOCKED'::"UphTestBatchRevisionStatus", quality_locker_membership_id = ${membership.id},
      quality_locker_user_id = ${membership.userId}, quality_locker_role = 'QUALITY'::"ProjectRole", locked_at = ${now},
      statistics_snapshot_json = final."statisticsSnapshot", statistics_checksum = final."statisticsChecksum",
      locked_snapshot_json = final."lockedSnapshot", locked_checksum = final."lockedChecksum",
      quality_locker_snapshot_json = "uph_test_batch_responsibility_snapshot"(
        ${membership.id}, ${membership.userId}, 'QUALITY'::"ProjectRole", ${now}, final."lockedChecksum"
      ),
      quality_locker_checksum = "uph_test_batch_responsibility_checksum"(
        ${membership.id}, ${membership.userId}, 'QUALITY'::"ProjectRole", ${now}, final."lockedChecksum"
      ), resource_version = resource_version + 1
      FROM final WHERE revision.id = ${revision.revisionId} AND revision.project_id = ${revision.projectId}
        AND revision.status = 'PM_CONFIRMED'::"UphTestBatchRevisionStatus"`
  );
  if (changed !== 1)
    throw new UphTestBatchServiceError("PM_CONFIRMATION_REQUIRED", "仅PM已确认修订可锁定。", 409);
}

async function supersedeCurrentLockedLineageAncestor(
  client: Client,
  revision: RevisionFacts
): Promise<void> {
  if (!revision.currentLockedRevisionId) return;
  const currentLocked = await rows<{ id: string; status: RevisionStatus }>(
    client,
    Prisma.sql`SELECT id, status::text AS status
      FROM project_uph_test_batch_revisions
      WHERE id = ${revision.currentLockedRevisionId} AND project_id = ${revision.projectId}
        AND batch_id = ${revision.batchId}
      FOR UPDATE`
  );
  if (currentLocked[0]?.status !== "LOCKED") {
    throw new UphTestBatchServiceError("LOCKED_LINEAGE_INVALID", "当前锁定修订状态不一致。", 409);
  }
  const lineage = await rows<{ isCurrentLockedAncestor: boolean }>(
    client,
    Prisma.sql`WITH RECURSIVE lineage AS (
      SELECT id, supersedes_revision_id
      FROM project_uph_test_batch_revisions
      WHERE id = ${revision.revisionId} AND project_id = ${revision.projectId}
      UNION ALL
      SELECT predecessor.id, predecessor.supersedes_revision_id
      FROM project_uph_test_batch_revisions predecessor
      JOIN lineage ON lineage.supersedes_revision_id = predecessor.id
      WHERE predecessor.project_id = ${revision.projectId}
    ) SELECT EXISTS(
      SELECT 1 FROM lineage WHERE id = ${revision.currentLockedRevisionId}
    ) AS "isCurrentLockedAncestor"`
  );
  if (!lineage[0]?.isCurrentLockedAncestor) {
    throw new UphTestBatchServiceError(
      "LOCKED_LINEAGE_INVALID",
      "锁定后继必须继承当前锁定修订的谱系。",
      409
    );
  }
  const changed = await client.$executeRaw(
    Prisma.sql`UPDATE project_uph_test_batch_revisions
      SET status = 'SUPERSEDED'::"UphTestBatchRevisionStatus", resource_version = resource_version + 1
      WHERE id = ${revision.currentLockedRevisionId} AND project_id = ${revision.projectId}
        AND batch_id = ${revision.batchId} AND status = 'LOCKED'::"UphTestBatchRevisionStatus"`
  );
  if (changed !== 1) {
    throw new UphTestBatchServiceError("RESOURCE_VERSION_CONFLICT", "锁定修订已变化。", 409);
  }
}

export async function lockUphTestBatch(input: RevisionCommandContext, transaction?: Client) {
  return command(transaction, async (client) => {
    assertActor(input);
    await projectLock(client, input.projectId);
    await lockFrozenSource(client, input.projectId, input.revisionId);
    const revision = await lockedRevision(client, input.projectId, input.batchId, input.revisionId);
    requireExpectedVersion(revision, input.resourceVersion);
    if (
      revision.status !== "PM_CONFIRMED" ||
      revision.currentWorkRevisionId !== revision.revisionId
    ) {
      throw new UphTestBatchServiceError(
        "PM_CONFIRMATION_REQUIRED",
        "仅当前PM已确认修订可锁定。",
        409
      );
    }
    if (
      input.actorId === revision.processOwnerUserId ||
      input.actorId === revision.pmConfirmerUserId
    ) {
      throw new UphTestBatchServiceError(
        "RESPONSIBILITY_INDEPENDENCE_REQUIRED",
        "质量锁定人必须独立于工艺和PM。",
        403
      );
    }
    const membership = await activeMembership(client, input.projectId, input.actorId, "QUALITY");
    assertAuthorization(input, PERMISSIONS.PROJECT_UPH_BATCH_LOCK, input.projectId, [
      membership.role
    ]);
    await supersedeCurrentLockedLineageAncestor(client, revision);
    await promoteLocked(client, revision, membership);
    const version = await bumpRoot(client, revision, input.resourceVersion, {
      currentWorkRevisionId: null,
      currentLockedRevisionId: input.revisionId
    });
    const response = await responseForRevision(
      client,
      input.projectId,
      input.batchId,
      input.revisionId
    );
    const facts = await writeCommandFacts(client, input, {
      action: AUDIT_ACTIONS.UPH_TEST_BATCH_LOCKED,
      objectType: AUDIT_OBJECT_TYPES.UPH_TEST_BATCH_REVISION,
      objectId: input.revisionId,
      eventType: "uph.test-batch.locked",
      aggregateId: input.revisionId,
      resourceVersion: version,
      payload: {
        projectId: input.projectId,
        batchId: input.batchId,
        revisionId: input.revisionId,
        status: response.status,
        resourceVersion: version
      }
    });
    return { ...response, resourceVersion: version, ...facts };
  });
}

async function insertSuccessor(
  client: Client,
  input: RevisionCommandContext & { reason: string },
  predecessor: RevisionFacts
): Promise<string> {
  const newRevisionId = randomUUID();
  const now = await databaseNow(client);
  const membership = await activeMembership(client, input.projectId, input.actorId, "ENGINEER");
  const copied = await rows<{
    revisionNumber: number;
    topologyVersionId: string;
    topologyRootNodeId: string;
    formulaVersionId: string;
    planDeclarationReason: string;
    plannedProductionSeconds: bigint;
    planSnapshot: unknown;
    planChecksum: string;
    planDeclaredAt: Date;
    observationStartedAt: Date;
    observationEndedAt: Date | null;
    timezone: string;
    protocolSnapshot: unknown;
    protocolChecksum: string;
    sourceSnapshot: unknown;
    sourceWatermark: string;
    sourceChecksum: string;
  }>(
    client,
    Prisma.sql`SELECT revision_number AS "revisionNumber", topology_version_id AS "topologyVersionId",
      topology_root_node_id AS "topologyRootNodeId", formula_version_id AS "formulaVersionId",
      plan_declaration_reason AS "planDeclarationReason", planned_production_seconds AS "plannedProductionSeconds",
      plan_snapshot_json AS "planSnapshot", plan_checksum AS "planChecksum", plan_declared_at AS "planDeclaredAt",
      observation_started_at AS "observationStartedAt", observation_ended_at AS "observationEndedAt", timezone,
      protocol_snapshot_json AS "protocolSnapshot", protocol_checksum AS "protocolChecksum",
      source_binding_snapshot_json AS "sourceSnapshot", source_watermark AS "sourceWatermark", source_checksum AS "sourceChecksum"
      FROM project_uph_test_batch_revisions WHERE id = ${predecessor.revisionId} AND project_id = ${input.projectId}`
  );
  const raw = copied[0];
  if (!raw)
    throw new UphTestBatchServiceError("TEST_BATCH_REVISION_NOT_FOUND", "前序修订不存在。", 404);
  await client.$executeRaw(
    Prisma.sql`INSERT INTO project_uph_test_batch_revisions (
      id, project_id, batch_id, revision_number, supersedes_revision_id, status, resource_version,
      topology_version_id, topology_root_node_id, formula_version_id,
      plan_declaration_reason, planned_production_seconds, plan_snapshot_json, plan_checksum, plan_declared_at,
      observation_started_at, observation_ended_at, timezone, test_protocol_code, test_protocol_version,
      protocol_snapshot_json, protocol_checksum, source_binding_snapshot_json, source_watermark, source_checksum,
      process_owner_membership_id, process_owner_user_id, process_owner_role,
      process_owner_snapshot_json, process_owner_checksum, created_by_id, created_at
    ) VALUES (
      ${newRevisionId}, ${input.projectId}, ${input.batchId}, ${raw.revisionNumber + 1}, ${predecessor.revisionId},
      'DRAFT'::"UphTestBatchRevisionStatus", 1, ${raw.topologyVersionId}, ${raw.topologyRootNodeId}, ${raw.formulaVersionId},
      ${raw.planDeclarationReason}, ${raw.plannedProductionSeconds}, ${json(raw.planSnapshot)}, ${raw.planChecksum}, ${raw.planDeclaredAt},
      ${raw.observationStartedAt}, ${raw.observationEndedAt}, ${raw.timezone}, 'UPH_TEST_PROTOCOL', 1,
      ${json(raw.protocolSnapshot)}, ${raw.protocolChecksum}, ${json(raw.sourceSnapshot)}, ${raw.sourceWatermark}, ${raw.sourceChecksum},
      ${membership.id}, ${input.actorId}, 'ENGINEER'::"ProjectRole",
      "uph_test_batch_responsibility_snapshot"(${membership.id}, ${input.actorId}, 'ENGINEER'::"ProjectRole", ${now}, NULL),
      "uph_test_batch_responsibility_checksum"(${membership.id}, ${input.actorId}, 'ENGINEER'::"ProjectRole", ${now}, NULL),
      ${input.actorId}, ${now}
    )`
  );
  const bindings = await rows<
    BindingFacts & {
      qualityInputCount: bigint | null;
      firstPassGoodCount: bigint | null;
      firstPassNonconformingCount: bigint | null;
      reworkInputCount: bigint | null;
      reworkRecoveredGoodCount: bigint | null;
    }
  >(
    client,
    Prisma.sql`SELECT id, project_module_id AS "projectModuleId", ct_definition_id AS "ctDefinitionId",
      ct_version_id AS "ctVersionId", ct_source_snapshot_json AS "ctSnapshot",
      ct_source_checksum AS "ctChecksum", ct_source_watermark AS "ctWatermark",
      quality_input_count AS "qualityInputCount", first_pass_good_count AS "firstPassGoodCount",
      first_pass_nonconforming_count AS "firstPassNonconformingCount", rework_input_count AS "reworkInputCount",
      rework_recovered_good_count AS "reworkRecoveredGoodCount"
      FROM project_uph_test_batch_revision_module_bindings
      WHERE revision_id = ${predecessor.revisionId} AND project_id = ${input.projectId}
      ORDER BY project_module_id, id`
  );
  const bindingMap = new Map<string, string>();
  for (const binding of bindings) {
    const id = randomUUID();
    bindingMap.set(binding.id, id);
    await client.$executeRaw(
      Prisma.sql`INSERT INTO project_uph_test_batch_revision_module_bindings
        (id, project_id, revision_id, project_module_id, ct_definition_id, ct_version_id,
         ct_source_snapshot_json, ct_source_checksum, ct_source_watermark,
         quality_input_count, first_pass_good_count, first_pass_nonconforming_count,
         rework_input_count, rework_recovered_good_count)
        VALUES (${id}, ${input.projectId}, ${newRevisionId}, ${binding.projectModuleId}, ${binding.ctDefinitionId},
          ${binding.ctVersionId}, ${json(binding.ctSnapshot)}, ${binding.ctChecksum}, ${binding.ctWatermark},
          ${binding.qualityInputCount}, ${binding.firstPassGoodCount}, ${binding.firstPassNonconformingCount},
          ${binding.reworkInputCount}, ${binding.reworkRecoveredGoodCount})`
    );
  }
  const production = await rows<{ gross: bigint; finalGood: bigint }>(
    client,
    Prisma.sql`SELECT actual_gross_output_count AS gross, final_good_output_count AS "finalGood"
      FROM project_uph_test_batch_revision_production_counts
      WHERE revision_id = ${predecessor.revisionId} AND project_id = ${input.projectId}`
  );
  if (production[0]) {
    await client.$executeRaw(
      Prisma.sql`INSERT INTO project_uph_test_batch_revision_production_counts
        (id, project_id, revision_id, actual_gross_output_count, final_good_output_count)
        VALUES (${randomUUID()}, ${input.projectId}, ${newRevisionId}, ${production[0].gross}, ${production[0].finalGood})`
    );
  }
  const samples = await rows<{
    id: string;
    moduleBindingId: string;
    ordinal: number;
    correctionOfSampleId: string | null;
    sourceEventId: string | null;
    cycleDurationSeconds: string;
    observedAt: Date;
    recordedAt: Date;
    captureMethod: SampleCaptureMethod;
    capturedByMembershipId: string;
    capturedByUserId: string;
    capturedByRole: ProjectRole;
    capturedBySnapshot: unknown;
    capturedByChecksum: string;
    disposition: SampleDisposition;
    exclusionReasonCode: ExclusionReasonCode | null;
  }>(
    client,
    Prisma.sql`SELECT id, module_binding_id AS "moduleBindingId", ordinal, correction_of_sample_id AS "correctionOfSampleId",
      source_event_id AS "sourceEventId", cycle_duration_seconds::text AS "cycleDurationSeconds", observed_at AS "observedAt",
      recorded_at AS "recordedAt", capture_method::text AS "captureMethod",
      captured_by_membership_id AS "capturedByMembershipId", captured_by_user_id AS "capturedByUserId",
      captured_by_role::text AS "capturedByRole", captured_by_snapshot_json AS "capturedBySnapshot",
      captured_by_checksum AS "capturedByChecksum", disposition::text AS disposition,
      exclusion_reason_code::text AS "exclusionReasonCode"
      FROM project_uph_module_cycle_samples WHERE revision_id = ${predecessor.revisionId} AND project_id = ${input.projectId}
      ORDER BY ordinal, id`
  );
  const sampleMap = new Map(samples.map((sample) => [sample.id, randomUUID()]));
  for (const sample of samples) {
    const newSampleId = sampleMap.get(sample.id);
    if (!newSampleId) throw new Error("样本复制标识缺失。");
    await client.$executeRaw(
      Prisma.sql`INSERT INTO project_uph_module_cycle_samples (
        id, project_id, revision_id, module_binding_id, ordinal, correction_of_sample_id, source_event_id,
        cycle_duration_seconds, observed_at, recorded_at, capture_method,
        captured_by_membership_id, captured_by_user_id, captured_by_role, captured_by_snapshot_json, captured_by_checksum,
        disposition, exclusion_reason_code
      ) VALUES (${newSampleId}, ${input.projectId}, ${newRevisionId}, ${bindingMap.get(sample.moduleBindingId) ?? ""},
        ${sample.ordinal}, ${sample.correctionOfSampleId ? (sampleMap.get(sample.correctionOfSampleId) ?? null) : null},
        ${sample.sourceEventId}, ${sample.cycleDurationSeconds}::numeric, ${sample.observedAt}, ${sample.recordedAt},
        ${sample.captureMethod}::"UphTestBatchSampleCaptureMethod", ${sample.capturedByMembershipId}, ${sample.capturedByUserId},
        ${sample.capturedByRole}::"ProjectRole", ${json(sample.capturedBySnapshot)}, ${sample.capturedByChecksum},
        ${sample.disposition}::"UphTestBatchSampleDisposition", ${sample.exclusionReasonCode}::"UphTestBatchExclusionReasonCode")`
    );
  }
  const evidence = await rows<{
    fileObjectId: string;
    sampleId: string | null;
    purpose: EvidencePurpose | null;
    sha: string;
    sensitivity: "INTERNAL" | "RESTRICTED";
  }>(
    client,
    Prisma.sql`SELECT file_object_id AS "fileObjectId", sample_id AS "sampleId", purpose::text AS purpose,
      file_sha256 AS sha, sensitivity::text AS sensitivity
      FROM project_uph_test_batch_revision_evidence WHERE revision_id = ${predecessor.revisionId} AND project_id = ${input.projectId}
      ORDER BY id`
  );
  for (const item of evidence) {
    await client.$executeRaw(
      Prisma.sql`INSERT INTO project_uph_test_batch_revision_evidence
        (id, project_id, revision_id, file_object_id, sample_id, purpose, file_sha256, sensitivity)
        VALUES (${randomUUID()}, ${input.projectId}, ${newRevisionId}, ${item.fileObjectId},
          ${item.sampleId ? (sampleMap.get(item.sampleId) ?? null) : null}, ${item.purpose}::"UphTestBatchEvidencePurpose",
          ${item.sha}, ${item.sensitivity}::"FileSensitivity")`
    );
  }
  return newRevisionId;
}

export async function replaceUphTestBatchRevision(
  input: RevisionCommandContext & { reason?: string; body?: { reason?: string } },
  transaction?: Client
) {
  return command(transaction, async (client) => {
    assertActor(input);
    await projectLock(client, input.projectId);
    await lockFrozenSource(client, input.projectId, input.revisionId);
    const predecessor = await lockedRevision(
      client,
      input.projectId,
      input.batchId,
      input.revisionId
    );
    requireExpectedVersion(predecessor, input.resourceVersion);
    if (
      (predecessor.status !== "PM_CONFIRMED" && predecessor.status !== "LOCKED") ||
      predecessor.processOwnerUserId !== input.actorId
    ) {
      throw new UphTestBatchServiceError(
        "REVISION_REPLACEMENT_INVALID",
        "仅工艺负责人可对已确认或锁定修订创建受控后继。",
        409
      );
    }
    const membership = await activeMembership(client, input.projectId, input.actorId, "ENGINEER");
    assertAuthorization(input, PERMISSIONS.PROJECT_UPH_BATCH_MANAGE, input.projectId, [
      membership.role
    ]);
    const reason = text(input.reason ?? input.body?.reason, "reason", 1024);
    if (predecessor.status === "PM_CONFIRMED") {
      const superseded = await client.$executeRaw(
        Prisma.sql`UPDATE project_uph_test_batch_revisions
          SET status = 'SUPERSEDED'::"UphTestBatchRevisionStatus", resource_version = resource_version + 1
          WHERE id = ${predecessor.revisionId} AND project_id = ${input.projectId}
            AND status = 'PM_CONFIRMED'::"UphTestBatchRevisionStatus"`
      );
      if (superseded !== 1) {
        throw new UphTestBatchServiceError("RESOURCE_VERSION_CONFLICT", "前序修订已变化。", 409);
      }
    }
    const successorId = await insertSuccessor(client, { ...input, reason }, predecessor);
    const version = await bumpRoot(client, predecessor, input.resourceVersion, {
      currentWorkRevisionId: successorId,
      currentLockedRevisionId:
        predecessor.status === "LOCKED"
          ? predecessor.revisionId
          : predecessor.currentLockedRevisionId
    });
    const response = await responseForRevision(client, input.projectId, input.batchId, successorId);
    const facts = await writeCommandFacts(client, input, {
      action: AUDIT_ACTIONS.UPH_TEST_BATCH_REVISION_REPLACED,
      objectType: AUDIT_OBJECT_TYPES.UPH_TEST_BATCH_REVISION,
      objectId: successorId,
      eventType: "uph.test-batch.revision.replaced",
      aggregateId: input.batchId,
      resourceVersion: version,
      payload: {
        projectId: input.projectId,
        batchId: input.batchId,
        revisionId: successorId,
        supersedesRevisionId: predecessor.revisionId,
        successorRevisionId: successorId,
        reason,
        status: response.status,
        resourceVersion: version
      },
      reason
    });
    return { ...response, revisionId: successorId, resourceVersion: version, ...facts };
  });
}
