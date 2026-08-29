import { Prisma, type PrismaClient } from "@prisma/client";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  ARCHIVE_VERSION_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_SOURCES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import type { JobExecution, JobHandler } from "@/modules/governance/contracts/jobs";
import type { JsonValue } from "@/modules/governance/domain/idempotency";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  ArchiveManifestError,
  type ArchiveManifestSourceInput,
  type ProjectArchiveManifest
} from "./archive-manifest-service";
import { getArchiveSourceFormulaAdapter } from "./archive-source-formula-registry";
import {
  archiveSourceFormulaToPersistence,
  type ArchiveSourceFormulaVersion
} from "../domain/archive-source-formula";
import { readRetrospectiveInput, type RetrospectiveInputBuild } from "./retrospective-input-reader";

type ArchiveGenerationPayload = {
  projectId: string;
  requestedById: string;
  archiveSourceFormulaVersion: ArchiveSourceFormulaVersion;
};

export type ArchiveVersionWriter = (input: {
  projectId: string;
  requestedById: string;
  generationJobId: string;
  archiveSourceFormulaVersion: ArchiveSourceFormulaVersion;
  retrospectiveInput?: RetrospectiveInputBuild;
  manifest: ProjectArchiveManifest;
}) => Promise<{ id: string; version: number }>;

function parsePayload(job: JobExecution): ArchiveGenerationPayload {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new TypeError("归档生成作业负载无效。");
  }
  const value = job.payload as Record<string, JsonValue>;
  const projectId = typeof value.projectId === "string" ? value.projectId.trim() : "";
  const requestedById = typeof value.requestedById === "string" ? value.requestedById.trim() : "";
  if (!projectId || !requestedById || projectId.length > 191 || requestedById.length > 191) {
    throw new TypeError("归档生成作业负载无效。");
  }
  const archiveSourceFormulaVersion =
    typeof value.archiveSourceFormulaVersion === "string"
      ? getArchiveSourceFormulaAdapter(value.archiveSourceFormulaVersion).version
      : getArchiveSourceFormulaAdapter(undefined).version;
  return { projectId, requestedById, archiveSourceFormulaVersion };
}

export function createArchiveGenerationHandler(input: {
  readSources: (projectId: string) => Promise<readonly ArchiveManifestSourceInput[]>;
  readRetrospectiveInput?: (projectId: string) => Promise<RetrospectiveInputBuild>;
  createVersion: ArchiveVersionWriter;
  scheduleIntegrityCheck: (input: {
    projectId: string;
    archiveVersionId: string;
    generationJobId: string;
  }) => Promise<void>;
}): JobHandler {
  return async (job) => {
    const payload = parsePayload(job);
    const formula = getArchiveSourceFormulaAdapter(payload.archiveSourceFormulaVersion);
    if (formula.version === "ARCHIVE.SOURCE@2" && !input.readRetrospectiveInput) {
      throw new ArchiveManifestError(
        "ARCHIVE_SOURCE_FACTS_UNAVAILABLE",
        "ARCHIVE.SOURCE@2 归档缺少复盘输入事实读取器。"
      );
    }
    const retrospectiveInput =
      formula.version === "ARCHIVE.SOURCE@2"
        ? await input.readRetrospectiveInput!(payload.projectId)
        : undefined;
    const manifest = formula.buildManifest({
      projectId: payload.projectId,
      items: await input.readSources(payload.projectId)
    });
    const version = await input.createVersion({
      projectId: payload.projectId,
      requestedById: payload.requestedById,
      generationJobId: job.id,
      archiveSourceFormulaVersion: formula.version,
      retrospectiveInput,
      manifest
    });
    await input.scheduleIntegrityCheck({
      projectId: payload.projectId,
      archiveVersionId: version.id,
      generationJobId: job.id
    });
  };
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [row] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!row) throw new Error("无法读取数据库时间。");
  return row.now;
}

function workerAuditContext(job: JobExecution, projectId: string, actorId: string): AuditContext {
  return {
    actorId,
    requestId: null,
    traceId: job.traceId ?? job.id,
    source: AUDIT_SOURCES.WORKER,
    sourceIp: null,
    userAgent: null,
    reason: null,
    projectId,
    departmentId: null,
    operationId: job.idempotencyKey
  };
}

