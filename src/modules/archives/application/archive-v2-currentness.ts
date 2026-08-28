import type { Prisma } from "@prisma/client";

import { getArchiveSourceFormulaAdapter } from "./archive-source-formula-registry";

export type ArchiveV2CurrentManifest = {
  manifestChecksum: string;
  sourceWatermark: string;
};

export type ArchiveV2Candidate = {
  id: string;
  version?: number;
  status: string;
  archiveSourceFormulaVersion: string;
  retrospectiveInputApplicability: string;
  retrospectiveInputWatermarkVersion?: string | null;
  retrospectiveInputWatermark?: string | null;
  manifestChecksum: string;
  sourceWatermark: string;
  integrityChecks: Array<{ sequence?: number; status: string }>;
  manifestItems?: Array<{ sourceType: string; sourceId: string }>;
};

export type ArchiveV2CurrentnessClient = {
  projectArchiveVersion?: {
    findMany(input: unknown): Promise<ArchiveV2Candidate[]>;
  };
  project?: unknown;
  controlledDocumentVersion?: unknown;
  mechanicalDrawingVersionFile?: unknown;
  documentReview?: unknown;
  gateSubmission?: unknown;
  acceptanceBatch?: unknown;
  acceptanceReport?: unknown;
  acceptanceConfirmation?: unknown;
};

function latestIntegrityStatus(candidate: ArchiveV2Candidate): string | null {
  const checks = [...candidate.integrityChecks].sort(
    (left, right) => (right.sequence ?? 0) - (left.sequence ?? 0)
  );
  return checks[0]?.status ?? null;
}

export function isReadyApplicableV2Archive(candidate: ArchiveV2Candidate | null): boolean {
  return Boolean(
    candidate &&
    candidate.status === "READY" &&
    candidate.archiveSourceFormulaVersion === "V2" &&
    candidate.retrospectiveInputApplicability === "APPLICABLE" &&
    latestIntegrityStatus(candidate) === "PASSED"
  );
}

function deterministicNewest(candidates: readonly ArchiveV2Candidate[]) {
  return [...candidates].sort(
    (left, right) =>
      (right.version ?? 0) - (left.version ?? 0) || right.id.localeCompare(left.id, "en")
  );
}

export async function readCurrentV2ArchiveManifest(input: {
  projectId: string;
  client: ArchiveV2CurrentnessClient;
}): Promise<ArchiveV2CurrentManifest> {
  const adapter = getArchiveSourceFormulaAdapter("ARCHIVE.SOURCE@2");
  const manifest = adapter.buildManifest(
    await adapter.read({
      client: input.client as unknown as Prisma.TransactionClient,
      projectId: input.projectId
    })
  );
  return {
    manifestChecksum: manifest.manifestChecksum,
    sourceWatermark: manifest.sourceWatermark
  };
}

export async function findReadyApplicableV2Archive(input: {
  projectId: string;
  archiveVersionId: string;
  client: ArchiveV2CurrentnessClient;
}): Promise<ArchiveV2Candidate | null> {
  const archives = input.client.projectArchiveVersion;
  if (!archives) return null;
  const candidates = await archives.findMany({
    where: {
      id: input.archiveVersionId,
      projectId: input.projectId,
      status: "READY",
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE"
    },
    include: {
      integrityChecks: { orderBy: { sequence: "desc" }, take: 1 },
      manifestItems: true
    },
    orderBy: [{ version: "desc" }, { id: "desc" }]
  });
  return deterministicNewest(candidates).find(isReadyApplicableV2Archive) ?? null;
}

export async function findCurrentV2Archive(input: {
  projectId: string;
  client: ArchiveV2CurrentnessClient;
  retrospectiveVersionId?: string;
  archiveVersionId?: string;
  readCurrentManifest?: (input: {
    projectId: string;
    client: ArchiveV2CurrentnessClient;
  }) => Promise<ArchiveV2CurrentManifest>;
}): Promise<ArchiveV2Candidate | null> {
  const archives = input.client.projectArchiveVersion;
  if (!archives) return null;
  if (
    !input.readCurrentManifest &&
    (!input.client.project ||
      !input.client.controlledDocumentVersion ||
      !input.client.mechanicalDrawingVersionFile ||
      !input.client.documentReview ||
      !input.client.gateSubmission ||
      !input.client.acceptanceBatch ||
      !input.client.acceptanceReport ||
      !input.client.acceptanceConfirmation)
  ) {
    return null;
  }
  let current: ArchiveV2CurrentManifest;
  try {
    current = await (input.readCurrentManifest ?? readCurrentV2ArchiveManifest)({
      projectId: input.projectId,
      client: input.client
    });
  } catch {
    return null;
  }
  const candidates = await archives.findMany({
    where: {
      ...(input.archiveVersionId ? { id: input.archiveVersionId } : {}),
      projectId: input.projectId,
      status: "READY",
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE",
      ...(input.retrospectiveVersionId
        ? {
            manifestItems: {
              some: {
                sourceType: "PROJECT_RETROSPECTIVE_VERSION",
                sourceId: input.retrospectiveVersionId
              }
            }
          }
        : {})
    },
    include: {
      integrityChecks: { orderBy: { sequence: "desc" }, take: 1 },
      manifestItems: input.retrospectiveVersionId
        ? {
            where: {
              sourceType: "PROJECT_RETROSPECTIVE_VERSION",
              sourceId: input.retrospectiveVersionId
            }
          }
        : true
    },
    orderBy: [{ version: "desc" }, { id: "desc" }]
  });
  return (
    deterministicNewest(candidates).find(
      (candidate) =>
        isReadyApplicableV2Archive(candidate) &&
        candidate.manifestChecksum === current.manifestChecksum &&
        candidate.sourceWatermark === current.sourceWatermark &&
        (!input.retrospectiveVersionId ||
          candidate.manifestItems?.some(
            (item) =>
              item.sourceType === "PROJECT_RETROSPECTIVE_VERSION" &&
              item.sourceId === input.retrospectiveVersionId
          ))
    ) ?? null
  );
}
