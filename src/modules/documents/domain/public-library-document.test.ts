import { describe, expect, it } from "vitest";

import {
  PUBLIC_LIBRARY_MATERIAL_TYPES,
  PublicLibraryDocumentError,
  validatePublicLibraryApplicability,
  validatePublicLibraryMaterialType,
  validatePublicLibraryReferenceVersion
} from "./public-library-document";

describe("APM-060 public-library document policy", () => {
  it("accepts the fixed enterprise reference material categories", () => {
    expect(PUBLIC_LIBRARY_MATERIAL_TYPES).toEqual({
      DRIVER: "DRIVER",
      FIRMWARE: "FIRMWARE",
      TOOL: "TOOL",
      MANUAL: "MANUAL",
      TRAINING: "TRAINING",
      STANDARD: "STANDARD",
      TEMPLATE: "TEMPLATE"
    });
    expect(validatePublicLibraryMaterialType("driver")).toBe("DRIVER");
  });

  it("normalizes explicitly scoped model and platform applicability without inventing scope", () => {
    expect(
      validatePublicLibraryApplicability({
        applicableModels: [" AX-100 ", "AX-100", "AX-200"],
        applicablePlatforms: [" Windows 11 ", "Linux"]
      })
    ).toEqual({
      applicableModels: ["AX-100", "AX-200"],
      applicablePlatforms: ["Windows 11", "Linux"]
    });
    expect(validatePublicLibraryApplicability({})).toEqual({
      applicableModels: [],
      applicablePlatforms: []
    });
  });

  it("rejects unknown categories, blank applicability facts, and a non-published reference", () => {
    expect(() => validatePublicLibraryMaterialType("CAD_ASSET")).toThrowError(
      PublicLibraryDocumentError
    );
    expect(() => validatePublicLibraryApplicability({ applicableModels: [" "] })).toThrowError(
      PublicLibraryDocumentError
    );
    expect(() => validatePublicLibraryReferenceVersion("DRAFT")).toThrowError(
      PublicLibraryDocumentError
    );
    expect(validatePublicLibraryReferenceVersion("PUBLISHED")).toBe(true);
  });
});
