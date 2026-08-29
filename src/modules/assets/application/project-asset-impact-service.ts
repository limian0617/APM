import {
  type AssetImpactDispositionType,
  type AssetProjectImpactStatus,
  Prisma
} from "@prisma/client";

import { decideAuthorization, type AuthorizationActor } from "@/lib/auth/authorize";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  ASSET_UPGRADE_IMPACT_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import type { JobExecution } from "@/modules/governance/contracts/jobs";

import {
  buildAssetDeactivationImpactAssessmentSource,
  buildAssetImpactAssessmentSource,
  nextAssetImpactStatus
} from "../domain/asset-upgrade-impact";
import {
  frozenProjectAssetUsageVersion,
  ProjectAssetUsageError
} from "../domain/project-asset-usage";
import { assertSensitiveFileReadAuthorized } from "./project-asset-usage-service";

type Client = Prisma.TransactionClient;

export class ProjectAssetImpactServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export type ImpactSnapshotUsage = {
  id: string;
  usageKey: string;
  version: number;
  status: "ACTIVE" | "RETIRED";
  referenceId: string;
  technicalAssetId: string;
  assetReleaseId: string;
  assetReleaseVersionId: string;
  releaseRevision: number;
  snapshotChecksum: string;
  sourceWatermark: string;
  componentSnapshotId: string;
  quantity: string;
  configurationJson: unknown;
  scopeType: string;
  scopeId: string;
  deliveryUnitId: string | null;
  moduleId: string | null;
  createdAt: Date;
  retiredAt: Date | null;
};

export type ImpactSnapshotReport = {
  id: string;
  snapshotChecksum: string;
  snapshotJson: unknown;
  acceptanceType?: string;
  status?: string;
  pdfFileId?: string;
  pdfSha256?: string;
  controlledDocumentVersionId?: string;
  generatedAt?: Date | null;
};

export type ImpactSnapshotReference = {
  id: string;
  technicalAssetId: string;
  assetReleaseId: string;
  assetReleaseVersionId: string;
  releaseCode: string;
  releaseRevision: number;
  snapshotChecksum: string;
  sourceWatermark: string;
  status: string;
  version: number;
  createdAt: Date;
  retiredAt: Date | null;
};

export type ImpactSnapshotDerivation = {
  id: string;
  sourceReferenceId: string;
  sourceUsageId: string;
  sourceTechnicalAssetId: string;
  sourceAssetReleaseId: string;
  sourceAssetReleaseVersionId: string;
  sourceComponentSnapshotId: string;
  sourceReleaseRevision: number;
  sourceSnapshotChecksum: string;
  sourceWatermark: string;
  targetControlledDocumentVersionId: string;
  targetMechanicalDrawingId: string | null;
  targetFileId: string;
  targetSourceFileSha256: string;
  targetType: string;
  targetDocumentVersion: number;
  targetDocumentVersionStatus: string;
  targetFileStatus: string;
  targetBindingKey: string;
  createdAt: Date;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactBinding(entry: Record<string, unknown>, usage: Record<string, unknown>) {
  return (
    entry.usageId === usage.usageId &&
    entry.version === usage.version &&
    entry.referenceId === usage.referenceId &&
    entry.technicalAssetId === usage.technicalAssetId &&
    entry.assetReleaseId === usage.assetReleaseId &&
    entry.assetReleaseVersionId === usage.assetReleaseVersionId &&
    entry.componentSnapshotId === usage.componentSnapshotId &&
    entry.revision === usage.releaseRevision &&
    entry.snapshotChecksum === usage.snapshotChecksum &&
    entry.sourceWatermark === usage.sourceWatermark
  );
}

function reportBinding(
  report: ImpactSnapshotReport,
  usages: ReadonlyMap<string, Record<string, unknown>>
) {
  const assetUsage = object(object(report.snapshotJson)?.assetUsage);
  const snapshot = object(assetUsage?.snapshot);
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  const usageBindings = entries
    .flatMap((entry) => {
      const value = object(entry);
      const usage = typeof value?.usageId === "string" ? usages.get(value.usageId) : null;
      return usage && exactBinding(value!, usage) ? [value as JsonValue] : [];
    })
    .sort((left, right) =>
      String((left as Record<string, JsonValue>).usageId).localeCompare(
        String((right as Record<string, JsonValue>).usageId)
      )
    );
  if (!usageBindings.length) return null;
  return {
    reportId: report.id,
    reportChecksum: report.snapshotChecksum,
    frozenAt: assetUsage?.frozenAt ?? null,
    usageSnapshotChecksum: assetUsage?.usageSnapshotChecksum ?? null,
    acceptanceType: report.acceptanceType ?? null,
    status: report.status ?? null,
    pdfFileId: report.pdfFileId ?? null,
    pdfSha256: report.pdfSha256 ?? null,
    controlledDocumentVersionId: report.controlledDocumentVersionId ?? null,
    generatedAt: report.generatedAt?.toISOString() ?? null,
    usageBindings
  };
}

export function buildProjectAssetImpactSnapshot(input: {
  frozenAt: Date;
  project?: { id: string; status: string; version: number };
  source?: Record<string, unknown>;
  owner?: Record<string, unknown> | null;
  dueAt?: Date | null;
  historicalOnly?: boolean;
  manualAssignmentRequired?: boolean;
  references?: readonly ImpactSnapshotReference[];
  usages: readonly ImpactSnapshotUsage[];
  derivations?: readonly ImpactSnapshotDerivation[];
  reports: readonly ImpactSnapshotReport[];
}) {
  const source = input.source ?? null;
  const references = (input.references ?? [])
    .map((reference) => ({
      referenceId: reference.id,
      technicalAssetId: reference.technicalAssetId,
      assetReleaseId: reference.assetReleaseId,
      assetReleaseVersionId: reference.assetReleaseVersionId,
      releaseCode: reference.releaseCode,
      releaseRevision: reference.releaseRevision,
      snapshotChecksum: reference.snapshotChecksum,
      sourceWatermark: reference.sourceWatermark,
      status: reference.status,
      version: reference.version,
      createdAt: reference.createdAt.toISOString(),
      retiredAt: reference.retiredAt?.toISOString() ?? null
    }))
    .sort((left, right) => left.referenceId.localeCompare(right.referenceId));
  const usages = input.usages
    .filter((usage) => usage.createdAt <= input.frozenAt)
    .map((usage) => {
      const retirementIsFuture = usage.retiredAt !== null && usage.retiredAt > input.frozenAt;
      const version = frozenProjectAssetUsageVersion(usage, input.frozenAt);
      return {
        usageId: usage.id,
        usageKey: usage.usageKey,
        version,
        status: retirementIsFuture ? ("ACTIVE" as const) : usage.status,
        referenceId: usage.referenceId,
        technicalAssetId: usage.technicalAssetId,
        assetReleaseId: usage.assetReleaseId,
        assetReleaseVersionId: usage.assetReleaseVersionId,
        releaseRevision: usage.releaseRevision,
        snapshotChecksum: usage.snapshotChecksum,
        sourceWatermark: usage.sourceWatermark,
        componentSnapshotId: usage.componentSnapshotId,
        quantity: usage.quantity,
        configurationJson: usage.configurationJson,
        scopeType: usage.scopeType,
        scopeId: usage.scopeId,
        deliveryUnitId: usage.deliveryUnitId,
        moduleId: usage.moduleId,
        createdAt: usage.createdAt.toISOString(),
        retiredAt: retirementIsFuture ? null : (usage.retiredAt?.toISOString() ?? null)
      };
    })
    .sort(
      (left, right) =>
        left.usageKey.localeCompare(right.usageKey) || left.usageId.localeCompare(right.usageId)
    );
  const usagesById = new Map(usages.map((usage) => [usage.usageId, usage]));
  const derivations = (input.derivations ?? [])
    .filter((derivation) => {
      const usage = usagesById.get(derivation.sourceUsageId);
      return (
        usage &&
        usage.referenceId === derivation.sourceReferenceId &&
        usage.technicalAssetId === derivation.sourceTechnicalAssetId &&
        usage.assetReleaseId === derivation.sourceAssetReleaseId &&
        usage.assetReleaseVersionId === derivation.sourceAssetReleaseVersionId &&
        usage.componentSnapshotId === derivation.sourceComponentSnapshotId &&
        usage.releaseRevision === derivation.sourceReleaseRevision &&
        usage.snapshotChecksum === derivation.sourceSnapshotChecksum &&
        usage.sourceWatermark === derivation.sourceWatermark
      );
    })
    .map((derivation) => ({
      derivationId: derivation.id,
      sourceReferenceId: derivation.sourceReferenceId,
      sourceUsageId: derivation.sourceUsageId,
      sourceTechnicalAssetId: derivation.sourceTechnicalAssetId,
      sourceAssetReleaseId: derivation.sourceAssetReleaseId,
      sourceAssetReleaseVersionId: derivation.sourceAssetReleaseVersionId,
      sourceComponentSnapshotId: derivation.sourceComponentSnapshotId,
      sourceReleaseRevision: derivation.sourceReleaseRevision,
      sourceSnapshotChecksum: derivation.sourceSnapshotChecksum,
      sourceWatermark: derivation.sourceWatermark,
      targetControlledDocumentVersionId: derivation.targetControlledDocumentVersionId,
      targetMechanicalDrawingId: derivation.targetMechanicalDrawingId,
      targetFileId: derivation.targetFileId,
      targetSourceFileSha256: derivation.targetSourceFileSha256,
      targetType: derivation.targetType,
      targetDocumentVersion: derivation.targetDocumentVersion,
      targetDocumentVersionStatus: derivation.targetDocumentVersionStatus,
      targetFileStatus: derivation.targetFileStatus,
      targetBindingKey: derivation.targetBindingKey,
      createdAt: derivation.createdAt.toISOString()
    }))
    .sort(
      (left, right) =>
        left.targetBindingKey.localeCompare(right.targetBindingKey) ||
        left.derivationId.localeCompare(right.derivationId)
    );
  const reports = input.reports
    .map((report) => reportBinding(report, usagesById))
    .filter((report): report is NonNullable<typeof report> => report !== null)
    .sort((left, right) => left.reportId.localeCompare(right.reportId));
  const snapshot = payloadHash({
    ...(source ?? {}),
    frozenAt: input.frozenAt.toISOString(),
    project: input.project ?? null,
    source,
    owner: input.owner ?? null,
    dueAt: input.dueAt?.toISOString() ?? null,
    historicalOnly: input.historicalOnly ?? false,
    manualAssignmentRequired: input.manualAssignmentRequired ?? false,
    references,
    usages,
    derivations,
    reports
  });
  return {
    snapshotJson: snapshot.value as JsonValue,
    snapshotChecksum: snapshot.hash
  };
}

type ImpactSource =
  | {
      sourceType: "RECALL";
      sourceKey: string;
      technicalAssetId: string;
      recallId: string;
      recallRevisionId: string;
      severity: "LOW" | "MEDIUM" | "HIGH";
      sourceFacts: Record<string, unknown>;
      affectedVersionIds: string[];
    }
  | {
      sourceType: "ASSET_DEACTIVATION";
      sourceKey: string;
      technicalAssetId: string;
      technicalAssetEventId: string;
      severity: "HIGH";
      sourceFacts: Record<string, unknown>;
      affectedVersionIds: null;
    };

function stableText(value: unknown, field: string, maximumLength = 1024) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximumLength) {
    throw new ProjectAssetImpactServiceError("VALIDATION_FAILED", `${field}格式无效。`, 422);
  }
  return value.trim();
}

