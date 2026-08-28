import { describe, expect, it } from "vitest";

import {
  ControlledDocumentError,
  assertDocumentVersionTransition,
  canCreateDraftVersion,
  canVoidControlledDocument,
  validateDocumentCode,
  validateDocumentTitle,
  validateDocumentVersionSource
} from "./controlled-document";

const SHA_256 = "a".repeat(64);

function expectDocumentError(operation: () => void, code: string) {
  try {
    operation();
    throw new Error("Expected a controlled document error.");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe("APM-050 controlled document rules", () => {
  it("normalizes a stable document code and rejects mutable or malformed identity values", () => {
    expect(validateDocumentCode("  doc-design-001  ")).toBe("DOC-DESIGN-001");
    expect(validateDocumentTitle("  机械设计说明书  ")).toBe("机械设计说明书");
    expect(() => validateDocumentCode("draft document")).toThrow(ControlledDocumentError);
    expect(() => validateDocumentTitle(" ")).toThrow(ControlledDocumentError);
  });

  it("accepts only an available same-project file with a persisted SHA-256 as version source", () => {
    expect(
      validateDocumentVersionSource({
        projectId: "project-1",
        fileProjectId: "project-1",
        fileStatus: "AVAILABLE",
        sha256: SHA_256,
        verifiedMimeType: "application/pdf",
        verifiedSize: 1024n
      })
    ).toEqual({ sha256: SHA_256, mimeType: "application/pdf", size: 1024n });

    expectDocumentError(
      () =>
        validateDocumentVersionSource({
          projectId: "project-1",
          fileProjectId: "project-2",
          fileStatus: "AVAILABLE",
          sha256: SHA_256,
          verifiedMimeType: "application/pdf",
          verifiedSize: 1024n
        }),
      "DOCUMENT_FILE_PROJECT_MISMATCH"
    );
    expectDocumentError(
      () =>
        validateDocumentVersionSource({
          projectId: "project-1",
          fileProjectId: "project-1",
          fileStatus: "PENDING_SCAN",
          sha256: SHA_256,
          verifiedMimeType: "application/pdf",
          verifiedSize: 1024n
        }),
      "DOCUMENT_FILE_NOT_AVAILABLE"
    );
  });

  it("allows only append-only draft iteration and terminal version transitions", () => {
    expect(canCreateDraftVersion("ACTIVE")).toBe(true);
    expect(canCreateDraftVersion("VOIDED")).toBe(false);
    expect(assertDocumentVersionTransition("DRAFT", "PUBLISHED")).toBe(true);
    expect(assertDocumentVersionTransition("DRAFT", "SUPERSEDED")).toBe(true);
    expect(assertDocumentVersionTransition("PUBLISHED", "SUPERSEDED")).toBe(true);
    expect(assertDocumentVersionTransition("PUBLISHED", "VOIDED")).toBe(true);
    expectDocumentError(
      () => assertDocumentVersionTransition("SUPERSEDED", "PUBLISHED"),
      "DOCUMENT_VERSION_TRANSITION_INVALID"
    );
    expectDocumentError(
      () => assertDocumentVersionTransition("VOIDED", "DRAFT"),
      "DOCUMENT_VERSION_TRANSITION_INVALID"
    );
  });

  it("makes document voiding terminal", () => {
    expect(canVoidControlledDocument("ACTIVE")).toBe(true);
    expect(canVoidControlledDocument("VOIDED")).toBe(false);
  });
});
