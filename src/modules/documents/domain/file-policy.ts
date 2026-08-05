export const FILE_STATUSES = {
  UPLOADING: "UPLOADING",
  PENDING_SCAN: "PENDING_SCAN",
  AVAILABLE: "AVAILABLE",
  QUARANTINED: "QUARANTINED",
  FAILED: "FAILED"
} as const;

export const FILE_SENSITIVITIES = {
  INTERNAL: "INTERNAL",
  RESTRICTED: "RESTRICTED"
} as const;

export const FILE_USE_ACTIONS = {
  REFERENCE: "REFERENCE",
  PREVIEW: "PREVIEW",
  DOWNLOAD: "DOWNLOAD",
  PUBLISH: "PUBLISH"
} as const;

export type FileStatus = (typeof FILE_STATUSES)[keyof typeof FILE_STATUSES];
export type FileSensitivity = (typeof FILE_SENSITIVITIES)[keyof typeof FILE_SENSITIVITIES];
export type FileUseAction = (typeof FILE_USE_ACTIONS)[keyof typeof FILE_USE_ACTIONS];

export class FileValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
  }
}

const MINIMUM_PART_SIZE = 5 * 1024 * 1024;
const MAXIMUM_FILE_SIZE = 5 * 1024 * 1024 * 1024 * 1024;
const MAXIMUM_PARTS = 10_000;

export function validateOriginalName(value: unknown): string {
  if (typeof value !== "string") {
    throw new FileValidationError("INVALID_FILE_NAME", "originalName 必须是字符串。");
  }
  const name = value.trim();
  if (!name || name.length > 255 || /[\u0000-\u001f/\\]/u.test(name)) {
    throw new FileValidationError(
      "INVALID_FILE_NAME",
      "文件名必须是 1 到 255 个字符，且不能包含路径或控制字符。"
    );
  }
  return name;
}

export function normalizeMimeType(value: unknown): string {
  if (typeof value !== "string") {
    throw new FileValidationError("INVALID_MIME_TYPE", "mimeType 必须是字符串。");
  }
  const mimeType = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mimeType)) {
    throw new FileValidationError("INVALID_MIME_TYPE", "mimeType 不是有效的媒体类型。");
  }
  return mimeType;
}

export function validateFileSize(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > MAXIMUM_FILE_SIZE
  ) {
    throw new FileValidationError(
      "INVALID_FILE_SIZE",
      "size 必须是大于 0 且不超过 S3 兼容上限的安全整数。"
    );
  }
  return value as number;
}

export function validateSensitivity(value: unknown): FileSensitivity {
  const sensitivity = value ?? FILE_SENSITIVITIES.INTERNAL;
  if (!Object.values(FILE_SENSITIVITIES).includes(sensitivity as FileSensitivity)) {
    throw new FileValidationError("INVALID_SENSITIVITY", "文件密级无效。");
  }
  return sensitivity as FileSensitivity;
}

export function validateIdempotencyKey(value: string | null): string {
  const key = value?.trim() ?? "";
  if (!key || key.length > 191) {
    throw new FileValidationError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "完成上传必须提供 1 到 191 个字符的 Idempotency-Key。",
      400
    );
  }
  return key;
}

export function multipartLayout(size: number): { partSize: number; partSizes: number[] } {
  const requiredPartSize = Math.ceil(size / MAXIMUM_PARTS);
  const partSize = Math.max(MINIMUM_PART_SIZE, requiredPartSize);
  const partCount = Math.ceil(size / partSize);
  const partSizes = Array.from({ length: partCount }, (_, index) =>
    index === partCount - 1 ? size - partSize * index : partSize
  );
  return { partSize, partSizes };
}

export type CompletionPart = { partNumber: number; etag: string; size: number };

export function parseCompletionParts(value: unknown): CompletionPart[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_PARTS) {
    throw new FileValidationError("INVALID_PARTS", "parts 必须是非空分片数组。");
  }
  const seen = new Set<number>();
  const parts = value.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new FileValidationError("INVALID_PART", "每个分片必须是对象。");
    }
    const record = part as Record<string, unknown>;
    const partNumber = record.partNumber;
    const size = record.size;
    const etag = typeof record.etag === "string" ? record.etag.trim() : "";
    if (
      !Number.isInteger(partNumber) ||
      (partNumber as number) < 1 ||
      (partNumber as number) > MAXIMUM_PARTS
    ) {
      throw new FileValidationError("INVALID_PART", "partNumber 必须在 1 到 10000 之间。");
    }
    if (!Number.isSafeInteger(size) || (size as number) <= 0) {
      throw new FileValidationError("INVALID_PART", "分片 size 必须是正整数。");
    }
    if (!etag || etag.length > 1024) {
      throw new FileValidationError("INVALID_PART", "分片 etag 无效。");
    }
    if (seen.has(partNumber as number)) {
      throw new FileValidationError("DUPLICATE_PART", "分片编号不能重复。", 409);
    }
    seen.add(partNumber as number);
    return { partNumber: partNumber as number, size: size as number, etag };
  });
  return parts.sort((left, right) => left.partNumber - right.partNumber);
}

export function assertCompleteParts(
  expected: ReadonlyArray<{ partNumber: number; expectedSize: bigint }>,
  supplied: CompletionPart[]
): void {
  if (expected.length !== supplied.length) {
    throw new FileValidationError("MISSING_UPLOAD_PARTS", "上传分片不完整。", 409);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedPart = expected[index];
    const suppliedPart = supplied[index];
    if (
      !expectedPart ||
      !suppliedPart ||
      expectedPart.partNumber !== suppliedPart.partNumber ||
      expectedPart.expectedSize !== BigInt(suppliedPart.size)
    ) {
      throw new FileValidationError("UPLOAD_PART_MISMATCH", "上传分片编号或大小不匹配。", 409);
    }
  }
}

export function assertFileUsable(status: string, action: FileUseAction): void {
  if (status !== FILE_STATUSES.AVAILABLE) {
    throw new FileValidationError(
      "FILE_NOT_AVAILABLE",
      `文件处于 ${status} 状态，不能执行 ${action}。`,
      409
    );
  }
}
