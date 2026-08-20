export const ARCHIVE_SOURCE_FORMULAS = {
  V1: "ARCHIVE.SOURCE@1",
  V2: "ARCHIVE.SOURCE@2"
} as const;

export type ArchiveSourceFormulaVersion =
  (typeof ARCHIVE_SOURCE_FORMULAS)[keyof typeof ARCHIVE_SOURCE_FORMULAS];

export type ArchiveSourceFormulaPersistenceValue = "V1" | "V2";

export class ArchiveSourceFormulaError extends Error {
  readonly code = "ARCHIVE_SOURCE_FORMULA_UNSUPPORTED";

  constructor(version: unknown) {
    super(`不支持的归档来源公式：${String(version ?? "missing")}`);
    this.name = "ArchiveSourceFormulaError";
  }
}

export function parseArchiveSourceFormulaVersion(
  version: string | null | undefined
): ArchiveSourceFormulaVersion {
  if (version === ARCHIVE_SOURCE_FORMULAS.V1 || version === ARCHIVE_SOURCE_FORMULAS.V2) {
    return version;
  }
  throw new ArchiveSourceFormulaError(version);
}

export function archiveSourceFormulaFromPersistence(
  value: ArchiveSourceFormulaPersistenceValue
): ArchiveSourceFormulaVersion {
  if (value === "V1") return ARCHIVE_SOURCE_FORMULAS.V1;
  if (value === "V2") return ARCHIVE_SOURCE_FORMULAS.V2;
  throw new ArchiveSourceFormulaError(value);
}

export function archiveSourceFormulaToPersistence(
  value: ArchiveSourceFormulaVersion
): ArchiveSourceFormulaPersistenceValue {
  return value === ARCHIVE_SOURCE_FORMULAS.V1 ? "V1" : "V2";
}
