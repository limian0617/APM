import { createHash, randomUUID } from "node:crypto";

import {
  AcceptanceConfirmationDecision,
  AcceptanceConfirmationChannel,
  Prisma
} from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  ACCEPTANCE_CONFIRMATION_AUDIT_FIELDS,
  ACCEPTANCE_REPORT_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import {
  assertProjectWritable,
  ProjectWritePolicyError
} from "@/modules/projects/domain/project-write-policy";
import {
  createControlledDocument,
  createControlledDocumentDraft,
  publishControlledDocumentVersion
} from "@/modules/documents/application/controlled-document-service";
import { STORAGE_AREAS, type ObjectStoragePort } from "@/modules/documents/contracts/file-storage";
import { getAssetUsageSnapshotForAcceptance } from "@/modules/assets/application/project-asset-usage-service";

import {
  ACCEPTANCE_CONFIRMATION_CHANNELS,
  ACCEPTANCE_CONFIRMATION_DECISIONS,
  AcceptanceReportPolicyError,
  assertConfirmationEvidence,
  assertReportCanGenerate,
  buildAcceptanceReportSnapshot,
  calculateConfirmationChecksum,
  calculateSnapshotChecksum,
  matchesExistingAcceptanceReportSnapshot,
  type AcceptanceConfirmationChannel as ConfirmationChannel,
  type AcceptanceConfirmationDecision as ConfirmationDecision,
  type AcceptanceReportSnapshot
} from "../domain/acceptance-report-policy";
import {
  ACCEPTANCE_REPORT_RENDERER_VERSION,
  AcceptanceReportPdfIntegrityError,
  assertFinalPdfHashIntegrity,
  renderAcceptanceReportPdf,
  sha256Bytes
} from "../infrastructure/acceptance-report-renderer";

export class AcceptanceReportServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "AcceptanceReportServiceError";
  }
}

/**
 * FileObject.objectKey is intentionally opaque: project identity belongs to the
 * database relation and authorization boundary, never to an object-storage key.
 */
export function createControlledReportObjectKey(): string {
  return randomUUID();
}

function text(value: unknown, field: string, maximum = 2048): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new AcceptanceReportServiceError(
      "ACCEPTANCE_REPORT_INVALID_INPUT",
      `${field} 必须是 1 到 ${maximum} 个字符。`
    );
  }
  return value.trim();
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string
): T[number] {
  if (!values.includes(value as T[number])) {
    throw new AcceptanceReportServiceError(
      "ACCEPTANCE_CONFIRMATION_ENUM_INVALID",
      `${field} 不是受支持的值。`,
      422
    );
  }
  return value as T[number];
}

