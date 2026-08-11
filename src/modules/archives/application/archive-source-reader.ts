import {
  ArchiveManifestError,
  type ArchiveManifestFile,
  type ArchiveManifestSourceInput
} from "./archive-manifest-service";

export type ArchiveSourceClient = {
  project: { findUnique(input: unknown): Promise<{ id: string } | null> };
  controlledDocumentVersion: { findMany(input: unknown): Promise<readonly Record<string, any>[]> };
  mechanicalDrawingVersionFile: {
    findMany(input: unknown): Promise<readonly Record<string, any>[]>;
  };
  documentReview: { findMany(input: unknown): Promise<readonly Record<string, any>[]> };
  gateSubmission: { findMany(input: unknown): Promise<readonly Record<string, any>[]> };
  acceptanceBatch: { findMany(input: unknown): Promise<readonly Record<string, any>[]> };
  acceptanceReport: { findMany(input: unknown): Promise<readonly Record<string, any>[]> };
  acceptanceConfirmation: { findMany(input: unknown): Promise<readonly Record<string, any>[]> };
};

function fileFacts(
  projectId: string,
  value: Record<string, any> | null | undefined
): ArchiveManifestFile | null {
  if (!value) return null;
  return {
    id: String(value.id),
    projectId,
    status: String(value.status),
    scannedAt:
      value.scannedAt instanceof Date
        ? value.scannedAt
        : value.scannedAt
          ? new Date(value.scannedAt)
          : null,
    storageArea: String(value.storageArea),
    sha256: value.sha256 ?? null,
    mimeType: value.verifiedMimeType ?? value.declaredMimeType ?? null,
    size: value.verifiedSize ?? value.declaredSize ?? null
  };
}

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null;
}

function documentSources(
  projectId: string,
  rows: readonly Record<string, any>[]
): ArchiveManifestSourceInput[] {
  return rows.map((row) => ({
    sourceType: "CONTROLLED_DOCUMENT_VERSION",
    sourceId: String(row.id),
    sourceVersion: String(row.version),
    file: fileFacts(projectId, row.sourceFile),
    snapshotJson: {
      documentCode: row.document?.code ?? null,
      documentTitle: row.document?.title ?? null,
      status: row.status,
      publishedAt: iso(row.publishedAt)
    }
  }));
}

