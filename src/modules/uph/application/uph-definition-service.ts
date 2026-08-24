import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS, type PermissionCode } from "@/lib/auth/permissions";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import { AUDIT_ACTIONS, AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";

import { validateTopologyForest, type TopologyForest } from "../domain/uph-definition";
import type { UphDefinitionBody, UphPatchDefinitionBody } from "../contracts/uph-http";

type Client = Prisma.TransactionClient;
type Kind = UphDefinitionBody["kind"];
type RootFacts = {
  id: string;
  projectId: string;
  projectModuleId: string | null;
  currentWorkVersionId: string | null;
  currentPublishedVersionId: string | null;
  version: number;
};
type VersionFacts = RootFacts & {
  versionId: string;
  revision: number;
  status: "DRAFT" | "PUBLISHED" | "SUPERSEDED";
  resourceVersion: number;
  snapshotChecksum: string;
  sourceWatermark: string | null;
  commissioningSignedAt: Date | null;
  processOwnerMembershipId: string;
  processOwnerUserId: string;
  commissioningMembershipId: string | null;
  commissioningUserId: string | null;
  qualityPublisherMembershipId: string | null;
  qualityPublisherUserId: string | null;
};

export class UphDefinitionServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
  }
}

const ROOTS: Record<
  Kind,
  {
    rootTable: string;
    versionTable: string;
    rootColumn: string;
    objectType: string;
    versionObjectType: string;
  }
> = {
  TOPOLOGY: {
    rootTable: "project_uph_topologies",
    versionTable: "project_uph_topology_versions",
    rootColumn: "topology_id",
    objectType: AUDIT_OBJECT_TYPES.UPH_TOPOLOGY,
    versionObjectType: AUDIT_OBJECT_TYPES.UPH_TOPOLOGY_VERSION
  },
  CT: {
    rootTable: "project_uph_ct_definitions",
    versionTable: "project_uph_ct_definition_versions",
    rootColumn: "ct_definition_id",
    objectType: AUDIT_OBJECT_TYPES.UPH_CT_DEFINITION,
    versionObjectType: AUDIT_OBJECT_TYPES.UPH_CT_DEFINITION_VERSION
  },
  FORMULA: {
    rootTable: "project_uph_formulas",
    versionTable: "project_uph_formula_versions",
    rootColumn: "formula_id",
    objectType: AUDIT_OBJECT_TYPES.UPH_FORMULA,
    versionObjectType: AUDIT_OBJECT_TYPES.UPH_FORMULA_VERSION
  }
};

const auditFields = [
  "projectId",
  "kind",
  "rootId",
  "versionId",
  "revision",
  "status",
  "resourceVersion",
  "snapshotChecksum",
  "sourceWatermark",
  "reason",
  "actorId",
  "processOwnerMembershipId",
  "commissioningMembershipId",
  "qualityPublisherMembershipId"
] as const;

function table(value: string) {
  return Prisma.raw(`"${value}"`);
}

function json(value: JsonValue) {
  return Prisma.sql`${JSON.stringify(value)}::jsonb`;
}

function text(value: unknown, field: string, max = 191): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new UphDefinitionServiceError("VALIDATION_FAILED", `${field}格式无效。`, 422);
  }
  return value.trim();
}

function positive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new UphDefinitionServiceError("VALIDATION_FAILED", `${field}必须为正数。`, 422);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = positive(value, field);
  if (!Number.isInteger(parsed)) {
    throw new UphDefinitionServiceError("VALIDATION_FAILED", `${field}必须为正整数。`, 422);
  }
  return parsed;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UphDefinitionServiceError("VALIDATION_FAILED", `${field}必须是对象。`, 422);
  }
  return value as Record<string, unknown>;
}

async function rows<T>(client: Client, query: Prisma.Sql): Promise<T[]> {
  return client.$queryRaw<T[]>(query);
}

async function databaseNow(client: Client): Promise<Date> {
  const result = await rows<{ now: Date }>(client, Prisma.sql`SELECT CURRENT_TIMESTAMP AS now`);
  if (!result[0]) throw new Error("无法读取数据库时间。");
  return result[0].now;
}

type ProjectFacts = {
  id: string;
  status: string;
  department_id: string | null;
  equipment_shape: string | null;
  structure_status: string;
};

async function projectLock(client: Client, projectId: string): Promise<ProjectFacts> {
  const result = await rows<ProjectFacts>(
    client,
    Prisma.sql`SELECT id, status, department_id, equipment_shape::text AS equipment_shape, structure_status::text AS structure_status FROM projects WHERE id = ${projectId} FOR NO KEY UPDATE`
  );
  const project = result[0];
  if (!project) throw new UphDefinitionServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  if (project.status === "CLOSED" || project.status === "CANCELED") {
    throw new UphDefinitionServiceError(
      "PROJECT_READ_ONLY",
      "已关闭或取消项目不可修改UPH定义。",
      409
    );
  }
  if (project.structure_status !== "READY") {
    throw new UphDefinitionServiceError("PROJECT_STRUCTURE_NOT_READY", "项目结构尚未就绪。", 409);
  }
  const capability = await rows<{
    selected_enabled: boolean;
    template_allowed: boolean;
    company_enabled: boolean;
  }>(
    client,
    Prisma.sql`SELECT pc.selected_enabled, pc.template_allowed, cc.enabled AS company_enabled FROM project_capabilities pc JOIN company_capabilities cc ON cc.code = pc.capability_code WHERE pc.project_id = ${projectId} AND pc.capability_code = 'UPH_ANALYSIS'::"CapabilityCode"`
  );
  if (
    !capability[0]?.selected_enabled ||
    !capability[0]?.template_allowed ||
    !capability[0]?.company_enabled
  ) {
    throw new UphDefinitionServiceError("UPH_CAPABILITY_REQUIRED", "项目未启用UPH分析能力。", 409);
  }
  return project;
}

async function actorMembership(
  client: Client,
  projectId: string,
  actorId: string,
  role: "ENGINEER" | "QUALITY"
) {
  const result = await rows<{
    id: string;
    user_id: string;
    project_role: "ENGINEER" | "QUALITY";
    department_id: string | null;
    version: number;
  }>(
    client,
    Prisma.sql`SELECT pm.id, pm.user_id, pm.project_role, pm.department_id, pm.version
      FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ${projectId} AND pm.user_id = ${actorId} AND pm.project_role = ${role}::"ProjectRole"
        AND pm.left_at IS NULL AND u.status = 'ACTIVE'
      ORDER BY pm.id LIMIT 1 FOR UPDATE`
  );
  if (!result[0])
    throw new UphDefinitionServiceError(
      "PROJECT_ROLE_REQUIRED",
      "当前成员角色不满足UPH操作。",
      403
    );
  return result[0];
}

async function loadRoot(
  client: Client,
  kind: Kind,
  projectId: string,
  projectModuleId?: string
): Promise<RootFacts | null> {
  if (kind === "CT" && !projectModuleId)
    throw new UphDefinitionServiceError("PROJECT_MODULE_REQUIRED", "CT定义必须指定项目模块。", 422);
  const spec = ROOTS[kind];
  const moduleProjection =
    kind === "CT"
      ? Prisma.sql`project_module_id AS "projectModuleId"`
      : Prisma.sql`NULL::text AS "projectModuleId"`;
  const modulePredicate =
    kind === "CT" ? Prisma.sql`AND project_module_id = ${projectModuleId}` : Prisma.empty;
  const result = await rows<RootFacts>(
    client,
    Prisma.sql`SELECT id, project_id AS "projectId", ${moduleProjection}, current_work_version_id AS "currentWorkVersionId", current_published_version_id AS "currentPublishedVersionId", version
      FROM ${table(spec.rootTable)} WHERE project_id = ${projectId} ${modulePredicate}`
  );
  return result[0] ?? null;
}

type SourceLockKey = {
  sourceType: "DELIVERY_UNIT" | "PROJECT_MODULE";
  stableId: string;
};

