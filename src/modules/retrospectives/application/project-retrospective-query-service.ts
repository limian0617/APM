import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";

type RetrospectiveVersionView = {
  id: string;
  status: string;
  retrospectiveId: string;
  retrospectiveInputArchiveVersionId: string;
  createdAt?: { toISOString?(): string } | unknown;
  submittedAt?: { toISOString?(): string } | unknown;
  [field: string]: unknown;
};

function versionView(version: RetrospectiveVersionView) {
  return {
    ...version,
    createdAt:
      version.createdAt &&
      typeof (version.createdAt as { toISOString?: unknown }).toISOString === "function"
        ? (version.createdAt as { toISOString(): string }).toISOString()
        : version.createdAt,
    submittedAt:
      version.submittedAt &&
      typeof (version.submittedAt as { toISOString?: unknown }).toISOString === "function"
        ? (version.submittedAt as { toISOString(): string }).toISOString()
        : version.submittedAt
  };
}

export class ProjectRetrospectiveQueryError extends Error {
  constructor(public readonly code: "PROJECT_RETROSPECTIVE_POINTER_INVALID") {
    super(code);
  }
}

const V2_CLOSURE_BINDINGS = {
  archiveCheckerCode: "CLOSURE.ARCHIVE.G9",
  archiveCheckerVersion: 2,
  retrospectiveCheckerCode: "CLOSURE.RETROSPECTIVE.G9",
  retrospectiveCheckerVersion: 1,
  archiveSourceFormulaVersion: "V2"
} as const;

type ArchiveReadiness = {
  id: string;
  status: string;
  archiveSourceFormulaVersion: string;
  retrospectiveInputApplicability: string;
  integrityChecks: Array<{ status: string }>;
};

function isReadyApplicableV2Archive(archive: ArchiveReadiness | null) {
  return (
    archive?.status === "READY" &&
    archive.archiveSourceFormulaVersion === "V2" &&
    archive.retrospectiveInputApplicability === "APPLICABLE" &&
    archive.integrityChecks[0]?.status === "PASSED"
  );
}

function assertRetrospectivePointers(aggregate: {
  id: string;
  currentVersionId: string | null;
  latestApprovedVersionId: string | null;
  currentVersion: RetrospectiveVersionView | null;
  latestApprovedVersion: RetrospectiveVersionView | null;
}) {
  if (
    (aggregate.currentVersionId && !aggregate.currentVersion) ||
    (aggregate.latestApprovedVersionId && !aggregate.latestApprovedVersion) ||
    (aggregate.currentVersion?.retrospectiveId !== undefined &&
      aggregate.currentVersion.retrospectiveId !== aggregate.id) ||
    (aggregate.latestApprovedVersion?.retrospectiveId !== undefined &&
      aggregate.latestApprovedVersion.retrospectiveId !== aggregate.id) ||
    (aggregate.latestApprovedVersion && aggregate.latestApprovedVersion.status !== "APPROVED")
  ) {
    throw new ProjectRetrospectiveQueryError("PROJECT_RETROSPECTIVE_POINTER_INVALID");
  }
}

function isV2ClosurePolicy(
  policy: {
    status: string;
    currentVersionId: string | null;
    currentVersion: {
      id: string;
      status: string;
      archiveCheckerCode: string;
      archiveCheckerVersion: number;
      retrospectiveCheckerCode: string;
      retrospectiveCheckerVersion: number;
      archiveSourceFormulaVersion: string;
      sourceGateDefinition: { code: string; scope: string } | null;
      sourceTemplateSnapshot: { id: string } | null;
    } | null;
  } | null
) {
  if (!policy?.currentVersion || policy.status !== "ACTIVE") return null;
  const version = policy.currentVersion;
  if (
    policy.currentVersionId !== version.id ||
    version.status !== "ACTIVE" ||
    version.archiveCheckerCode !== V2_CLOSURE_BINDINGS.archiveCheckerCode ||
    version.archiveCheckerVersion !== V2_CLOSURE_BINDINGS.archiveCheckerVersion ||
    version.retrospectiveCheckerCode !== V2_CLOSURE_BINDINGS.retrospectiveCheckerCode ||
    version.retrospectiveCheckerVersion !== V2_CLOSURE_BINDINGS.retrospectiveCheckerVersion ||
    version.archiveSourceFormulaVersion !== V2_CLOSURE_BINDINGS.archiveSourceFormulaVersion ||
    version.sourceGateDefinition?.code !== "G9" ||
    version.sourceGateDefinition.scope !== "PROJECT" ||
    !version.sourceTemplateSnapshot
  ) {
    return null;
  }
  return { id: version.id, status: version.status };
}

