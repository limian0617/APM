import { describe, expect, it } from "vitest";

import {
  DrawingError,
  assertDrawingFileRole,
  pairDrawingFiles,
  validateDrawingNumber,
  validateDrawingType
} from "./mechanical-drawing";

describe("APM-052 mechanical drawing rules", () => {
  it("normalizes a drawing number and keeps drawing type separate from manufacturing classification", () => {
    expect(validateDrawingNumber(" dwg.001-a ")).toBe("DWG.001-A");
    expect(validateDrawingType(" assembly ")).toBe("ASSEMBLY");
    expect(() => validateDrawingNumber("drawing 001")).toThrowError(DrawingError);
    expect(() => validateDrawingType("机加工")).toThrowError(DrawingError);
  });

  it("accepts only immutable CAD, PDF, and STEP version file roles", () => {
    expect(assertDrawingFileRole("CAD_SOURCE")).toBe("CAD_SOURCE");
    expect(assertDrawingFileRole("PDF_PREVIEW")).toBe("PDF_PREVIEW");
    expect(assertDrawingFileRole("STEP_EXCHANGE")).toBe("STEP_EXCHANGE");
    expect(() => assertDrawingFileRole("MANUFACTURING_CATEGORY")).toThrowError(DrawingError);
  });

  it("pairs only identical filename stems and leaves unmatched files for human confirmation", () => {
    expect(
      pairDrawingFiles([
        { id: "cad-1", originalName: "DWG-001.dwg" },
        { id: "pdf-1", originalName: "DWG-001.pdf" },
        { id: "step-1", originalName: "DWG-001.step" },
        { id: "pdf-2", originalName: "DWG-002.pdf" }
      ])
    ).toEqual([
      {
        filenameStem: "DWG-001",
        cadSourceFileId: "cad-1",
        pdfPreviewFileId: "pdf-1",
        stepExchangeFileIds: ["step-1"],
        pairingStatus: "PAIRED"
      },
      {
        filenameStem: "DWG-002",
        cadSourceFileId: null,
        pdfPreviewFileId: "pdf-2",
        stepExchangeFileIds: [],
        pairingStatus: "UNPAIRED"
      }
    ]);
  });

  it("marks duplicate role candidates as ambiguous instead of silently selecting a file", () => {
    expect(
      pairDrawingFiles([
        { id: "cad-1", originalName: "DWG-003.dwg" },
        { id: "cad-2", originalName: "DWG-003.dxf" },
        { id: "pdf-1", originalName: "DWG-003.pdf" }
      ])
    ).toEqual([
      {
        filenameStem: "DWG-003",
        cadSourceFileId: null,
        pdfPreviewFileId: "pdf-1",
        stepExchangeFileIds: [],
        pairingStatus: "AMBIGUOUS"
      }
    ]);
  });
});