function positiveVersion(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProjectAssetImpactServiceError("VALIDATION_FAILED", "version必须是正整数。", 422);
  }
  return value as number;
}

function canonicalEvidence(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    throw new ProjectAssetImpactServiceError(
      "VALIDATION_FAILED",
      "evidence必须是非空 JSON 对象。",
      422
    );
  }
  return payloadHash(value).value as Prisma.InputJsonValue;
}

async function databaseNow(client: Client) {
  const [row] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  if (!row) throw new Error("无法读取数据库时间。");
  return row.now;
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof ProjectAssetImpactServiceError || error instanceof ProjectAssetUsageError) {
    throw error;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2025") {
      throw new ProjectAssetImpactServiceError(
        "ASSET_PROJECT_IMPACT_NOT_FOUND",
        "项目资产影响不存在。",
        404
      );
    }
    if (error.code === "P2002" || error.code === "P2003" || error.code === "P2004") {
      throw new ProjectAssetImpactServiceError(
        "ASSET_PROJECT_IMPACT_CONFLICT",
        "项目资产影响关系或状态冲突。",
        409
      );
    }
  }
  throw error;
}

async function loadRecallSource(client: Client, recallRevisionId: string): Promise<ImpactSource> {
  const revision = await client.assetReleaseRecallRevision.findUnique({
    where: { id: recallRevisionId },
    include: {
      recall: {
        include: { affectedVersions: { orderBy: { assetReleaseVersionId: "asc" } } }
      }
    }
  });
  if (!revision) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_RELEASE_RECALL_REVISION_NOT_FOUND",
      "资产召回修订不存在。",
      404
    );
  }
  const recall = revision.recall;
  return {
    sourceType: "RECALL",
    sourceKey: `RECALL:${recall.id}`,
    technicalAssetId: recall.technicalAssetId,
    recallId: recall.id,
    recallRevisionId: revision.id,
    severity: revision.severity,
    affectedVersionIds: recall.affectedVersions.map(
      ({ assetReleaseVersionId }) => assetReleaseVersionId
    ),
    sourceFacts: {
      recallId: recall.id,
      recallRevisionId: revision.id,
      recallRevisionNumber: revision.revision,
      recallRevisionSnapshotChecksum: revision.snapshotChecksum,
      recallRevisionKind: revision.kind,
      recallRevisionState: revision.state,
      severity: revision.severity,
      affectedVersionSetChecksum: revision.affectedVersionSetChecksum,
      effectiveAt: revision.effectiveAt.toISOString()
    }
  };
}

function sourceSequence(source: ImpactSource) {
  return source.sourceType === "RECALL"
    ? (source.sourceFacts.recallRevisionNumber as number)
    : (source.sourceFacts.eventSequence as number);
}

function frozenSourceFact(snapshotJson: unknown, field: string) {
  const snapshot = object(snapshotJson);
  return snapshot?.[field] ?? object(snapshot?.source)?.[field];
}

async function loadDeactivationSource(client: Client, eventId: string): Promise<ImpactSource> {
  const event = await client.technicalAssetEvent.findUnique({ where: { id: eventId } });
  if (
    !event ||
    event.eventType !== "STATUS_CHANGED" ||
    event.fromStatus !== "VALIDATED" ||
    event.toStatus !== "DISABLED"
  ) {
    throw new ProjectAssetImpactServiceError(
      "TECHNICAL_ASSET_DEACTIVATION_EVENT_NOT_FOUND",
      "技术资产停用事件不存在。",
      404
    );
  }
  return {
    sourceType: "ASSET_DEACTIVATION",
    sourceKey: `ASSET_DEACTIVATION:${event.id}`,
    technicalAssetId: event.technicalAssetId,
    technicalAssetEventId: event.id,
    severity: "HIGH",
    affectedVersionIds: null,
    sourceFacts: {
      technicalAssetId: event.technicalAssetId,
      technicalAssetEventId: event.id,
      eventSequence: event.sequence,
      fromStatus: "VALIDATED",
      toStatus: "DISABLED",
      eventSnapshot: event.snapshotJson
    }
  };
}

async function loadSource(
  client: Client,
  input:
    | {
        eventType: "asset.release-recall.issued" | "asset.release-recall.revised";
        sourceId: string;
      }
    | { eventType: "asset.technical-asset.deactivated"; sourceId: string }
) {
  return input.eventType === "asset.technical-asset.deactivated"
    ? loadDeactivationSource(client, input.sourceId)
    : loadRecallSource(client, input.sourceId);
}

function referenceWhere(source: ImpactSource) {
  return source.sourceType === "RECALL"
    ? {
        technicalAssetId: source.technicalAssetId,
        assetReleaseVersionId: { in: source.affectedVersionIds }
      }
    : { technicalAssetId: source.technicalAssetId };
}

async function affectedProjectIds(client: Client, source: ImpactSource) {
  const rows = await client.projectAssetReference.findMany({
    where: referenceWhere(source),
    distinct: ["projectId"],
    orderBy: { projectId: "asc" },
    select: { projectId: true }
  });
  return rows.map(({ projectId }) => projectId).sort();
}

function membershipSnapshot(member: {
  id: string;
  userId: string;
  projectRole: string;
  departmentId: string | null;
  version: number;
}) {
  return {
    membershipId: member.id,
    userId: member.userId,
    projectRole: member.projectRole,
    departmentId: member.departmentId,
    version: member.version
  };
}

function dueAt(frozenAt: Date, severity: "LOW" | "MEDIUM" | "HIGH") {
  const days = severity === "HIGH" ? 3 : severity === "MEDIUM" ? 7 : 14;
  return new Date(frozenAt.getTime() + days * 86_400_000);
}

async function buildSnapshotFromDatabase(
  client: Client,
  input: { projectId: string; source: ImpactSource; frozenAt: Date }
) {
  const project = await client.project.findUnique({ where: { id: input.projectId } });
  if (!project) {
    throw new ProjectAssetImpactServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  }
  const references = await client.projectAssetReference.findMany({
    where: { projectId: project.id, ...referenceWhere(input.source) },
    orderBy: { id: "asc" }
  });
  const referenceIds = references.map(({ id }) => id);
  const usages = referenceIds.length
    ? await client.projectAssetUsage.findMany({
        where: { projectId: project.id, referenceId: { in: referenceIds } },
        orderBy: [{ usageKey: "asc" }, { id: "asc" }]
      })
    : [];
  const derivations = referenceIds.length
    ? await client.projectAssetDerivation.findMany({
        where: { projectId: project.id, sourceReferenceId: { in: referenceIds } },
        orderBy: [{ targetBindingKey: "asc" }, { id: "asc" }]
      })
    : [];
  const reports = await client.acceptanceReport.findMany({
    where: { projectId: project.id },
    orderBy: { id: "asc" }
  });
  const historicalOnly = project.status === "CLOSED" || project.status === "CANCELED";
  const owner = historicalOnly
    ? null
    : await client.projectMember.findFirst({
        where: { projectId: project.id, projectRole: "PROJECT_MANAGER", leftAt: null },
        orderBy: { id: "asc" }
      });
  const ownerSnapshot = owner ? membershipSnapshot(owner) : null;
  const deadline = owner ? dueAt(input.frozenAt, input.source.severity) : null;
  const projectFacts = {
    project: { id: project.id, status: project.status, version: project.version },
    owner: ownerSnapshot,
    references: references.map((reference) => ({
      ...reference,
      createdAt: reference.createdAt.toISOString(),
      updatedAt: reference.updatedAt.toISOString(),
      retiredAt: reference.retiredAt?.toISOString() ?? null
    })),
    usages: usages.map((usage) => ({
      ...usage,
      quantity: usage.quantity.toString(),
      createdAt: usage.createdAt.toISOString(),
      updatedAt: usage.updatedAt.toISOString(),
      retiredAt: usage.retiredAt?.toISOString() ?? null
    })),
    derivations: derivations.map((derivation) => ({
      ...derivation,
      createdAt: derivation.createdAt.toISOString()
    })),
    reports: reports.map((report) => ({
      id: report.id,
      snapshotChecksum: report.snapshotChecksum,
      status: report.status,
      pdfFileId: report.pdfFileId,
      pdfSha256: report.pdfSha256,
      controlledDocumentVersionId: report.controlledDocumentVersionId,
      generatedAt: report.generatedAt?.toISOString() ?? null,
      assetUsage: object(report.snapshotJson)?.assetUsage ?? null
    }))
  };
  const projectFactsWatermark = payloadHash(projectFacts).hash;
  const source =
    input.source.sourceType === "RECALL"
      ? buildAssetImpactAssessmentSource({
          recallId: input.source.recallId,
          recallRevisionId: input.source.recallRevisionId,
          recallRevisionNumber: input.source.sourceFacts.recallRevisionNumber as number,
          recallRevisionSnapshotChecksum: input.source.sourceFacts
            .recallRevisionSnapshotChecksum as string,
          recallRevisionKind: input.source.sourceFacts.recallRevisionKind as
            "ISSUED" | "CORRECTED" | "WITHDRAWN" | "REISSUED",
          recallRevisionState: input.source.sourceFacts.recallRevisionState as
            "ACTIVE" | "WITHDRAWN",
          projectFactsWatermark
        })
      : buildAssetDeactivationImpactAssessmentSource({
          technicalAssetId: input.source.technicalAssetId,
          technicalAssetEventId: input.source.technicalAssetEventId,
          eventSequence: input.source.sourceFacts.eventSequence as number,
          eventSnapshot: input.source.sourceFacts.eventSnapshot,
          projectFactsWatermark
        });
  const snapshot = buildProjectAssetImpactSnapshot({
    frozenAt: input.frozenAt,
    project: { id: project.id, status: project.status, version: project.version },
    source: { ...input.source.sourceFacts, ...source },
    owner: ownerSnapshot,
    dueAt: deadline,
    historicalOnly,
    manualAssignmentRequired: !historicalOnly && !owner,
    references,
    usages: usages.map((usage) => ({ ...usage, quantity: usage.quantity.toString() })),
    derivations,
    reports
  });
  return {
    project,
    owner,
    ownerSnapshot,
    dueAt: deadline,
    historicalOnly,
    manualAssignmentRequired: !historicalOnly && !owner,
    sourceWatermark: source.sourceWatermark,
    ...snapshot
  };
}

