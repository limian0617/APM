import type { Prisma } from "@prisma/client";

import { getArchiveSourceFormulaAdapter } from "@/modules/archives/application/archive-source-formula-registry";
import type { JsonValue } from "@/modules/governance/domain/idempotency";

type ArchiveVersionRecord = {
  id: string;
  status: string;
  archiveSourceFormulaVersion: string;
  retrospectiveInputApplicability: string;
  retrospectiveInputWatermarkVersion: string | null;
  retrospectiveInputWatermark: string | null;
  manifestChecksum: string;
  sourceWatermark: string;
  integrityChecks?: Array<{ id: string; status: string; sequence?: number }>;
  manifestItems?: Array<{ sourceType: string; sourceId: string }>;
};

type RetrospectiveRecord = {
  currentVersionId: string | null;
  latestApprovedVersionId: string | null;
  currentVersion: {
    id: string;
    status: string;
    contentChecksum: string;
    submittedById: string | null;
    retrospectiveInputArchiveVersionId: string;
    retrospectiveInputManifestChecksum: string;
    retrospectiveInputSourceWatermark: string;
    retrospectiveInputWatermarkVersion: string;
    retrospectiveInputWatermark: string;
    reviews: Array<{ decision: string; reviewerId: string }>;
    contributions: Array<{ required: boolean; factText: string; impactText: string }>;
  } | null;
};

export type ClosureGateFactsClient = {
  projectArchiveVersion: {
    findMany(input: unknown): Promise<ArchiveVersionRecord[]>;
    findFirst(input: unknown): Promise<ArchiveVersionRecord | null>;
  };
  projectRetrospective: {
    findUnique(input: unknown): Promise<RetrospectiveRecord | null>;
  };
  residualItem: { findMany(input: unknown): Promise<Array<{ id: string }>> };
  projectArchive?: unknown;
  gateSubmission?: unknown;
};

function unavailable(projectId: string, reason: string): Readonly<Record<string, JsonValue>> {
  const closureArchiveV2 = {
    factsAvailable: false,
    projectId,
    archiveA: null,
    archiveB: null,
    approvedRetrospective: null,
    currentRetrospectiveVersionId: null,
    latestApprovedRetrospectiveVersionId: null,
    archiveBIncludesRetrospectiveVersion: false,
    openResidualItemIds: [],
    reason
  } as unknown as JsonValue;
  const closureRetrospective = {
    factsAvailable: false,
    projectId,
    currentVersionId: null,
    latestApprovedVersionId: null,
    retrospective: null,
    archiveA: null,
    archiveB: null,
    reason
  } as unknown as JsonValue;
  return { closureArchiveV2, closureRetrospective };
}

function archiveFacts(version: ArchiveVersionRecord | null) {
  if (!version) return null;
  return {
    id: version.id,
    status: version.status,
    archiveSourceFormulaVersion:
      version.archiveSourceFormulaVersion === "V2"
        ? "ARCHIVE.SOURCE@2"
        : version.archiveSourceFormulaVersion,
    retrospectiveInputApplicability: version.retrospectiveInputApplicability,
    retrospectiveInputWatermarkVersion: version.retrospectiveInputWatermarkVersion,
    retrospectiveInputWatermark: version.retrospectiveInputWatermark,
    manifestChecksum: version.manifestChecksum,
    sourceWatermark: version.sourceWatermark
  };
}

function latestIntegrityCheck(version: ArchiveVersionRecord | null) {
  const checks = version?.integrityChecks ?? [];
  return [...checks].sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0))[0] ?? null;
}

function requiredContributionsComplete(
  contributions: readonly { required: boolean; factText: string; impactText: string }[]
) {
  return contributions.every(
    (contribution) =>
      !contribution.required ||
      (Boolean(contribution.factText?.trim()) && Boolean(contribution.impactText?.trim()))
  );
}

function independentReview(retrospective: NonNullable<RetrospectiveRecord["currentVersion"]>) {
  return retrospective.reviews.some(
    (review) =>
      review.decision === "APPROVED" &&
      Boolean(review.reviewerId) &&
      review.reviewerId !== retrospective.submittedById
  );
}

