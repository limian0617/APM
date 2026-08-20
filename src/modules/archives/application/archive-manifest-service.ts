import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";

export const ARCHIVE_EXTERNAL_PUBLICATION = {
  NOT_APPLICABLE: "NOT_APPLICABLE"
} as const;

export type ArchiveExternalPublicationApplicability =
  (typeof ARCHIVE_EXTERNAL_PUBLICATION)[keyof typeof ARCHIVE_EXTERNAL_PUBLICATION];

export type ArchiveManifestFile = {
  id: string;
  projectId: string;
  status: string;
  scannedAt: Date | null;
  storageArea: string;
  sha256: string | null;
  mimeType: string | null;
  size: bigint | number | null;
};

export type ArchiveManifestSourceInput = {
  sourceType: string;
  sourceId: string;
  sourceVersion: string | number;
  snapshotJson: unknown;
  file?: ArchiveManifestFile | null;
};

export type ProjectArchiveManifestItem = {
  position: number;
  sourceType: string;
  sourceId: string;
  sourceVersion: string;
  sourceChecksum: string;
  fileObjectId: string | null;
  fileSha256: string | null;
  fileMimeType: string | null;
  fileSize: bigint | null;
  snapshotJson: JsonValue;
};

export type ProjectArchiveManifest = {
  projectId: string;
  externalPublication: {
    applicability: ArchiveExternalPublicationApplicability;
    reason: string;
  };
  items: ProjectArchiveManifestItem[];
  manifestChecksum: string;
  sourceWatermark: string;
  snapshotJson: JsonValue;
};

export type ArchiveManifestBuild = ProjectArchiveManifest;

export type ArchiveSourceFacts = {
  projectId: string;
  items: readonly ArchiveManifestSourceInput[];
};

export class ArchiveManifestError extends Error {
  constructor(
    readonly code:
      | "ARCHIVE_SOURCE_FILE_INVALID"
      | "ARCHIVE_SOURCE_VERSION_REQUIRED"
      | "ARCHIVE_SOURCE_FACTS_UNAVAILABLE",
    message?: string
  ) {
    super(message ?? code);
    this.name = "ArchiveManifestError";
  }
}

function requiredText(value: string | number, field: string): string {
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 191) {
    throw new ArchiveManifestError("ARCHIVE_SOURCE_FACTS_UNAVAILABLE", `${field} 不可用。`);
  }
  return normalized;
}

function sha256(value: string | null): string {
  if (!value || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new ArchiveManifestError("ARCHIVE_SOURCE_FILE_INVALID", "归档来源文件缺少有效 SHA-256。");
  }
  return value;
}

function normalizeFile(projectId: string, file: ArchiveManifestFile) {
  if (
    file.projectId !== projectId ||
    file.status !== "AVAILABLE" ||
    file.scannedAt === null ||
    file.storageArea !== "CONTROLLED" ||
    !file.id.trim() ||
    !file.mimeType?.trim() ||
    file.size === null ||
    BigInt(file.size) < 0n
  ) {
    throw new ArchiveManifestError(
      "ARCHIVE_SOURCE_FILE_INVALID",
      "归档来源文件必须属于当前项目、已经扫描、可用且位于受控存储区。"
    );
  }
  return {
    fileObjectId: file.id.trim(),
    fileSha256: sha256(file.sha256),
    fileMimeType: file.mimeType.trim().toLowerCase(),
    fileSize: BigInt(file.size)
  };
}

function isInternalDrawingSelectionSet(sourceType: string): boolean {
  return sourceType.trim() === "DRAWING_SELECTION_SET";
}

function sortSources(
  left: Omit<ProjectArchiveManifestItem, "position">,
  right: Omit<ProjectArchiveManifestItem, "position">
) {
  return [left.sourceType, left.sourceId, left.sourceVersion, left.fileObjectId ?? ""]
    .join("\u0000")
    .localeCompare(
      [right.sourceType, right.sourceId, right.sourceVersion, right.fileObjectId ?? ""].join(
        "\u0000"
      ),
      "en"
    );
}