async function lockUphStructureSources(
  client: Client,
  projectId: string,
  requested?: SourceLockKey[]
): Promise<void> {
  const planned = requested
    ? requested
    : [
        ...(
          await rows<{ id: string }>(
            client,
            Prisma.sql`SELECT id FROM delivery_units WHERE project_id = ${projectId}`
          )
        ).map((row) => ({ sourceType: "DELIVERY_UNIT" as const, stableId: row.id })),
        ...(
          await rows<{ id: string }>(
            client,
            Prisma.sql`SELECT id FROM project_modules WHERE project_id = ${projectId}`
          )
        ).map((row) => ({ sourceType: "PROJECT_MODULE" as const, stableId: row.id }))
      ];
  const sourceKeys = [
    ...new Map(planned.map((key) => [`${key.sourceType}:${key.stableId}`, key])).values()
  ].sort(
    (left, right) =>
      left.sourceType.localeCompare(right.sourceType) || left.stableId.localeCompare(right.stableId)
  );
  for (const { sourceType, stableId } of sourceKeys) {
    if (sourceType === "DELIVERY_UNIT") {
      await rows(
        client,
        Prisma.sql`SELECT id FROM delivery_units WHERE id = ${stableId} AND project_id = ${projectId} FOR UPDATE`
      );
    } else {
      await rows(
        client,
        Prisma.sql`SELECT id FROM project_modules WHERE id = ${stableId} AND project_id = ${projectId} FOR UPDATE`
      );
    }
  }
}

async function lockUphRootAndVersion(
  client: Client,
  kind: Kind,
  projectId: string,
  targetVersionId?: string,
  projectModuleId?: string
): Promise<RootFacts | null> {
  if (kind === "CT" && !projectModuleId)
    throw new UphDefinitionServiceError("PROJECT_MODULE_REQUIRED", "CT定义必须指定项目模块。", 422);
  const spec = ROOTS[kind];
  const moduleProjection =
    kind === "CT"
      ? Prisma.sql`project_module_id AS "projectModuleId"`
      : Prisma.sql`NULL::text AS "projectModuleId"`;
  const modulePredicate =
    kind === "CT" ? Prisma.sql`AND project_module_id = ${projectModuleId}` : Prisma.empty;
  const root = (
    await rows<RootFacts>(
      client,
      Prisma.sql`SELECT id, project_id AS "projectId", ${moduleProjection}, current_work_version_id AS "currentWorkVersionId", current_published_version_id AS "currentPublishedVersionId", version FROM ${table(spec.rootTable)} WHERE project_id = ${projectId} ${modulePredicate} FOR UPDATE`
    )
  )[0];
  if (!root) return null;

  const currentWorkVersionId = root.currentWorkVersionId;
  const currentPublishedVersionId = root.currentPublishedVersionId;
  const versionIds = [
    ...new Set([currentWorkVersionId, currentPublishedVersionId, targetVersionId].filter(Boolean))
  ].sort();
  if (versionIds.length) {
    await rows(
      client,
      Prisma.sql`SELECT id FROM ${table(spec.versionTable)} WHERE ${table(spec.rootColumn)} = ${root.id} AND project_id = ${projectId} AND id IN (${Prisma.join(versionIds.map((id) => Prisma.sql`${id}`))}) ORDER BY id FOR UPDATE`
    );
  }
  if (kind === "CT") {
    await lockUphStructureSources(client, projectId, [
      { sourceType: "PROJECT_MODULE", stableId: root.projectModuleId! }
    ]);
  }
  if (kind === "TOPOLOGY") await lockUphStructureSources(client, projectId);
  return root;
}

async function locateCtRootByVersion(
  client: Client,
  projectId: string,
  versionId: string
): Promise<{ rootId: string; projectModuleId: string }> {
  const result = await rows<{ rootId: string; projectModuleId: string }>(
    client,
    Prisma.sql`SELECT r.id AS "rootId", r.project_module_id AS "projectModuleId"
      FROM project_uph_ct_definition_versions v
      JOIN project_uph_ct_definitions r ON r.id = v.ct_definition_id AND r.project_id = v.project_id
      WHERE v.id = ${versionId} AND v.project_id = ${projectId}`
  );
  if (!result[0])
    throw new UphDefinitionServiceError("UPH_VERSION_NOT_FOUND", "UPH版本不存在。", 404);
  return result[0];
}

async function loadVersion(
  client: Client,
  kind: Kind,
  rootId: string,
  versionId: string
): Promise<VersionFacts | null> {
  const spec = ROOTS[kind];
  const commissioningSelect =
    kind === "FORMULA"
      ? Prisma.sql`NULL::timestamp AS "commissioningSignedAt"`
      : Prisma.sql`v.commissioning_signed_at AS "commissioningSignedAt"`;
  const sourceWatermarkSelect =
    kind === "FORMULA"
      ? Prisma.sql`NULL::text AS "sourceWatermark"`
      : Prisma.sql`v.source_watermark AS "sourceWatermark"`;
  const commissioningFactsSelect =
    kind === "FORMULA"
      ? Prisma.sql`NULL::text AS "commissioningMembershipId", NULL::text AS "commissioningUserId"`
      : Prisma.sql`v.commissioning_membership_id AS "commissioningMembershipId", v.commissioning_user_id AS "commissioningUserId"`;
  const result = await rows<VersionFacts>(
    client,
    Prisma.sql`SELECT v.id AS "versionId", v.project_id AS "projectId", v.${table(spec.rootColumn)} AS "rootId", v.revision, v.status::text AS status, v.resource_version AS "resourceVersion", v.snapshot_checksum AS "snapshotChecksum", ${sourceWatermarkSelect}, v.process_owner_membership_id AS "processOwnerMembershipId", v.process_owner_user_id AS "processOwnerUserId", ${commissioningFactsSelect}, v.quality_publisher_membership_id AS "qualityPublisherMembershipId", v.quality_publisher_user_id AS "qualityPublisherUserId", ${commissioningSelect}, r.current_work_version_id AS "currentWorkVersionId", r.current_published_version_id AS "currentPublishedVersionId", r.version
      FROM ${table(spec.versionTable)} v JOIN ${table(spec.rootTable)} r ON r.id = v.${table(spec.rootColumn)} AND r.project_id = v.project_id
      WHERE v.${table(spec.rootColumn)} = ${rootId} AND v.id = ${versionId}`
  );
  return result[0] ?? null;
}

function topologyContent(content: Record<string, unknown>): {
  snapshot: TopologyForest & Record<string, unknown>;
  nodes: Array<Record<string, unknown>>;
  rootList: string[];
} {
  const snapshot = object(content, "content") as TopologyForest & Record<string, unknown>;
  for (const forbidden of ["nodes", "sourceWatermark", "groupKey", "parallelGroups"]) {
    if (forbidden in snapshot)
      throw new UphDefinitionServiceError(
        "VALIDATION_FAILED",
        `content.${forbidden}不属于APM-080合同。`,
        422
      );
  }
  const roots = Array.isArray(snapshot.roots)
    ? snapshot.roots.map((item) => object(item, "content.roots"))
    : [];
  if (!roots.length)
    throw new UphDefinitionServiceError("TOPOLOGY_ROOT_REQUIRED", "拓扑必须包含完整根集合。", 422);
  validateTopologyForest({ projectShape: snapshot.projectShape, roots: roots as never });
  const nodes: Array<Record<string, unknown>> = [];
  const visit = (node: Record<string, unknown>) => {
    for (const forbidden of [
      "groupKey",
      "parallelGroups",
      "ownerMembershipId",
      "signerMembershipId",
      "publisherMembershipId"
    ]) {
      if (forbidden in node)
        throw new UphDefinitionServiceError(
          "VALIDATION_FAILED",
          `拓扑节点不允许${forbidden}。`,
          422
        );
    }
    nodes.push(node);
    for (const child of Array.isArray(node.children) ? node.children : [])
      visit(object(child, "content.nodes.children"));
  };
  roots.forEach(visit);
  return {
    snapshot,
    nodes,
    rootList: roots.map((root) => text(root.sourceId, "content.roots.sourceId"))
  };
}

type SourceFact = {
  id: string;
  projectId: string;
  sourceType: "DELIVERY_UNIT" | "PROJECT_MODULE";
  parentId: string | null;
  deliveryUnitId: string | null;
  unitType: string | null;
  version: number;
  status: string;
  snapshot: JsonValue;
};

type SourceState = {
  facts: SourceFact[];
  watermark: string;
};

