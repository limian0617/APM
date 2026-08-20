import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  ASSET_RELEASE_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { payloadHash } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  AssetReleaseError,
  assertAssetReleaseTransition,
  assertComponentPositionsUnique,
  validateAssetComponentSnapshot,
  validateAssetReleaseCode,
  type AssetComponentSnapshot,
  type AssetReleaseVersionStatus
} from "../domain/asset-release";

type Transaction = Prisma.TransactionClient;

const releaseInclude = {
  currentVersion: { include: { components: { orderBy: { position: "asc" } } } },
  versions: {
    orderBy: { revision: "asc" },
    include: { components: { orderBy: { position: "asc" } } }
  }
} satisfies Prisma.AssetReleaseInclude;

type ReleaseFact = Prisma.AssetReleaseGetPayload<{ include: typeof releaseInclude }>;
type ReleaseVersionFact = ReleaseFact["versions"][number];

function text(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximumLength) {
    throw new AssetReleaseError(
      "INVALID_FILE_SNAPSHOT",
      `${field}不能为空且长度不能超过 ${maximumLength}。`,
      422
    );
  }
  return value.trim();
}

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AssetReleaseError("INVALID_RELEASE_VERSION", `${field}必须是正整数。`, 422);
  }
  return value as number;
}

function commandContext(
  context: AuditContext,
  actorId: string,
  reason: string,
  departmentId: string | null
) {
  return { ...context, actorId, reason, departmentId, projectId: null };
}

function releaseAuditValue(release: {
  id: string;
  technicalAssetId: string;
  releaseCode: string;
  version: number;
}) {
  return {
    releaseId: release.id,
    technicalAssetId: release.technicalAssetId,
    releaseCode: release.releaseCode,
    version: release.version
  };
}

function versionAuditValue(version: {
  id: string;
  releaseId: string;
  technicalAssetId: string;
  revision: number;
  status: string;
  releaseNotes: string | null;
  snapshotChecksum: string;
  sourceWatermark: string;
  publishedById: string | null;
}) {
  return {
    releaseVersionId: version.id,
    releaseId: version.releaseId,
    technicalAssetId: version.technicalAssetId,
    revision: version.revision,
    status: version.status,
    releaseNotes: version.releaseNotes,
    snapshotChecksum: version.snapshotChecksum,
    sourceWatermark: version.sourceWatermark,
    publishedById: version.publishedById
  };
}

function serializedComponent(component: ReleaseVersionFact["components"][number]) {
  return {
    id: component.id,
    releaseVersionId: component.releaseVersionId,
    technicalAssetId: component.technicalAssetId,
    position: component.position,
    componentType: component.componentType,
    sourceProjectId: component.sourceProjectId,
    sourceDrawingId: component.sourceDrawingId,
    sourceDocumentVersionId: component.sourceDocumentVersionId,
    sourceFileId: component.sourceFileId,
    sourceVersion: component.sourceVersion,
    sourceStatus: component.sourceStatus,
    sourceChecksum: component.sourceChecksum,
    sourceFileSha256: component.sourceFileSha256,
    sourceFileMimeType: component.sourceFileMimeType,
    sourceFileSize: Number(component.sourceFileSize),
    snapshotJson: component.snapshotJson,
    createdAt: component.createdAt.toISOString()
  };
}

function serializeVersion(version: ReleaseVersionFact) {
  return {
    id: version.id,
    releaseId: version.releaseId,
    technicalAssetId: version.technicalAssetId,
    revision: version.revision,
    status: version.status,
    releaseNotes: version.releaseNotes,
    snapshotChecksum: version.snapshotChecksum,
    sourceWatermark: version.sourceWatermark,
    createdById: version.createdById,
    publishedById: version.publishedById,
    createdAt: version.createdAt.toISOString(),
    publishedAt: version.publishedAt?.toISOString() ?? null,
    supersededAt: version.supersededAt?.toISOString() ?? null,
    components: version.components.map(serializedComponent)
  };
}

function serializeRelease(release: ReleaseFact) {
  return {
    id: release.id,
    technicalAssetId: release.technicalAssetId,
    releaseCode: release.releaseCode,
    currentVersionId: release.currentVersionId,
    version: release.version,
    createdById: release.createdById,
    createdAt: release.createdAt.toISOString(),
    updatedAt: release.updatedAt.toISOString(),
    resourceVersion: release.version,
    currentVersion: release.currentVersion ? serializeVersion(release.currentVersion) : null,
    versions: release.versions.map(serializeVersion)
  };
}

