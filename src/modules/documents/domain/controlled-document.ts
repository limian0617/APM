export const CONTROLLED_DOCUMENT_STATUSES = {
  ACTIVE: "ACTIVE",
  VOIDED: "VOIDED"
} as const;

export type ControlledDocumentStatus =
  (typeof CONTROLLED_DOCUMENT_STATUSES)[keyof typeof CONTROLLED_DOCUMENT_STATUSES];

export const CONTROLLED_DOCUMENT_VERSION_STATUSES = {
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  SUPERSEDED: "SUPERSEDED",
  VOIDED: "VOIDED"
} as const;

export type ControlledDocumentVersionStatus =
  (typeof CONTROLLED_DOCUMENT_VERSION_STATUSES)[keyof typeof CONTROLLED_DOCUMENT_VERSION_STATUSES];

export class ControlledDocumentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "ControlledDocumentError";
  }
}

const DOCUMENT_CODE = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
const SHA_256 = /^[0-9a-f]{64}$/;

export function validateDocumentCode(value: unknown): string {
  if (typeof value !== "string") {
    throw new ControlledDocumentError("DOCUMENT_CODE_INVALID", "文档编号格式无效。", 422);
  }
  const code = value.trim().toUpperCase();
  if (!DOCUMENT_CODE.test(code)) {
    throw new ControlledDocumentError(
      "DOCUMENT_CODE_INVALID",
      "文档编号必须为 1 到 64 个大写字母、数字、点、下划线或连字符。",
      422
    );
  }
  return code;
}

export function validateDocumentTitle(value: unknown): string {
  if (typeof value !== "string") {
    throw new ControlledDocumentError("DOCUMENT_TITLE_INVALID", "文档标题格式无效。", 422);
  }
  const title = value.trim();
  if (!title || title.length > 256) {
    throw new ControlledDocumentError(
      "DOCUMENT_TITLE_INVALID",
      "文档标题必须为 1 到 256 个字符。",
      422
    );
  }
  return title;
}

export function validateDocumentVersionSource(input: {
  projectId: string;
  fileProjectId: string;
  fileStatus: string;
  sha256: string | null;
  verifiedMimeType: string | null;
  verifiedSize: bigint | null;
}) {
  if (input.fileProjectId !== input.projectId) {
    throw new ControlledDocumentError(
      "DOCUMENT_FILE_PROJECT_MISMATCH",
      "文档版本只能引用同一项目的文件。"
    );
  }
  if (input.fileStatus !== "AVAILABLE") {
    throw new ControlledDocumentError(
      "DOCUMENT_FILE_NOT_AVAILABLE",
      "文档版本只能引用已扫描可用的文件。"
    );
  }
  if (!input.sha256 || !SHA_256.test(input.sha256)) {
    throw new ControlledDocumentError(
      "DOCUMENT_FILE_HASH_REQUIRED",
      "文档版本源文件必须具有有效的 SHA-256。"
    );
  }
  if (!input.verifiedMimeType || !input.verifiedSize || input.verifiedSize < 1n) {
    throw new ControlledDocumentError(
      "DOCUMENT_FILE_VERIFICATION_REQUIRED",
      "文档版本源文件必须具有已验证的 MIME 和大小。"
    );
  }
  return {
    sha256: input.sha256,
    mimeType: input.verifiedMimeType,
    size: input.verifiedSize
  };
}

export function canCreateDraftVersion(status: ControlledDocumentStatus): boolean {
  return status === CONTROLLED_DOCUMENT_STATUSES.ACTIVE;
}

export function canVoidControlledDocument(status: ControlledDocumentStatus): boolean {
  return status === CONTROLLED_DOCUMENT_STATUSES.ACTIVE;
}

const allowedTransitions: Record<
  ControlledDocumentVersionStatus,
  ControlledDocumentVersionStatus[]
> = {
  DRAFT: ["PUBLISHED", "SUPERSEDED", "VOIDED"],
  PUBLISHED: ["SUPERSEDED", "VOIDED"],
  SUPERSEDED: ["VOIDED"],
  VOIDED: []
};

export function assertDocumentVersionTransition(
  from: ControlledDocumentVersionStatus,
  to: ControlledDocumentVersionStatus
): true {
  if (!allowedTransitions[from].includes(to)) {
    throw new ControlledDocumentError(
      "DOCUMENT_VERSION_TRANSITION_INVALID",
      "文档版本当前状态不允许该操作。"
    );
  }
  return true;
}