function workerAuditContext(operationId: string, projectId: string): AuditContext {
  return {
    actorId: null,
    requestId: null,
    traceId: null,
    source: "WORKER",
    sourceIp: null,
    userAgent: null,
    reason: "投影资产升级影响",
    projectId,
    departmentId: null,
    operationId
  };
}

function impactAuditFacts(input: {
  impactId: string;
  assessmentRevisionId: string;
  projectId: string;
  source: ImpactSource;
  snapshotChecksum: string;
  sourceWatermark: string;
  ownerMembershipId: string | null;
  dueAt: Date | null;
  historicalOnly: boolean;
  manualAssignmentRequired: boolean;
  resourceVersion: number;
}) {
  return {
    projectId: input.projectId,
    impactId: input.impactId,
    assessmentRevisionId: input.assessmentRevisionId,
    technicalAssetId: input.source.technicalAssetId,
    sourceType: input.source.sourceType,
    sourceKey: input.source.sourceKey,
    recallId: input.source.sourceType === "RECALL" ? input.source.recallId : null,
    recallRevisionId: input.source.sourceType === "RECALL" ? input.source.recallRevisionId : null,
    technicalAssetEventId:
      input.source.sourceType === "ASSET_DEACTIVATION" ? input.source.technicalAssetEventId : null,
    snapshotChecksum: input.snapshotChecksum,
    sourceWatermark: input.sourceWatermark,
    ownerMembershipId: input.ownerMembershipId,
    dueAt: input.dueAt?.toISOString() ?? null,
    historicalOnly: input.historicalOnly,
    manualAssignmentRequired: input.manualAssignmentRequired,
    resourceVersion: input.resourceVersion
  };
}