export function createPrismaArchiveGenerationHandler(input?: {
  client?: PrismaClient;
}): JobHandler {
  const client = input?.client ?? db;
  return async (job) => {
    const payload = parsePayload(job);
    const formula = getArchiveSourceFormulaAdapter(payload.archiveSourceFormulaVersion);
    const retrospectiveInput =
      formula.version === "ARCHIVE.SOURCE@2"
        ? await readRetrospectiveInput({ projectId: payload.projectId, client: client as never })
        : undefined;
    const manifest = formula.buildManifest(
      await formula.read({ client: client as never, projectId: payload.projectId })
    );
    await client.$transaction(async (transaction) => {
      const existing = await transaction.projectArchiveVersion.findUnique({
        where: { generationJobId: job.id }
      });
      if (existing) {
        await appendOutboxEvent(transaction, {
          eventType: "archive.integrity.check",
          aggregateType: AUDIT_OBJECT_TYPES.PROJECT_ARCHIVE_VERSION,
          aggregateId: existing.id,
          idempotencyKey: `${existing.id}:integrity:1`,
          payload: {
            projectId: payload.projectId,
            archiveVersionId: existing.id,
            generationJobId: job.id
          },
          traceId: job.traceId
        });
        return;
      }

      const archive = await transaction.projectArchive.upsert({
        where: { projectId: payload.projectId },
        create: { projectId: payload.projectId },
        update: {}
      });
      const latest = await transaction.projectArchiveVersion.findFirst({
        where: { archiveId: archive.id, projectId: payload.projectId },
        orderBy: { version: "desc" },
        select: { version: true }
      });
      const versionNumber = (latest?.version ?? 0) + 1;
      const created = await transaction.projectArchiveVersion.create({
        data: {
          archiveId: archive.id,
          projectId: payload.projectId,
          version: versionNumber,
          status: "VERIFYING",
          manifestChecksum: manifest.manifestChecksum,
          sourceWatermark: manifest.sourceWatermark,
          snapshotJson: manifest.snapshotJson as Prisma.InputJsonValue,
          externalPublicationApplicability: "NOT_APPLICABLE",
          externalPublicationReason: manifest.externalPublication.reason,
          archiveSourceFormulaVersion: archiveSourceFormulaToPersistence(formula.version),
          retrospectiveInputApplicability: retrospectiveInput ? "APPLICABLE" : "NOT_APPLICABLE",
          retrospectiveInputWatermarkVersion: retrospectiveInput ? "RETROSPECTIVE.INPUT@1" : null,
          retrospectiveInputSnapshotJson: retrospectiveInput
            ? (retrospectiveInput.snapshot as Prisma.InputJsonValue)
            : Prisma.DbNull,
          retrospectiveInputWatermark: retrospectiveInput?.watermark ?? null,
          createdById: payload.requestedById,
          generationJobId: job.id,
          manifestItems: {
            create: manifest.items.map((item) => ({
              position: item.position,
              sourceType: item.sourceType as never,
              sourceId: item.sourceId,
              sourceVersion: item.sourceVersion,
              sourceChecksum: item.sourceChecksum,
              fileObjectId: item.fileObjectId,
              fileSha256: item.fileSha256,
              fileMimeType: item.fileMimeType,
              fileSize: item.fileSize,
              snapshotJson: item.snapshotJson as Prisma.InputJsonValue
            }))
          }
        },
        select: { id: true, version: true }
      });
      await appendOutboxEvent(transaction, {
        eventType: "archive.integrity.check",
        aggregateType: AUDIT_OBJECT_TYPES.PROJECT_ARCHIVE_VERSION,
        aggregateId: created.id,
        idempotencyKey: `${created.id}:integrity:1`,
        payload: {
          projectId: payload.projectId,
          archiveVersionId: created.id,
          generationJobId: job.id
        },
        traceId: job.traceId
      });
      await writeAudit(transaction, {
        action: AUDIT_ACTIONS.PROJECT_ARCHIVE_GENERATED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_ARCHIVE_VERSION,
        objectId: created.id,
        context: workerAuditContext(job, payload.projectId, payload.requestedById),
        after: {
          value: {
            projectId: payload.projectId,
            archiveVersionId: created.id,
            version: created.version,
            manifestChecksum: manifest.manifestChecksum,
            sourceWatermark: manifest.sourceWatermark
          },
          allowedFields: ARCHIVE_VERSION_AUDIT_FIELDS
        },
        metadata: {
          value: { generationJobId: job.id, itemCount: manifest.items.length },
          allowedFields: ARCHIVE_VERSION_AUDIT_FIELDS
        }
      });
      await databaseNow(transaction);
    });
  };
}
