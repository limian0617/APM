import type { ArchiveManifestSourceInput } from "./archive-manifest-service";

export const CLOSURE_SELF_REFERENCE_EXCLUSION_VERSION =
  "CLOSURE.SELF_REFERENCE_EXCLUSION@1" as const;

function isClosureSelfReference(
  source: ArchiveManifestSourceInput,
  closureSubmissionIds: ReadonlySet<string>
): boolean {
  if (
    source.sourceType !== "GATE_SUBMISSION" &&
    source.sourceType !== "GATE_SUBMISSION_DOCUMENT_REFERENCE"
  ) {
    return source.sourceType === "PROJECT_CLOSURE_RECORD";
  }
  const snapshot = source.snapshotJson as Record<string, unknown> | null;
  return (
    closureSubmissionIds.has(source.sourceId) ||
    (typeof snapshot?.gateSubmissionId === "string" &&
      closureSubmissionIds.has(snapshot.gateSubmissionId)) ||
    typeof snapshot?.closurePolicyVersionId === "string" ||
    typeof snapshot?.closurePolicyChecksum === "string"
  );
}

export async function readProjectArchiveSourcesV2(input: {
  projectId: string;
  client?: {
    gateSubmission: {
      findMany(input: unknown): Promise<ReadonlyArray<{ id: string }>>;
    };
    projectRetrospective?: {
      findUnique(input: unknown): Promise<Record<string, any> | null>;
    };
    projectRetrospectiveVersion?: {
      findUnique(input: unknown): Promise<Record<string, any> | null>;
    };
  };
  readLegacySources: (projectId: string) => Promise<readonly ArchiveManifestSourceInput[]>;
}): Promise<ArchiveManifestSourceInput[]> {
  const [sources, closureSubmissions] = await Promise.all([
    input.readLegacySources(input.projectId),
    input.client?.gateSubmission.findMany({
      where: { projectId: input.projectId, closurePolicyVersionId: { not: null } },
      select: { id: true }
    }) ?? Promise.resolve([])
  ]);
  const closureSubmissionIds = new Set(closureSubmissions.map((row) => row.id));
  const filtered = sources.filter(
    (source) => !isClosureSelfReference(source, closureSubmissionIds)
  );
  if (!input.client?.projectRetrospective || !input.client.projectRetrospectiveVersion) {
    return filtered;
  }
  const retrospective = await input.client.projectRetrospective.findUnique({
    where: { projectId: input.projectId },
    select: { currentVersionId: true, latestApprovedVersionId: true }
  });
  if (
    !retrospective ||
    !retrospective.currentVersionId ||
    retrospective.currentVersionId !== retrospective.latestApprovedVersionId
  ) {
    return filtered;
  }
  const version = await input.client.projectRetrospectiveVersion.findUnique({
    where: {
      id_projectId: { id: retrospective.currentVersionId, projectId: input.projectId }
    }
  });
  if (!version || version.status !== "APPROVED") return filtered;
  return [
    ...filtered,
    {
      sourceType: "PROJECT_RETROSPECTIVE_VERSION",
      sourceId: version.id,
      sourceVersion: String(version.versionNo),
      snapshotJson: {
        retrospectiveId: version.retrospectiveId,
        versionNo: version.versionNo,
        status: version.status,
        retrospectiveInputArchiveVersionId: version.retrospectiveInputArchiveVersionId,
        retrospectiveInputWatermark: version.retrospectiveInputWatermark,
        contentChecksum: version.contentChecksum
      }
    }
  ];
}
