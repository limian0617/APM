import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import {
  findCurrentV2Archive,
  findReadyApplicableV2Archive,
  isReadyApplicableV2Archive,
  type ArchiveV2Candidate,
  type ArchiveV2CurrentManifest,
  type ArchiveV2CurrentnessClient
} from "@/modules/archives/application/archive-v2-currentness";
import {
  evaluateClosurePolicyBinding,
  parseClosureCheckerBindings,
  resolveExactActiveClosurePolicy
} from "@/modules/governance/domain/closure-policy-binding";

type RetrospectiveVersionView = {
  id: string;
  status: string;
  retrospectiveId: string;
  retrospectiveInputArchiveVersionId: string;
  retrospectiveInputManifestChecksum?: string;
  retrospectiveInputSourceWatermark?: string;
  retrospectiveInputWatermarkVersion?: string;
  retrospectiveInputWatermark?: string;
  contentChecksum?: string;
  createdAt?: { toISOString?(): string } | unknown;
  submittedAt?: { toISOString?(): string } | unknown;
  [field: string]: unknown;
};

type RetrospectiveAggregate = {
  id: string;
  projectId: string;
  version: number;
  currentVersionId: string | null;
  latestApprovedVersionId: string | null;
  currentVersion: RetrospectiveVersionView | null;
  latestApprovedVersion: RetrospectiveVersionView | null;
  versions: RetrospectiveVersionView[];
  reviews: Array<Record<string, unknown>>;
};

type CurrentManifestReader = (input: {
  projectId: string;
  client: ArchiveV2CurrentnessClient;
}) => Promise<ArchiveV2CurrentManifest>;

type ClosurePolicyVersion = NonNullable<
  NonNullable<Parameters<typeof resolveExactActiveClosurePolicy>[0]>["currentVersion"]
>;

type GateEvidence = Record<string, unknown>;

export class ProjectRetrospectiveQueryError extends Error {
  constructor(public readonly code: "PROJECT_RETROSPECTIVE_POINTER_INVALID") {
    super(code);
    this.name = "ProjectRetrospectiveQueryError";
  }
}

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

function reviewView(review: Record<string, unknown>) {
  const reviewedAt = review.reviewedAt;
  return {
    ...review,
    reviewedAt:
      reviewedAt && typeof (reviewedAt as { toISOString?: unknown }).toISOString === "function"
        ? (reviewedAt as { toISOString(): string }).toISOString()
        : reviewedAt
  };
}

function assertRetrospectivePointers(aggregate: RetrospectiveAggregate) {
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

function archiveView(archive: ArchiveV2Candidate | null) {
  return archive && isReadyApplicableV2Archive(archive)
    ? { id: archive.id, status: archive.status }
    : null;
}

function frozenArchiveAIsBound(
  version: RetrospectiveVersionView,
  archive: ArchiveV2Candidate | null
) {
  return Boolean(
    archive &&
    isReadyApplicableV2Archive(archive) &&
    version.retrospectiveInputArchiveVersionId === archive.id &&
    version.retrospectiveInputManifestChecksum === archive.manifestChecksum &&
    version.retrospectiveInputSourceWatermark === archive.sourceWatermark &&
    version.retrospectiveInputWatermarkVersion === archive.retrospectiveInputWatermarkVersion &&
    version.retrospectiveInputWatermark === archive.retrospectiveInputWatermark
  );
}

function sameTuple(
  row: {
    projectId?: string;
    closurePolicyVersionId?: string | null;
    closurePolicyChecksum?: string | null;
    archiveSourceFormulaVersion?: string | null;
  },
  projectId: string,
  policy: ClosurePolicyVersion
) {
  return (
    row.projectId === projectId &&
    row.closurePolicyVersionId === policy.id &&
    row.closurePolicyChecksum === policy.policyChecksum &&
    row.archiveSourceFormulaVersion === "V2"
  );
}

function record(value: unknown): GateEvidence {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as GateEvidence) : {};
}

function archiveEvidenceMatches(
  evidence: GateEvidence,
  input: {
    projectId: string;
    archiveA: ArchiveV2Candidate;
    archiveB: ArchiveV2Candidate;
    retrospective: RetrospectiveVersionView;
  }
) {
  return (
    evidence.projectId === input.projectId &&
    evidence.archiveBId === input.archiveB.id &&
    evidence.archiveSourceFormulaVersion === "ARCHIVE.SOURCE@2" &&
    evidence.archiveAId === input.archiveA.id &&
    evidence.archiveAInputWatermark === input.archiveA.retrospectiveInputWatermark &&
    evidence.archiveBInputWatermark === input.archiveB.retrospectiveInputWatermark &&
    evidence.manifestChecksum === input.archiveB.manifestChecksum &&
    evidence.sourceWatermark === input.archiveB.sourceWatermark &&
    evidence.retrospectiveVersionId === input.retrospective.id &&
    evidence.currentRetrospectiveVersionId === input.retrospective.id &&
    evidence.latestApprovedRetrospectiveVersionId === input.retrospective.id &&
    evidence.archiveBIncludesRetrospectiveVersion === true &&
    evidence.sourceFactsCurrent === true
  );
}