async function loadSourceState(
  client: Client,
  project: ProjectFacts,
  projectId: string,
  content: Record<string, unknown>
): Promise<SourceState> {
  const topology = topologyContent(content);
  await lockUphStructureSources(client, projectId);
  const deliveries = await rows<{
    id: string;
    project_id: string;
    parent_id: string | null;
    unit_type: string;
    status: string;
    version: number;
  }>(
    client,
    Prisma.sql`SELECT id, project_id, parent_id, unit_type::text AS unit_type, status::text AS status, version FROM delivery_units WHERE project_id = ${projectId} ORDER BY id`
  );
  const modules = await rows<{
    id: string;
    project_id: string;
    delivery_unit_id: string;
    status: string;
    version: number;
  }>(
    client,
    Prisma.sql`SELECT id, project_id, delivery_unit_id, status::text AS status, version FROM project_modules WHERE project_id = ${projectId} ORDER BY id`
  );
  const facts: SourceFact[] = [
    ...deliveries.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      sourceType: "DELIVERY_UNIT" as const,
      parentId: row.parent_id,
      deliveryUnitId: null,
      unitType: row.unit_type,
      version: row.version,
      status: row.status,
      snapshot: {
        id: row.id,
        projectId: row.project_id,
        version: row.version,
        status: row.status,
        parentId: row.parent_id,
        unitType: row.unit_type,
        structureStatus: project.structure_status
      }
    })),
    ...modules.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      sourceType: "PROJECT_MODULE" as const,
      parentId: row.delivery_unit_id,
      deliveryUnitId: row.delivery_unit_id,
      unitType: null,
      version: row.version,
      status: row.status,
      snapshot: {
        id: row.id,
        projectId: row.project_id,
        version: row.version,
        status: row.status,
        parentId: row.delivery_unit_id,
        unitType: "MODULE",
        structureStatus: project.structure_status
      }
    }))
  ];
  const byKey = new Map(facts.map((fact) => [`${fact.sourceType}:${fact.id}`, fact]));
  const submitted = new Map<string, Record<string, unknown>>();
  for (const node of topology.nodes) {
    const sourceType = isProjectModuleSource(node.sourceType) ? "PROJECT_MODULE" : "DELIVERY_UNIT";
    const sourceId = text(node.sourceId, "content.roots.sourceId");
    const key = `${sourceType}:${sourceId}`;
    if (submitted.has(key))
      throw new UphDefinitionServiceError("TOPOLOGY_DUPLICATE_SOURCE", "拓扑源对象重复。", 422);
    submitted.set(key, node);
    const source = byKey.get(key);
    if (!source || source.status !== "ACTIVE") {
      throw new UphDefinitionServiceError(
        "UPH_SOURCE_NOT_AVAILABLE",
        "拓扑源对象不存在或已禁用。",
        409
      );
    }
    if (sourceType === "DELIVERY_UNIT" && node.sourceType !== source.unitType) {
      throw new UphDefinitionServiceError(
        "TOPOLOGY_SOURCE_TYPE_MISMATCH",
        "拓扑源类型与项目结构不一致。",
        422
      );
    }
    const parentSourceId =
      node.parentSourceId == null ? null : text(node.parentSourceId, "content.parentSourceId");
    if (parentSourceId !== source.parentId) {
      throw new UphDefinitionServiceError(
        "TOPOLOGY_PHYSICAL_PARENT_MISMATCH",
        "拓扑父级必须匹配项目物理层级。",
        422
      );
    }
    if ((parentSourceId === null) !== (node.relation === "ROOT")) {
      throw new UphDefinitionServiceError(
        "TOPOLOGY_ROOT_INVALID",
        "拓扑根节点与物理父级不一致。",
        422
      );
    }
  }
  const activeFacts = facts.filter((fact) => fact.status === "ACTIVE");
  if (
    submitted.size !== activeFacts.length ||
    activeFacts.some((fact) => !submitted.has(`${fact.sourceType}:${fact.id}`))
  ) {
    throw new UphDefinitionServiceError(
      "TOPOLOGY_FOREST_INCOMPLETE",
      "拓扑必须完整覆盖当前项目结构。",
      422
    );
  }
  const activeRoots = facts.filter(
    (fact) =>
      fact.sourceType === "DELIVERY_UNIT" && fact.status === "ACTIVE" && fact.parentId === null
  );
  if (topology.snapshot.projectShape === "SINGLE_MACHINE") {
    if (
      activeRoots.length !== 1 ||
      activeRoots[0]?.unitType !== "MACHINE" ||
      activeFacts.some((fact) => fact.sourceType === "DELIVERY_UNIT" && fact.unitType !== "MACHINE")
    ) {
      throw new UphDefinitionServiceError(
        "SINGLE_MACHINE_ROOT_INVALID",
        "单机项目必须只有一个物理MACHINE根。",
        422
      );
    }
  } else if (
    topology.snapshot.projectShape === "LINE" &&
    activeRoots.some((root) => root.unitType !== "LINE")
  ) {
    throw new UphDefinitionServiceError("LINE_ROOT_INVALID", "整线项目的物理根必须是LINE。", 422);
  }
  if (project.equipment_shape && project.equipment_shape !== topology.snapshot.projectShape) {
    throw new UphDefinitionServiceError(
      "TOPOLOGY_SHAPE_MISMATCH",
      "拓扑形态与项目结构不一致。",
      422
    );
  }
  const actualRootIds = activeRoots.map((root) => root.id).sort();
  const submittedRootIds = topology.rootList.slice().sort();
  if (topology.rootList.some((id, index) => id !== submittedRootIds[index]))
    throw new UphDefinitionServiceError(
      "TOPOLOGY_ROOT_ORDER_INVALID",
      "拓扑根列表必须按稳定对象ID升序。",
      422
    );
  if (
    actualRootIds.length !== submittedRootIds.length ||
    actualRootIds.some((id, index) => id !== submittedRootIds[index])
  ) {
    throw new UphDefinitionServiceError(
      "TOPOLOGY_ROOT_SET_MISMATCH",
      "拓扑根集合必须匹配项目物理根。",
      422
    );
  }
  const watermark = payloadHash({
    projectId,
    equipmentShape: project.equipment_shape,
    structureStatus: project.structure_status,
    sources: activeFacts
      .map((fact) => fact.snapshot)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  }).hash;
  return { facts, watermark };
}

async function loadCtSourceWatermark(
  client: Client,
  project: ProjectFacts,
  projectId: string,
  projectModuleId: string
): Promise<string> {
  const source = await rows<{
    id: string;
    project_id: string;
    delivery_unit_id: string;
    version: number;
    status: string;
  }>(
    client,
    Prisma.sql`SELECT id, project_id, delivery_unit_id, version, status::text AS status FROM project_modules WHERE id = ${projectModuleId} AND project_id = ${projectId}`
  );
  if (!source[0] || source[0].status !== "ACTIVE") {
    throw new UphDefinitionServiceError(
      "UPH_SOURCE_NOT_AVAILABLE",
      "CT所属模块不存在或已禁用。",
      409
    );
  }
  return payloadHash({
    projectId,
    structureStatus: project.structure_status,
    source: {
      id: source[0].id,
      projectId: source[0].project_id,
      version: source[0].version,
      status: source[0].status,
      parentId: source[0].delivery_unit_id,
      unitType: "MODULE"
    }
  }).hash;
}