export async function projectAssetImpactsFromSourceEvent(input: {
  eventType:
    | "asset.technical-asset.deactivated"
    | "asset.release-recall.issued"
    | "asset.release-recall.revised";
  sourceId: string;
  eventFingerprint: string;
}) {
  const source = await db.$transaction((client) => loadSource(client, input));
  const projects = await db.$transaction((client) => affectedProjectIds(client, source));
  const results = [];
  for (const projectId of projects) {
    const result = await db.$transaction(
      async (client) => {
        await client.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE`;
        const frozenAt = await databaseNow(client);
        const snapshot = await buildSnapshotFromDatabase(client, { projectId, source, frozenAt });
        const existing = await client.assetProjectImpact.findUnique({
          where: { projectId_sourceKey: { projectId, sourceKey: source.sourceKey } },
          include: { currentAssessmentRevision: true }
        });
        if (existing) {
          const currentSnapshot = existing.currentAssessmentRevision?.snapshotJson;
          const currentSourceId =
            source.sourceType === "RECALL"
              ? frozenSourceFact(currentSnapshot, "recallRevisionId")
              : frozenSourceFact(currentSnapshot, "technicalAssetEventId");
          const currentSourceSequence =
            source.sourceType === "RECALL"
              ? frozenSourceFact(currentSnapshot, "recallRevisionNumber")
              : frozenSourceFact(currentSnapshot, "eventSequence");
          const availableSourceId =
            source.sourceType === "RECALL" ? source.recallRevisionId : source.technicalAssetEventId;
          if (
            typeof currentSourceSequence === "number" &&
            currentSourceSequence > sourceSequence(source)
          ) {
            return {
              impactId: existing.id,
              projectId,
              created: false,
              replayed: true,
              refreshRequired: false,
              currentSourceId,
              availableSourceId: currentSourceId,
              auditId: null,
              outboxEventId: null
            };
          }
          if (
            currentSourceId === availableSourceId &&
            existing.currentAssessmentRevision?.sourceWatermark === snapshot.sourceWatermark
          ) {
            const storedFingerprint = object(
              existing.currentAssessmentRevision.snapshotJson
            )?.projectionFingerprint;
            if (
              typeof storedFingerprint === "string" &&
              storedFingerprint !== input.eventFingerprint
            ) {
              throw new ProjectAssetImpactServiceError(
                "ASSET_IMPACT_EVENT_FINGERPRINT_CONFLICT",
                "同一资产影响来源事件的指纹不一致。",
                409
              );
            }
            return {
              impactId: existing.id,
              projectId,
              created: false,
              replayed: true,
              refreshRequired: false,
              currentSourceId,
              availableSourceId: currentSourceId,
              auditId: null,
              outboxEventId: null
            };
          }
          return {
            impactId: existing.id,
            projectId,
            created: false,
            replayed: false,
            refreshRequired: true,
            currentSourceId: currentSourceId ?? null,
            availableSourceId,
            auditId: null,
            outboxEventId: null
          };
        }

        const impact = await client.assetProjectImpact.create({
          data: {
            projectId,
            technicalAssetId: source.technicalAssetId,
            sourceType: source.sourceType,
            sourceKey: source.sourceKey,
            recallId: source.sourceType === "RECALL" ? source.recallId : null,
            technicalAssetEventId:
              source.sourceType === "ASSET_DEACTIVATION" ? source.technicalAssetEventId : null,
            ownerMembershipId: snapshot.owner?.id ?? null,
            dueAt: snapshot.dueAt
          }
        });
        const snapshotJson = object(snapshot.snapshotJson)!;
        snapshotJson.projectionFingerprint = input.eventFingerprint;
        const canonical = payloadHash(snapshotJson);
        const assessment = await client.assetImpactAssessmentRevision.create({
          data: {
            impactId: impact.id,
            projectId,
            technicalAssetId: source.technicalAssetId,
            sequence: 1,
            kind: "INITIAL",
            recallId: source.sourceType === "RECALL" ? source.recallId : null,
            recallRevisionId: source.sourceType === "RECALL" ? source.recallRevisionId : null,
            sourceWatermark: snapshot.sourceWatermark,
            snapshotChecksum: canonical.hash,
            snapshotJson: canonical.value as Prisma.InputJsonValue,
            frozenAt,
            ownerMembershipId: snapshot.owner?.id ?? null,
            ownerMembershipSnapshotJson:
              snapshot.ownerSnapshot === null
                ? Prisma.DbNull
                : (snapshot.ownerSnapshot as Prisma.InputJsonValue),
            dueAt: snapshot.dueAt
          }
        });
        await client.assetProjectImpact.update({
          where: { id: impact.id },
          data: { currentAssessmentRevisionId: assessment.id }
        });
        const facts = impactAuditFacts({
          impactId: impact.id,
          assessmentRevisionId: assessment.id,
          projectId,
          source,
          snapshotChecksum: assessment.snapshotChecksum,
          sourceWatermark: assessment.sourceWatermark,
          ownerMembershipId: snapshot.owner?.id ?? null,
          dueAt: snapshot.dueAt,
          historicalOnly: snapshot.historicalOnly,
          manualAssignmentRequired: snapshot.manualAssignmentRequired,
          resourceVersion: 1
        });
        const audit = await writeAudit(client, {
          action: AUDIT_ACTIONS.ASSET_PROJECT_IMPACT_CREATED,
          objectType: AUDIT_OBJECT_TYPES.ASSET_PROJECT_IMPACT,
          objectId: impact.id,
          context: workerAuditContext(`asset-impact:${source.sourceKey}:${projectId}`, projectId),
          after: { value: facts, allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS }
        });
        const outbox = await appendOutboxEvent(client, {
          eventType: "asset.impact.assessed",
          aggregateType: "ASSET_PROJECT_IMPACT",
          aggregateId: impact.id,
          idempotencyKey: `asset-impact:${assessment.id}:revision:1`,
          payload: facts
        });
        return {
          impactId: impact.id,
          projectId,
          created: true,
          replayed: false,
          refreshRequired: false,
          currentSourceId:
            source.sourceType === "RECALL" ? source.recallRevisionId : source.technicalAssetEventId,
          availableSourceId:
            source.sourceType === "RECALL" ? source.recallRevisionId : source.technicalAssetEventId,
          auditId: audit.id,
          outboxEventId: outbox.id
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
    results.push(result);
  }
  return { items: results };
}

function payloadId(payload: JsonValue, field: string) {
  const value = object(payload)?.[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_IMPACT_EVENT_INVALID",
      `事件缺少${field}。`,
      422
    );
  }
  return value;
}

export async function projectAssetImpactProjectionHandler(job: JobExecution) {
  if (
    job.jobType !== "asset.technical-asset.deactivated" &&
    job.jobType !== "asset.release-recall.issued" &&
    job.jobType !== "asset.release-recall.revised"
  ) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_IMPACT_EVENT_INVALID",
      "不支持的资产影响事件。",
      422
    );
  }
  const sourceId =
    job.jobType === "asset.technical-asset.deactivated"
      ? payloadId(job.payload, "eventId")
      : payloadId(job.payload, "recallRevisionId");
  return projectAssetImpactsFromSourceEvent({
    eventType: job.jobType,
    sourceId,
    eventFingerprint: job.payloadHash
  });
}

async function sourceForImpact(
  client: Client,
  impact: { recallId: string | null; technicalAssetEventId: string | null }
) {
  if (impact.recallId) {
    const recall = await client.assetReleaseRecall.findUnique({
      where: { id: impact.recallId },
      select: { currentRevisionId: true }
    });
    if (!recall?.currentRevisionId) {
      throw new ProjectAssetImpactServiceError(
        "ASSET_RELEASE_RECALL_REVISION_NOT_FOUND",
        "资产召回没有当前修订。",
        404
      );
    }
    return loadRecallSource(client, recall.currentRevisionId);
  }
  if (impact.technicalAssetEventId) {
    return loadDeactivationSource(client, impact.technicalAssetEventId);
  }
  throw new ProjectAssetImpactServiceError(
    "ASSET_PROJECT_IMPACT_SOURCE_INVALID",
    "项目资产影响缺少 exact source。",
    409
  );
}

function serializedImpact(
  impact: {
    id: string;
    projectId: string;
    technicalAssetId: string;
    sourceType: string;
    sourceKey: string;
    recallId: string | null;
    technicalAssetEventId: string | null;
    currentAssessmentRevisionId: string | null;
    status: string;
    ownerMembershipId: string | null;
    dueAt: Date | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    currentAssessmentRevision?: {
      id: string;
      sequence: number;
      kind: string;
      recallRevisionId: string | null;
      sourceWatermark: string;
      snapshotChecksum: string;
      snapshotJson: unknown;
      frozenAt: Date;
    } | null;
  },
  allowedActions: string[],
  sourceDrift: { refreshRequired: boolean; currentSourceId: unknown; availableSourceId: string }
) {
  return {
    ...impact,
    dueAt: impact.dueAt?.toISOString() ?? null,
    createdAt: impact.createdAt.toISOString(),
    updatedAt: impact.updatedAt.toISOString(),
    currentAssessmentRevision: impact.currentAssessmentRevision
      ? {
          ...impact.currentAssessmentRevision,
          frozenAt: impact.currentAssessmentRevision.frozenAt.toISOString()
        }
      : null,
    resourceVersion: impact.version,
    allowedActions,
    ...sourceDrift
  };
}

async function impactView(
  client: Client,
  impact: Prisma.AssetProjectImpactGetPayload<{
    include: { currentAssessmentRevision: true; ownerMembership: true; project: true };
  }>,
  input: { actorId: string; authorizationActor: AuthorizationActor; canManage: boolean }
) {
  const source = await sourceForImpact(client, impact);
  const currentSourceId =
    source.sourceType === "RECALL"
      ? (object(impact.currentAssessmentRevision?.snapshotJson)?.recallRevisionId ??
        object(object(impact.currentAssessmentRevision?.snapshotJson)?.source)?.recallRevisionId)
      : source.technicalAssetEventId;
  const frozenAt = await databaseNow(client);
  const available = await buildSnapshotFromDatabase(client, {
    projectId: impact.projectId,
    source,
    frozenAt
  });
  const refreshRequired =
    impact.currentAssessmentRevision?.sourceWatermark !== available.sourceWatermark;
  const riskRequest = await client.assetImpactRiskAcceptanceRequest.findFirst({
    where: {
      impactId: impact.id,
      projectId: impact.projectId,
      technicalAssetId: impact.technicalAssetId
    },
    include: { decisions: { orderBy: { decidedAt: "desc" }, take: 1 } },
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }]
  });
  const ownerIsActor =
    impact.ownerMembership?.userId === input.actorId &&
    impact.ownerMembership.leftAt === null &&
    impact.ownerMembership.projectRole === "PROJECT_MANAGER";
  const writableByOwner =
    input.canManage &&
    ownerIsActor &&
    input.authorizationActor.status === "ACTIVE" &&
    impact.project.status !== "CLOSED" &&
    impact.project.status !== "CANCELED";
  const decisionMembership =
    input.canManage &&
    input.authorizationActor.status === "ACTIVE" &&
    impact.status === "RISK_ACCEPTANCE_PENDING" &&
    riskRequest?.status === "PENDING"
      ? await client.projectMember.findFirst({
          where: {
            projectId: impact.projectId,
            userId: input.actorId,
            leftAt: null,
            projectRole: { in: ["QUALITY", "DEPARTMENT_LEAD"] },
            user: { status: "ACTIVE" }
          },
          orderBy: { id: "asc" }
        })
      : null;
  const technicalAsset = decisionMembership
    ? await client.technicalAsset.findUnique({
        where: { id: impact.technicalAssetId },
        select: { ownerId: true }
      })
    : null;
  const independentDecisionActor =
    decisionMembership !== null &&
    technicalAsset !== null &&
    input.actorId !== riskRequest?.requestedById &&
    input.actorId !== riskRequest?.sourceActorId &&
    input.actorId !== impact.ownerMembership?.userId &&
    input.actorId !== technicalAsset.ownerId;
  const allowedActions = independentDecisionActor
    ? ["APPROVE_RISK", "REJECT_RISK"]
    : refreshRequired
      ? writableByOwner
        ? ["REFRESH"]
        : []
      : !writableByOwner
        ? []
        : impact.status === "OPEN"
          ? ["ACKNOWLEDGE"]
          : impact.status === "ACKNOWLEDGED"
            ? ["START_ASSESSMENT"]
            : impact.status === "ASSESSING"
              ? ["PLAN_UPGRADE", "REQUEST_RISK"]
              : impact.status === "UPGRADE_PLANNED"
                ? ["REQUEST_RISK"]
                : impact.status === "MITIGATED" || impact.status === "ACCEPTED_RISK"
                  ? ["CLOSE"]
                  : [];
  const currentRiskAcceptanceRequest = riskRequest
    ? {
        id: riskRequest.id,
        requestId: riskRequest.id,
        impactId: riskRequest.impactId,
        projectId: riskRequest.projectId,
        technicalAssetId: riskRequest.technicalAssetId,
        status: riskRequest.status,
        version: riskRequest.version,
        resourceVersion: riskRequest.version,
        requestedById: riskRequest.requestedById,
        requestedMembershipId: riskRequest.requestedMembershipId,
        requestedMembershipSnapshotJson: riskRequest.requestedMembershipSnapshotJson,
        sourceActorId: riskRequest.sourceActorId,
        sourceActorSnapshotJson: riskRequest.sourceActorSnapshotJson,
        evidenceJson: riskRequest.evidenceJson,
        reason: riskRequest.reason,
        requestedAt: riskRequest.requestedAt.toISOString(),
        createdAt: riskRequest.createdAt.toISOString(),
        updatedAt: riskRequest.updatedAt.toISOString(),
        decision: riskRequest.decisions[0]
          ? {
              id: riskRequest.decisions[0].id,
              decision: riskRequest.decisions[0].decision,
              actorId: riskRequest.decisions[0].actorId,
              actorMembershipId: riskRequest.decisions[0].actorMembershipId,
              actorMembershipSnapshotJson: riskRequest.decisions[0].actorMembershipSnapshotJson,
              evidenceJson: riskRequest.decisions[0].evidenceJson,
              reason: riskRequest.decisions[0].reason,
              decidedAt: riskRequest.decisions[0].decidedAt.toISOString(),
              createdAt: riskRequest.decisions[0].createdAt.toISOString()
            }
          : null
      }
    : null;
  return {
    item: {
      ...serializedImpact(impact, allowedActions, {
        refreshRequired,
        currentSourceId: currentSourceId ?? null,
        availableSourceId:
          source.sourceType === "RECALL" ? source.recallRevisionId : source.technicalAssetEventId
      }),
      currentRiskAcceptanceRequest
    },
    allowedActions
  };
}

export async function assertSnapshotReadAuthorized(
  client: Client,
  snapshotJson: unknown,
  actor: AuthorizationActor,
  projectId: string
) {
  const snapshot = object(snapshotJson);
  const derivations = Array.isArray(snapshot?.derivations) ? snapshot.derivations : [];
  const reports = Array.isArray(snapshot?.reports) ? snapshot.reports : [];
  if (!derivations.length && !reports.length) return;
  const project = await client.project.findUnique({
    where: { id: projectId },
    select: {
      departmentId: true,
      members: {
        where: { userId: actor.id, leftAt: null },
        select: { projectRole: true }
      }
    }
  });
  const bindings = [
    ...derivations.map((value) => {
      const derivation = object(value);
      return {
        sourceType: "DERIVATION" as const,
        sourceId: derivation?.derivationId,
        documentVersionId: derivation?.targetControlledDocumentVersionId,
        fileId: derivation?.targetFileId,
        sha256: derivation?.targetSourceFileSha256
      };
    }),
    ...reports.map((value) => {
      const report = object(value);
      return {
        sourceType: "REPORT" as const,
        sourceId: report?.reportId,
        documentVersionId: report?.controlledDocumentVersionId,
        fileId: report?.pdfFileId,
        sha256: report?.pdfSha256
      };
    })
  ];
  if (
    !project ||
    bindings.some(
      ({ sourceId, documentVersionId, fileId, sha256 }) =>
        typeof sourceId !== "string" ||
        typeof documentVersionId !== "string" ||
        typeof fileId !== "string" ||
        typeof sha256 !== "string"
    )
  ) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_PROJECT_IMPACT_SOURCE_NOT_FOUND",
      "项目资产影响的冻结来源不完整或不存在。",
      404
    );
  }
  const derivationBindings = bindings.filter(({ sourceType }) => sourceType === "DERIVATION");
  const reportBindings = bindings.filter(({ sourceType }) => sourceType === "REPORT");
  const storedDerivations = derivationBindings.length
    ? await client.projectAssetDerivation.findMany({
        where: {
          id: { in: derivationBindings.map(({ sourceId }) => sourceId as string).sort() },
          projectId
        },
        select: {
          id: true,
          targetControlledDocumentVersionId: true,
          targetFileId: true,
          targetSourceFileSha256: true
        }
      })
    : [];
  const storedReports = reportBindings.length
    ? await client.acceptanceReport.findMany({
        where: {
          id: { in: reportBindings.map(({ sourceId }) => sourceId as string).sort() },
          projectId
        },
        select: {
          id: true,
          controlledDocumentVersionId: true,
          pdfFileId: true,
          pdfSha256: true
        }
      })
    : [];
  const exactSources = new Set([
    ...storedDerivations.map(
      (value) =>
        `DERIVATION:${value.id}:${value.targetControlledDocumentVersionId}:${value.targetFileId}:${value.targetSourceFileSha256}`
    ),
    ...storedReports.map(
      (value) =>
        `REPORT:${value.id}:${value.controlledDocumentVersionId}:${value.pdfFileId}:${value.pdfSha256}`
    )
  ]);
  if (
    exactSources.size !== bindings.length ||
    bindings.some(
      ({ sourceType, sourceId, documentVersionId, fileId, sha256 }) =>
        !exactSources.has(`${sourceType}:${sourceId}:${documentVersionId}:${fileId}:${sha256}`)
    )
  ) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_PROJECT_IMPACT_SOURCE_NOT_FOUND",
      "项目资产影响的冻结派生或报告来源关系不存在。",
      404
    );
  }
  const documentVersionIds = [
    ...new Set(bindings.map(({ documentVersionId }) => documentVersionId as string))
  ].sort();
  const documentVersions = await client.controlledDocumentVersion.findMany({
    where: { id: { in: documentVersionIds }, projectId },
    select: { id: true, status: true, document: { select: { status: true, createdById: true } } }
  });
  if (
    documentVersions.length !== documentVersionIds.length ||
    documentVersions.some(
      (version) => version.status === "VOIDED" || version.document.status === "VOIDED"
    )
  ) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_PROJECT_IMPACT_SOURCE_NOT_FOUND",
      "项目资产影响的受控文档来源不存在或不可用。",
      404
    );
  }
  for (const version of documentVersions) {
    if (
      !decideAuthorization(actor, PERMISSIONS.CONTROLLED_DOCUMENT_READ, {
        projectId,
        resourceDepartmentId: project.departmentId,
        resourceOwnerId: version.document.createdById,
        memberRoles: project.members.map(({ projectRole }) => projectRole),
        requireProjectMembership: true
      }).allowed
    ) {
      throw new ProjectAssetImpactServiceError(
        "ASSET_PROJECT_IMPACT_SOURCE_DENIED",
        "无权读取影响快照中的受控文档来源。",
        403
      );
    }
  }
  const expectedFiles = new Map<string, string>();
  for (const binding of bindings) {
    const fileId = binding.fileId as string;
    const sha256 = binding.sha256 as string;
    if (expectedFiles.has(fileId) && expectedFiles.get(fileId) !== sha256) {
      throw new ProjectAssetImpactServiceError(
        "ASSET_PROJECT_IMPACT_SOURCE_NOT_FOUND",
        "项目资产影响的冻结文件校验值冲突。",
        404
      );
    }
    expectedFiles.set(fileId, sha256);
  }
  const fileIds = [...expectedFiles.keys()].sort();
  const files = await client.fileObject.findMany({
    where: { id: { in: [...new Set(fileIds)].sort() }, projectId },
    select: {
      id: true,
      projectId: true,
      status: true,
      sensitivity: true,
      sha256: true,
      uploadedById: true,
      project: {
        select: {
          departmentId: true,
          members: {
            where: { userId: actor.id, leftAt: null },
            select: { projectRole: true }
          }
        }
      }
    }
  });
  if (
    files.length !== fileIds.length ||
    files.some((file) => file.status !== "AVAILABLE" || file.sha256 !== expectedFiles.get(file.id))
  ) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_PROJECT_IMPACT_SOURCE_NOT_FOUND",
      "项目资产影响文件来源不存在、不可用或校验值不一致。",
      404
    );
  }
  for (const file of files) assertSensitiveFileReadAuthorized(file, actor);
}

export async function listProjectAssetImpacts(input: {
  projectId: string;
  cursor?: string;
  limit: number;
  actorId: string;
  authorizationActor: AuthorizationActor;
  canManage: boolean;
  auditContext: AuditContext;
}) {
  try {
    return await db.$transaction(
      async (client) => {
        const rows = await client.assetProjectImpact.findMany({
          where: { projectId: input.projectId },
          include: { currentAssessmentRevision: true, ownerMembership: true, project: true },
          orderBy: { id: "asc" },
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          take: input.limit + 1
        });
        const page = rows.slice(0, input.limit);
        const items = [];
        for (const row of page) {
          if (row.currentAssessmentRevision) {
            await assertSnapshotReadAuthorized(
              client,
              row.currentAssessmentRevision.snapshotJson,
              input.authorizationActor,
              input.projectId
            );
          }
          items.push((await impactView(client, row, input)).item);
        }
        const audit = await writeAudit(client, {
          action: AUDIT_ACTIONS.ASSET_PROJECT_IMPACT_READ,
          objectType: AUDIT_OBJECT_TYPES.ASSET_PROJECT_IMPACT,
          objectId: input.projectId,
          context: { ...input.auditContext, actorId: input.actorId, projectId: input.projectId },
          after: {
            value: { projectId: input.projectId, returnedCount: items.length },
            allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS
          }
        });
        return {
          items,
          nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
          allowedActions: [],
          auditId: audit.id,
          outboxEventId: null
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function getProjectAssetImpact(input: {
  projectId: string;
  impactId: string;
  actorId: string;
  authorizationActor: AuthorizationActor;
  canManage: boolean;
  auditContext: AuditContext;
}) {
  try {
    return await db.$transaction(
      async (client) => {
        const impact = await client.assetProjectImpact.findFirst({
          where: { id: input.impactId, projectId: input.projectId },
          include: { currentAssessmentRevision: true, ownerMembership: true, project: true }
        });
        if (!impact) {
          throw new ProjectAssetImpactServiceError(
            "ASSET_PROJECT_IMPACT_NOT_FOUND",
            "项目资产影响不存在。",
            404
          );
        }
        if (impact.currentAssessmentRevision) {
          await assertSnapshotReadAuthorized(
            client,
            impact.currentAssessmentRevision.snapshotJson,
            input.authorizationActor,
            input.projectId
          );
        }
        const view = await impactView(client, impact, input);
        const audit = await writeAudit(client, {
          action: AUDIT_ACTIONS.ASSET_PROJECT_IMPACT_READ,
          objectType: AUDIT_OBJECT_TYPES.ASSET_PROJECT_IMPACT,
          objectId: impact.id,
          context: { ...input.auditContext, actorId: input.actorId, projectId: input.projectId },
          after: {
            value: {
              projectId: input.projectId,
              impactId: impact.id,
              resourceVersion: impact.version
            },
            allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS
          }
        });
        return {
          item: view.item,
          impact: view.item,
          resourceVersion: impact.version,
          allowedActions: view.allowedActions,
          auditId: audit.id,
          outboxEventId: null
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  } catch (error) {
    mapDatabaseError(error);
  }
}

async function lockCommandImpact(
  client: Client,
  input: {
    projectId: string;
    impactId: string;
    version: number;
    actorId: string;
  }
) {
  const identity = await client.assetProjectImpact.findFirst({
    where: { id: input.impactId, projectId: input.projectId },
    select: {
      technicalAssetId: true,
      recallId: true,
      technicalAssetEventId: true
    }
  });
  if (!identity) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_PROJECT_IMPACT_NOT_FOUND",
      "项目资产影响不存在。",
      404
    );
  }
  await client.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${input.projectId} FOR UPDATE`;
  await lockImpactSource(client, identity);
  await client.$queryRaw`SELECT "id" FROM "asset_project_impacts" WHERE "id" = ${input.impactId} AND "project_id" = ${input.projectId} FOR UPDATE`;
  const impact = await client.assetProjectImpact.findFirst({
    where: { id: input.impactId, projectId: input.projectId },
    include: { project: true, currentAssessmentRevision: true, ownerMembership: true }
  });
  if (!impact) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_PROJECT_IMPACT_NOT_FOUND",
      "项目资产影响不存在。",
      404
    );
  }
  if (impact.version !== positiveVersion(input.version)) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_IMPACT_VERSION_CONFLICT",
      "项目资产影响版本冲突。",
      409
    );
  }
  if (impact.project.status === "CLOSED" || impact.project.status === "CANCELED") {
    throw new ProjectAssetImpactServiceError(
      "ASSET_PROJECT_IMPACT_HISTORICAL_ONLY",
      "关闭或取消项目的资产影响仅供历史读取。",
      409
    );
  }
  if (!impact.currentAssessmentRevision) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_PROJECT_IMPACT_INCOMPLETE",
      "项目资产影响缺少当前评估事实。",
      409
    );
  }
  const actorMembership = await client.projectMember.findFirst({
    where: { projectId: input.projectId, userId: input.actorId, leftAt: null },
    orderBy: { id: "asc" }
  });
  if (!actorMembership) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_IMPACT_ACTOR_MEMBERSHIP_REQUIRED",
      "资产影响命令要求有效项目成员身份。",
      403
    );
  }
  return {
    impact,
    currentAssessmentRevision: impact.currentAssessmentRevision,
    actorMembership
  };
}

