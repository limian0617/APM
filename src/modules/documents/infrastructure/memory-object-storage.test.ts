import { describe, expect, it } from "vitest";

import { STORAGE_AREAS } from "../contracts/file-storage";
import { MemoryObjectStorage } from "./memory-object-storage";

describe("MemoryObjectStorage", () => {
  it("exercises multipart upload, facts, copy, private download, and cleanup boundaries", async () => {
    const storage = new MemoryObjectStorage();
    const objectKey = "1687785e-406c-4d9f-958f-756f739e6337";
    const { uploadId } = await storage.beginMultipartUpload({
      area: STORAGE_AREAS.QUARANTINE,
      objectKey,
      mimeType: "text/plain"
    });
    const url = await storage.createPartUploadUrl({
      area: STORAGE_AREAS.QUARANTINE,
      objectKey,
      uploadId,
      partNumber: 1,
      expiresInSeconds: 300
    });
    expect(url).not.toContain(objectKey);
    const bytes = new TextEncoder().encode("safe file");
    const etag = storage.uploadPart(url, bytes);
    await storage.completeMultipartUpload({
      area: STORAGE_AREAS.QUARANTINE,
      objectKey,
      uploadId,
      parts: [{ partNumber: 1, etag }]
    });
    await expect(
      storage.headObject({ area: STORAGE_AREAS.QUARANTINE, objectKey })
    ).resolves.toEqual({ size: bytes.byteLength, mimeType: "text/plain" });

    await storage.copyObject({
      sourceArea: STORAGE_AREAS.QUARANTINE,
      destinationArea: STORAGE_AREAS.CONTROLLED,
      objectKey,
      mimeType: "text/plain"
    });
    const downloadUrl = await storage.createDownloadUrl({
      area: STORAGE_AREAS.CONTROLLED,
      objectKey,
      downloadName: "visible.txt",
      mimeType: "text/plain",
      expiresInSeconds: 60
    });
    expect(downloadUrl).not.toContain(objectKey);
    expect(Array.from(storage.readDownloadUrl(downloadUrl))).toEqual(Array.from(bytes));

    await storage.deleteObject({ area: STORAGE_AREAS.QUARANTINE, objectKey });
    await expect(
      storage.headObject({ area: STORAGE_AREAS.QUARANTINE, objectKey })
    ).resolves.toBeNull();
  });
});