export async function getProjectRetrospective(input: {
  projectId: string;
  client?: Prisma.TransactionClient | typeof db;
  allowedActions?: readonly string[];
}) {
  const client = input.client ?? db;
  const aggregate = await client.projectRetrospective.findUnique({
    where: { projectId: input.projectId },
    include: {
      currentVersion: true,
      latestApprovedVersion: true,
      versions: { orderBy: { versionNo: "desc" } },
      reviews: { orderBy: { reviewedAt: "desc" } }
    }
  });
  if (!aggregate) {
    return {
      projectId: input.projectId,
      retrospective: null,
      versions: [],
      allowedActions: input.allowedActions ?? []
    };
  }
  assertRetrospectivePointers(aggregate);
  const currentVersion = aggregate.currentVersion;
  const latestApprovedVersion = aggregate.latestApprovedVersion;
  const [archiveA, archiveB, closurePolicy] = await Promise.all([
    latestApprovedVersion?.retrospectiveInputArchiveVersionId
      ? client.projectArchiveVersion.findUnique({
          where: {
            id_projectId: {
              id: latestApprovedVersion.retrospectiveInputArchiveVersionId,
              projectId: input.projectId
            }
          },
          select: {
            id: true,
            status: true,
            archiveSourceFormulaVersion: true,
            retrospectiveInputApplicability: true,
            integrityChecks: { orderBy: { sequence: "desc" }, take: 1, select: { status: true } }
          }
        })
      : Promise.resolve(null),
    latestApprovedVersion
      ? client.projectArchiveVersion.findFirst({
          where: {
            projectId: input.projectId,
            status: "READY",
            archiveSourceFormulaVersion: "V2",
            retrospectiveInputApplicability: "APPLICABLE",
            manifestItems: {
              some: {
                sourceType: "PROJECT_RETROSPECTIVE_VERSION",
                sourceId: latestApprovedVersion.id
              }
            }
          },
          orderBy: { version: "desc" },
          select: {
            id: true,
            status: true,
            archiveSourceFormulaVersion: true,
            retrospectiveInputApplicability: true,
            integrityChecks: { orderBy: { sequence: "desc" }, take: 1, select: { status: true } }
          }
        })
      : Promise.resolve(null),
    client.projectClosurePolicy.findUnique({
      where: { projectId: input.projectId },
      include: {
        currentVersion: { include: { sourceGateDefinition: true, sourceTemplateSnapshot: true } }
      }
    })
  ]);
  if (latestApprovedVersion?.retrospectiveInputArchiveVersionId && !archiveA) {
    throw new ProjectRetrospectiveQueryError("PROJECT_RETROSPECTIVE_POINTER_INVALID");
  }
  return {
    projectId: input.projectId,
    retrospective: {
      id: aggregate.id,
      version: aggregate.version,
      currentVersionId: aggregate.currentVersionId,
      latestApprovedVersionId: aggregate.latestApprovedVersionId
    },
    currentVersionId: aggregate.currentVersionId,
    latestApprovedVersionId: aggregate.latestApprovedVersionId,
    staleApprovedPointer: aggregate.currentVersionId !== aggregate.latestApprovedVersionId,
    currentVersion: currentVersion ? versionView(currentVersion) : null,
    latestApprovedVersion: latestApprovedVersion ? versionView(latestApprovedVersion) : null,
    archiveA:
      archiveA && isReadyApplicableV2Archive(archiveA)
        ? { id: archiveA.id, status: archiveA.status }
        : null,
    archiveB:
      archiveB && isReadyApplicableV2Archive(archiveB)
        ? { id: archiveB.id, status: archiveB.status }
        : null,
    closurePolicy: isV2ClosurePolicy(closurePolicy),
    versions: aggregate.versions.map(versionView),
    reviews: aggregate.reviews.map((review: Record<string, any>) => ({
      ...review,
      reviewedAt: review.reviewedAt?.toISOString?.() ?? review.reviewedAt
    })),
    allowedActions: input.allowedActions ?? []
  };
}