export function createProjectArchiveManifest(input: {
  projectId: string;
  items: readonly ArchiveManifestSourceInput[];
}): ProjectArchiveManifest {
  const projectId = requiredText(input.projectId, "projectId");
  const items = input.items
    .filter((item) => !isInternalDrawingSelectionSet(item.sourceType))
    .map((item) => {
      const sourceType = requiredText(item.sourceType, "sourceType");
      const sourceId = requiredText(item.sourceId, "sourceId");
      const sourceVersion = requiredText(item.sourceVersion, "sourceVersion");
      if (/^(current|latest)$/iu.test(sourceVersion)) {
        throw new ArchiveManifestError(
          "ARCHIVE_SOURCE_VERSION_REQUIRED",
          "归档清单只能引用确切来源版本。"
        );
      }
      const snapshot = payloadHash(item.snapshotJson).value;
      const file = item.file ? normalizeFile(projectId, item.file) : null;
      const sourceChecksum = payloadHash({
        sourceType,
        sourceId,
        sourceVersion,
        fileSha256: file?.fileSha256 ?? null,
        snapshotJson: snapshot
      }).hash;
      return {
        sourceType,
        sourceId,
        sourceVersion,
        sourceChecksum,
        fileObjectId: file?.fileObjectId ?? null,
        fileSha256: file?.fileSha256 ?? null,
        fileMimeType: file?.fileMimeType ?? null,
        fileSize: file?.fileSize ?? null,
        snapshotJson: snapshot
      };
    })
    .sort(sortSources)
    .map((item, position) => ({ ...item, position }));
  const externalPublication = {
    applicability: ARCHIVE_EXTERNAL_PUBLICATION.NOT_APPLICABLE,
    reason: "外部供应商包能力尚未实现。"
  } as const;
  const sourceWatermark = payloadHash({
    projectId,
    sources: items.map((item) => ({
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      sourceVersion: item.sourceVersion,
      sourceChecksum: item.sourceChecksum
    }))
  }).hash;
  const snapshotJson = payloadHash({
    projectId,
    externalPublication,
    items: items.map((item) => ({
      ...item,
      fileSize: item.fileSize === null ? null : item.fileSize.toString()
    }))
  }).value;
  return {
    projectId,
    externalPublication,
    items,
    manifestChecksum: payloadHash(snapshotJson).hash,
    sourceWatermark,
    snapshotJson
  };
}

export function createProjectArchiveManifestV2(input: {
  projectId: string;
  items: readonly ArchiveManifestSourceInput[];
}): ProjectArchiveManifest {
  const legacy = createProjectArchiveManifest(input);
  const archiveSourceFormulaVersion = "ARCHIVE.SOURCE@2" as const;
  const sourceWatermark = payloadHash({
    archiveSourceFormulaVersion,
    projectId: legacy.projectId,
    sources: legacy.items.map((item) => ({
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      sourceVersion: item.sourceVersion,
      sourceChecksum: item.sourceChecksum
    }))
  }).hash;
  const snapshotJson = payloadHash({
    archiveSourceFormulaVersion,
    projectId: legacy.projectId,
    externalPublication: legacy.externalPublication,
    items: legacy.items.map((item) => ({
      ...item,
      fileSize: item.fileSize === null ? null : item.fileSize.toString()
    }))
  }).value;
  return {
    ...legacy,
    sourceWatermark,
    snapshotJson,
    manifestChecksum: payloadHash(snapshotJson).hash
  };
}

export async function buildProjectArchiveManifest(input: {
  projectId: string;
  readSources: (projectId: string) => Promise<readonly ArchiveManifestSourceInput[]>;
}) {
  const projectId = requiredText(input.projectId, "projectId");
  const sources = await input.readSources(projectId);
  if (!Array.isArray(sources)) {
    throw new ArchiveManifestError("ARCHIVE_SOURCE_FACTS_UNAVAILABLE", "归档来源事实不可用。");
  }
  return createProjectArchiveManifest({ projectId, items: sources });
}