async function assertVersionSourcesCurrent(
  client: Client,
  project: ProjectFacts,
  projectId: string,
  kind: Kind,
  rootId: string,
  versionId: string
): Promise<void> {
  if (kind === "FORMULA") return;
  if (kind === "TOPOLOGY") {
    const version = await rows<{ snapshot_json: JsonValue; source_watermark: string }>(
      client,
      Prisma.sql`SELECT snapshot_json, source_watermark FROM project_uph_topology_versions WHERE id = ${versionId} AND topology_id = ${rootId} AND project_id = ${projectId}`
    );
    const current = version[0];
    if (!current)
      throw new UphDefinitionServiceError("UPH_VERSION_NOT_FOUND", "UPH版本不存在。", 404);
    const state = await loadSourceState(
      client,
      project,
      projectId,
      object(current.snapshot_json, "snapshot_json")
    );
    if (state.watermark !== current.source_watermark)
      throw new UphDefinitionServiceError(
        "UPH_SOURCE_WATERMARK_STALE",
        "项目结构已变化，请创建新的UPH草稿。",
        409
      );
    return;
  }
  const root = await rows<{ project_module_id: string }>(
    client,
    Prisma.sql`SELECT project_module_id FROM project_uph_ct_definitions WHERE id = ${rootId} AND project_id = ${projectId}`
  );
  const version = await rows<{ snapshot_json: JsonValue; source_watermark: string }>(
    client,
    Prisma.sql`SELECT snapshot_json, source_watermark FROM project_uph_ct_definition_versions WHERE id = ${versionId} AND ct_definition_id = ${rootId} AND project_id = ${projectId}`
  );
  const moduleId = root[0]?.project_module_id;
  const current = version[0];
  if (!moduleId || !current)
    throw new UphDefinitionServiceError("UPH_SOURCE_NOT_AVAILABLE", "CT所属模块不存在。", 409);
  const snapshot = object(current.snapshot_json, "snapshot_json");
  if (snapshot.projectModuleId !== moduleId)
    throw new UphDefinitionServiceError(
      "UPH_SOURCE_WATERMARK_STALE",
      "CT所属模块已变化，请创建新的UPH草稿。",
      409
    );
  const watermark = await loadCtSourceWatermark(client, project, projectId, moduleId);
  if (watermark !== current.source_watermark)
    throw new UphDefinitionServiceError(
      "UPH_SOURCE_WATERMARK_STALE",
      "CT所属模块已变化，请创建新的UPH草稿。",
      409
    );
}

function isProjectModuleSource(value: unknown): boolean {
  return value === "PROJECT_MODULE" || value === "MODULE";
}

function versionInsertSql(
  kind: Kind,
  spec: (typeof ROOTS)[Kind],
  rootId: string,
  projectId: string,
  versionId: string,
  revision: number,
  actorId: string,
  membershipId: string,
  snapshot: JsonValue,
  checksum: string,
  watermark: string,
  content: Record<string, unknown>,
  supersedesVersionId: string | null = null
) {
  const ownerSnapshot = payloadHash({ membershipId, userId: actorId, role: "ENGINEER" });
  if (kind === "CT") {
    return Prisma.sql`INSERT INTO ${table(spec.versionTable)} (id, project_id, ${table(spec.rootColumn)}, revision, status, supersedes_version_id, resource_version, snapshot_checksum, source_watermark, process_owner_membership_id, process_owner_user_id, process_owner_role, process_owner_snapshot_json, process_owner_checksum, created_by_id, snapshot_json, intrinsic_ct_seconds, output_per_cycle_total, parallel_channel_count, cavity_count) VALUES (${versionId}, ${projectId}, ${rootId}, ${revision}, 'DRAFT'::"UphVersionStatus", ${supersedesVersionId}, 1, ${checksum}, ${watermark}, ${membershipId}, ${actorId}, 'ENGINEER'::"ProjectRole", ${json(ownerSnapshot.value)}, ${ownerSnapshot.hash}, ${actorId}, ${json(snapshot)}, ${positive(content.intrinsicCtSeconds, "intrinsicCtSeconds")}, ${positiveInteger(content.outputPerCycleTotal, "outputPerCycleTotal")}, ${positiveInteger(content.parallelChannelCount, "parallelChannelCount")}, ${positiveInteger(content.cavityCount, "cavityCount")})`;
  }
  if (kind === "FORMULA") {
    return Prisma.sql`INSERT INTO ${table(spec.versionTable)} (id, project_id, ${table(spec.rootColumn)}, revision, status, supersedes_version_id, resource_version, snapshot_checksum, process_owner_membership_id, process_owner_user_id, process_owner_role, process_owner_snapshot_json, process_owner_checksum, created_by_id, formula_code, formula_json) VALUES (${versionId}, ${projectId}, ${rootId}, ${revision}, 'DRAFT'::"UphVersionStatus", ${supersedesVersionId}, 1, ${checksum}, ${membershipId}, ${actorId}, 'ENGINEER'::"ProjectRole", ${json(ownerSnapshot.value)}, ${ownerSnapshot.hash}, ${actorId}, ${text(content.formulaCode, "formulaCode")}, ${json(object(content.formulaJson, "formulaJson") as unknown as JsonValue)})`;
  }
  const topology = topologyContent(content);
  return Prisma.sql`INSERT INTO ${table(spec.versionTable)} (id, project_id, ${table(spec.rootColumn)}, revision, status, supersedes_version_id, resource_version, snapshot_checksum, source_watermark, process_owner_membership_id, process_owner_user_id, process_owner_role, process_owner_snapshot_json, process_owner_checksum, created_by_id, snapshot_json, root_list_json) VALUES (${versionId}, ${projectId}, ${rootId}, ${revision}, 'DRAFT'::"UphVersionStatus", ${supersedesVersionId}, 1, ${checksum}, ${watermark}, ${membershipId}, ${actorId}, 'ENGINEER'::"ProjectRole", ${json(ownerSnapshot.value)}, ${ownerSnapshot.hash}, ${actorId}, ${json(topology.snapshot as unknown as JsonValue)}, ${json(topology.rootList)})`;
}

async function writeVersionNodes(
  client: Client,
  projectId: string,
  versionId: string,
  content: Record<string, unknown>,
  sourceState: SourceState
) {
  const topology = topologyContent(content);
  const facts = new Map(sourceState.facts.map((fact) => [`${fact.sourceType}:${fact.id}`, fact]));
  const nodeIds = new Map<string, string>();
  for (const node of topology.nodes) {
    const sourceType = isProjectModuleSource(node.sourceType) ? "PROJECT_MODULE" : "DELIVERY_UNIT";
    const sourceId = text(node.sourceId, "content.nodes.sourceId");
    const source = facts.get(`${sourceType}:${sourceId}`);
    if (!source || source.status !== "ACTIVE")
      throw new UphDefinitionServiceError(
        "UPH_SOURCE_NOT_AVAILABLE",
        "拓扑源对象不存在或已禁用。",
        409
      );
    const sourceChecksum = payloadHash(source.snapshot).hash;
    const parentSourceId =
      node.parentSourceId == null
        ? null
        : text(node.parentSourceId, "content.nodes.parentSourceId");
    const nodeId = randomUUID();
    const parentNodeId = parentSourceId
      ? (nodeIds.get(`DELIVERY_UNIT:${parentSourceId}`) ?? null)
      : null;
    if (parentSourceId && !parentNodeId)
      throw new UphDefinitionServiceError(
        "TOPOLOGY_PARENT_MISMATCH",
        "拓扑父节点必须先存在于同一版本。",
        422
      );
    await client.$executeRaw(
      Prisma.sql`INSERT INTO project_uph_topology_nodes (id, project_id, topology_version_id, source_type, delivery_unit_id, project_module_id, parent_node_id, parent_relation, capacity, source_version, source_status, source_snapshot_json, source_checksum, source_watermark) VALUES (${nodeId}, ${projectId}, ${versionId}, ${sourceType}::"UphTopologySourceType", ${sourceType === "DELIVERY_UNIT" ? sourceId : null}, ${sourceType === "PROJECT_MODULE" ? sourceId : null}, ${parentNodeId}, ${text(node.relation ?? "MANDATORY", "content.nodes.relation")}::"UphTopologyNodeRelation", ${node.capacity == null ? null : positive(node.capacity, "content.nodes.capacity")}, ${source.version}, 'ACTIVE'::"ProjectStructureNodeStatus", ${json(source.snapshot)}, ${sourceChecksum}, ${sourceState.watermark})`
    );
    nodeIds.set(`${sourceType}:${sourceId}`, nodeId);
  }
}

