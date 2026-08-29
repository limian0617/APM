import { describe, expect, it } from "vitest";

import {
  ArchiveSourceFormulaError,
  archiveSourceFormulaFromPersistence,
  archiveSourceFormulaToPersistence,
  parseArchiveSourceFormulaVersion
} from "./archive-source-formula";

describe("archive source formula", () => {
  it.each([null, undefined, "", "ARCHIVE.SOURCE@3"])(
    "default-denies an unsupported formula %s",
    (value) => {
      expect(() => parseArchiveSourceFormulaVersion(value)).toThrowError(
        expect.objectContaining<Partial<ArchiveSourceFormulaError>>({
          code: "ARCHIVE_SOURCE_FORMULA_UNSUPPORTED"
        })
      );
    }
  );

  it.each(["ARCHIVE.SOURCE@1", "ARCHIVE.SOURCE@2"] as const)("accepts %s", (value) => {
    expect(parseArchiveSourceFormulaVersion(value)).toBe(value);
  });

  it("maps Prisma enum values without treating persistence names as public formulas", () => {
    expect(archiveSourceFormulaFromPersistence("V1")).toBe("ARCHIVE.SOURCE@1");
    expect(archiveSourceFormulaFromPersistence("V2")).toBe("ARCHIVE.SOURCE@2");
    expect(archiveSourceFormulaToPersistence("ARCHIVE.SOURCE@1")).toBe("V1");
    expect(archiveSourceFormulaToPersistence("ARCHIVE.SOURCE@2")).toBe("V2");
    expect(() => parseArchiveSourceFormulaVersion("V2")).toThrowError(
      expect.objectContaining({ code: "ARCHIVE_SOURCE_FORMULA_UNSUPPORTED" })
    );
  });
});