export async function readProjectArchiveSources(input: {
  projectId: string;
  client: ArchiveSourceClient | Pick<ArchiveSourceClient, "project">;
}): Promise<ArchiveManifestSourceInput[]> {
  const client = input.client as ArchiveSourceClient;
  const project = await client.project.findUnique({
    where: { id: input.projectId },
    select: { id: true }
  });
  if (!project) {
    throw new ArchiveManifestError("ARCHIVE_SOURCE_FACTS_UNAVAILABLE", "归档项目不存在。 ");
  }
  const [documents, drawingFiles, reviews, submissions, batches, reports, confirmations] =
    await Promise.all([
      client.controlledDocumentVersion.findMany({
        where: { projectId: input.projectId, status: "PUBLISHED" },
        include: { sourceFile: true, document: true },
        orderBy: [{ documentId: "asc" }, { version: "asc" }]
      }),
      client.mechanicalDrawingVersionFile.findMany({
        where: { projectId: input.projectId },
        include: { drawing: true, documentVersion: true, file: true },
        orderBy: { id: "asc" }
      }),
      client.documentReview.findMany({
        where: { projectId: input.projectId },
        orderBy: { id: "asc" }
      }),
      client.gateSubmission.findMany({
        where: { projectId: input.projectId },
        include: { documentReferences: true, approvals: true },
        orderBy: { id: "asc" }
      }),
      client.acceptanceBatch.findMany({
        where: { projectId: input.projectId, status: "LOCKED" },
        include: {
          templateVersion: true,
          results: {
            include: { item: true, revisions: { orderBy: { revisionNo: "desc" }, take: 1 } },
            orderBy: { itemId: "asc" }
          }
        },
        orderBy: { id: "asc" }
      }),
      client.acceptanceReport.findMany({
        where: { projectId: input.projectId, status: { in: ["READY", "PUBLISHED"] } },
        include: { pdfFile: true },
        orderBy: [{ reportNumber: "asc" }, { reportVersion: "asc" }]
      }),
      client.acceptanceConfirmation.findMany({
        where: { projectId: input.projectId, status: "ACTIVE" },
        include: { evidence: { include: { fileObject: true } } },
        orderBy: { id: "asc" }
      })
    ]);

  const sources: ArchiveManifestSourceInput[] = [...documentSources(input.projectId, documents)];
  sources.push(
    ...drawingFiles.map((row) => ({
      sourceType: "MECHANICAL_DRAWING_VERSION",
      sourceId: String(row.documentVersionId),
      sourceVersion: `${String(row.documentVersion?.version)}:${String(row.role)}`,
      file: fileFacts(input.projectId, row.file),
      snapshotJson: {
        drawingId: row.drawingId,
        drawingNumber: row.drawing?.drawingNumber ?? null,
        drawingType: row.drawing?.drawingType ?? null,
        role: row.role
      }
    }))
  );
  sources.push(
    ...reviews.map((row) => ({
      sourceType: "DOCUMENT_REVIEW",
      sourceId: String(row.id),
      sourceVersion: String(row.version),
      snapshotJson: {
        documentVersionId: row.documentVersionId,
        reviewerId: row.reviewerId,
        required: row.required,
        status: row.status,
        decidedAt: iso(row.decidedAt)
      }
    }))
  );
  sources.push(
    ...submissions.flatMap((row) => [
      {
        sourceType: "GATE_SUBMISSION",
        sourceId: String(row.id),
        sourceVersion: String(row.sequence),
        snapshotJson: {
          status: row.status,
          gateInstanceId: row.gateInstanceId,
          snapshotId: row.gateCheckSnapshotId,
          submittedAt: iso(row.submittedAt),
          approvals: row.approvals ?? []
        }
      },
      ...(row.documentReferences ?? []).map((reference: Record<string, any>) => ({
        sourceType: "GATE_SUBMISSION_DOCUMENT_REFERENCE",
        sourceId: String(reference.id),
        sourceVersion: iso(reference.createdAt) ?? "1",
        snapshotJson: {
          gateSubmissionId: row.id,
          documentVersionId: reference.documentVersionId,
          documentVersion: reference.documentVersion,
          sourceFileSha256: reference.sourceFileSha256,
          reviewEvidenceJson: reference.reviewEvidenceJson
        }
      }))
    ])
  );
  sources.push(
    ...batches.map((row) => ({
      sourceType: "ACCEPTANCE_BATCH",
      sourceId: String(row.id),
      sourceVersion: `LOCKED:${String(row.version)}`,
      snapshotJson: {
        acceptanceType: row.acceptanceType,
        scopeType: row.scopeType,
        scopeId: row.scopeId,
        status: row.status,
        templateVersionId: row.templateVersionId,
        templateChecksum: row.templateVersion?.checksum ?? null,
        results: (row.results ?? []).map((result: Record<string, any>) => ({
          resultId: result.id,
          itemId: result.itemId,
          revision: result.revisions?.[0] ?? null
        }))
      }
    }))
  );
  sources.push(
    ...reports.map((row) => ({
      sourceType: "ACCEPTANCE_REPORT",
      sourceId: String(row.id),
      sourceVersion: String(row.reportVersion),
      file: fileFacts(input.projectId, row.pdfFile),
      snapshotJson: {
        reportNumber: row.reportNumber,
        reportVersion: row.reportVersion,
        sourceBatchId: row.sourceBatchId,
        finalBatchId: row.finalBatchId,
        snapshotChecksum: row.snapshotChecksum,
        pdfSha256: row.pdfSha256,
        status: row.status
      }
    }))
  );
  sources.push(
    ...confirmations.flatMap((row) => [
      {
        sourceType: "ACCEPTANCE_CONFIRMATION",
        sourceId: String(row.id),
        sourceVersion: iso(row.recordedAt) ?? "1",
        snapshotJson: {
          reportId: row.reportId,
          reportChecksum: row.reportChecksum,
          decision: row.decision,
          customerOrganization: row.customerOrganization,
          customerRepresentative: row.customerRepresentative,
          recordedAt: iso(row.recordedAt),
          status: row.status
        }
      },
      ...(row.evidence ?? []).map((evidence: Record<string, any>) => ({
        sourceType: "ACCEPTANCE_CONFIRMATION",
        sourceId: `${String(row.id)}:${String(evidence.id)}`,
        sourceVersion: iso(evidence.createdAt) ?? "1",
        file: fileFacts(input.projectId, evidence.fileObject),
        snapshotJson: {
          confirmationId: row.id,
          evidenceId: evidence.id,
          fileSha256: evidence.fileSha256
        }
      }))
    ])
  );
  return sources;
}