export async function lockImpactSource(
  client: Client,
  impact: {
    technicalAssetId: string;
    recallId: string | null;
    technicalAssetEventId: string | null;
  }
) {
  const asset = await client.technicalAsset.findUnique({
    where: { id: impact.technicalAssetId },
    select: { rndProjectId: true }
  });
  if (!asset) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_PROJECT_IMPACT_SOURCE_NOT_FOUND",
      "项目资产影响的技术资产来源不存在。",
      404
    );
  }
  await client.$queryRaw`SELECT "id" FROM "rnd_projects" WHERE "id" = ${asset.rndProjectId} FOR UPDATE`;
  await client.$queryRaw`SELECT "id" FROM "technical_assets" WHERE "id" = ${impact.technicalAssetId} FOR UPDATE`;
  if (impact.recallId) {
    const recall = await client.assetReleaseRecall.findFirst({
      where: { id: impact.recallId, technicalAssetId: impact.technicalAssetId },
      select: {
        releaseId: true,
        affectedVersions: {
          orderBy: { assetReleaseVersionId: "asc" },
          select: { assetReleaseVersionId: true }
        }
      }
    });
    if (!recall) {
      throw new ProjectAssetImpactServiceError(
        "ASSET_PROJECT_IMPACT_SOURCE_NOT_FOUND",
        "项目资产影响的召回来源不存在。",
        404
      );
    }
    await client.$queryRaw`SELECT "id" FROM "asset_releases" WHERE "id" = ${recall.releaseId} AND "technical_asset_id" = ${impact.technicalAssetId} FOR UPDATE`;
    const versionIds = recall.affectedVersions.map(
      ({ assetReleaseVersionId }) => assetReleaseVersionId
    );
    if (versionIds.length) {
      await client.$queryRaw`SELECT "id" FROM "asset_release_versions" WHERE "technical_asset_id" = ${impact.technicalAssetId} AND "id" IN (${Prisma.join(versionIds)}) ORDER BY "id" FOR UPDATE`;
    }
    await client.$queryRaw`SELECT "id" FROM "asset_release_recalls" WHERE "id" = ${impact.recallId} AND "technical_asset_id" = ${impact.technicalAssetId} FOR UPDATE`;
    await client.$queryRaw`SELECT revision."id" FROM "asset_release_recalls" recall JOIN "asset_release_recall_revisions" revision ON revision."id" = recall."current_revision_id" WHERE recall."id" = ${impact.recallId} AND recall."technical_asset_id" = ${impact.technicalAssetId} FOR UPDATE OF revision`;
  } else if (impact.technicalAssetEventId) {
    await client.$queryRaw`SELECT "id" FROM "technical_asset_events" WHERE "id" = ${impact.technicalAssetEventId} AND "technical_asset_id" = ${impact.technicalAssetId} FOR UPDATE`;
  } else {
    throw new ProjectAssetImpactServiceError(
      "ASSET_PROJECT_IMPACT_SOURCE_INVALID",
      "项目资产影响缺少 exact source。",
      409
    );
  }
}

export async function assertImpactAssessmentCurrent(
  client: Client,
  impact: {
    id: string;
    projectId: string;
    technicalAssetId: string;
    recallId: string | null;
    technicalAssetEventId: string | null;
    currentAssessmentRevision: { sourceWatermark: string } | null;
  }
) {
  if (!impact.currentAssessmentRevision) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_PROJECT_IMPACT_INCOMPLETE",
      "项目资产影响缺少当前评估事实。",
      409
    );
  }
  const source = await sourceForImpact(client, impact);
  const authoritative = await buildSnapshotFromDatabase(client, {
    projectId: impact.projectId,
    source,
    frozenAt: await databaseNow(client)
  });
  if (authoritative.sourceWatermark !== impact.currentAssessmentRevision.sourceWatermark) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_IMPACT_REFRESH_REQUIRED",
      "项目资产影响来源或项目事实已变化，请先刷新评估。",
      409
    );
  }
  return source;
}

