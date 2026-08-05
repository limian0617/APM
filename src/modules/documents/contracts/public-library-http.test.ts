import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  createProjectPublicLibraryReferenceBodySchema,
  createPublicLibraryDocumentBodySchema,
  createPublicLibraryDocumentVersionBodySchema,
  projectPublicLibraryReferencePathSchema,
  publicLibraryDocumentPathSchema,
  publicLibraryDocumentQuerySchema,
  publicLibraryDocumentVersionPathSchema,
  retireProjectPublicLibraryReferenceBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

describe("APM-060 public-library HTTP contracts", () => {
  it("accepts a strict enterprise document definition and exact project reference", () => {
    expect(
      parseDto(
        createPublicLibraryDocumentBodySchema,
        {
          code: "tool.vendor.001",
          title: "供应商调试工具",
          materialType: "TOOL",
          sourceFileId: "file-1",
          applicableModels: ["AX-100"],
          applicablePlatforms: ["Windows 11"],
          reason: "纳入企业公共资料库"
        },
        "body"
      )
    ).toEqual({
      code: "TOOL.VENDOR.001",
      title: "供应商调试工具",
      materialType: "TOOL",
      sourceFileId: "file-1",
      applicableModels: ["AX-100"],
      applicablePlatforms: ["Windows 11"],
      reason: "纳入企业公共资料库"
    });
    expect(
      parseDto(
        createPublicLibraryDocumentVersionBodySchema,
        {
          version: 2,
          sourceFileId: "file-2",
          applicableModels: ["AX-200"],
          applicablePlatforms: [],
          reason: "厂商更新版本"
        },
        "body"
      )
    ).toEqual({
      version: 2,
      sourceFileId: "file-2",
      applicableModels: ["AX-200"],
      applicablePlatforms: [],
      reason: "厂商更新版本"
    });
    expect(
      parseDto(
        createProjectPublicLibraryReferenceBodySchema,
        { publicDocumentVersionId: "public-version-1", reason: "项目验证采用此工具版本" },
        "body"
      )
    ).toEqual({ publicDocumentVersionId: "public-version-1", reason: "项目验证采用此工具版本" });
    expect(
      parseDto(
        projectPublicLibraryReferencePathSchema,
        { projectId: "project-1", referenceId: "reference-1" },
        "path"
      )
    ).toEqual({ projectId: "project-1", referenceId: "reference-1" });
    expect(
      parseDto(
        publicLibraryDocumentVersionPathSchema,
        { documentId: "public-document-1", documentVersionId: "public-version-1" },
        "path"
      )
    ).toEqual({ documentId: "public-document-1", documentVersionId: "public-version-1" });
    expect(
      parseDto(publicLibraryDocumentPathSchema, { documentId: "public-document-1" }, "path")
    ).toEqual({
      documentId: "public-document-1"
    });
    expect(
      parseDto(publicLibraryDocumentQuerySchema, { materialType: "DRIVER", limit: "25" }, "query")
    ).toEqual({ materialType: "DRIVER", limit: 25 });
  });

  it("rejects unknown fields, non-enumerated material types, and invalid reference versions", () => {
    expect(() =>
      parseDto(
        createPublicLibraryDocumentBodySchema,
        {
          code: "TOOL.001",
          title: "工具",
          materialType: "CAD_ASSET",
          sourceFileId: "file-1",
          reason: "建立",
          currentVersion: true
        },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        createProjectPublicLibraryReferenceBodySchema,
        { publicDocumentVersionId: " ", reason: "使用" },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        retireProjectPublicLibraryReferenceBodySchema,
        { version: 0, reason: "停止使用" },
        "body"
      )
    ).toThrowError(ApiContractError);
  });
});