function retrospectiveEvidenceMatches(
  evidence: GateEvidence,
  input: {
    projectId: string;
    archiveA: ArchiveV2Candidate;
    archiveB: ArchiveV2Candidate;
    retrospective: RetrospectiveVersionView;
  }
) {
  return (
    evidence.projectId === input.projectId &&
    evidence.archiveBId === input.archiveB.id &&
    evidence.archiveAId === input.archiveA.id &&
    evidence.archiveAInputWatermark === input.archiveA.retrospectiveInputWatermark &&
    evidence.archiveBInputWatermark === input.archiveB.retrospectiveInputWatermark &&
    (evidence.archiveBManifestChecksum ?? evidence.manifestChecksum) ===
      input.archiveB.manifestChecksum &&
    (evidence.archiveBSourceWatermark ?? evidence.sourceWatermark) ===
      input.archiveB.sourceWatermark &&
    evidence.retrospectiveVersionId === input.retrospective.id &&
    evidence.retrospectiveContentChecksum === input.retrospective.contentChecksum &&
    evidence.currentVersionId === input.retrospective.id &&
    evidence.latestApprovedVersionId === input.retrospective.id &&
    evidence.archiveBIncludesRetrospectiveVersion === true
  );
}

async function readApprovedG9(input: {
  client: ArchiveV2CurrentnessClient & {
    gateSubmission?: { findMany(input: unknown): Promise<Array<Record<string, unknown>>> };
  };
  projectId: string;
  policy: ClosurePolicyVersion | null;
  archiveA: ArchiveV2Candidate | null;
  archiveB: ArchiveV2Candidate | null;
  retrospective: RetrospectiveVersionView | null;
}) {
  if (!input.policy || !input.archiveA || !input.archiveB || !input.retrospective) return null;
  if (!input.client.gateSubmission) return null;
  const submissions = await input.client.gateSubmission.findMany({
    where: {
      projectId: input.projectId,
      status: "APPROVED",
      closurePolicyVersionId: input.policy.id
    },
    include: {
      gateInstance: { include: { gateDefinition: true } },
      gateCheckSnapshot: { include: { results: true } }
    },
    orderBy: [{ decidedAt: "desc" }, { sequence: "desc" }, { id: "desc" }]
  });
  const expected = {
    projectId: input.projectId,
    archiveA: input.archiveA,
    archiveB: input.archiveB,
    retrospective: input.retrospective
  };
  for (const candidate of submissions) {
    if (candidate.status !== "APPROVED") continue;
    const instance = candidate.gateInstance as {
      projectId?: string;
      gateDefinitionId?: string;
      closurePolicyVersionId?: string | null;
      closurePolicyChecksum?: string | null;
      archiveSourceFormulaVersion?: string | null;
      gateDefinition?: { id?: string; checkerBindingsJson?: unknown };
    } | null;
    const snapshot = candidate.gateCheckSnapshot as {
      projectId?: string;
      status?: string;
      closurePolicyVersionId?: string | null;
      closurePolicyChecksum?: string | null;
      archiveSourceFormulaVersion?: string | null;
      checkerBindingsJson?: unknown;
      results?: Array<Record<string, unknown>>;
    } | null;
    if (
      !sameTuple(candidate, input.projectId, input.policy) ||
      !instance ||
      !snapshot ||
      !sameTuple(instance, input.projectId, input.policy) ||
      !sameTuple(snapshot, input.projectId, input.policy) ||
      instance.gateDefinitionId !== input.policy.sourceGateDefinitionId ||
      instance.gateDefinition?.id !== input.policy.sourceGateDefinitionId ||
      snapshot.status !== "PASSED"
    ) {
      continue;
    }
    const binding = evaluateClosurePolicyBinding({
      projectId: input.projectId,
      sourceTemplateSnapshotId: input.policy.sourceTemplateSnapshotId,
      sourceGateDefinitionId: input.policy.sourceGateDefinitionId,
      sourceGateDefinitionBindings: parseClosureCheckerBindings(
        instance.gateDefinition?.checkerBindingsJson
      ),
      snapshotBindings: parseClosureCheckerBindings(snapshot.checkerBindingsJson),
      persisted: input.policy
    });
    if (
      !binding.policyFactsValid ||
      !binding.sourceGateDefinitionBindingsValid ||
      !binding.snapshotCheckerBindingsValid
    ) {
      continue;
    }
    const results = snapshot.results ?? [];
    const archiveResult = results.find(
      (result) =>
        result.checkerCode === "CLOSURE.ARCHIVE.G9" &&
        result.checkerVersion === 2 &&
        result.status === "PASSED"
    );
    const retrospectiveResult = results.find(
      (result) =>
        result.checkerCode === "CLOSURE.RETROSPECTIVE.G9" &&
        result.checkerVersion === 1 &&
        result.status === "PASSED"
    );
    if (
      !archiveResult ||
      !retrospectiveResult ||
      !archiveEvidenceMatches(record(archiveResult.evidenceJson), expected) ||
      !retrospectiveEvidenceMatches(record(retrospectiveResult.evidenceJson), expected)
    ) {
      continue;
    }
    return { submissionId: String(candidate.id), status: "APPROVED" as const };
  }
  return null;
}

