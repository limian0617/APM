export const DRAWING_FILE_ROLES = {
  CAD_SOURCE: "CAD_SOURCE",
  PDF_PREVIEW: "PDF_PREVIEW",
  STEP_EXCHANGE: "STEP_EXCHANGE"
} as const;

export type DrawingFileRole = (typeof DRAWING_FILE_ROLES)[keyof typeof DRAWING_FILE_ROLES];

export const DRAWING_PAIRING_STATUSES = {
  PAIRED: "PAIRED",
  UNPAIRED: "UNPAIRED",
  AMBIGUOUS: "AMBIGUOUS"
} as const;

export type DrawingPairingStatus =
  (typeof DRAWING_PAIRING_STATUSES)[keyof typeof DRAWING_PAIRING_STATUSES];

export class DrawingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "DrawingError";
  }
}

const DRAWING_NUMBER = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;
const DRAWING_TYPE = /^[A-Z][A-Z0-9._-]{0,63}$/;

export function validateDrawingNumber(value: unknown): string {
  if (typeof value !== "string") {
    throw new DrawingError("DRAWING_NUMBER_INVALID", "图号格式无效。");
  }
  const drawingNumber = value.trim().toUpperCase();
  if (!DRAWING_NUMBER.test(drawingNumber)) {
    throw new DrawingError(
      "DRAWING_NUMBER_INVALID",
      "图号必须为 1 到 64 个大写字母、数字、点、下划线或连字符。"
    );
  }
  return drawingNumber;
}

export function validateDrawingType(value: unknown): string {
  if (typeof value !== "string") {
    throw new DrawingError("DRAWING_TYPE_INVALID", "图纸类型格式无效。");
  }
  const drawingType = value.trim().toUpperCase();
  if (!DRAWING_TYPE.test(drawingType)) {
    throw new DrawingError(
      "DRAWING_TYPE_INVALID",
      "图纸类型必须为 1 到 64 个大写字母、数字、点、下划线或连字符。"
    );
  }
  return drawingType;
}

export function assertDrawingFileRole(value: unknown): DrawingFileRole {
  if (typeof value === "string" && value in DRAWING_FILE_ROLES) {
    return value as DrawingFileRole;
  }
  throw new DrawingError(
    "DRAWING_FILE_ROLE_INVALID",
    "图纸版本文件角色必须是 CAD_SOURCE、PDF_PREVIEW 或 STEP_EXCHANGE。"
  );
}

type CandidateFile = { id: string; originalName: string };

type DrawingFilePair = {
  filenameStem: string;
  cadSourceFileId: string | null;
  pdfPreviewFileId: string | null;
  stepExchangeFileIds: string[];
  pairingStatus: DrawingPairingStatus;
};

export function normalizeDrawingFilenameStem(originalName: string): string | null {
  const normalized = originalName.trim();
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex < 1 || extensionIndex === normalized.length - 1) return null;
  const extension = normalized.slice(extensionIndex + 1).toLowerCase();
  if (!new Set(["dwg", "dxf", "pdf", "step", "stp"]).has(extension)) return null;
  const stem = normalized.slice(0, extensionIndex).trim().toUpperCase();
  return stem || null;
}

export function inferDrawingFileRole(originalName: string): DrawingFileRole | null {
  const extension = originalName.trim().split(".").at(-1)?.toLowerCase();
  if (extension === "dwg" || extension === "dxf") return DRAWING_FILE_ROLES.CAD_SOURCE;
  if (extension === "pdf") return DRAWING_FILE_ROLES.PDF_PREVIEW;
  if (extension === "step" || extension === "stp") return DRAWING_FILE_ROLES.STEP_EXCHANGE;
  return null;
}

export function pairDrawingFiles(files: CandidateFile[]): DrawingFilePair[] {
  const groups = new Map<string, Record<DrawingFileRole, string[]>>();
  for (const file of files) {
    const stem = normalizeDrawingFilenameStem(file.originalName);
    const role = inferDrawingFileRole(file.originalName);
    if (!stem || !role) continue;
    const group = groups.get(stem) ?? {
      CAD_SOURCE: [],
      PDF_PREVIEW: [],
      STEP_EXCHANGE: []
    };
    group[role].push(file.id);
    groups.set(stem, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([stem, group]) => {
      const ambiguous = group.CAD_SOURCE.length > 1 || group.PDF_PREVIEW.length > 1;
      const cadSourceFileId = group.CAD_SOURCE.length === 1 ? (group.CAD_SOURCE[0] ?? null) : null;
      const pdfPreviewFileId =
        group.PDF_PREVIEW.length === 1 ? (group.PDF_PREVIEW[0] ?? null) : null;
      return {
        filenameStem: stem,
        cadSourceFileId,
        pdfPreviewFileId,
        stepExchangeFileIds: ambiguous ? [] : group.STEP_EXCHANGE,
        pairingStatus: ambiguous
          ? DRAWING_PAIRING_STATUSES.AMBIGUOUS
          : cadSourceFileId && pdfPreviewFileId
            ? DRAWING_PAIRING_STATUSES.PAIRED
            : DRAWING_PAIRING_STATUSES.UNPAIRED
      };
    });
}
