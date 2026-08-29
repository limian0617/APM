import { describe, expect, it } from "vitest";

import {
  assertCompleteParts,
  assertFileUsable,
  FILE_STATUSES,
  FILE_USE_ACTIONS,
  FileValidationError,
  multipartLayout,
  parseCompletionParts,
  validateOriginalName
} from "./file-policy";

describe("file policy", () => {
  it.each([
    FILE_STATUSES.UPLOADING,
    FILE_STATUSES.PENDING_SCAN,
    FILE_STATUSES.QUARANTINED,
    FILE_STATUSES.FAILED
  ])("rejects reference, preview, download, and publish for %s", (status) => {
    for (const action of Object.values(FILE_USE_ACTIONS)) {
      expect(() => assertFileUsable(status, action)).toThrowError(FileValidationError);
    }
  });

  it("accepts all supported uses only after the file is available", () => {
    for (const action of Object.values(FILE_USE_ACTIONS)) {
      expect(() => assertFileUsable(FILE_STATUSES.AVAILABLE, action)).not.toThrow();
    }
  });

  it("builds deterministic multipart sizes including a short final part", () => {
    expect(multipartLayout(12 * 1024 * 1024)).toEqual({
      partSize: 5 * 1024 * 1024,
      partSizes: [5 * 1024 * 1024, 5 * 1024 * 1024, 2 * 1024 * 1024]
    });
  });

  it("rejects missing, duplicate, or size-mismatched completion parts", () => {
    const expected = [
      { partNumber: 1, expectedSize: 5n },
      { partNumber: 2, expectedSize: 3n }
    ];
    expect(() => assertCompleteParts(expected, [{ partNumber: 1, etag: "a", size: 5 }])).toThrow(
      "上传分片不完整"
    );
    expect(() =>
      parseCompletionParts([
        { partNumber: 1, etag: "a", size: 5 },
        { partNumber: 1, etag: "b", size: 3 }
      ])
    ).toThrow("分片编号不能重复");
    expect(() =>
      assertCompleteParts(expected, [
        { partNumber: 1, etag: "a", size: 5 },
        { partNumber: 2, etag: "b", size: 4 }
      ])
    ).toThrow("上传分片编号或大小不匹配");
  });

  it("does not allow a source file name to become a storage path", () => {
    expect(() => validateOriginalName("customer/project.dwg")).toThrow("不能包含路径");
    expect(validateOriginalName("项目图纸.dwg")).toBe("项目图纸.dwg");
  });
});
