export const ASSET_RELEASE_VERSION_STATUSES = ["DRAFT", "PUBLISHED", "SUPERSEDED"] as const;

export type AssetReleaseVersionStatus = (typeof ASSET_RELEASE_VERSION_STATUSES)[number];

export const ASSET_COMPONENT_TYPES = [
  "MECHANICAL_DRAWING",
  "SOFTWARE",
  "VALIDATION_REPORT"
] as const;

export type AssetComponentType = (typeof ASSET_COMPONENT_TYPES)[number];

export type AssetReleaseErrorCode =
  | "INVALID_RELEASE_CODE"
  | "INVALID_RELEASE_VERSION"
  | "INVALID_COMPONENT_TYPE"
  | "INVALID_COMPONENT_POSITION"
  | "INVALID_SOURCE_CHECKSUM"
  | "INVALID_FILE_SNAPSHOT"
  | "SOURCE_VERSION_NOT_PUBLISHED"
  | "SOURCE_REFERENCE_MISMATCH"
  | "SOURCE_FILE_NOT_AVAILABLE"
  | "INVALID_RELEASE_TRANSITION"
  | "PUBLISHED_VERSION_IMMUTABLE"
  | "DUPLICATE_COMPONENT_POSITION"
  | "SOURCE_NOT_FOUND"
  | "TECHNICAL_ASSET_NOT_FOUND"
  | "ASSET_RELEASE_NOT_FOUND"
  | "ASSET_RELEASE_VERSION_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "RELEASE_CODE_CONFLICT"
  | "ASSET_RELEASE_NOT_WRITABLE"
  | "ACTOR_NOT_FOUND"
  | "ACTOR_DISABLED";

export class AssetReleaseError extends Error {
  constructor(
    public readonly code: AssetReleaseErrorCode,
    message: string,
    public readonly status = 422
  ) {
    super(message);
    this.name = "AssetReleaseError";
  }
}

const releaseTransitions: Record<AssetReleaseVersionStatus, readonly AssetReleaseVersionStatus[]> =
  {
    DRAFT: ["PUBLISHED"],
    PUBLISHED: ["SUPERSEDED"],
    SUPERSEDED: []
  };

export function validateAssetReleaseCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new AssetReleaseError("INVALID_RELEASE_CODE", "Release code 必须是稳定代码。", 422);
  }
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_.-]{2,100}$/u.test(normalized)) {
    throw new AssetReleaseError(
      "INVALID_RELEASE_CODE",
      "Release code 必须是 3 到 101 个字符的大写稳定代码。",
      422
    );
  }
  return normalized;
}

export function assertAssetReleaseTransition(
  from: AssetReleaseVersionStatus,
  to: AssetReleaseVersionStatus
): void {
  if (!releaseTransitions[from].includes(to)) {
    throw new AssetReleaseError(
      "INVALID_RELEASE_TRANSITION",
      `资产 Release 版本不能从 ${from} 转换到 ${to}。`,
      409
    );
  }
}

export function assertPublishedVersionImmutable(input: {
  status: AssetReleaseVersionStatus;
  changedFields: readonly string[];
}): void {
  if (input.status === "PUBLISHED" && input.changedFields.some((field) => field !== "status")) {
    throw new AssetReleaseError(
      "PUBLISHED_VERSION_IMMUTABLE",
      "已发布 Release 版本的业务内容不可修改。",
      409
    );
  }
}

function assertSha256(value: unknown, code: AssetReleaseErrorCode, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/iu.test(value)) {
    throw new AssetReleaseError(code, `${label}必须是 64 位 SHA-256。`, 422);
  }
  return value.toLowerCase();
}

export type AssetComponentFileSnapshot = {
  fileId: string;
  sha256: string;
  mimeType: string;
  size: number;
};

export type AssetComponentSnapshot = {
  componentType: AssetComponentType;
  position: number;
  sourceProjectId: string;
  sourceDrawingId?: string | null;
  sourceDocumentVersionId: string;
  sourceVersion: number;
  sourceStatus: "PUBLISHED";
  sourceChecksum: string;
  files: AssetComponentFileSnapshot[];
  metadata: Record<string, unknown>;
};

