import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  confirmMechanicalDrawingImportBodySchema,
  createMechanicalDrawingBodySchema,
  createMechanicalDrawingImportBodySchema,
  createMechanicalDrawingVersionBodySchema,
  mechanicalDrawingPathSchema,
  mechanicalDrawingQuerySchema,
  mechanicalDrawingVersionPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

describe("APM-052 mechanical drawing HTTP contracts", () => {
  it("accepts strict drawing, version, import, and confirmation DTOs", () => {
    expect(
      parseDto(
        createMechanicalDrawingBodySchema,
        {
          drawingNumber: "dwg-001",
          title: "总装图",
          drawingType: "assembly",
          cadSourceFileId: "cad-1",
          pdfPreviewFileId: "pdf-1",
          stepExchangeFileIds: ["step-1"],
          reason: "创建首版图纸"
        },
        "body"
      )
    ).toMatchObject({ drawingNumber: "DWG-001", drawingType: "ASSEMBLY" });
    expect(
      parseDto(
        createMechanicalDrawingImportBodySchema,
        { fileIds: ["cad-1", "pdf-1"], reason: "识别图纸文件" },
        "body"
      )
    ).toEqual({ fileIds: ["cad-1", "pdf-1"], reason: "识别图纸文件" });
    expect(
      parseDto(
        confirmMechanicalDrawingImportBodySchema,
        {
          version: 1,
          decisions: [
            {
              itemId: "item-1",
              action: "CONFIRM",
              drawingNumber: "DWG-001",
              title: "总装图",
              drawingType: "ASSEMBLY"
            },
            { itemId: "item-2", action: "REJECT" }
          ],
          reason: "人工确认"
        },
        "body"
      )
    ).toMatchObject({ version: 1, decisions: [{ action: "CONFIRM" }, { action: "REJECT" }] });
    expect(
      parseDto(
        mechanicalDrawingPathSchema,
        { projectId: "project-1", drawingId: "drawing-1" },
        "path"
      )
    ).toEqual({ projectId: "project-1", drawingId: "drawing-1" });
    expect(
      parseDto(
        mechanicalDrawingVersionPathSchema,
        { projectId: "project-1", drawingId: "drawing-1", documentVersionId: "version-1" },
        "path"
      )
    ).toEqual({ projectId: "project-1", drawingId: "drawing-1", documentVersionId: "version-1" });
    expect(parseDto(mechanicalDrawingQuerySchema, { limit: "20" }, "query")).toEqual({ limit: 20 });
    expect(
      parseDto(
        createMechanicalDrawingVersionBodySchema,
        {
          version: 2,
          cadSourceFileId: "cad-2",
          pdfPreviewFileId: null,
          stepExchangeFileIds: [],
          reason: "建立第二版"
        },
        "body"
      )
    ).toMatchObject({ version: 2, cadSourceFileId: "cad-2" });
  });

  it("rejects manufacturing scope, duplicate files, unknown fields, and invalid resource versions", () => {
    expect(() =>
      parseDto(
        createMechanicalDrawingBodySchema,
        {
          drawingNumber: "DWG-001",
          title: "总装图",
          drawingType: "ASSEMBLY",
          cadSourceFileId: "cad-1",
          pdfPreviewFileId: null,
          stepExchangeFileIds: [],
          manufacturingCategory: "MACHINING",
          reason: "不得越过 APM-053"
        },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        createMechanicalDrawingImportBodySchema,
        { fileIds: ["cad-1", "cad-1"], reason: "重复文件" },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        createMechanicalDrawingVersionBodySchema,
        {
          version: 0,
          cadSourceFileId: "cad-2",
          pdfPreviewFileId: null,
          stepExchangeFileIds: [],
          reason: "非法版本"
        },
        "body"
      )
    ).toThrowError(ApiContractError);
  });
});