function asDate(value: unknown, field: string): Date {
  if (typeof value !== "string") {
    throw new AcceptanceReportServiceError(
      "ACCEPTANCE_REPORT_DATE_INVALID",
      `${field} 必须是 ISO 时间。`
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AcceptanceReportServiceError(
      "ACCEPTANCE_REPORT_DATE_INVALID",
      `${field} 必须是 ISO 时间。`
    );
  }
  return date;
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [row] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  if (!row) throw new Error("无法读取数据库时间。");
  return row.now;
}

async function readObjectBytes(storage: ObjectStoragePort, objectKey: string): Promise<Uint8Array> {
  const stream = await storage.readObject({ area: STORAGE_AREAS.CONTROLLED, objectKey });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

function reportAuditValue(report: {
  id: string;
  projectId: string;
  reportNumber: string;
  reportVersion: number;
  acceptanceType: string;
  scopeType: string;
  scopeId: string;
  sourceBatchId: string;
  finalBatchId: string;
  templateVersionId: string;
  templateChecksum: string;
  snapshotChecksum: string;
  rendererVersion: string;
  pdfFileId: string;
  pdfSha256: string;
  controlledDocumentVersionId: string;
  status: string;
  supersedesReportId: string | null;
}) {
  return {
    projectId: report.projectId,
    reportId: report.id,
    reportNumber: report.reportNumber,
    reportVersion: report.reportVersion,
    acceptanceType: report.acceptanceType,
    scopeType: report.scopeType,
    scopeId: report.scopeId,
    sourceBatchId: report.sourceBatchId,
    finalBatchId: report.finalBatchId,
    templateVersionId: report.templateVersionId,
    templateChecksum: report.templateChecksum,
    snapshotChecksum: report.snapshotChecksum,
    rendererVersion: report.rendererVersion,
    pdfFileId: report.pdfFileId,
    pdfSha256: report.pdfSha256,
    controlledDocumentVersionId: report.controlledDocumentVersionId,
    status: report.status,
    supersedesReportId: report.supersedesReportId
  };
}

async function loadLockedBatchFacts(
  client: Prisma.TransactionClient,
  projectId: string,
  batchId: string
) {
  await client.$queryRaw`
    SELECT "id" FROM "acceptance_batches"
    WHERE "id" = ${batchId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  const batch = await client.acceptanceBatch.findUnique({
    where: { id_projectId: { id: batchId, projectId } },
    include: {
      project: { select: { id: true, name: true, code: true } },
      templateVersion: { include: { template: true, items: { orderBy: { position: "asc" } } } },
      results: {
        include: {
          revisions: {
            orderBy: { revisionNo: "desc" },
            take: 1,
            include: {
              evidence: { include: { fileObject: { select: { id: true, sha256: true } } } }
            }
          }
        }
      },
      retestOfBatch: { select: { id: true, projectId: true, status: true } }
    }
  });
  if (!batch)
    throw new AcceptanceReportServiceError("ACCEPTANCE_BATCH_NOT_FOUND", "验收批次不存在。", 404);
  const project = await client.project.findUnique({
    where: { id: projectId },
    select: { status: true }
  });
  if (!project) throw new AcceptanceReportServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  try {
    assertProjectWritable(project.status);
  } catch (error) {
    if (error instanceof ProjectWritePolicyError) {
      throw new AcceptanceReportServiceError(error.code, error.message, error.status);
    }
    throw error;
  }
  try {
    assertReportCanGenerate(batch.status);
  } catch (error) {
    if (error instanceof AcceptanceReportPolicyError) {
      throw new AcceptanceReportServiceError(error.code, error.message, error.status);
    }
    throw error;
  }
  return batch;
}

async function loadRetestChain(
  client: Prisma.TransactionClient,
  projectId: string,
  batchId: string
) {
  const chain = [batchId];
  let current = batchId;
  for (let count = 0; count < 32; count += 1) {
    const next = await client.acceptanceBatch.findFirst({
      where: { projectId, retestOfBatchId: current, status: "LOCKED" },
      orderBy: [{ lockedAt: "desc" }, { id: "desc" }],
      select: { id: true }
    });
    if (!next) break;
    chain.push(next.id);
    current = next.id;
  }
  return chain;
}

async function buildSnapshot(
  client: Prisma.TransactionClient,
  batch: Awaited<ReturnType<typeof loadLockedBatchFacts>>,
  frozenAt: Date,
  readAudit?: { actorId: string; auditContext: AuditContext }
) {
  const revisionIds = batch.results
    .map((result) => result.revisions[0]?.id)
    .filter(Boolean) as string[];
  const issueRelations = revisionIds.length
    ? await client.issueRelation.findMany({
        where: {
          projectId: batch.projectId,
          relationType: "TEST_RESULT",
          status: "ACTIVE",
          targetId: { in: revisionIds }
        },
        include: {
          issue: {
            select: {
              id: true,
              category: true,
              severity: true,
              status: true,
              ownerMembershipId: true,
              verifierMembershipId: true,
              dueDate: true
            }
          }
        },
        orderBy: { createdAt: "asc" }
      })
    : [];
  const issues = issueRelations.map((relation) => ({
    issueId: relation.issue.id,
    resultRevisionId: relation.targetId,
    status: relation.issue.status,
    severity: relation.issue.severity,
    category: relation.issue.category,
    ownerMembershipId: relation.issue.ownerMembershipId,
    verifierMembershipId: relation.issue.verifierMembershipId,
    dueDate: relation.issue.dueDate?.toISOString().slice(0, 10) ?? null
  }));
  const gateSnapshots = await client.gateCheckSnapshot.findMany({
    where: {
      projectId: batch.projectId,
      results: { some: { checkerCode: { startsWith: "ACCEPTANCE." } } }
    },
    include: {
      gateInstance: { select: { scope: true, deliveryUnitId: true, moduleId: true } },
      results: {
        where: { checkerCode: { startsWith: "ACCEPTANCE." } },
        orderBy: { position: "asc" }
      }
    },
    orderBy: { checkedAt: "desc" },
    take: 20
  });
  const gateSnapshot =
    gateSnapshots.find((candidate) => {
      if (batch.scopeType === "PROJECT") return candidate.gateInstance.scope === "PROJECT";
      if (batch.scopeType === "DELIVERY_UNIT") {
        return (
          candidate.gateInstance.scope === "DELIVERY_UNIT" &&
          candidate.gateInstance.deliveryUnitId === batch.scopeId
        );
      }
      return candidate.gateInstance.moduleId === batch.scopeId;
    }) ?? gateSnapshots[0];
  const gateResults = gateSnapshot?.results ?? [];
  const gateStatus = gateResults.some((result) => result.status === "HARD_FAILED")
    ? "HARD_FAILED"
    : gateResults.some((result) => result.status === "WARNING")
      ? "WARNING"
      : gateResults.length
        ? "PASSED"
        : "NOT_RUN";
  const retestChain = await loadRetestChain(client, batch.projectId, batch.id);
  const residualItemIds = gateResults.flatMap((result) => {
    const evidence = result.evidenceJson;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return [];
    const ids = (evidence as { residualItemIds?: unknown }).residualItemIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  });
  const assetUsageRead = await getAssetUsageSnapshotForAcceptance(
    {
      projectId: batch.projectId,
      acceptanceType: batch.acceptanceType,
      scopeType: batch.scopeType,
      scopeId: batch.scopeId,
      frozenAt,
      ...(readAudit ? { readAudit } : {})
    },
    client
  );
  const assetUsage = {
    frozenAt: assetUsageRead.frozenAt,
    snapshot: assetUsageRead.snapshot,
    usageSnapshotChecksum: assetUsageRead.usageSnapshotChecksum
  };
  const snapshot = buildAcceptanceReportSnapshot({
    project: batch.project,
    batch: {
      id: batch.id,
      acceptanceType: batch.acceptanceType,
      scopeType: batch.scopeType,
      scopeId: batch.scopeId
    },
    template: {
      id: batch.templateVersion.id,
      version: batch.templateVersion.version,
      checksum: batch.templateVersion.snapshotChecksum
    },
    items: batch.templateVersion.items.map((item) => {
      const result = batch.results.find((entry) => entry.itemId === item.id);
      const revision = result?.revisions[0];
      return {
        code: item.code,
        position: item.position,
        name: item.name,
        method: item.method,
        acceptanceCriteria: item.acceptanceCriteria,
        unit: item.unit,
        required: item.required,
        decision: revision?.decision ?? null,
        measuredValue: revision?.measuredValue ?? null,
        measuredUnit: revision?.measuredUnit ?? null,
        note: revision?.note ?? null,
        resultRevisionId: revision?.id ?? null,
        evidence:
          revision?.evidence.map((evidence) => ({
            fileId: evidence.fileObject.id,
            sha256: evidence.fileObject.sha256 ?? ""
          })) ?? []
      };
    }),
    issues,
    gate: {
      status: gateStatus,
      warnings: gateResults
        .filter((result) => result.status === "WARNING")
        .map((result) => result.checkerCode),
      residualItemIds
    },
    assetUsage,
    retestOfBatchId: batch.retestOfBatch?.id ?? null,
    frozenAt: frozenAt.toISOString(),
    rendererVersion: ACCEPTANCE_REPORT_RENDERER_VERSION
  });
  return {
    snapshot,
    snapshotChecksum: calculateSnapshotChecksum(snapshot),
    retestChain,
    finalBatchId: retestChain.at(-1)!
  };
}

export function snapshotReadAudit(
  input: { actorId: string; auditContext: AuditContext },
  phase: "historical-replay" | "current-authoritative"
) {
  const suffix = `:${phase}`;
  const operationId = input.auditContext.operationId;
  const derivedOperationId =
    operationId && operationId.length + suffix.length > 191
      ? `${operationId.slice(0, 191 - suffix.length - 17)}:${createHash("sha256")
          .update(operationId)
          .digest("hex")
          .slice(0, 16)}${suffix}`
      : operationId
        ? `${operationId}${suffix}`
        : null;
  return {
    actorId: input.actorId,
    auditContext: {
      ...input.auditContext,
      operationId: derivedOperationId
    }
  };
}

function serializeReport(report: Record<string, unknown>) {
  return {
    ...report,
    pdfSize: typeof report.pdfSize === "bigint" ? Number(report.pdfSize) : report.pdfSize,
    generatedAt:
      report.generatedAt instanceof Date ? report.generatedAt.toISOString() : report.generatedAt,
    createdAt: report.createdAt instanceof Date ? report.createdAt.toISOString() : report.createdAt
  };
}

export async function generateAcceptanceReport(
  input: {
    projectId: string;
    batchId: string;
    version: number;
    supersedesReportId?: string | null;
    actorId: string;
    auditContext: AuditContext;
    storage: ObjectStoragePort;
  },
  transaction?: Prisma.TransactionClient
) {
  let objectKey: string | null = null;
  try {
    return await inTransaction(
      transaction,
      async (client) => {
        await client.$queryRaw`
          SELECT "id" FROM "projects"
          WHERE "id" = ${input.projectId}
          FOR UPDATE
        `;
        const batch = await loadLockedBatchFacts(client, input.projectId, input.batchId);
        if (batch.version !== input.version) {
          throw new AcceptanceReportServiceError(
            "ACCEPTANCE_BATCH_VERSION_CONFLICT",
            "验收批次已被其他操作更新，请刷新后重试。",
            409
          );
        }
        const existing = await client.acceptanceReport.findFirst({
          where: {
            projectId: input.projectId,
            sourceBatchId: batch.id,
            status: { in: ["GENERATING", "READY", "PUBLISHED"] }
          },
          orderBy: { reportVersion: "desc" }
        });
        if (input.supersedesReportId && (!existing || existing.id !== input.supersedesReportId)) {
          throw new AcceptanceReportServiceError(
            "ACCEPTANCE_REPORT_SUPERSEDES_INVALID",
            "只能取代当前项目该批次的最新报告。",
            409
          );
        }
        if (
          existing &&
          !input.supersedesReportId &&
          (() => {
            const previousFrozenAt =
              existing.snapshotJson &&
              typeof existing.snapshotJson === "object" &&
              "frozenAt" in existing.snapshotJson
                ? (existing.snapshotJson as { frozenAt?: unknown }).frozenAt
                : null;
            return (
              typeof previousFrozenAt === "string" &&
              !Number.isNaN(new Date(previousFrozenAt).getTime())
            );
          })()
        ) {
          const previousFrozenAt = (existing.snapshotJson as { frozenAt: string }).frozenAt;
          const replay = await buildSnapshot(
            client,
            batch,
            new Date(previousFrozenAt),
            snapshotReadAudit(input, "historical-replay")
          );
          if (
            matchesExistingAcceptanceReportSnapshot({
              existingSnapshot: existing.snapshotJson,
              existingSnapshotChecksum: existing.snapshotChecksum,
              currentSnapshot: replay.snapshot
            })
          )
            return {
              report: serializeReport(existing as unknown as Record<string, unknown>),
              repeated: true
            };
        }
        const frozenAt = await databaseNow(client);
        const facts = await buildSnapshot(
          client,
          batch,
          frozenAt,
          snapshotReadAudit(input, "current-authoritative")
        );
        const reportNumber = `APM-${batch.acceptanceType}-${batch.id}`.toUpperCase();
        const latest = await client.acceptanceReport.findFirst({
          where: { projectId: input.projectId, reportNumber },
          orderBy: { reportVersion: "desc" },
          select: { reportVersion: true }
        });
        const reportVersion = (latest?.reportVersion ?? 0) + 1;
        // The report document has an APM-owned code and a matching immutable business version.
        // This is the exact ControlledDocumentVersion business identity embedded in the PDF;
        // the database ID is intentionally kept in controlled-document metadata and APIs.
        const documentCode = `ACCEPTANCE-${batch.acceptanceType}-${batch.id}`.toUpperCase();
        const pdf = renderAcceptanceReportPdf({
          snapshot: facts.snapshot,
          reportNumber,
          reportVersion,
          snapshotChecksum: facts.snapshotChecksum,
          controlledDocumentVersion: { code: documentCode, version: reportVersion }
        });
        const pdfSha256 = sha256Bytes(pdf);
        objectKey = createControlledReportObjectKey();
        await input.storage.putObject({
          area: STORAGE_AREAS.CONTROLLED,
          objectKey,
          mimeType: "application/pdf",
          body: pdf
        });
        const now = frozenAt;
        const file = await client.fileObject.create({
          data: {
            projectId: input.projectId,
            uploadedById: input.actorId,
            originalName: `${reportNumber}-v${reportVersion}.pdf`,
            declaredMimeType: "application/pdf",
            verifiedMimeType: "application/pdf",
            declaredSize: BigInt(pdf.byteLength),
            verifiedSize: BigInt(pdf.byteLength),
            sha256: pdfSha256,
            objectKey,
            storageArea: "CONTROLLED",
            status: "AVAILABLE",
            sensitivity: "INTERNAL",
            scanEngine: "APM-102-renderer",
            scannerVersion: ACCEPTANCE_REPORT_RENDERER_VERSION,
            scannedAt: now
          }
        });
        const storedPdf = await readObjectBytes(input.storage, objectKey);
        if (!file.sha256) throw new AcceptanceReportPdfIntegrityError();
        assertFinalPdfHashIntegrity({
          pdf: storedPdf,
          acceptanceReportPdfSha256: pdfSha256,
          fileObjectSha256: file.sha256
        });
        if (existing) {
          await client.acceptanceReport.update({
            where: { id: existing.id },
            data: { status: "SUPERSEDED" }
          });
        }
        const document = await client.controlledDocument.findUnique({
          where: { projectId_code: { projectId: input.projectId, code: documentCode } },
          select: { id: true, version: true }
        });
        let controlledDocumentVersionId: string;
        if (!document) {
          const created = await createControlledDocument(
            {
              projectId: input.projectId,
              code: documentCode,
              title: `${batch.acceptanceType} 验收报告`,
              sourceFileId: file.id,
              reason: "生成受控验收报告",
              actorId: input.actorId,
              auditContext: input.auditContext
            },
            client
          );
          const first = (created.document as { versions?: Array<{ id: string }> }).versions?.[0];
          if (!first) throw new Error("受控报告文档版本创建失败。");
          controlledDocumentVersionId = first.id;
          await publishControlledDocumentVersion(
            {
              projectId: input.projectId,
              documentId: created.document.id,
              documentVersionId: controlledDocumentVersionId,
              version: created.resourceVersion,
              reason: "发布受控验收报告",
              actorId: input.actorId,
              auditContext: input.auditContext
            },
            client
          );
        } else {
          const drafted = await createControlledDocumentDraft(
            {
              projectId: input.projectId,
              documentId: document.id,
              version: document.version,
              sourceFileId: file.id,
              reason: "生成新版本受控验收报告",
              actorId: input.actorId,
              auditContext: input.auditContext
            },
            client
          );
          const latestVersion = (
            drafted.document as { versions?: Array<{ id: string; status: string }> }
          ).versions?.find((version) => version.status === "DRAFT");
          if (!latestVersion) throw new Error("受控报告草稿版本创建失败。");
          controlledDocumentVersionId = latestVersion.id;
          await publishControlledDocumentVersion(
            {
              projectId: input.projectId,
              documentId: document.id,
              documentVersionId: controlledDocumentVersionId,
              version: drafted.resourceVersion,
              reason: "发布新版本受控验收报告",
              actorId: input.actorId,
              auditContext: input.auditContext
            },
            client
          );
        }
        const controlledDocumentVersion = await client.controlledDocumentVersion.findUnique({
          where: { id_projectId: { id: controlledDocumentVersionId, projectId: input.projectId } },
          select: {
            version: true,
            sourceFileSha256: true,
            document: { select: { code: true } }
          }
        });
        if (
          !controlledDocumentVersion ||
          controlledDocumentVersion.document.code !== documentCode ||
          controlledDocumentVersion.version !== reportVersion ||
          controlledDocumentVersion.sourceFileSha256 !== pdfSha256
        ) {
          throw new AcceptanceReportPdfIntegrityError();
        }
        const report = await client.acceptanceReport.create({
          data: {
            projectId: input.projectId,
            acceptanceType: batch.acceptanceType,
            scopeType: batch.scopeType,
            scopeId: batch.scopeId,
            reportNumber,
            reportVersion,
            sourceBatchId: batch.id,
            finalBatchId: facts.finalBatchId,
            retestChainJson: facts.retestChain,
            templateVersionId: batch.templateVersionId,
            templateChecksum: batch.templateVersion.snapshotChecksum,
            snapshotJson: facts.snapshot as unknown as Prisma.InputJsonValue,
            snapshotChecksum: facts.snapshotChecksum,
            rendererVersion: ACCEPTANCE_REPORT_RENDERER_VERSION,
            pdfFileId: file.id,
            pdfSha256,
            pdfSize: BigInt(pdf.byteLength),
            pdfMimeType: "application/pdf",
            controlledDocumentVersionId,
            status: "READY",
            requestedById: input.actorId,
            generatedAt: now,
            supersedesReportId: existing?.id ?? null
          }
        });
        const value = reportAuditValue(report);
        const audit = await writeAudit(client, {
          action: AUDIT_ACTIONS.ACCEPTANCE_REPORT_GENERATED,
          objectType: AUDIT_OBJECT_TYPES.ACCEPTANCE_REPORT,
          objectId: report.id,
          context: { ...input.auditContext, actorId: input.actorId, projectId: input.projectId },
          after: { value, allowedFields: ACCEPTANCE_REPORT_AUDIT_FIELDS }
        });
        const outbox = await appendOutboxEvent(client, {
          eventType: "acceptance.report.generated",
          aggregateType: "ACCEPTANCE_REPORT",
          aggregateId: report.id,
          idempotencyKey: `${report.id}:generated`,
          payload: { ...value, auditId: audit.id },
          traceId: input.auditContext.traceId ?? undefined
        });
        return {
          report: serializeReport(report as unknown as Record<string, unknown>),
          repeated: false,
          auditId: audit.id,
          outboxEventId: outbox.id
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  } catch (error) {
    if (objectKey)
      await input.storage
        .deleteObject({ area: STORAGE_AREAS.CONTROLLED, objectKey })
        .catch(() => undefined);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AcceptanceReportServiceError(
        "ACCEPTANCE_REPORT_GENERATION_CONFLICT",
        "报告正在由其他请求生成，请刷新后重试。",
        409
      );
    }
    if (error instanceof AcceptanceReportPolicyError)
      throw new AcceptanceReportServiceError(error.code, error.message, error.status);
    if (error instanceof AcceptanceReportPdfIntegrityError)
      throw new AcceptanceReportServiceError(error.code, error.message, 409);
    throw error;
  }
}

export async function listAcceptanceReports(input: { projectId: string; reportId?: string }) {
  const where = {
    projectId: text(input.projectId, "projectId"),
    ...(input.reportId ? { id: text(input.reportId, "reportId") } : {})
  };
  const reports = await db.acceptanceReport.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { reportVersion: "desc" }],
    select: {
      id: true,
      projectId: true,
      acceptanceType: true,
      scopeType: true,
      scopeId: true,
      reportNumber: true,
      reportVersion: true,
      sourceBatchId: true,
      finalBatchId: true,
      retestChainJson: true,
      templateVersionId: true,
      templateChecksum: true,
      snapshotChecksum: true,
      rendererVersion: true,
      pdfFileId: true,
      pdfSha256: true,
      pdfSize: true,
      pdfMimeType: true,
      controlledDocumentVersionId: true,
      status: true,
      requestedById: true,
      generatedAt: true,
      failureCode: true,
      failureMessage: true,
      supersedesReportId: true,
      createdAt: true,
      confirmations: {
        orderBy: { recordedAt: "desc" },
        select: {
          id: true,
          decision: true,
          status: true,
          recordedAt: true,
          supersedesConfirmationId: true
        }
      }
    }
  });
  return {
    projectId: where.projectId,
    reports: reports.map((report) => serializeReport(report as unknown as Record<string, unknown>))
  };
}

export async function getAcceptanceReport(input: {
  projectId: string;
  reportId: string;
  sensitive?: boolean;
}) {
  const report = await db.acceptanceReport.findFirst({
    where: { id: text(input.reportId, "reportId"), projectId: text(input.projectId, "projectId") },
    include: {
      confirmations: {
        orderBy: { recordedAt: "desc" },
        include: {
          evidence: {
            include: { fileObject: { select: { id: true, sha256: true, originalName: true } } }
          }
        }
      }
    }
  });
  if (!report)
    throw new AcceptanceReportServiceError("ACCEPTANCE_REPORT_NOT_FOUND", "验收报告不存在。", 404);
  const { snapshotJson: _snapshotJson, ...serialized } = serializeReport(
    report as unknown as Record<string, unknown>
  ) as Record<string, unknown>;
  return {
    report: {
      ...serialized,
      ...(input.sensitive ? { snapshotJson: report.snapshotJson } : {}),
      confirmations: report.confirmations.map((confirmation) => ({
        id: confirmation.id,
        decision: confirmation.decision,
        status: confirmation.status,
        recordedAt: confirmation.recordedAt.toISOString(),
        supersedesConfirmationId: confirmation.supersedesConfirmationId,
        ...(input.sensitive
          ? {
              reportChecksum: confirmation.reportChecksum,
              customerOrganization: confirmation.customerOrganization,
              customerRepresentative: confirmation.customerRepresentative,
              representativeTitle: confirmation.representativeTitle,
              confirmationChannel: confirmation.confirmationChannel,
              customerConfirmedAt: confirmation.customerConfirmedAt.toISOString(),
              comment: confirmation.comment,
              confirmationChecksum: confirmation.confirmationChecksum,
              evidence: confirmation.evidence.map((evidence) => ({
                fileId: evidence.fileObject.id,
                fileSha256: evidence.fileObject.sha256,
                originalName: evidence.fileObject.originalName
              }))
            }
          : {})
      }))
    }
  };
}

export async function recordAcceptanceConfirmation(
  input: {
    projectId: string;
    reportId: string;
    version: number;
    reportChecksum: string;
    decision: unknown;
    customerOrganization: unknown;
    customerRepresentative: unknown;
    representativeTitle: unknown;
    confirmationChannel: unknown;
    customerConfirmedAt: unknown;
    comment: unknown;
    evidenceFileIds: unknown;
    supersedesConfirmationId?: string | null;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const decision = enumValue(
    input.decision,
    ACCEPTANCE_CONFIRMATION_DECISIONS,
    "decision"
  ) as ConfirmationDecision;
  const confirmationChannel = enumValue(
    input.confirmationChannel,
    ACCEPTANCE_CONFIRMATION_CHANNELS,
    "confirmationChannel"
  ) as ConfirmationChannel;
  const evidenceFileIds = Array.isArray(input.evidenceFileIds)
    ? [
        ...new Set(
          input.evidenceFileIds.filter(
            (value): value is string => typeof value === "string" && Boolean(value.trim())
          )
        )
      ]
    : [];
  if (evidenceFileIds.length === 0)
    throw new AcceptanceReportServiceError(
      "CONFIRMATION_EVIDENCE_REQUIRED",
      "客户确认至少需要一个确认凭证。",
      422
    );
  const customerConfirmedAt = asDate(input.customerConfirmedAt, "customerConfirmedAt");
  return inTransaction(transaction, async (client) => {
    const project = await client.project.findUnique({
      where: { id: text(input.projectId, "projectId") },
      select: { status: true }
    });
    if (!project) throw new AcceptanceReportServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
    try {
      assertProjectWritable(project.status);
    } catch (error) {
      if (error instanceof ProjectWritePolicyError) {
        throw new AcceptanceReportServiceError(error.code, error.message, error.status);
      }
      throw error;
    }
    const report = await client.acceptanceReport.findFirst({
      where: { id: text(input.reportId, "reportId"), projectId: text(input.projectId, "projectId") }
    });
    if (!report)
      throw new AcceptanceReportServiceError(
        "ACCEPTANCE_REPORT_NOT_FOUND",
        "验收报告不存在。",
        404
      );
    if (!Number.isSafeInteger(input.version) || input.version !== report.reportVersion) {
      throw new AcceptanceReportServiceError(
        "ACCEPTANCE_REPORT_VERSION_CONFLICT",
        "验收报告版本已变化，请刷新后重试。",
        409
      );
    }
    if (
      !["READY", "PUBLISHED"].includes(report.status) ||
      report.snapshotChecksum !== text(input.reportChecksum, "reportChecksum", 128)
    )
      throw new AcceptanceReportServiceError(
        "ACCEPTANCE_REPORT_CHECKSUM_CONFLICT",
        "只能确认确切的 READY/PUBLISHED 报告版本。",
        409
      );
    const files = await client.fileObject.findMany({
      where: { id: { in: evidenceFileIds }, projectId: input.projectId },
      select: {
        id: true,
        projectId: true,
        status: true,
        storageArea: true,
        sensitivity: true,
        scannedAt: true,
        sha256: true
      }
    });
    if (files.length !== evidenceFileIds.length)
      throw new AcceptanceReportServiceError(
        "CONFIRMATION_EVIDENCE_NOT_FOUND",
        "确认凭证不存在或不属于当前项目。",
        404
      );
    for (const file of files) {
      try {
        assertConfirmationEvidence({ projectId: input.projectId, file });
      } catch (error) {
        if (error instanceof AcceptanceReportPolicyError)
          throw new AcceptanceReportServiceError(error.code, error.message, error.status);
        throw error;
      }
    }
    let superseded: { id: string } | null = null;
    if (input.supersedesConfirmationId) {
      superseded = await client.acceptanceConfirmation.findFirst({
        where: {
          id: input.supersedesConfirmationId,
          projectId: input.projectId,
          reportId: report.id,
          status: "ACTIVE"
        },
        select: { id: true }
      });
      if (!superseded)
        throw new AcceptanceReportServiceError(
          "CONFIRMATION_SUPERSEDES_INVALID",
          "只能取代同一报告的有效确认记录。",
          409
        );
      await client.acceptanceConfirmation.update({
        where: { id: superseded.id },
        data: { status: "SUPERSEDED" }
      });
    }
    const evidence = files.map((file) => ({ fileId: file.id, sha256: file.sha256! }));
    const confirmationChecksum = calculateConfirmationChecksum({
      projectId: input.projectId,
      reportId: report.id,
      reportChecksum: report.snapshotChecksum,
      controlledDocumentVersionId: report.controlledDocumentVersionId,
      decision,
      customerOrganization: text(input.customerOrganization, "customerOrganization"),
      customerRepresentative: text(input.customerRepresentative, "customerRepresentative"),
      representativeTitle: text(input.representativeTitle, "representativeTitle"),
      confirmationChannel,
      customerConfirmedAt: customerConfirmedAt.toISOString(),
      comment: text(input.comment, "comment", 4096),
      evidence,
      supersedesConfirmationId: superseded?.id ?? null
    });
    const confirmation = await client.acceptanceConfirmation.create({
      data: {
        projectId: input.projectId,
        reportId: report.id,
        reportChecksum: report.snapshotChecksum,
        controlledDocumentVersionId: report.controlledDocumentVersionId,
        decision: decision as AcceptanceConfirmationDecision,
        customerOrganization: text(input.customerOrganization, "customerOrganization"),
        customerRepresentative: text(input.customerRepresentative, "customerRepresentative"),
        representativeTitle: text(input.representativeTitle, "representativeTitle"),
        confirmationChannel: confirmationChannel as AcceptanceConfirmationChannel,
        customerConfirmedAt,
        comment: text(input.comment, "comment", 4096),
        recordedById: input.actorId,
        supersedesConfirmationId: superseded?.id ?? null,
        confirmationChecksum,
        evidence: {
          create: files.map((file) => ({
            fileObjectId: file.id,
            fileSha256: file.sha256!,
            createdById: input.actorId
          }))
        }
      },
      include: { evidence: true }
    });
    const value = {
      projectId: input.projectId,
      confirmationId: confirmation.id,
      reportId: report.id,
      reportChecksum: report.snapshotChecksum,
      controlledDocumentVersionId: report.controlledDocumentVersionId,
      decision: confirmation.decision,
      confirmationChannel: confirmation.confirmationChannel,
      recordedAt: confirmation.recordedAt.toISOString(),
      supersedesConfirmationId: confirmation.supersedesConfirmationId,
      confirmationChecksum,
      evidenceFileId: files.map((file) => file.id),
      evidenceFileSha256: files.map((file) => file.sha256)
    };
    const audit = await writeAudit(client, {
      action: superseded
        ? AUDIT_ACTIONS.ACCEPTANCE_CONFIRMATION_SUPERSEDED
        : AUDIT_ACTIONS.ACCEPTANCE_CONFIRMATION_RECORDED,
      objectType: AUDIT_OBJECT_TYPES.ACCEPTANCE_CONFIRMATION,
      objectId: confirmation.id,
      context: { ...input.auditContext, actorId: input.actorId, projectId: input.projectId },
      after: { value, allowedFields: ACCEPTANCE_CONFIRMATION_AUDIT_FIELDS }
    });
    const outbox = await appendOutboxEvent(client, {
      eventType: "acceptance.confirmation.recorded",
      aggregateType: "ACCEPTANCE_CONFIRMATION",
      aggregateId: confirmation.id,
      idempotencyKey: `${confirmation.id}:recorded`,
      payload: { ...value, auditId: audit.id },
      traceId: input.auditContext.traceId ?? undefined
    });
    return { confirmation, auditId: audit.id, outboxEventId: outbox.id };
  });
}

export async function isConfirmationEvidenceFile(input: { projectId: string; fileId: string }) {
  return db.acceptanceConfirmationEvidence.findFirst({
    where: { projectId: input.projectId, fileObjectId: input.fileId },
    select: { id: true, confirmationId: true }
  });
}