export function validateAssetComponentSnapshot(input: unknown): AssetComponentSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AssetReleaseError("INVALID_FILE_SNAPSHOT", "组件快照必须是对象。", 422);
  }
  const candidate = input as Record<string, unknown>;
  const componentType = candidate.componentType;
  if (
    typeof componentType !== "string" ||
    !ASSET_COMPONENT_TYPES.includes(componentType as AssetComponentType)
  ) {
    throw new AssetReleaseError("INVALID_COMPONENT_TYPE", "组件类型不受支持。", 422);
  }
  const position = candidate.position;
  if (!Number.isSafeInteger(position) || (position as number) < 1) {
    throw new AssetReleaseError("INVALID_COMPONENT_POSITION", "组件位置必须是正整数。", 422);
  }
  const sourceProjectId = candidate.sourceProjectId;
  const sourceDrawingId = candidate.sourceDrawingId;
  const sourceDocumentVersionId = candidate.sourceDocumentVersionId;
  if (
    typeof sourceProjectId !== "string" ||
    !sourceProjectId.trim() ||
    typeof sourceDocumentVersionId !== "string" ||
    !sourceDocumentVersionId.trim()
  ) {
    throw new AssetReleaseError("SOURCE_NOT_FOUND", "组件必须引用精确来源版本。", 404);
  }
  if (!Number.isSafeInteger(candidate.sourceVersion) || (candidate.sourceVersion as number) < 1) {
    throw new AssetReleaseError("INVALID_RELEASE_VERSION", "来源版本必须是正整数。", 422);
  }
  if (candidate.sourceStatus !== "PUBLISHED") {
    throw new AssetReleaseError("SOURCE_VERSION_NOT_PUBLISHED", "来源版本必须已经发布。", 422);
  }
  const sourceChecksum = assertSha256(
    candidate.sourceChecksum,
    "INVALID_SOURCE_CHECKSUM",
    "来源 checksum"
  );
  if (!Array.isArray(candidate.files)) {
    throw new AssetReleaseError("INVALID_FILE_SNAPSHOT", "文件快照必须是数组。", 422);
  }
  const files = candidate.files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new AssetReleaseError("INVALID_FILE_SNAPSHOT", "文件快照必须是对象。", 422);
    }
    const row = file as Record<string, unknown>;
    if (
      typeof row.fileId !== "string" ||
      !row.fileId.trim() ||
      typeof row.mimeType !== "string" ||
      !row.mimeType.trim() ||
      !Number.isSafeInteger(row.size) ||
      (row.size as number) < 0
    ) {
      throw new AssetReleaseError("INVALID_FILE_SNAPSHOT", "文件快照字段无效。", 422);
    }
    return {
      fileId: row.fileId,
      sha256: assertSha256(row.sha256, "INVALID_FILE_SNAPSHOT", "文件 checksum"),
      mimeType: row.mimeType.trim(),
      size: row.size as number
    };
  });
  const metadata = candidate.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new AssetReleaseError("INVALID_FILE_SNAPSHOT", "组件 metadata 必须是对象。", 422);
  }
  return {
    componentType: componentType as AssetComponentType,
    position: position as number,
    sourceProjectId: sourceProjectId.trim(),
    sourceDrawingId:
      sourceDrawingId === undefined || sourceDrawingId === null
        ? null
        : typeof sourceDrawingId === "string" && sourceDrawingId.trim()
          ? sourceDrawingId.trim()
          : (() => {
              throw new AssetReleaseError("SOURCE_NOT_FOUND", "来源图纸标识无效。", 404);
            })(),
    sourceDocumentVersionId: sourceDocumentVersionId.trim(),
    sourceVersion: candidate.sourceVersion as number,
    sourceStatus: "PUBLISHED",
    sourceChecksum,
    files,
    metadata: metadata as Record<string, unknown>
  };
}

export function assertComponentPositionsUnique(
  components: ReadonlyArray<{ position: number }>
): void {
  const positions = new Set<number>();
  for (const component of components) {
    if (positions.has(component.position)) {
      throw new AssetReleaseError(
        "DUPLICATE_COMPONENT_POSITION",
        `组件位置 ${component.position} 重复。`,
        422
      );
    }
    positions.add(component.position);
  }
}

type CanonicalComponent = {
  position: number;
  componentType: string;
  sourceVersion: number;
};

export function canonicalAssetReleaseSnapshot(input: {
  releaseCode: unknown;
  revision: number;
  components: ReadonlyArray<CanonicalComponent>;
}) {
  const releaseCode = validateAssetReleaseCode(input.releaseCode);
  assertComponentPositionsUnique(input.components);
  return {
    releaseCode,
    revision: input.revision,
    components: [...input.components]
      .sort((left, right) => left.position - right.position)
      .map((component) => ({ ...component }))
  };
}