export async function readClosureGateFacts(input: {
  projectId: string;
  client: ClosureGateFactsClient;
  readCurrentSourceWatermark?: (input: {
    projectId: string;
    archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2";
  }) => Promise<string>;
}): Promise<Readonly<Record<string, JsonValue>>> {
  const retrospective = await input.client.projectRetrospective.findUnique({
    where: { projectId: input.projectId },
    include: {
      currentVersion: { include: { reviews: true, contributions: true } }
    }
  });
  const current = retrospective?.currentVersion ?? null;
  const candidates = await input.client.projectArchiveVersion.findMany({
    where: {
      projectId: input.projectId,
      status: "READY",
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE"
    },
    include: {
      integrityChecks: { orderBy: { sequence: "desc" }, take: 1 },
      manifestItems: { where: { sourceType: "PROJECT_RETROSPECTIVE_VERSION" } }
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  const archiveB = current
    ? (candidates.find((candidate) =>
        (candidate.manifestItems ?? []).some(
          (item) =>
            item.sourceType === "PROJECT_RETROSPECTIVE_VERSION" && item.sourceId === current.id
        )
      ) ?? null)
    : null;
  if (!retrospective || !current || !archiveB)
    return unavailable(input.projectId, "ARCHIVE_B_OR_RETROSPECTIVE_REQUIRED");
  const archiveA = await input.client.projectArchiveVersion.findFirst({
    where: {
      id: current.retrospectiveInputArchiveVersionId,
      projectId: input.projectId,
      archiveSourceFormulaVersion: "V2",
      retrospectiveInputApplicability: "APPLICABLE"
    },
    include: { integrityChecks: { orderBy: { sequence: "desc" }, take: 1 } }
  });
  const residuals = await input.client.residualItem.findMany({
    where: { projectId: input.projectId, status: { not: "CLOSED" } },
    select: { id: true }
  });
  let sourceFactsCurrent = false;
  try {
    const sourceWatermark = input.readCurrentSourceWatermark
      ? await input.readCurrentSourceWatermark({
          projectId: input.projectId,
          archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2"
        })
      : await readCurrentV2SourceWatermark(input.projectId, input.client);
    sourceFactsCurrent = sourceWatermark === archiveB.sourceWatermark;
  } catch {
    sourceFactsCurrent = false;
  }
  const archiveAFacts = archiveFacts(archiveA);
  const archiveBFacts = archiveFacts(archiveB);
  const integrity = latestIntegrityCheck(archiveB);
  const archiveBIncludesRetrospectiveVersion = (archiveB.manifestItems ?? []).some(
    (item) => item.sourceType === "PROJECT_RETROSPECTIVE_VERSION" && item.sourceId === current.id
  );
  const retrospectiveFacts = {
    id: current.id,
    status: current.status,
    contentChecksum: current.contentChecksum,
    retrospectiveInputArchiveVersionId: current.retrospectiveInputArchiveVersionId,
    retrospectiveInputManifestChecksum: current.retrospectiveInputManifestChecksum,
    retrospectiveInputSourceWatermark: current.retrospectiveInputSourceWatermark,
    retrospectiveInputWatermarkVersion: current.retrospectiveInputWatermarkVersion,
    retrospectiveInputWatermark: current.retrospectiveInputWatermark,
    independentReviewer: independentReview(current),
    requiredContributionsComplete: requiredContributionsComplete(current.contributions)
  };
  return {
    closureArchiveV2: {
      factsAvailable: true,
      projectId: input.projectId,
      archiveA: archiveAFacts,
      archiveB: archiveBFacts
        ? {
            ...archiveBFacts,
            latestIntegrityCheck: integrity ? { id: integrity.id, status: integrity.status } : null,
            sourceFactsCurrent
          }
        : null,
      approvedRetrospective: {
        id: current.id,
        status: current.status,
        contentChecksum: current.contentChecksum,
        retrospectiveInputArchiveVersionId: current.retrospectiveInputArchiveVersionId
      },
      currentRetrospectiveVersionId: retrospective.currentVersionId,
      latestApprovedRetrospectiveVersionId: retrospective.latestApprovedVersionId,
      archiveBIncludesRetrospectiveVersion,
      openResidualItemIds: residuals.map((residual) => residual.id).sort()
    } as unknown as JsonValue,
    closureRetrospective: {
      factsAvailable: true,
      projectId: input.projectId,
      currentVersionId: retrospective.currentVersionId,
      latestApprovedVersionId: retrospective.latestApprovedVersionId,
      retrospective: retrospectiveFacts,
      archiveA: archiveAFacts,
      archiveB: archiveBFacts
        ? {
            ...archiveBFacts,
            latestIntegrityCheck: integrity ? { id: integrity.id, status: integrity.status } : null,
            sourceFactsCurrent,
            includesRetrospectiveVersion: archiveBIncludesRetrospectiveVersion
          }
        : null
    } as unknown as JsonValue
  };
}

async function readCurrentV2SourceWatermark(
  projectId: string,
  client: ClosureGateFactsClient
): Promise<string> {
  const adapter = getArchiveSourceFormulaAdapter("ARCHIVE.SOURCE@2");
  const manifest = adapter.buildManifest(
    await adapter.read({ client: client as unknown as Prisma.TransactionClient, projectId })
  );
  return manifest.sourceWatermark;
}