async function replaceVersionNodes(
  client: Client,
  projectId: string,
  versionId: string,
  content: Record<string, unknown>,
  sourceState: SourceState
) {
  // The self-reference intentionally remains ON DELETE RESTRICT. Remove the
  // draft snapshot in leaf-to-root batches so a multi-level topology can be
  // rebuilt without weakening that database invariant.
  while (true) {
    const deleted = await client.$executeRaw(
      Prisma.sql`DELETE FROM project_uph_topology_nodes AS node
        WHERE node.topology_version_id = ${versionId}
          AND node.project_id = ${projectId}
          AND NOT EXISTS (
            SELECT 1
            FROM project_uph_topology_nodes AS child
            WHERE child.topology_version_id = node.topology_version_id
              AND child.project_id = node.project_id
              AND child.parent_node_id = node.id
          )`
    );
    if (deleted > 0) continue;

    const remaining = await client.$queryRaw<Array<{ count: bigint }>>(
      Prisma.sql`SELECT COUNT(*)::bigint AS count
        FROM project_uph_topology_nodes
        WHERE topology_version_id = ${versionId} AND project_id = ${projectId}`
    );
    if (remaining[0]?.count && remaining[0].count > 0n)
      throw new UphDefinitionServiceError("INVALID_TOPOLOGY", "UPH拓扑节点存在无法删除的环。", 422);
    break;
  }
  await writeVersionNodes(client, projectId, versionId, content, sourceState);
}

type UphReadAccess = {
  actor?: AuthorizationActor;
  projectMemberRoles?: string[];
  resourceDepartmentId?: string | null;
};

type UphAllowedAction = "PATCH" | "SIGNOFF" | "PUBLISH" | "REPLACE";

function canExecuteReadAction(
  access: UphReadAccess | undefined,
  version: VersionFacts,
  permission: PermissionCode
): boolean {
  if (!access?.actor || !access.projectMemberRoles?.length) return false;
  return decideAuthorization(access.actor, permission, {
    projectId: version.projectId,
    resourceDepartmentId: access.resourceDepartmentId,
    requireProjectMembership: true,
    memberRoles: access.projectMemberRoles
  }).allowed;
}

function allowedActionsFor(
  version: VersionFacts | null,
  kind: Kind,
  access?: UphReadAccess
): UphAllowedAction[] {
  if (!version || version.status !== "DRAFT" || !access?.actor) return [];
  const isProcessOwner = access.actor.id === version.processOwnerUserId;
  const isIndependentPublisher =
    access.actor.id !== version.processOwnerUserId &&
    access.actor.id !== version.commissioningUserId;
  const canManage =
    isProcessOwner &&
    canExecuteReadAction(access, version, PERMISSIONS.PROJECT_UPH_DEFINITION_MANAGE);
  const canPublish =
    isIndependentPublisher &&
    canExecuteReadAction(access, version, PERMISSIONS.PROJECT_UPH_PUBLISH);

  if (kind === "FORMULA") {
    return [
      ...(canManage ? (["PATCH", "REPLACE"] as const) : []),
      ...(canPublish ? (["PUBLISH"] as const) : [])
    ];
  }
  if (!version.commissioningSignedAt) {
    const canSignoff =
      access.actor.id !== version.processOwnerUserId &&
      canExecuteReadAction(access, version, PERMISSIONS.PROJECT_UPH_COMMISSIONING_SIGNOFF);
    return [
      ...(canManage ? (["PATCH"] as const) : []),
      ...(canSignoff ? (["SIGNOFF"] as const) : [])
    ];
  }
  return [
    ...(canManage ? (["REPLACE"] as const) : []),
    ...(canPublish ? (["PUBLISH"] as const) : [])
  ];
}

function response(
  version: VersionFacts | RootFacts,
  kind: Kind,
  extra: Record<string, unknown> = {},
  access?: UphReadAccess
) {
  const versionResponse = "versionId" in version ? version : null;
  const allowedActions = allowedActionsFor(versionResponse, kind, access);
  return {
    id: "versionId" in version ? version.versionId : version.id,
    kind,
    projectId: version.projectId,
    revision: "revision" in version ? version.revision : 1,
    status: "status" in version ? version.status : "DRAFT",
    resourceVersion: "resourceVersion" in version ? version.resourceVersion : version.version,
    ...("versionId" in version
      ? {
          snapshotChecksum: version.snapshotChecksum,
          sourceWatermark: version.sourceWatermark,
          approvalFacts: {
            processOwnerMembershipId: version.processOwnerMembershipId,
            processOwnerUserId: version.processOwnerUserId,
            commissioningMembershipId: version.commissioningMembershipId,
            commissioningUserId: version.commissioningUserId,
            qualityPublisherMembershipId: version.qualityPublisherMembershipId,
            qualityPublisherUserId: version.qualityPublisherUserId
          },
          allowedActions
        }
      : { allowedActions: [] }),
    ...extra
  };
}

