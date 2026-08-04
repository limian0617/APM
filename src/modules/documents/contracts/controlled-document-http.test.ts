import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  controlledDocumentPathSchema,
  controlledDocumentQuerySchema,
  controlledDocumentVersionPathSchema,
  createControlledDocumentBodySchema,
  createControlledDocumentVersionBodySchema,
  publishControlledDocumentVersionBodySchema,
  voidControlledDocumentBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

describe("APM-050 controlled document HTTP contracts", () => {
  it("accepts strict create, iteration, publication, void, path, and list DTOs", () => {
    expect(
      parseDto(
        createControlledDocumentBodySchema,
        {
          code: "doc.design-001",
          title: "机械设计说明书",
          sourceFileId: "file-1",
          reason: "建立受控文档"
        },
        "body"
      )
    ).toEqual({
      code: "DOC.DESIGN-001",
      title: "机械设计说明书",
      sourceFileId: "file-1",
      reason: "建立受控文档"
    });
    expect(
      parseDto(
        createControlledDocumentVersionBodySchema,
        { version: 2, sourceFileId: "file-2", reason: "设计内容修订" },
        "body"
      )
    ).toEqual({ version: 2, sourceFileId: "file-2", reason: "设计内容修订" });
    expect(
      parseDto(
        publishControlledDocumentVersionBodySchema,
        { version: 3, reason: "发布审核完成" },
        "body"
      )
    ).toEqual({ version: 3, reason: "发布审核完成" });
    expect(
      parseDto(voidControlledDocumentBodySchema, { version: 4, reason: "项目取消" }, "body")
    ).toEqual({
      version: 4,
      reason: "项目取消"
    });
    expect(
      parseDto(
        controlledDocumentVersionPathSchema,
        { projectId: "project-1", documentId: "document-1", documentVersionId: "version-1" },
        "path"
      )
    ).toEqual({ projectId: "project-1", documentId: "document-1", documentVersionId: "version-1" });
    expect(
      parseDto(controlledDocumentQuerySchema, { status: "ACTIVE", limit: "25" }, "query")
    ).toEqual({
      status: "ACTIVE",
      limit: 25
    });
  });

  it("rejects loose document identities, unknown fields, invalid resource versions, and malformed paths", () => {
    expect(() =>
      parseDto(
        createControlledDocumentBodySchema,
        {
          code: "draft document",
          title: "机械设计说明书",
          sourceFileId: "file-1",
          reason: "建立受控文档"
        },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        createControlledDocumentVersionBodySchema,
        { version: 0, sourceFileId: "file-2", reason: "设计内容修订", current: true },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(controlledDocumentPathSchema, { projectId: "project-1", documentId: " " }, "path")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(controlledDocumentQuerySchema, { status: "DRAFT" }, "query")
    ).toThrowError(ApiContractError);
  });
});