async function databaseNow(client: Transaction): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

async function lockTechnicalAsset(client: Transaction, technicalAssetId: string) {
  await client.$queryRaw`SELECT "id" FROM "technical_assets" WHERE "id" = ${technicalAssetId} FOR UPDATE`;
  return client.technicalAsset.findUnique({
    where: { id: technicalAssetId },
    select: {
      id: true,
      rndProjectId: true,
      ownerId: true,
      status: true,
      rndProject: { select: { id: true, departmentId: true, status: true } }
    }
  });
}

async function assertActiveActor(client: Transaction, actorId: string) {
  const actor = await client.user.findUnique({
    where: { id: actorId },
    select: { id: true, status: true }
  });
  if (!actor) throw new AssetReleaseError("ACTOR_NOT_FOUND", "操作人不存在。", 404);
  if (actor.status !== "ACTIVE")
    throw new AssetReleaseError("ACTOR_DISABLED", "操作人必须处于启用状态。", 409);
}

async function lockRelease(client: Transaction, technicalAssetId: string, releaseId: string) {
  await client.$queryRaw`
    SELECT "id" FROM "asset_releases"
    WHERE "id" = ${releaseId} AND "technical_asset_id" = ${technicalAssetId}
    FOR UPDATE
  `;
  return client.assetRelease.findFirst({ where: { id: releaseId, technicalAssetId } });
}

function assertWritableAsset(asset: { status: string; rndProject: { status: string } }) {
  if (
    asset.status === "CANCELED" ||
    asset.rndProject.status === "COMPLETED" ||
    asset.rndProject.status === "CANCELED"
  ) {
    throw new AssetReleaseError(
      "ASSET_RELEASE_NOT_WRITABLE",
      "当前技术资产或研发项目不可写入 Release。",
      409
    );
  }
}

type ValidatedComponent = {
  input: AssetComponentSnapshot;
  sourceDrawingId: string | null;
  sourceFileId: string;
  sourceFileSha256: string;
  sourceFileMimeType: string;
  sourceFileSize: number;
  files: AssetComponentSnapshot["files"];
  snapshotJson: Prisma.InputJsonValue;
};