export async function createUphDefinition(
  input: {
    projectId: string;
    actorId: string;
    authorizationActor: AuthorizationActor;
    body: UphDefinitionBody | UphPatchDefinitionBody;
    auditContext: AuditContext;
  },
  transaction?: Client
) {
  return inTransaction(transaction, async (client) => {
    if (
      input.authorizationActor.id !== input.actorId ||
      input.authorizationActor.status !== "ACTIVE"
    )
      throw new UphDefinitionServiceError("ACTOR_INVALID", "操作人身份无效。", 403);
    const project = await projectLock(client, input.projectId);
    const spec = ROOTS[input.body.kind];
    const content = object(input.body.content, "content");
    const projectModuleId =
      input.body.kind === "CT" ? text(content.projectModuleId, "projectModuleId") : undefined;
    const existing = await lockUphRootAndVersion(
      client,
      input.body.kind,
      input.projectId,
      "versionId" in input.body ? input.body.versionId : undefined,
      projectModuleId
    );
    const membership = await actorMembership(client, input.projectId, input.actorId, "ENGINEER");
    if (existing && input.body.projectVersion !== existing.version)
      throw new UphDefinitionServiceError("VERSION_CONFLICT", "项目UPH资源版本冲突。", 409);
    if (existing && input.body.kind === "CT") {
      if (existing.projectModuleId !== projectModuleId)
        throw new UphDefinitionServiceError(
          "CT_ROOT_MODULE_IMMUTABLE",
          "CT定义根只能绑定固定项目模块。",
          409
        );
    }
    const topologyState =
      input.body.kind === "TOPOLOGY"
        ? await loadSourceState(client, project, input.projectId, content)
        : null;
    if (input.body.kind === "CT" && !existing) {
      await lockUphStructureSources(client, input.projectId, [
        {
          sourceType: "PROJECT_MODULE",
          stableId: projectModuleId!
        }
      ]);
    }
    const sourceWatermarkValue =
      input.body.kind === "TOPOLOGY"
        ? topologyState!.watermark
        : input.body.kind === "CT"
          ? await loadCtSourceWatermark(client, project, input.projectId, projectModuleId!)
          : null;
    const rootId = existing?.id ?? randomUUID();
    if (!existing) {
      if (input.body.kind === "CT") {
        await client.$executeRaw(
          Prisma.sql`INSERT INTO ${table(spec.rootTable)} (id, project_id, project_module_id, version, created_by_id, updated_by_id) VALUES (${rootId}, ${input.projectId}, ${projectModuleId}, 1, ${input.actorId}, ${input.actorId})`
        );
      } else {
        await client.$executeRaw(
          Prisma.sql`INSERT INTO ${table(spec.rootTable)} (id, project_id, version, created_by_id, updated_by_id) VALUES (${rootId}, ${input.projectId}, 1, ${input.actorId}, ${input.actorId})`
        );
      }
    }
    const current = existing?.currentWorkVersionId
      ? await loadVersion(client, input.body.kind, rootId, existing.currentWorkVersionId)
      : null;
    if ("versionId" in input.body) {
      if (
        !current ||
        current.versionId !== input.body.versionId ||
        current.resourceVersion !== input.body.resourceVersion
      )
        throw new UphDefinitionServiceError("VERSION_CONFLICT", "UPH版本资源版本冲突。", 409);
    }
    if (current?.status === "DRAFT" && current.processOwnerUserId !== input.actorId)
      throw new UphDefinitionServiceError(
        "PROCESS_OWNER_REQUIRED",
        "只有工艺负责人可以修改或替代当前UPH草稿。",
        403
      );
    if (current?.status === "DRAFT" && current.commissioningSignedAt)
      throw new UphDefinitionServiceError(
        "SIGNED_DRAFT_REPLACEMENT_REQUIRED",
        "已会签草稿必须使用受控纠错命令。",
        409
      );
    const snapshot = payloadHash(input.body.content);
    if (current && current.status === "DRAFT") {
      if (input.body.kind === "FORMULA") {
        const changed = await client.$executeRaw(
          Prisma.sql`UPDATE ${table(spec.versionTable)} SET formula_code = ${text(content.formulaCode, "formulaCode")}, formula_json = ${json(object(content.formulaJson, "formulaJson") as unknown as JsonValue)}, snapshot_checksum = ${snapshot.hash}, resource_version = resource_version + 1 WHERE id = ${current.versionId} AND project_id = ${input.projectId} AND resource_version = ${current.resourceVersion}`
        );
        if (changed !== 1)
          throw new UphDefinitionServiceError("VERSION_CONFLICT", "UPH版本资源版本冲突。", 409);
      } else if (input.body.kind === "TOPOLOGY") {
        await replaceVersionNodes(
          client,
          input.projectId,
          current.versionId,
          content,
          topologyState!
        );
        const changed = await client.$executeRaw(
          Prisma.sql`UPDATE ${table(spec.versionTable)} SET snapshot_json = ${json(snapshot.value)}, snapshot_checksum = ${snapshot.hash}, source_watermark = ${sourceWatermarkValue}, resource_version = resource_version + 1 WHERE id = ${current.versionId} AND project_id = ${input.projectId} AND resource_version = ${current.resourceVersion}`
        );
        if (changed !== 1)
          throw new UphDefinitionServiceError("VERSION_CONFLICT", "UPH版本资源版本冲突。", 409);
      } else {
        const changed = await client.$executeRaw(
          Prisma.sql`UPDATE ${table(spec.versionTable)} SET snapshot_json = ${json(snapshot.value)}, snapshot_checksum = ${snapshot.hash}, source_watermark = ${sourceWatermarkValue}, intrinsic_ct_seconds = ${positive(content.intrinsicCtSeconds, "intrinsicCtSeconds")}, output_per_cycle_total = ${positiveInteger(content.outputPerCycleTotal, "outputPerCycleTotal")}, parallel_channel_count = ${positiveInteger(content.parallelChannelCount, "parallelChannelCount")}, cavity_count = ${positiveInteger(content.cavityCount, "cavityCount")}, resource_version = resource_version + 1 WHERE id = ${current.versionId} AND project_id = ${input.projectId} AND resource_version = ${current.resourceVersion}`
        );
        if (changed !== 1)
          throw new UphDefinitionServiceError("VERSION_CONFLICT", "UPH版本资源版本冲突。", 409);
      }
      const rootChanged = await client.$executeRaw(
        Prisma.sql`UPDATE ${table(spec.rootTable)} SET version = version + 1, updated_by_id = ${input.actorId} WHERE id = ${rootId} AND project_id = ${input.projectId} AND version = ${existing!.version}`
      );
      if (rootChanged !== 1)
        throw new UphDefinitionServiceError("VERSION_CONFLICT", "UPH根资源版本冲突。", 409);
      const updated = await loadVersion(client, input.body.kind, rootId, current.versionId);
      if (!updated) throw new Error("UPH version disappeared");
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.UPH_DEFINITION_UPDATED,
        objectType: spec.versionObjectType as never,
        objectId: current.versionId,
        context: input.auditContext,
        after: { value: response(updated, input.body.kind), allowedFields: auditFields }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "project.uph.definition.updated",
        aggregateType: spec.versionObjectType,
        aggregateId: current.versionId,
        idempotencyKey: `uph:update:${current.versionId}:${updated.resourceVersion}`,
        payload: response(updated, input.body.kind)
      });
      return { ...response(updated, input.body.kind), auditId: audit.id, outboxEventId: outbox.id };
    }
    const versionId = randomUUID();
    const revision = existing
      ? ((
          await rows<{ revision: number }>(
            client,
            Prisma.sql`SELECT COALESCE(MAX(revision), 0) AS revision FROM ${table(spec.versionTable)} WHERE ${table(spec.rootColumn)} = ${rootId} AND project_id = ${input.projectId}`
          )
        )[0]?.revision ?? 0) + 1
      : 1;
    await client.$executeRaw(
      versionInsertSql(
        input.body.kind,
        spec,
        rootId,
        input.projectId,
        versionId,
        revision,
        input.actorId,
        membership.id,
        snapshot.value,
        snapshot.hash,
        sourceWatermarkValue ?? "",
        object(input.body.content, "content"),
        existing?.currentPublishedVersionId ?? null
      )
    );
    if (input.body.kind === "TOPOLOGY")
      await writeVersionNodes(
        client,
        input.projectId,
        versionId,
        object(input.body.content, "content"),
        topologyState!
      );
    const rootChanged = await client.$executeRaw(
      Prisma.sql`UPDATE ${table(spec.rootTable)} SET current_work_version_id = ${versionId}, version = version + 1, updated_by_id = ${input.actorId} WHERE id = ${rootId} AND project_id = ${input.projectId} AND version = ${existing?.version ?? 1}`
    );
    if (rootChanged !== 1)
      throw new UphDefinitionServiceError("VERSION_CONFLICT", "UPH根资源版本冲突。", 409);
    const version = await loadVersion(client, input.body.kind, rootId, versionId);
    if (!version) throw new Error("UPH version disappeared");
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.UPH_DEFINITION_DRAFT_CREATED,
      objectType: spec.versionObjectType as never,
      objectId: versionId,
      context: { ...input.auditContext, departmentId: project.department_id },
      after: { value: response(version, input.body.kind), allowedFields: auditFields }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "project.uph.definition.draft-created",
      aggregateType: spec.versionObjectType,
      aggregateId: versionId,
      idempotencyKey: `uph:draft:${versionId}`,
      payload: response(version, input.body.kind)
    });
    return { ...response(version, input.body.kind), auditId: audit.id, outboxEventId: outbox.id };
  });
}

