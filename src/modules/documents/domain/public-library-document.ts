import { validateDocumentCode, validateDocumentTitle } from "./controlled-document";

export const PUBLIC_LIBRARY_MATERIAL_TYPES = {
  DRIVER: "DRIVER",
  FIRMWARE: "FIRMWARE",
  TOOL: "TOOL",
  MANUAL: "MANUAL",
  TRAINING: "TRAINING",
  STANDARD: "STANDARD",
  TEMPLATE: "TEMPLATE"
} as const;

export type PublicLibraryMaterialType =
  (typeof PUBLIC_LIBRARY_MATERIAL_TYPES)[keyof typeof PUBLIC_LIBRARY_MATERIAL_TYPES];

export const PUBLIC_LIBRARY_DOCUMENT_STATUSES = {
  ACTIVE: "ACTIVE",
  VOIDED: "VOIDED"
} as const;

export const PUBLIC_LIBRARY_DOCUMENT_VERSION_STATUSES = {
  DRAFT: "DRAFT",
  PUBLISHED: "PUBLISHED",
  SUPERSEDED: "SUPERSEDED",
  VOIDED: "VOIDED"
} as const;

export class PublicLibraryDocumentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "PublicLibraryDocumentError";
  }
}

const materialTypes = new Set<string>(Object.values(PUBLIC_LIBRARY_MATERIAL_TYPES));

function normalizeApplicabilityList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new PublicLibraryDocumentError(
      "PUBLIC_LIBRARY_APPLICABILITY_INVALID",
      `${field} 必须是最多 100 项的字符串列表。`,
      422
    );
  }
  const entries = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry.trim().length > 191) {
      throw new PublicLibraryDocumentError(
        "PUBLIC_LIBRARY_APPLICABILITY_INVALID",
        `${field} 的每一项必须是 1 到 191 个字符。`,
        422
      );
    }
    return entry.trim();
  });
  return [...new Set(entries)];
}

export function validatePublicLibraryMaterialType(value: unknown): PublicLibraryMaterialType {
  if (typeof value !== "string" || !materialTypes.has(value.trim().toUpperCase())) {
    throw new PublicLibraryDocumentError(
      "PUBLIC_LIBRARY_MATERIAL_TYPE_INVALID",
      "公共资料类型无效。",
      422
    );
  }
  return value.trim().toUpperCase() as PublicLibraryMaterialType;
}

export function validatePublicLibraryApplicability(input: {
  applicableModels?: unknown;
  applicablePlatforms?: unknown;
}) {
  return {
    applicableModels: normalizeApplicabilityList(input.applicableModels, "applicableModels"),
    applicablePlatforms: normalizeApplicabilityList(
      input.applicablePlatforms,
      "applicablePlatforms"
    )
  };
}

export function validatePublicLibraryCode(value: unknown): string {
  try {
    return validateDocumentCode(value);
  } catch {
    throw new PublicLibraryDocumentError(
      "PUBLIC_LIBRARY_DOCUMENT_CODE_INVALID",
      "公共资料编号格式无效。",
      422
    );
  }
}

export function validatePublicLibraryTitle(value: unknown): string {
  try {
    return validateDocumentTitle(value);
  } catch {
    throw new PublicLibraryDocumentError(
      "PUBLIC_LIBRARY_DOCUMENT_TITLE_INVALID",
      "公共资料标题格式无效。",
      422
    );
  }
}

export function validatePublicLibraryReferenceVersion(value: unknown): true {
  if (value !== "PUBLISHED") {
    throw new PublicLibraryDocumentError(
      "PUBLIC_LIBRARY_VERSION_NOT_PUBLISHED",
      "项目只能引用已发布的公共资料确切版本。"
    );
  }
  return true;
}

export function validatePublicLibraryReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new PublicLibraryDocumentError(
      "REASON_REQUIRED",
      "操作原因必须是 1 到 1024 个字符。",
      422
    );
  }
  return value.trim();
}

export function validatePublicLibraryVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PublicLibraryDocumentError("INVALID_VERSION", "version 必须是正整数。", 422);
  }
  return value as number;
}