async function safely<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

export async function getProjectRetrospective(input: {
  projectId: string;
  client?: Prisma.TransactionClient | typeof db;
  allowedActions?: readonly string[];
  readCurrentV2Manifest?: CurrentManifestReader;
}) {
  const client = input.client ?? db;
  const aggregate = (await client.projectRetrospective.findUnique({
    where: { projectId: input.projectId },
    include: {
      currentVersion: true,
      latestApprovedVersion: true,
      versions: { orderBy: { versionNo: "desc" } },
      reviews: { orderBy: { reviewedAt: "desc" } }
    }
  })) as RetrospectiveAggregate | null;
  const archiveClient = client as unknown as ArchiveV2CurrentnessClient & {
    gateSubmission?: { findMany(input: unknown): Promise<Array<Record<string, unknown>>> };
  };
  if (!aggregate) {
    const archiveA = await safely(() =>
      findCurrentV2Archive({
        projectId: input.projectId,
        client: archiveClient,
        readCurrentManifest: input.readCurrentV2Manifest
      })
    );
    return {
      projectId: input.projectId,
      retrospective: null,
      currentVersionId: null,
      latestApprovedVersionId: null,
      staleApprovedPointer: false,
      currentVersion: null,
      latestApprovedVersion: null,
      archiveA: archiveView(archiveA),
      archiveB: null,
      closurePolicy: null,
      g9Approval: null,
      versions: [],
      reviews: [],
      allowedActions: input.allowedActions ?? []
    };
  }
  assertRetrospectivePointers(aggregate);
  const currentVersion = aggregate.currentVersion;
  const latestApprovedVersion = aggregate.latestApprovedVersion;
  const governingVersion = latestApprovedVersion ?? currentVersion;
  const archiveA = governingVersion
    ? await safely(async () => {
        const candidate = latestApprovedVersion
          ? await findReadyApplicableV2Archive({
              projectId: input.projectId,
              archiveVersionId: governingVersion.retrospectiveInputArchiveVersionId,
              client: archiveClient
            })
          : await findCurrentV2Archive({
              projectId: input.projectId,
              archiveVersionId: governingVersion.retrospectiveInputArchiveVersionId,
              client: archiveClient,
              readCurrentManifest: input.readCurrentV2Manifest
            });
        return frozenArchiveAIsBound(governingVersion, candidate) ? candidate : null;
      })
    : null;
  const archiveB =
    latestApprovedVersion && currentVersion?.id === latestApprovedVersion.id
      ? await safely(() =>
          findCurrentV2Archive({
            projectId: input.projectId,
            retrospectiveVersionId: latestApprovedVersion.id,
            client: archiveClient,
            readCurrentManifest: input.readCurrentV2Manifest
          })
        )
      : null;
  const closurePolicyRecord = await safely(async () =>
    client.projectClosurePolicy.findUnique({
      where: { projectId: input.projectId },
      include: {
        currentVersion: { include: { sourceGateDefinition: true, sourceTemplateSnapshot: true } }
      }
    })
  );
  const policyVersion = resolveExactActiveClosurePolicy(
    closurePolicyRecord as Parameters<typeof resolveExactActiveClosurePolicy>[0],
    input.projectId
  );
  const g9Approval =
    policyVersion && archiveA && archiveB && currentVersion?.id === latestApprovedVersion?.id
      ? await safely(() =>
          readApprovedG9({
            client: archiveClient,
            projectId: input.projectId,
            policy: policyVersion,
            archiveA,
            archiveB,
            retrospective: latestApprovedVersion
          })
        )
      : null;
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
    archiveA: archiveView(archiveA),
    archiveB: archiveView(archiveB),
    closurePolicy: policyVersion ? { id: policyVersion.id, status: policyVersion.status } : null,
    g9Approval,
    versions: aggregate.versions.map(versionView),
    reviews: aggregate.reviews.map(reviewView),
    allowedActions: input.allowedActions ?? []
  };
}