export async function signoffUphDefinition(
  input: {
    projectId: string;
    kind: Kind;
    versionId: string;
    resourceVersion: number;
    actorId: string;
    authorizationActor: AuthorizationActor;
    auditContext: AuditContext;
  },
  transaction?: Client
) {
  return inTransaction(transaction, async (client) => {
    if (
      input.authorizationActor.id !== input.actorId ||
      input.authorizationActor.status !== "ACTIVE"
    )
      throw new UphDefinitionServiceError("ACTOR_INVALID", "操作人身份无效。", 403);
    if (input.kind === "FORMULA")
      throw new UphDefinitionServiceError("SIGNOFF_NOT_REQUIRED", "公式版本不需要调试会签。", 409);
    const project = await projectLock(client, input.projectId);
    const spec = ROOTS[input.kind];
    const ctRoot =
      input.kind === "CT"
        ? await locateCtRootByVersion(client, input.projectId, input.versionId)
        : undefined;
    const lockedRoot = await lockUphRootAndVersion(
      client,
      input.kind,
      input.projectId,
      input.versionId,
      ctRoot?.projectModuleId
    );
    const membership = await actorMembership(client, input.projectId, input.actorId, "ENGINEER");
    const version = await rows<{
      id: string;
      project_id: string;
      root_id: string;
      current_work_version_id: string | null;
      process_owner_user_id: string;
      status: string;
      resource_version: number;
      commissioning_signed_at: Date | null;
    }>(
      client,
      Prisma.sql`SELECT v.id, v.project_id, v.${table(spec.rootColumn)} AS root_id, r.current_work_version_id, v.process_owner_user_id, v.status::text AS status, v.resource_version, v.commissioning_signed_at FROM ${table(spec.versionTable)} v JOIN ${table(spec.rootTable)} r ON r.id = v.${table(spec.rootColumn)} AND r.project_id = v.project_id WHERE v.id = ${input.versionId} AND v.project_id = ${input.projectId} FOR UPDATE`
    );
    const current = version[0];
    if (!current)
      throw new UphDefinitionServiceError("UPH_VERSION_NOT_FOUND", "UPH版本不存在。", 404);
    if (!lockedRoot || lockedRoot.id !== current.root_id)
      throw new UphDefinitionServiceError("UPH_VERSION_NOT_FOUND", "UPH版本不存在。", 404);
    if (current.status !== "DRAFT")
      throw new UphDefinitionServiceError("VERSION_IMMUTABLE", "只有草稿可以会签。", 409);
    if (current.resource_version !== input.resourceVersion)
      throw new UphDefinitionServiceError("VERSION_CONFLICT", "UPH版本资源版本冲突。", 409);
    if (current.current_work_version_id !== current.id)
      throw new UphDefinitionServiceError(
        "UPH_CURRENT_WORK_CONFLICT",
        "版本不是当前工作草稿。",
        409
      );
    if (current.commissioning_signed_at)
      throw new UphDefinitionServiceError("VERSION_IMMUTABLE", "草稿已经完成会签。", 409);
    if (current.process_owner_user_id === input.actorId)
      throw new UphDefinitionServiceError(
        "ACTOR_NOT_INDEPENDENT",
        "会签人与工艺负责人必须是不同用户。",
        409
      );
    await assertVersionSourcesCurrent(
      client,
      project,
      input.projectId,
      input.kind,
      current.root_id,
      input.versionId
    );
    const commissioningSnapshot = {
      membershipId: membership.id,
      userId: input.actorId,
      role: "ENGINEER"
    };
    const changed = await client.$executeRaw(
      Prisma.sql`UPDATE ${table(spec.versionTable)} SET commissioning_membership_id = ${membership.id}, commissioning_user_id = ${input.actorId}, commissioning_role = 'ENGINEER'::"ProjectRole", commissioning_snapshot_json = ${json(commissioningSnapshot)}, commissioning_checksum = ${payloadHash(commissioningSnapshot).hash}, commissioning_signed_at = CURRENT_TIMESTAMP, resource_version = resource_version + 1 WHERE id = ${input.versionId} AND project_id = ${input.projectId} AND resource_version = ${current.resource_version}`
    );
    if (changed !== 1)
      throw new UphDefinitionServiceError("VERSION_CONFLICT", "UPH版本资源版本冲突。", 409);
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.UPH_COMMISSIONING_SIGNED,
      objectType: spec.versionObjectType as never,
      objectId: input.versionId,
      context: { ...input.auditContext, departmentId: project.department_id },
      after: {
        value: { kind: input.kind, versionId: input.versionId, membershipId: membership.id },
        allowedFields: auditFields
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "project.uph.definition.commissioning-signed",
      aggregateType: spec.versionObjectType,
      aggregateId: input.versionId,
      idempotencyKey: `uph:signoff:${input.versionId}:${current.resource_version + 1}`,
      payload: { kind: input.kind, versionId: input.versionId, membershipId: membership.id }
    });
    const updated = await loadVersion(client, input.kind, current.root_id, input.versionId);
    if (!updated) throw new Error("UPH version disappeared");
    return {
      ...response(updated, input.kind),
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function publishUphDefinition(
  input: {
    projectId: string;
    kind: Kind;
    versionId: string;
    resourceVersion: number;
    actorId: string;
    authorizationActor: AuthorizationActor;
    auditContext: AuditContext;
  },
  transaction?: Client
) {
  return inTransaction(transaction, async (client) => {
    if (
      input.authorizationActor.id !== input.actorId ||
      input.authorizationActor.status !== "ACTIVE"
    )
      throw new UphDefinitionServiceError("ACTOR_INVALID", "操作人身份无效。", 403);
    const project = await projectLock(client, input.projectId);
    const spec = ROOTS[input.kind];
    const ctRoot =
      input.kind === "CT"
        ? await locateCtRootByVersion(client, input.projectId, input.versionId)
        : undefined;
    const lockedRoot = await lockUphRootAndVersion(
      client,
      input.kind,
      input.projectId,
      input.versionId,
      ctRoot?.projectModuleId
    );
    const membership = await actorMembership(client, input.projectId, input.actorId, "QUALITY");
    const commissioningUserSelect =
      input.kind === "FORMULA"
        ? Prisma.sql`NULL::text AS commissioning_user_id`
        : Prisma.sql`v.commissioning_user_id`;
    const commissioningSignedAtSelect =
      input.kind === "FORMULA"
        ? Prisma.sql`NULL::timestamp AS commissioning_signed_at`
        : Prisma.sql`v.commissioning_signed_at`;
    const current = (
      await rows<{
        id: string;
        root_id: string;
        status: string;
        resource_version: number;
        process_owner_user_id: string;
        commissioning_user_id: string | null;
        commissioning_signed_at: Date | null;
      }>(
        client,
        Prisma.sql`SELECT v.id, v.${table(spec.rootColumn)} AS root_id, v.status::text AS status, v.resource_version, v.process_owner_user_id, ${commissioningUserSelect}, ${commissioningSignedAtSelect} FROM ${table(spec.versionTable)} v WHERE v.id = ${input.versionId} AND v.project_id = ${input.projectId} FOR UPDATE`
      )
    )[0];
    if (!current)
      throw new UphDefinitionServiceError("UPH_VERSION_NOT_FOUND", "UPH版本不存在。", 404);
    if (current.status !== "DRAFT")
      throw new UphDefinitionServiceError("VERSION_IMMUTABLE", "只有草稿可以发布。", 409);
    if (current.resource_version !== input.resourceVersion)
      throw new UphDefinitionServiceError("VERSION_CONFLICT", "UPH版本资源版本冲突。", 409);
    if (input.kind !== "FORMULA" && !current.commissioning_signed_at)
      throw new UphDefinitionServiceError(
        "COMMISSIONING_REQUIRED",
        "拓扑或CT发布前必须完成调试会签。",
        409
      );
    if (
      input.actorId === current.process_owner_user_id ||
      input.actorId === current.commissioning_user_id
    )
      throw new UphDefinitionServiceError(
        "ACTOR_NOT_INDEPENDENT",
        "质量发布人与前置责任人必须是不同用户。",
        409
      );
    const root = lockedRoot;
    if (!root || root.id !== current.root_id || root.currentWorkVersionId !== input.versionId)
      throw new UphDefinitionServiceError(
        "UPH_CURRENT_WORK_CONFLICT",
        "版本不是当前工作草稿。",
        409
      );
    await assertVersionSourcesCurrent(
      client,
      project,
      input.projectId,
      input.kind,
      current.root_id,
      input.versionId
    );
    if (root.currentPublishedVersionId) {
      const previous = await rows<{ resource_version: number; status: string }>(
        client,
        Prisma.sql`SELECT resource_version, status::text AS status FROM ${table(spec.versionTable)} WHERE id = ${root.currentPublishedVersionId} AND ${table(spec.rootColumn)} = ${root.id} AND project_id = ${input.projectId} FOR UPDATE`
      );
      if (!previous[0] || previous[0].status !== "PUBLISHED")
        throw new UphDefinitionServiceError(
          "UPH_CURRENT_PUBLISHED_CONFLICT",
          "当前发布版本状态冲突。",
          409
        );
      const changed = await client.$executeRaw(
        Prisma.sql`UPDATE ${table(spec.versionTable)} SET status = 'SUPERSEDED'::"UphVersionStatus", resource_version = resource_version + 1 WHERE id = ${root.currentPublishedVersionId} AND project_id = ${input.projectId} AND resource_version = ${previous[0].resource_version}`
      );
      if (changed !== 1)
        throw new UphDefinitionServiceError("VERSION_CONFLICT", "当前发布版本资源版本冲突。", 409);
    }
    const qualitySnapshot = { membershipId: membership.id, userId: input.actorId, role: "QUALITY" };
    const published = await client.$executeRaw(
      Prisma.sql`UPDATE ${table(spec.versionTable)} SET status = 'PUBLISHED'::"UphVersionStatus", quality_publisher_membership_id = ${membership.id}, quality_publisher_user_id = ${input.actorId}, quality_publisher_role = 'QUALITY'::"ProjectRole", quality_publisher_snapshot_json = ${json(qualitySnapshot)}, quality_publisher_checksum = ${payloadHash(qualitySnapshot).hash}, published_at = CURRENT_TIMESTAMP, resource_version = resource_version + 1 WHERE id = ${input.versionId} AND project_id = ${input.projectId} AND resource_version = ${current.resource_version}`
    );
    if (published !== 1)
      throw new UphDefinitionServiceError("VERSION_CONFLICT", "UPH版本资源版本冲突。", 409);
    const rootChanged = await client.$executeRaw(
      Prisma.sql`UPDATE ${table(spec.rootTable)} SET current_work_version_id = NULL, current_published_version_id = ${input.versionId}, version = version + 1, updated_by_id = ${input.actorId} WHERE id = ${root.id} AND project_id = ${input.projectId} AND version = ${root.version}`
    );
    if (rootChanged !== 1)
      throw new UphDefinitionServiceError("VERSION_CONFLICT", "UPH根资源版本冲突。", 409);
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.UPH_DEFINITION_PUBLISHED,
      objectType: spec.versionObjectType as never,
      objectId: input.versionId,
      context: { ...input.auditContext, departmentId: project.department_id },
      after: {
        value: { kind: input.kind, versionId: input.versionId, membershipId: membership.id },
        allowedFields: auditFields
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "project.uph.definition.published",
      aggregateType: spec.versionObjectType,
      aggregateId: input.versionId,
      idempotencyKey: `uph:publish:${input.versionId}`,
      payload: { kind: input.kind, versionId: input.versionId, membershipId: membership.id }
    });
    const updated = await loadVersion(client, input.kind, root.id, input.versionId);
    if (!updated) throw new Error("UPH version disappeared");
    return {
      ...response(updated, input.kind),
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function replaceSignedUphDraft(
  input: {
    projectId: string;
    kind: Kind;
    reason: string;
    actorId: string;
    authorizationActor: AuthorizationActor;
    body: UphDefinitionBody;
    auditContext: AuditContext;
  },
  transaction?: Client
) {
  if (input.body.kind !== input.kind)
    throw new UphDefinitionServiceError("VALIDATION_FAILED", "定义类型不一致。", 422);
  return inTransaction(transaction, async (client) => {
    if (
      input.authorizationActor.id !== input.actorId ||
      input.authorizationActor.status !== "ACTIVE"
    )
      throw new UphDefinitionServiceError("ACTOR_INVALID", "操作人身份无效。", 403);
    const project = await projectLock(client, input.projectId);
    const spec = ROOTS[input.kind];
    const content = object(input.body.content, "content");
    const projectModuleId =
      input.kind === "CT" ? text(content.projectModuleId, "projectModuleId") : undefined;
    const root = await lockUphRootAndVersion(
      client,
      input.kind,
      input.projectId,
      undefined,
      projectModuleId
    );
    const membership = await actorMembership(client, input.projectId, input.actorId, "ENGINEER");
    if (root && input.body.projectVersion !== root.version)
      throw new UphDefinitionServiceError("VERSION_CONFLICT", "UPH根资源版本冲突。", 409);
    if (!root?.currentWorkVersionId)
      throw new UphDefinitionServiceError("SIGNED_DRAFT_REQUIRED", "不存在待纠错会签草稿。", 409);
    const current = await loadVersion(client, input.kind, root.id, root.currentWorkVersionId);
    if (!current || (input.kind !== "FORMULA" && !current.commissioningSignedAt))
      throw new UphDefinitionServiceError(
        "SIGNED_DRAFT_REQUIRED",
        "只有已会签草稿可以纠错替代。",
        409
      );
    if (current.processOwnerUserId !== input.actorId)
      throw new UphDefinitionServiceError(
        "PROCESS_OWNER_REQUIRED",
        "只有工艺负责人可以替代当前UPH草稿。",
        403
      );
    const topologyState =
      input.kind === "TOPOLOGY"
        ? await loadSourceState(client, project, input.projectId, content)
        : null;
    const sourceWatermarkValue =
      input.kind === "TOPOLOGY"
        ? topologyState!.watermark
        : input.kind === "CT"
          ? await loadCtSourceWatermark(client, project, input.projectId, projectModuleId!)
          : null;
    const reason = text(input.reason, "reason", 1024);
    const superseded = await client.$executeRaw(
      Prisma.sql`UPDATE ${table(spec.versionTable)} SET status = 'SUPERSEDED'::"UphVersionStatus", resource_version = resource_version + 1 WHERE id = ${current.versionId} AND project_id = ${input.projectId} AND resource_version = ${current.resourceVersion}`
    );
    if (superseded !== 1)
      throw new UphDefinitionServiceError("VERSION_CONFLICT", "UPH版本资源版本冲突。", 409);
    const snapshot = payloadHash(input.body.content);
    const revision = current.revision + 1;
    const versionId = randomUUID();
    await client.$executeRaw(
      versionInsertSql(
        input.kind,
        spec,
        root.id,
        input.projectId,
        versionId,
        revision,
        input.actorId,
        membership.id,
        snapshot.value,
        snapshot.hash,
        sourceWatermarkValue ?? "",
        content,
        current.versionId
      )
    );
    if (input.kind === "TOPOLOGY")
      await writeVersionNodes(client, input.projectId, versionId, content, topologyState!);
    const rootChanged = await client.$executeRaw(
      Prisma.sql`UPDATE ${table(spec.rootTable)} SET current_work_version_id = ${versionId}, version = version + 1, updated_by_id = ${input.actorId} WHERE id = ${root.id} AND project_id = ${input.projectId} AND version = ${root.version}`
    );
    if (rootChanged !== 1)
      throw new UphDefinitionServiceError("VERSION_CONFLICT", "UPH根资源版本冲突。", 409);
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.UPH_DRAFT_REPLACED,
      objectType: spec.versionObjectType as never,
      objectId: versionId,
      context: { ...input.auditContext, departmentId: project.department_id, reason },
      after: {
        value: {
          kind: input.kind,
          versionId,
          supersedesVersionId: current.versionId,
          reasonCode: "DRAFT_CORRECTION"
        },
        allowedFields: auditFields
      }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "project.uph.definition.draft-replaced",
      aggregateType: spec.versionObjectType,
      aggregateId: versionId,
      idempotencyKey: `uph:replacement:${versionId}`,
      payload: { kind: input.kind, versionId, supersedesVersionId: current.versionId, reason }
    });
    const updated = await loadVersion(client, input.kind, root.id, versionId);
    if (!updated) throw new Error("UPH version disappeared");
    return {
      ...response(updated, input.kind),
      auditId: audit.id,
      outboxEventId: outbox.id
    };
  });
}

export async function getUphDefinition(
  input: {
    projectId: string;
    kind: Kind;
    selection: "currentWork" | "currentPublished" | "exact";
    versionId?: string;
    projectModuleId?: string;
    authorizationActor?: AuthorizationActor;
    projectMemberRoles?: string[];
  },
  transaction: Client = db as unknown as Client
) {
  if (input.selection === "exact" && input.projectModuleId)
    throw new UphDefinitionServiceError(
      "VALIDATION_FAILED",
      "精确版本查询不接受项目模块范围。",
      422
    );
  if (input.kind !== "CT" && input.projectModuleId)
    throw new UphDefinitionServiceError(
      "VALIDATION_FAILED",
      "仅CT当前版本查询接受项目模块范围。",
      422
    );
  if (input.kind === "CT" && input.selection !== "exact" && !input.projectModuleId)
    throw new UphDefinitionServiceError(
      "PROJECT_MODULE_REQUIRED",
      "CT当前版本查询必须指定项目模块。",
      422
    );
  const ctRoot =
    input.kind === "CT" && input.selection === "exact"
      ? await locateCtRootByVersion(
          transaction,
          input.projectId,
          text(input.versionId, "versionId")
        )
      : undefined;
  const root = await loadRoot(
    transaction,
    input.kind,
    input.projectId,
    input.kind === "CT" ? (ctRoot?.projectModuleId ?? input.projectModuleId) : undefined
  );
  if (!root) throw new UphDefinitionServiceError("UPH_NOT_FOUND", "项目尚未建立该UPH定义。", 404);
  const versionId =
    input.selection === "currentWork"
      ? root.currentWorkVersionId
      : input.selection === "currentPublished"
        ? root.currentPublishedVersionId
        : input.versionId;
  if (!versionId)
    throw new UphDefinitionServiceError("UPH_VERSION_NOT_FOUND", "请求的UPH版本不存在。", 404);
  const version = await loadVersion(transaction, input.kind, root.id, versionId);
  if (!version)
    throw new UphDefinitionServiceError("UPH_VERSION_NOT_FOUND", "请求的UPH版本不存在。", 404);
  const project = await rows<{ department_id: string | null }>(
    transaction,
    Prisma.sql`SELECT department_id FROM projects WHERE id = ${input.projectId}`
  );
  return response(
    version,
    input.kind,
    { selection: input.selection },
    {
      actor: input.authorizationActor,
      projectMemberRoles: input.projectMemberRoles,
      resourceDepartmentId: project[0]?.department_id ?? null
    }
  );
}