async function validateSourceComponent(
  client: Transaction,
  component: AssetComponentSnapshot
): Promise<ValidatedComponent> {
  const source = await client.controlledDocumentVersion.findFirst({
    where: { id: component.sourceDocumentVersionId, projectId: component.sourceProjectId },
    select: {
      id: true,
      projectId: true,
      documentId: true,
      version: true,
      status: true,
      sourceFileId: true,
      sourceFileSha256: true,
      sourceMimeType: true,
      sourceFileSize: true
    }
  });
  if (!source) throw new AssetReleaseError("SOURCE_NOT_FOUND", "来源文档版本不存在。", 404);
  if (source.status !== "PUBLISHED") {
    throw new AssetReleaseError("SOURCE_VERSION_NOT_PUBLISHED", "来源文档版本必须已经发布。", 422);
  }
  if (source.version !== component.sourceVersion || component.sourceStatus !== "PUBLISHED") {
    throw new AssetReleaseError(
      "SOURCE_REFERENCE_MISMATCH",
      "来源版本快照与已发布事实不一致。",
      422
    );
  }
  const sourceChecksum = source.sourceFileSha256.toLowerCase();
  if (sourceChecksum !== component.sourceChecksum.toLowerCase()) {
    throw new AssetReleaseError(
      "SOURCE_REFERENCE_MISMATCH",
      "来源 checksum 与已发布文档版本不一致。",
      422
    );
  }

  const files: AssetComponentSnapshot["files"] = [];
  for (const requested of component.files) {
    const file = await client.fileObject.findFirst({
      where: { id: requested.fileId, projectId: component.sourceProjectId },
      select: { id: true, status: true, sha256: true, verifiedMimeType: true, verifiedSize: true }
    });
    if (!file)
      throw new AssetReleaseError("SOURCE_NOT_FOUND", "组件文件不存在或不属于来源项目。", 404);
    if (file.status !== "AVAILABLE") {
      throw new AssetReleaseError(
        "SOURCE_FILE_NOT_AVAILABLE",
        "组件文件必须处于 AVAILABLE 状态。",
        422
      );
    }
    if (
      !file.sha256 ||
      file.sha256.toLowerCase() !== requested.sha256.toLowerCase() ||
      file.verifiedMimeType !== requested.mimeType ||
      file.verifiedSize === null ||
      Number(file.verifiedSize) !== requested.size
    ) {
      throw new AssetReleaseError("INVALID_FILE_SNAPSHOT", "组件文件快照与文件事实不一致。", 422);
    }
    files.push({ ...requested, sha256: requested.sha256.toLowerCase() });
  }
  const primary = files.find((file) => file.fileId === source.sourceFileId);
  if (!primary) {
    throw new AssetReleaseError(
      "INVALID_FILE_SNAPSHOT",
      "组件文件列表必须包含受控文档的主源文件。",
      422
    );
  }
  if (
    primary.sha256 !== sourceChecksum ||
    primary.mimeType !== source.sourceMimeType ||
    primary.size !== Number(source.sourceFileSize)
  ) {
    throw new AssetReleaseError(
      "SOURCE_REFERENCE_MISMATCH",
      "主源文件快照与已发布文档版本不一致。",
      422
    );
  }

  let sourceDrawingId: string | null = component.sourceDrawingId ?? null;
  if (component.componentType === "MECHANICAL_DRAWING") {
    if (!sourceDrawingId) {
      throw new AssetReleaseError("SOURCE_NOT_FOUND", "机械图纸组件必须提供来源图纸。", 404);
    }
    const drawing = await client.mechanicalDrawing.findFirst({
      where: { id: sourceDrawingId, projectId: component.sourceProjectId },
      select: { id: true, documentId: true }
    });
    if (!drawing || drawing.documentId !== source.documentId) {
      throw new AssetReleaseError("SOURCE_REFERENCE_MISMATCH", "来源图纸必须属于该文档版本。", 422);
    }
  } else if (sourceDrawingId) {
    throw new AssetReleaseError("SOURCE_REFERENCE_MISMATCH", "非机械组件不能携带来源图纸。", 422);
  }

  const snapshot = {
    componentType: component.componentType,
    position: component.position,
    sourceProjectId: component.sourceProjectId,
    sourceDrawingId,
    sourceDocumentVersionId: source.id,
    sourceVersion: source.version,
    sourceStatus: source.status,
    sourceChecksum,
    files,
    metadata: component.metadata
  };
  let snapshotJson: Prisma.InputJsonValue;
  try {
    snapshotJson = payloadHash(snapshot).value as Prisma.InputJsonValue;
  } catch {
    throw new AssetReleaseError(
      "INVALID_FILE_SNAPSHOT",
      "组件 metadata 必须是可序列化 JSON。",
      422
    );
  }
  return {
    input: component,
    sourceDrawingId,
    sourceFileId: source.sourceFileId,
    sourceFileSha256: sourceChecksum,
    sourceFileMimeType: source.sourceMimeType,
    sourceFileSize: Number(source.sourceFileSize),
    files,
    snapshotJson
  };
}

function hashesForRelease(input: {
  releaseCode: string;
  revision: number;
  components: ValidatedComponent[];
}) {
  const componentFacts = input.components.map((component) => ({
    ...component.input,
    sourceDrawingId: component.sourceDrawingId,
    sourceChecksum: component.sourceFileSha256,
    files: component.files
  }));
  try {
    const snapshot = payloadHash({
      releaseCode: input.releaseCode,
      revision: input.revision,
      components: componentFacts
    });
    const source = payloadHash(
      componentFacts.map((component) => ({
        sourceProjectId: component.sourceProjectId,
        sourceDrawingId: component.sourceDrawingId,
        sourceDocumentVersionId: component.sourceDocumentVersionId,
        sourceVersion: component.sourceVersion,
        sourceStatus: component.sourceStatus,
        sourceChecksum: component.sourceChecksum,
        files: component.files
      }))
    );
    return { snapshotChecksum: snapshot.hash, sourceWatermark: source.hash };
  } catch {
    throw new AssetReleaseError("INVALID_FILE_SNAPSHOT", "Release 快照必须是可序列化 JSON。", 422);
  }
}