function commandAuditContext(input: {
  auditContext: AuditContext;
  actorId: string;
  projectId: string;
  reason: string;
}) {
  return {
    ...input.auditContext,
    actorId: input.actorId,
    projectId: input.projectId,
    reason: input.reason
  };
}

export async function refreshProjectAssetImpact(
  input: {
    projectId: string;
    impactId: string;
    version: unknown;
    reason: unknown;
    evidence: unknown;
    actorId: string;
    authorizationActor: AuthorizationActor;
    auditContext: AuditContext;
  },
  transaction?: Client
) {
  try {
    return await inTransaction(transaction, async (client) => {
      const reason = stableText(input.reason, "reason");
      const evidence = canonicalEvidence(input.evidence);
      const { impact, currentAssessmentRevision, actorMembership } = await lockCommandImpact(
        client,
        {
          projectId: input.projectId,
          impactId: input.impactId,
          version: positiveVersion(input.version),
          actorId: input.actorId
        }
      );
      if (
        input.authorizationActor.id !== input.actorId ||
        input.authorizationActor.status !== "ACTIVE"
      ) {
        throw new ProjectAssetImpactServiceError(
          "ASSET_IMPACT_ACTOR_INVALID",
          "资产影响操作人无效。",
          403
        );
      }
      const frozenAt = await databaseNow(client);
      const source = await sourceForImpact(client, impact);
      const snapshot = await buildSnapshotFromDatabase(client, {
        projectId: input.projectId,
        source,
        frozenAt
      });
      if (snapshot.sourceWatermark === currentAssessmentRevision.sourceWatermark) {
        throw new ProjectAssetImpactServiceError(
          "ASSET_IMPACT_REFRESH_UNCHANGED",
          "召回来源与项目事实均未变化，无需刷新。",
          409
        );
      }
      if (!snapshot.owner || !snapshot.ownerSnapshot || !snapshot.dueAt) {
        throw new ProjectAssetImpactServiceError(
          "ASSET_IMPACT_OWNER_REQUIRED",
          "刷新要求当前项目存在有效项目经理 Owner。",
          409
        );
      }
      const assessmentSequence = currentAssessmentRevision.sequence + 1;
      const assessment = await client.assetImpactAssessmentRevision.create({
        data: {
          impactId: impact.id,
          projectId: impact.projectId,
          technicalAssetId: impact.technicalAssetId,
          sequence: assessmentSequence,
          kind: "REFRESH",
          recallId: source.sourceType === "RECALL" ? source.recallId : null,
          recallRevisionId: source.sourceType === "RECALL" ? source.recallRevisionId : null,
          sourceWatermark: snapshot.sourceWatermark,
          snapshotChecksum: snapshot.snapshotChecksum,
          snapshotJson: snapshot.snapshotJson as Prisma.InputJsonValue,
          frozenAt,
          actorId: input.actorId,
          actorMembershipId: actorMembership.id,
          actorMembershipSnapshotJson: membershipSnapshot(actorMembership),
          ownerMembershipId: snapshot.owner.id,
          ownerMembershipSnapshotJson: snapshot.ownerSnapshot,
          dueAt: snapshot.dueAt
        }
      });
      const dispositionSequence =
        (await client.assetImpactDisposition.count({ where: { impactId: impact.id } })) + 1;
      const disposition = await client.assetImpactDisposition.create({
        data: {
          impactId: impact.id,
          projectId: impact.projectId,
          technicalAssetId: impact.technicalAssetId,
          assessmentRevisionId: assessment.id,
          sequence: dispositionSequence,
          type: "REFRESHED",
          fromStatus: impact.status,
          toStatus: "OPEN",
          reason,
          evidenceJson: evidence,
          actorId: input.actorId,
          actorMembershipId: actorMembership.id,
          actorMembershipSnapshotJson: membershipSnapshot(actorMembership),
          ownerMembershipId: snapshot.owner.id,
          ownerMembershipSnapshotJson: snapshot.ownerSnapshot,
          dueAt: snapshot.dueAt
        }
      });
      const updated = await client.assetProjectImpact.update({
        where: { id: impact.id },
        data: {
          currentAssessmentRevisionId: assessment.id,
          status: "OPEN",
          ownerMembershipId: snapshot.owner.id,
          dueAt: snapshot.dueAt,
          version: { increment: 1 }
        }
      });
      const facts = {
        projectId: impact.projectId,
        impactId: impact.id,
        assessmentRevisionId: assessment.id,
        dispositionId: disposition.id,
        technicalAssetId: impact.technicalAssetId,
        sourceType: impact.sourceType,
        sourceKey: impact.sourceKey,
        sequence: assessment.sequence,
        fromStatus: impact.status,
        toStatus: updated.status,
        sourceWatermark: assessment.sourceWatermark,
        snapshotChecksum: assessment.snapshotChecksum,
        ownerMembershipId: snapshot.owner.id,
        dueAt: snapshot.dueAt.toISOString(),
        resourceVersion: updated.version,
        reason
      };
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_PROJECT_IMPACT_REFRESHED,
        objectType: AUDIT_OBJECT_TYPES.ASSET_PROJECT_IMPACT,
        objectId: impact.id,
        context: commandAuditContext({ ...input, reason }),
        after: { value: facts, allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "asset.impact.assessed",
        aggregateType: "ASSET_PROJECT_IMPACT",
        aggregateId: impact.id,
        idempotencyKey: `asset-impact:${assessment.id}:revision:${assessment.sequence}`,
        payload: facts
      });
      return {
        item: { ...updated, resourceVersion: updated.version },
        impact: { ...updated, resourceVersion: updated.version },
        resourceVersion: updated.version,
        allowedActions: ["ACKNOWLEDGE"],
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

const dispositionByAction = {
  ACKNOWLEDGE: { domain: "ACKNOWLEDGE", type: "ACKNOWLEDGED" },
  START_ASSESSMENT: { domain: "ASSESS", type: "ASSESSING" },
  PLAN_UPGRADE: { domain: "PLAN_UPGRADE", type: "UPGRADE_PLANNED" }
} as const;

export async function recordProjectAssetImpactDisposition(
  input: {
    projectId: string;
    impactId: string;
    action: keyof typeof dispositionByAction;
    version: unknown;
    reason: unknown;
    evidence: unknown;
    actorId: string;
    authorizationActor: AuthorizationActor;
    auditContext: AuditContext;
  },
  transaction?: Client
) {
  try {
    return await inTransaction(transaction, async (client) => {
      const reason = stableText(input.reason, "reason");
      const evidence = canonicalEvidence(input.evidence);
      const { impact, currentAssessmentRevision, actorMembership } = await lockCommandImpact(
        client,
        {
          projectId: input.projectId,
          impactId: input.impactId,
          version: positiveVersion(input.version),
          actorId: input.actorId
        }
      );
      if (
        input.authorizationActor.id !== input.actorId ||
        input.authorizationActor.status !== "ACTIVE" ||
        !impact.ownerMembership ||
        impact.ownerMembership.userId !== input.actorId ||
        impact.ownerMembership.leftAt !== null ||
        impact.ownerMembership.projectRole !== "PROJECT_MANAGER" ||
        !impact.dueAt
      ) {
        throw new ProjectAssetImpactServiceError(
          "ASSET_IMPACT_OWNER_REQUIRED",
          "基础处置要求当前有效项目经理 Owner 执行。",
          403
        );
      }
      await assertImpactAssessmentCurrent(client, impact);
      const transition = dispositionByAction[input.action];
      if (!transition) {
        throw new ProjectAssetImpactServiceError(
          "ASSET_IMPACT_TRANSITION_INVALID",
          "不支持的资产影响基础处置。",
          422
        );
      }
      let toStatus: AssetProjectImpactStatus;
      try {
        toStatus = nextAssetImpactStatus(impact.status, transition.domain);
      } catch {
        throw new ProjectAssetImpactServiceError(
          "ASSET_IMPACT_TRANSITION_INVALID",
          "当前资产影响状态不允许该处置。",
          409
        );
      }
      const dispositionSequence =
        (await client.assetImpactDisposition.count({ where: { impactId: impact.id } })) + 1;
      const ownerSnapshot = membershipSnapshot(impact.ownerMembership);
      const disposition = await client.assetImpactDisposition.create({
        data: {
          impactId: impact.id,
          projectId: impact.projectId,
          technicalAssetId: impact.technicalAssetId,
          assessmentRevisionId: currentAssessmentRevision.id,
          sequence: dispositionSequence,
          type: transition.type as AssetImpactDispositionType,
          fromStatus: impact.status,
          toStatus,
          reason,
          evidenceJson: evidence,
          actorId: input.actorId,
          actorMembershipId: actorMembership.id,
          actorMembershipSnapshotJson: membershipSnapshot(actorMembership),
          ownerMembershipId: impact.ownerMembership.id,
          ownerMembershipSnapshotJson: ownerSnapshot,
          dueAt: impact.dueAt
        }
      });
      const updated = await client.assetProjectImpact.update({
        where: { id: impact.id },
        data: { status: toStatus, version: { increment: 1 } }
      });
      const facts = {
        projectId: impact.projectId,
        impactId: impact.id,
        assessmentRevisionId: currentAssessmentRevision.id,
        dispositionId: disposition.id,
        technicalAssetId: impact.technicalAssetId,
        sourceType: impact.sourceType,
        sourceKey: impact.sourceKey,
        sequence: disposition.sequence,
        fromStatus: impact.status,
        toStatus,
        ownerMembershipId: impact.ownerMembership.id,
        dueAt: impact.dueAt.toISOString(),
        resourceVersion: updated.version,
        reason
      };
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_PROJECT_IMPACT_DISPOSITION_RECORDED,
        objectType: AUDIT_OBJECT_TYPES.ASSET_PROJECT_IMPACT,
        objectId: impact.id,
        context: commandAuditContext({ ...input, reason }),
        after: { value: facts, allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "asset.impact.disposition-recorded",
        aggregateType: "ASSET_PROJECT_IMPACT",
        aggregateId: impact.id,
        idempotencyKey: `asset-impact:${impact.id}:disposition:${disposition.sequence}`,
        payload: facts
      });
      return {
        item: { ...updated, resourceVersion: updated.version },
        impact: { ...updated, resourceVersion: updated.version },
        resourceVersion: updated.version,
        allowedActions:
          toStatus === "ACKNOWLEDGED"
            ? ["START_ASSESSMENT"]
            : toStatus === "ASSESSING"
              ? ["PLAN_UPGRADE"]
              : [],
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

function assertActiveCommandActor(input: {
  actorId: string;
  authorizationActor: AuthorizationActor;
}) {
  if (
    input.authorizationActor.id !== input.actorId ||
    input.authorizationActor.status !== "ACTIVE"
  ) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_IMPACT_ACTOR_INVALID",
      "资产影响操作人无效。",
      403
    );
  }
}

function assertCurrentProjectManagerOwner(
  impact: Prisma.AssetProjectImpactGetPayload<{
    include: { ownerMembership: true; currentAssessmentRevision: true };
  }>,
  actorId: string
) {
  if (
    !impact.ownerMembership ||
    impact.ownerMembership.userId !== actorId ||
    impact.ownerMembership.leftAt !== null ||
    impact.ownerMembership.projectRole !== "PROJECT_MANAGER" ||
    !impact.currentAssessmentRevision?.ownerMembershipId ||
    !impact.currentAssessmentRevision.ownerMembershipSnapshotJson ||
    !impact.currentAssessmentRevision.dueAt
  ) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_IMPACT_OWNER_REQUIRED",
      "风险处置要求当前有效项目经理 Owner 执行。",
      403
    );
  }
  return impact.ownerMembership;
}

async function exactRiskSourceActor(
  client: Client,
  impact: {
    recallId: string | null;
    technicalAssetEventId: string | null;
    technicalAssetId: string;
    currentAssessmentRevision: { recallRevisionId: string | null } | null;
  }
) {
  const userSelect = {
    id: true,
    employeeNo: true,
    name: true,
    departmentId: true,
    status: true,
    version: true
  } as const;
  const actor =
    impact.recallId && impact.currentAssessmentRevision?.recallRevisionId
      ? (
          await client.assetReleaseRecallRevision.findFirst({
            where: {
              id: impact.currentAssessmentRevision.recallRevisionId,
              recallId: impact.recallId,
              technicalAssetId: impact.technicalAssetId
            },
            select: { actor: { select: userSelect } }
          })
        )?.actor
      : impact.technicalAssetEventId
        ? (
            await client.technicalAssetEvent.findFirst({
              where: {
                id: impact.technicalAssetEventId,
                technicalAssetId: impact.technicalAssetId
              },
              select: { actor: { select: userSelect } }
            })
          )?.actor
        : null;
  if (!actor) {
    throw new ProjectAssetImpactServiceError(
      "ASSET_PROJECT_IMPACT_SOURCE_NOT_FOUND",
      "项目资产影响的 exact 来源操作人不存在。",
      404
    );
  }
  return {
    actor,
    snapshot: {
      actorId: actor.id,
      employeeNo: actor.employeeNo,
      name: actor.name,
      departmentId: actor.departmentId,
      status: actor.status,
      version: actor.version
    }
  };
}

function riskCommandResult(input: {
  impact: { id: string; status: AssetProjectImpactStatus; version: number };
  riskAcceptanceRequest: { id: string; status: string; version: number };
  allowedActions: string[];
  auditId: string;
  outboxEventId: string;
}) {
  const riskAcceptanceRequest = {
    ...input.riskAcceptanceRequest,
    requestId: input.riskAcceptanceRequest.id,
    resourceVersion: input.riskAcceptanceRequest.version
  };
  const impact = { ...input.impact, resourceVersion: input.impact.version };
  return {
    item: { ...impact, currentRiskAcceptanceRequest: riskAcceptanceRequest },
    impact,
    riskAcceptanceRequest,
    resourceVersion: input.impact.version,
    allowedActions: input.allowedActions,
    auditId: input.auditId,
    outboxEventId: input.outboxEventId
  };
}

export async function requestProjectAssetImpactRiskAcceptance(
  input: {
    projectId: string;
    impactId: string;
    version: unknown;
    reason: unknown;
    evidence: unknown;
    actorId: string;
    authorizationActor: AuthorizationActor;
    auditContext: AuditContext;
  },
  transaction?: Client
) {
  try {
    return await inTransaction(transaction, async (client) => {
      const reason = stableText(input.reason, "reason");
      const evidence = canonicalEvidence(input.evidence);
      assertActiveCommandActor(input);
      const { impact, currentAssessmentRevision } = await lockCommandImpact(client, {
        projectId: input.projectId,
        impactId: input.impactId,
        version: positiveVersion(input.version),
        actorId: input.actorId
      });
      const owner = assertCurrentProjectManagerOwner(impact, input.actorId);
      if (impact.status !== "ASSESSING" && impact.status !== "UPGRADE_PLANNED") {
        throw new ProjectAssetImpactServiceError(
          "ASSET_RISK_ACCEPTANCE_TRANSITION_INVALID",
          "当前资产影响状态不允许申请风险接受。",
          409
        );
      }
      await assertImpactAssessmentCurrent(client, impact);
      const { actor: sourceActor, snapshot: sourceActorSnapshot } = await exactRiskSourceActor(
        client,
        impact
      );
      const requestedAt = await databaseNow(client);
      const riskRequest = await client.assetImpactRiskAcceptanceRequest.create({
        data: {
          impactId: impact.id,
          projectId: impact.projectId,
          technicalAssetId: impact.technicalAssetId,
          requestedById: input.actorId,
          requestedMembershipId: owner.id,
          requestedMembershipSnapshotJson: membershipSnapshot(owner),
          sourceActorId: sourceActor.id,
          sourceActorSnapshotJson: sourceActorSnapshot,
          evidenceJson: evidence,
          reason,
          requestedAt
        }
      });
      const sequence =
        (await client.assetImpactDisposition.count({ where: { impactId: impact.id } })) + 1;
      const disposition = await client.assetImpactDisposition.create({
        data: {
          impactId: impact.id,
          projectId: impact.projectId,
          technicalAssetId: impact.technicalAssetId,
          assessmentRevisionId: currentAssessmentRevision.id,
          sequence,
          type: "RISK_ACCEPTANCE_REQUESTED",
          fromStatus: impact.status,
          toStatus: "RISK_ACCEPTANCE_PENDING",
          reason,
          evidenceJson: evidence,
          actorId: input.actorId,
          actorMembershipId: owner.id,
          actorMembershipSnapshotJson: membershipSnapshot(owner),
          ownerMembershipId: currentAssessmentRevision.ownerMembershipId!,
          ownerMembershipSnapshotJson:
            currentAssessmentRevision.ownerMembershipSnapshotJson as Prisma.InputJsonValue,
          dueAt: currentAssessmentRevision.dueAt!,
          riskAcceptanceRequestId: riskRequest.id
        }
      });
      const updated = await client.assetProjectImpact.update({
        where: { id: impact.id },
        data: { status: "RISK_ACCEPTANCE_PENDING", version: { increment: 1 } }
      });
      const facts = {
        projectId: impact.projectId,
        impactId: impact.id,
        technicalAssetId: impact.technicalAssetId,
        assessmentRevisionId: currentAssessmentRevision.id,
        dispositionId: disposition.id,
        requestId: riskRequest.id,
        requestedById: input.actorId,
        sourceActorId: sourceActor.id,
        fromStatus: impact.status,
        toStatus: updated.status,
        resourceVersion: updated.version,
        requestResourceVersion: riskRequest.version,
        reason
      };
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_IMPACT_RISK_ACCEPTANCE_REQUESTED,
        objectType: AUDIT_OBJECT_TYPES.ASSET_IMPACT_RISK_ACCEPTANCE_REQUEST,
        objectId: riskRequest.id,
        context: commandAuditContext({ ...input, reason }),
        after: { value: facts, allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "asset.impact.risk-acceptance.requested",
        aggregateType: "ASSET_PROJECT_IMPACT",
        aggregateId: impact.id,
        idempotencyKey: `asset-impact:${impact.id}:risk-request:${riskRequest.id}`,
        payload: facts
      });
      return riskCommandResult({
        impact: updated,
        riskAcceptanceRequest: riskRequest,
        allowedActions: [],
        auditId: audit.id,
        outboxEventId: outbox.id
      });
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function decideProjectAssetImpactRiskAcceptance(
  input: {
    projectId: string;
    impactId: string;
    requestId: string;
    version: unknown;
    decision: "APPROVE" | "REJECT";
    reason: unknown;
    evidence: unknown;
    actorId: string;
    authorizationActor: AuthorizationActor;
    auditContext: AuditContext;
  },
  transaction?: Client
) {
  try {
    return await inTransaction(transaction, async (client) => {
      const reason = stableText(input.reason, "reason");
      const evidence = canonicalEvidence(input.evidence);
      const requestVersion = positiveVersion(input.version);
      assertActiveCommandActor(input);
      const identity = await client.assetProjectImpact.findFirst({
        where: { id: input.impactId, projectId: input.projectId },
        select: { technicalAssetId: true, recallId: true, technicalAssetEventId: true }
      });
      if (!identity) {
        throw new ProjectAssetImpactServiceError(
          "ASSET_RISK_ACCEPTANCE_REQUEST_NOT_FOUND",
          "风险接受申请不存在或不可访问。",
          404
        );
      }
      await client.$queryRaw`SELECT "id" FROM "projects" WHERE "id" = ${input.projectId} FOR UPDATE`;
      await lockImpactSource(client, identity);
      await client.$queryRaw`SELECT "id" FROM "asset_project_impacts" WHERE "id" = ${input.impactId} AND "project_id" = ${input.projectId} FOR UPDATE`;
      await client.$queryRaw`SELECT "id" FROM "asset_impact_risk_acceptance_requests" WHERE "id" = ${input.requestId} AND "impact_id" = ${input.impactId} AND "project_id" = ${input.projectId} FOR UPDATE`;
      const impact = await client.assetProjectImpact.findFirst({
        where: { id: input.impactId, projectId: input.projectId },
        include: { project: true, currentAssessmentRevision: true, ownerMembership: true }
      });
      const riskRequest = await client.assetImpactRiskAcceptanceRequest.findFirst({
        where: {
          id: input.requestId,
          impactId: input.impactId,
          projectId: input.projectId,
          technicalAssetId: impact?.technicalAssetId
        },
        include: { decisions: { take: 1 } }
      });
      if (!impact || !riskRequest) {
        throw new ProjectAssetImpactServiceError(
          "ASSET_RISK_ACCEPTANCE_REQUEST_NOT_FOUND",
          "风险接受申请不存在或不可访问。",
          404
        );
      }
      if (riskRequest.version !== requestVersion) {
        throw new ProjectAssetImpactServiceError(
          "ASSET_RISK_ACCEPTANCE_VERSION_CONFLICT",
          "风险接受申请版本冲突。",
          409
        );
      }
      if (
        impact.project.status === "CLOSED" ||
        impact.project.status === "CANCELED" ||
        impact.status !== "RISK_ACCEPTANCE_PENDING" ||
        riskRequest.status !== "PENDING" ||
        riskRequest.decisions.length > 0 ||
        !impact.currentAssessmentRevision ||
        !impact.ownerMembership ||
        !impact.currentAssessmentRevision.ownerMembershipId ||
        !impact.currentAssessmentRevision.ownerMembershipSnapshotJson ||
        !impact.currentAssessmentRevision.dueAt
      ) {
        throw new ProjectAssetImpactServiceError(
          "ASSET_RISK_ACCEPTANCE_DECISION_CONFLICT",
          "风险接受申请已处理或当前状态不允许审批。",
          409
        );
      }
      await assertImpactAssessmentCurrent(client, impact);
      const actorMembership = await client.projectMember.findFirst({
        where: {
          projectId: input.projectId,
          userId: input.actorId,
          leftAt: null,
          projectRole: { in: ["QUALITY", "DEPARTMENT_LEAD"] },
          user: { status: "ACTIVE" }
        },
        orderBy: { id: "asc" }
      });
      if (!actorMembership) {
        throw new ProjectAssetImpactServiceError(
          "ASSET_RISK_APPROVER_ROLE_REQUIRED",
          "风险接受审批要求有效 QUALITY 或 DEPARTMENT_LEAD 项目成员身份。",
          403
        );
      }
      const technicalAsset = await client.technicalAsset.findUnique({
        where: { id: impact.technicalAssetId },
        select: { ownerId: true }
      });
      if (
        !technicalAsset ||
        input.actorId === riskRequest.requestedById ||
        input.actorId === riskRequest.sourceActorId ||
        input.actorId === impact.ownerMembership.userId ||
        input.actorId === technicalAsset.ownerId
      ) {
        throw new ProjectAssetImpactServiceError(
          "ASSET_RISK_APPROVAL_INDEPENDENCE_REQUIRED",
          "风险接受审批人必须独立于申请人、项目 Owner、资产 Owner 与来源操作人。",
          403
        );
      }
      const decisionValue = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
      const toStatus: AssetProjectImpactStatus =
        input.decision === "APPROVE" ? "ACCEPTED_RISK" : "ASSESSING";
      const decision = await client.assetImpactRiskAcceptanceDecision.create({
        data: {
          requestId: riskRequest.id,
          impactId: impact.id,
          projectId: impact.projectId,
          technicalAssetId: impact.technicalAssetId,
          decision: decisionValue,
          actorId: input.actorId,
          actorMembershipId: actorMembership.id,
          actorMembershipSnapshotJson: membershipSnapshot(actorMembership),
          evidenceJson: evidence,
          reason,
          decidedAt: await databaseNow(client)
        }
      });
      const updatedRequest = await client.assetImpactRiskAcceptanceRequest.update({
        where: { id: riskRequest.id },
        data: { status: decisionValue, version: { increment: 1 } }
      });
      const sequence =
        (await client.assetImpactDisposition.count({ where: { impactId: impact.id } })) + 1;
      const disposition = await client.assetImpactDisposition.create({
        data: {
          impactId: impact.id,
          projectId: impact.projectId,
          technicalAssetId: impact.technicalAssetId,
          assessmentRevisionId: impact.currentAssessmentRevision.id,
          sequence,
          type:
            input.decision === "APPROVE" ? "RISK_ACCEPTANCE_APPROVED" : "RISK_ACCEPTANCE_REJECTED",
          fromStatus: "RISK_ACCEPTANCE_PENDING",
          toStatus,
          reason,
          evidenceJson: evidence,
          actorId: input.actorId,
          actorMembershipId: actorMembership.id,
          actorMembershipSnapshotJson: membershipSnapshot(actorMembership),
          ownerMembershipId: impact.currentAssessmentRevision.ownerMembershipId,
          ownerMembershipSnapshotJson: impact.currentAssessmentRevision
            .ownerMembershipSnapshotJson as Prisma.InputJsonValue,
          dueAt: impact.currentAssessmentRevision.dueAt,
          riskAcceptanceRequestId: riskRequest.id,
          riskAcceptanceDecisionId: decision.id
        }
      });
      const updated = await client.assetProjectImpact.update({
        where: { id: impact.id },
        data: { status: toStatus, version: { increment: 1 } }
      });
      const facts = {
        projectId: impact.projectId,
        impactId: impact.id,
        technicalAssetId: impact.technicalAssetId,
        assessmentRevisionId: impact.currentAssessmentRevision.id,
        dispositionId: disposition.id,
        requestId: riskRequest.id,
        decisionId: decision.id,
        decision: decisionValue,
        actorMembershipId: actorMembership.id,
        fromStatus: impact.status,
        toStatus,
        resourceVersion: updated.version,
        requestResourceVersion: updatedRequest.version,
        reason
      };
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_IMPACT_RISK_ACCEPTANCE_DECIDED,
        objectType: AUDIT_OBJECT_TYPES.ASSET_IMPACT_RISK_ACCEPTANCE_DECISION,
        objectId: decision.id,
        context: commandAuditContext({ ...input, reason }),
        after: { value: facts, allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "asset.impact.risk-acceptance.decided",
        aggregateType: "ASSET_PROJECT_IMPACT",
        aggregateId: impact.id,
        idempotencyKey: `asset-impact:${impact.id}:risk-decision:${decision.id}`,
        payload: facts
      });
      return {
        ...riskCommandResult({
          impact: updated,
          riskAcceptanceRequest: updatedRequest,
          allowedActions: [],
          auditId: audit.id,
          outboxEventId: outbox.id
        }),
        riskAcceptanceDecision: decision
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}

export async function closeProjectAssetImpact(
  input: {
    projectId: string;
    impactId: string;
    version: unknown;
    reason: unknown;
    evidence: unknown;
    actorId: string;
    authorizationActor: AuthorizationActor;
    auditContext: AuditContext;
  },
  transaction?: Client
) {
  try {
    return await inTransaction(transaction, async (client) => {
      const reason = stableText(input.reason, "reason");
      const evidence = canonicalEvidence(input.evidence);
      assertActiveCommandActor(input);
      const { impact, currentAssessmentRevision } = await lockCommandImpact(client, {
        projectId: input.projectId,
        impactId: input.impactId,
        version: positiveVersion(input.version),
        actorId: input.actorId
      });
      const owner = assertCurrentProjectManagerOwner(impact, input.actorId);
      if (impact.status !== "MITIGATED" && impact.status !== "ACCEPTED_RISK") {
        throw new ProjectAssetImpactServiceError(
          "ASSET_IMPACT_CLOSE_TRANSITION_INVALID",
          "只有已缓解或已接受风险的资产影响可以关闭。",
          409
        );
      }
      await assertImpactAssessmentCurrent(client, impact);
      if (impact.status === "MITIGATED") {
        const mitigation = await client.assetImpactDisposition.findFirst({
          where: {
            impactId: impact.id,
            projectId: impact.projectId,
            technicalAssetId: impact.technicalAssetId,
            type: "MITIGATED",
            mitigationAdoptionId: { not: null }
          },
          include: { mitigationAdoption: true },
          orderBy: { sequence: "desc" }
        });
        if (
          !mitigation?.mitigationAdoption ||
          mitigation.mitigationAdoption.impactId !== impact.id ||
          mitigation.mitigationAdoption.projectId !== impact.projectId ||
          mitigation.mitigationAdoption.technicalAssetId !== impact.technicalAssetId
        ) {
          throw new ProjectAssetImpactServiceError(
            "ASSET_IMPACT_MITIGATION_FACT_REQUIRED",
            "已缓解影响缺少 exact 成功升级采用事实。",
            409
          );
        }
      } else {
        const accepted = await client.assetImpactRiskAcceptanceRequest.findFirst({
          where: {
            impactId: impact.id,
            projectId: impact.projectId,
            technicalAssetId: impact.technicalAssetId,
            status: "APPROVED",
            decisions: { some: { decision: "APPROVED" } }
          },
          select: { id: true }
        });
        if (!accepted) {
          throw new ProjectAssetImpactServiceError(
            "ASSET_RISK_APPROVAL_REQUIRED",
            "关闭风险接受影响要求 exact 独立审批事实。",
            409
          );
        }
      }
      const sequence =
        (await client.assetImpactDisposition.count({ where: { impactId: impact.id } })) + 1;
      const disposition = await client.assetImpactDisposition.create({
        data: {
          impactId: impact.id,
          projectId: impact.projectId,
          technicalAssetId: impact.technicalAssetId,
          assessmentRevisionId: currentAssessmentRevision.id,
          sequence,
          type: "CLOSED",
          fromStatus: impact.status,
          toStatus: "CLOSED",
          reason,
          evidenceJson: evidence,
          actorId: input.actorId,
          actorMembershipId: owner.id,
          actorMembershipSnapshotJson: membershipSnapshot(owner),
          ownerMembershipId: currentAssessmentRevision.ownerMembershipId!,
          ownerMembershipSnapshotJson:
            currentAssessmentRevision.ownerMembershipSnapshotJson as Prisma.InputJsonValue,
          dueAt: currentAssessmentRevision.dueAt!
        }
      });
      const updated = await client.assetProjectImpact.update({
        where: { id: impact.id },
        data: { status: "CLOSED", version: { increment: 1 } }
      });
      const facts = {
        projectId: impact.projectId,
        impactId: impact.id,
        technicalAssetId: impact.technicalAssetId,
        assessmentRevisionId: currentAssessmentRevision.id,
        dispositionId: disposition.id,
        fromStatus: impact.status,
        toStatus: updated.status,
        ownerMembershipId: owner.id,
        resourceVersion: updated.version,
        reason
      };
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.ASSET_PROJECT_IMPACT_DISPOSITION_RECORDED,
        objectType: AUDIT_OBJECT_TYPES.ASSET_PROJECT_IMPACT,
        objectId: impact.id,
        context: commandAuditContext({ ...input, reason }),
        after: { value: facts, allowedFields: ASSET_UPGRADE_IMPACT_AUDIT_FIELDS }
      });
      const outbox = await appendOutboxEvent(client, {
        eventType: "asset.impact.closed",
        aggregateType: "ASSET_PROJECT_IMPACT",
        aggregateId: impact.id,
        idempotencyKey: `asset-impact:${impact.id}:disposition:${disposition.sequence}`,
        payload: facts
      });
      return {
        item: { ...updated, resourceVersion: updated.version },
        impact: { ...updated, resourceVersion: updated.version },
        resourceVersion: updated.version,
        allowedActions: [],
        auditId: audit.id,
        outboxEventId: outbox.id
      };
    });
  } catch (error) {
    mapDatabaseError(error);
  }
}