async function hydrateRelease(client: Transaction, technicalAssetId: string, releaseId: string) {
  const release = await client.assetRelease.findFirst({
    where: { id: releaseId, technicalAssetId },
    include: releaseInclude
  });
  if (!release)
    throw new AssetReleaseError("ASSET_RELEASE_NOT_FOUND", "资产 Release 不存在。", 404);
  return release;
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof AssetReleaseError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new AssetReleaseError(
        "RELEASE_CODE_CONFLICT",
        "同一技术资产下 Release code 已存在。",
        409
      );
    }
    if (error.code === "P2025" || error.code === "P2003") {
      throw new AssetReleaseError("SOURCE_NOT_FOUND", "Release 关联事实不存在。", 404);
    }
  }
  throw error;
}

export async function createAssetRelease(
  input: {
    technicalAssetId: string;
    releaseCode: unknown;
    releaseNotes?: unknown;
    components: unknown;
    reason?: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Transaction
) {
  const releaseCode = validateAssetReleaseCode(input.releaseCode);
  const releaseNotes =
    input.releaseNotes === undefined || input.releaseNotes === null
      ? null
      : text(input.releaseNotes, "releaseNotes", 4000);
  if (!Array.isArray(input.components) || input.components.length === 0) {
    throw new AssetReleaseError("INVALID_FILE_SNAPSHOT", "Release 至少需要一个组件。", 422);
  }
  const components = input.components.map(validateAssetComponentSnapshot);
  assertComponentPositionsUnique(components);
  try {
    return await inTransaction(transaction, async (client) => {
      await assertActiveActor(client, input.actorId);
      const asset = await lockTechnicalAsset(client, input.technicalAssetId);
      if (!asset) throw new AssetReleaseError("TECHNICAL_ASSET_NOT_FOUND", "技术资产不存在。", 404);
      assertWritableAsset(asset);
      const validated: ValidatedComponent[] = [];
      for (const component of components)
        validated.push(await validateSourceComponent(client, component));
      const hashes = hashesForRelease({ releaseCode, revision: 1, components: validated });
      const release = await client.assetRelease.create({
        data: {
          technicalAssetId: asset.id,
          releaseCode,
          version: 2,
          createdById: input.actorId
        }
      });
      const draft = await client.assetReleaseVersion.create({
        data: {
          releaseId: release.id,
          technicalAssetId: asset.id,
          revision: 1,
          status: "DRAFT",
          releaseNotes,
          snapshotChecksum: hashes.snapshotChecksum,
          sourceWatermark: hashes.sourceWatermark,
          createdById: input.actorId,
          components: {
            create: validated.map((component) => ({
              position: component.input.position,
              componentType: component.input.componentType,
              sourceProjectId: component.input.sourceProjectId,
              sourceDrawingId: component.sourceDrawingId,
              sourceDocumentVersionId: component.input.sourceDocumentVersionId,
              sourceFileId: component.sourceFileId,
              sourceVersion: component.input.sourceVersion,
              sourceStatus: component.input.sourceStatus,
              sourceChecksum: component.input.sourceChecksum,
              sourceFileSha256: component.sourceFileSha256,
              sourceFileMimeType: component.sourceFileMimeType,
              sourceFileSize: BigInt(component.sourceFileSize),
              snapshotJson: component.snapshotJson
            }))
          }
        },
        include: { components: { orderBy: { position: "asc" } } }
      });
      const operationReason =
        input.reason === undefined
          ? typeof input.auditContext.reason === "string" && input.auditContext.reason.trim()
            ? input.auditContext.reason.trim()
            : "创建资产 Release"
          : text(input.reason, "reason", 1024);
      const context = commandContext(
        input.auditContext,
        input.actorId,
        operationReason,
        asset.rndProject.departmentId
      );
      const releaseAudit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_RELEASE_CREATED,
        objectType: AUDIT_OBJECT_TYPES.ASSET_RELEASE,
        objectId: release.id,
        context,
        after: { value: releaseAuditValue(release), allowedFields: ASSET_RELEASE_AUDIT_FIELDS }
      });
      const versionAudit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_RELEASE_VERSION_DRAFTED,
        objectType: AUDIT_OBJECT_TYPES.ASSET_RELEASE_VERSION,
        objectId: draft.id,
        context,
        after: {
          value: versionAuditValue(draft),
          allowedFields: ASSET_RELEASE_AUDIT_FIELDS
        }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "asset-release.created",
        aggregateType: "ASSET_RELEASE",
        aggregateId: release.id,
        idempotencyKey: `${release.id}:created`,
        payload: { ...releaseAuditValue(release), releaseVersionId: draft.id }
      });
      await appendOutboxEvent(client, {
        eventType: "asset-release.version-drafted",
        aggregateType: "ASSET_RELEASE",
        aggregateId: release.id,
        idempotencyKey: `${release.id}:${draft.id}:drafted`,
        payload: versionAuditValue(draft)
      });
      const hydrated = await hydrateRelease(client, asset.id, release.id);
      return {
        release: serializeRelease(hydrated),
        releaseVersion: serializeVersion(hydrated.versions[0]!),
        resourceVersion: release.version,
        auditId: versionAudit.id ?? releaseAudit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function publishAssetReleaseVersion(
  input: {
    technicalAssetId: string;
    releaseId: string;
    releaseVersionId?: string;
    version: unknown;
    releaseVersion: unknown;
    actorId: string;
    reason: unknown;
    auditContext: AuditContext;
  },
  transaction?: Transaction
) {
  const expectedVersion = positiveVersion(input.version, "version");
  const expectedRevision = positiveVersion(input.releaseVersion, "releaseVersion");
  const reason = text(input.reason, "reason", 1024);
  try {
    return await inTransaction(transaction, async (client) => {
      await assertActiveActor(client, input.actorId);
      const asset = await lockTechnicalAsset(client, input.technicalAssetId);
      if (!asset) throw new AssetReleaseError("TECHNICAL_ASSET_NOT_FOUND", "技术资产不存在。", 404);
      assertWritableAsset(asset);
      const release = await lockRelease(client, asset.id, input.releaseId);
      if (!release)
        throw new AssetReleaseError("ASSET_RELEASE_NOT_FOUND", "资产 Release 不存在。", 404);
      if (release.version !== expectedVersion) {
        throw new AssetReleaseError("VERSION_CONFLICT", "Release 已发生变化，请刷新后重试。", 409);
      }
      const target = await client.assetReleaseVersion.findFirst({
        where: {
          ...(input.releaseVersionId ? { id: input.releaseVersionId } : {}),
          releaseId: release.id,
          technicalAssetId: asset.id,
          revision: expectedRevision
        },
        include: { components: { orderBy: { position: "asc" } } }
      });
      if (!target)
        throw new AssetReleaseError("ASSET_RELEASE_VERSION_NOT_FOUND", "Release 版本不存在。", 404);
      assertAssetReleaseTransition(target.status as AssetReleaseVersionStatus, "PUBLISHED");
      const storedComponents = target.components.map((component) => {
        const snapshot = component.snapshotJson as Record<string, unknown>;
        return validateAssetComponentSnapshot({
          componentType: component.componentType,
          position: component.position,
          sourceProjectId: component.sourceProjectId,
          sourceDrawingId: component.sourceDrawingId,
          sourceDocumentVersionId: component.sourceDocumentVersionId,
          sourceVersion: component.sourceVersion,
          sourceStatus: component.sourceStatus,
          sourceChecksum: component.sourceChecksum,
          files: Array.isArray(snapshot.files) ? snapshot.files : [],
          metadata:
            snapshot.metadata && typeof snapshot.metadata === "object" ? snapshot.metadata : {}
        });
      });
      const validated: ValidatedComponent[] = [];
      for (const component of storedComponents)
        validated.push(await validateSourceComponent(client, component));
      const hashes = hashesForRelease({
        releaseCode: release.releaseCode,
        revision: target.revision,
        components: validated
      });
      if (
        hashes.snapshotChecksum !== target.snapshotChecksum ||
        hashes.sourceWatermark !== target.sourceWatermark
      ) {
        throw new AssetReleaseError(
          "PUBLISHED_VERSION_IMMUTABLE",
          "草稿来源事实已发生变化，不能发布旧快照。",
          409
        );
      }
      const now = await databaseNow(client);
      const published = await client.assetReleaseVersion.update({
        where: { id: target.id },
        data: { status: "PUBLISHED", publishedById: input.actorId, publishedAt: now }
      });
      const previous = release.currentVersionId
        ? await client.assetReleaseVersion.findFirst({
            where: {
              id: release.currentVersionId,
              releaseId: release.id,
              technicalAssetId: asset.id
            }
          })
        : null;
      let supersedeAuditId: string | null = null;
      if (previous && previous.id !== published.id) {
        if (previous.status !== "PUBLISHED") {
          throw new AssetReleaseError(
            "INVALID_RELEASE_TRANSITION",
            "当前 Release 版本状态不允许被替换。",
            409
          );
        }
        const superseded = await client.assetReleaseVersion.update({
          where: { id: previous.id },
          data: { status: "SUPERSEDED", supersededAt: now }
        });
        const supersedeAudit = await writeAudit(client, {
          action: AUDIT_ACTIONS.ASSET_RELEASE_VERSION_SUPERSEDED,
          objectType: AUDIT_OBJECT_TYPES.ASSET_RELEASE_VERSION,
          objectId: superseded.id,
          context: commandContext(
            input.auditContext,
            input.actorId,
            reason,
            asset.rndProject.departmentId
          ),
          before: { value: versionAuditValue(previous), allowedFields: ASSET_RELEASE_AUDIT_FIELDS },
          after: { value: versionAuditValue(superseded), allowedFields: ASSET_RELEASE_AUDIT_FIELDS }
        });
        supersedeAuditId = supersedeAudit.id;
        await appendOutboxEvent(client, {
          eventType: "asset-release.version-superseded",
          aggregateType: "ASSET_RELEASE_VERSION",
          aggregateId: superseded.id,
          idempotencyKey: `${superseded.id}:superseded`,
          payload: versionAuditValue(superseded)
        });
      }
      const releaseUpdate = await client.assetRelease.updateMany({
        where: { id: release.id, technicalAssetId: asset.id, version: expectedVersion },
        data: { currentVersionId: published.id, version: { increment: 1 }, updatedAt: now }
      });
      if (releaseUpdate.count !== 1)
        throw new AssetReleaseError("VERSION_CONFLICT", "Release 已发生变化，请刷新后重试。", 409);
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_RELEASE_VERSION_PUBLISHED,
        objectType: AUDIT_OBJECT_TYPES.ASSET_RELEASE_VERSION,
        objectId: published.id,
        context: commandContext(
          input.auditContext,
          input.actorId,
          reason,
          asset.rndProject.departmentId
        ),
        after: { value: versionAuditValue(published), allowedFields: ASSET_RELEASE_AUDIT_FIELDS },
        metadata: supersedeAuditId
          ? { value: { supersedeAuditId }, allowedFields: ASSET_RELEASE_AUDIT_FIELDS }
          : undefined
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "asset-release.version-published",
        aggregateType: "ASSET_RELEASE_VERSION",
        aggregateId: published.id,
        idempotencyKey: `${published.id}:published`,
        payload: { ...versionAuditValue(published), releaseId: release.id }
      });
      const hydrated = await hydrateRelease(client, asset.id, release.id);
      return {
        release: serializeRelease(hydrated),
        releaseVersion: serializeVersion(hydrated.currentVersion!),
        resourceVersion: hydrated.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function createAssetReleaseRevision(
  input: {
    technicalAssetId: string;
    releaseId: string;
    version: unknown;
    releaseNotes?: unknown;
    components: unknown;
    actorId: string;
    reason: unknown;
    auditContext: AuditContext;
  },
  transaction?: Transaction
) {
  const expectedVersion = positiveVersion(input.version, "version");
  const releaseNotes =
    input.releaseNotes === undefined || input.releaseNotes === null
      ? null
      : text(input.releaseNotes, "releaseNotes", 4000);
  const reason = text(input.reason, "reason", 1024);
  if (!Array.isArray(input.components) || input.components.length === 0) {
    throw new AssetReleaseError("INVALID_FILE_SNAPSHOT", "Release 至少需要一个组件。", 422);
  }
  const components = input.components.map(validateAssetComponentSnapshot);
  assertComponentPositionsUnique(components);
  try {
    return await inTransaction(transaction, async (client) => {
      await assertActiveActor(client, input.actorId);
      const asset = await lockTechnicalAsset(client, input.technicalAssetId);
      if (!asset) throw new AssetReleaseError("TECHNICAL_ASSET_NOT_FOUND", "技术资产不存在。", 404);
      assertWritableAsset(asset);
      const release = await lockRelease(client, asset.id, input.releaseId);
      if (!release)
        throw new AssetReleaseError("ASSET_RELEASE_NOT_FOUND", "资产 Release 不存在。", 404);
      if (release.version !== expectedVersion) {
        throw new AssetReleaseError("VERSION_CONFLICT", "Release 已发生变化，请刷新后重试。", 409);
      }
      const latest = await client.assetReleaseVersion.findFirst({
        where: { releaseId: release.id, technicalAssetId: asset.id },
        orderBy: { revision: "desc" },
        select: { revision: true }
      });
      const revision = (latest?.revision ?? 0) + 1;
      const validated: ValidatedComponent[] = [];
      for (const component of components)
        validated.push(await validateSourceComponent(client, component));
      const hashes = hashesForRelease({
        releaseCode: release.releaseCode,
        revision,
        components: validated
      });
      const draft = await client.assetReleaseVersion.create({
        data: {
          releaseId: release.id,
          technicalAssetId: asset.id,
          revision,
          status: "DRAFT",
          releaseNotes,
          snapshotChecksum: hashes.snapshotChecksum,
          sourceWatermark: hashes.sourceWatermark,
          createdById: input.actorId,
          components: {
            create: validated.map((component) => ({
              position: component.input.position,
              componentType: component.input.componentType,
              sourceProjectId: component.input.sourceProjectId,
              sourceDrawingId: component.sourceDrawingId,
              sourceDocumentVersionId: component.input.sourceDocumentVersionId,
              sourceFileId: component.sourceFileId,
              sourceVersion: component.input.sourceVersion,
              sourceStatus: component.input.sourceStatus,
              sourceChecksum: component.input.sourceChecksum,
              sourceFileSha256: component.sourceFileSha256,
              sourceFileMimeType: component.sourceFileMimeType,
              sourceFileSize: BigInt(component.sourceFileSize),
              snapshotJson: component.snapshotJson
            }))
          }
        },
        include: { components: { orderBy: { position: "asc" } } }
      });
      const now = await databaseNow(client);
      const updated = await client.assetRelease.updateMany({
        where: { id: release.id, technicalAssetId: asset.id, version: expectedVersion },
        data: { version: { increment: 1 }, updatedAt: now }
      });
      if (updated.count !== 1) {
        throw new AssetReleaseError("VERSION_CONFLICT", "Release 已发生变化，请刷新后重试。", 409);
      }
      const updatedRelease = await client.assetRelease.findUniqueOrThrow({
        where: { id: release.id }
      });
      const context = commandContext(
        input.auditContext,
        input.actorId,
        reason,
        asset.rndProject.departmentId
      );
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_RELEASE_VERSION_DRAFTED,
        objectType: AUDIT_OBJECT_TYPES.ASSET_RELEASE_VERSION,
        objectId: draft.id,
        context,
        after: { value: versionAuditValue(draft), allowedFields: ASSET_RELEASE_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "asset-release.version-drafted",
        aggregateType: "ASSET_RELEASE",
        aggregateId: release.id,
        idempotencyKey: `${release.id}:${draft.id}:drafted`,
        payload: versionAuditValue(draft)
      });
      const hydrated = await hydrateRelease(client, asset.id, release.id);
      return {
        release: serializeRelease(hydrated),
        releaseVersion: serializeVersion(
          hydrated.versions.find((version) => version.id === draft.id)!
        ),
        resourceVersion: updatedRelease.version,
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function getAssetRelease(input: {
  technicalAssetId: string;
  releaseId: string;
  actorId?: string;
  auditContext?: AuditContext;
}) {
  return inTransaction(undefined, async (client) => {
    const release = await hydrateRelease(client, input.technicalAssetId, input.releaseId);
    if (input.actorId && input.auditContext) {
      await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_RELEASE_READ,
        objectType: AUDIT_OBJECT_TYPES.ASSET_RELEASE,
        objectId: release.id,
        context: commandContext(
          input.auditContext,
          input.actorId,
          input.auditContext.reason ?? "读取资产 Release",
          null
        ),
        after: { value: releaseAuditValue(release), allowedFields: ASSET_RELEASE_AUDIT_FIELDS }
      });
    }
    return { release: serializeRelease(release) };
  }).catch((error) => {
    mapDatabaseError(error);
  });
}
