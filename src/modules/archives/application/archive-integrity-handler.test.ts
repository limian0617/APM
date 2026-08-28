import { describe, expect, it, vi } from "vitest";

import { verifyArchiveManifestItems } from "./archive-integrity-handler";

async function* bytes(value: Uint8Array) {
  yield value;
}

describe("archive integrity worker", () => {
  it("hashes actual controlled object bytes and detects a database hash mismatch", async () => {
    const storage = {
      readObject: vi.fn().mockResolvedValue(bytes(new TextEncoder().encode("real-bytes")))
    };
    const result = await verifyArchiveManifestItems({
      storage,
      items: [
        {
          id: "item-1",
          file: {
            id: "file-1",
            status: "AVAILABLE",
            storageArea: "CONTROLLED",
            objectKey: "project-1/file-1",
            sha256: "b".repeat(64),
            size: 10n
          }
        }
      ]
    });

    expect(storage.readObject).toHaveBeenCalledWith({
      area: "CONTROLLED",
      objectKey: "project-1/file-1"
    });
    expect(result).toEqual([
      expect.objectContaining({
        itemId: "item-1",
        status: "FAILED",
        failureCode: "ARCHIVE_FILE_HASH_MISMATCH",
        actualSize: 10n
      })
    ]);
  });

  it("records a missing or unavailable object as a failed item without throwing away the check", async () => {
    const result = await verifyArchiveManifestItems({
      storage: { readObject: vi.fn().mockRejectedValue(new Error("not found")) },
      items: [
        {
          id: "item-1",
          file: {
            id: "file-1",
            status: "QUARANTINED",
            storageArea: "QUARANTINE",
            objectKey: "project-1/file-1",
            sha256: "a".repeat(64),
            size: 1n
          }
        }
      ]
    });
    expect(result[0]).toMatchObject({
      itemId: "item-1",
      status: "FAILED",
      failureCode: "ARCHIVE_FILE_NOT_AVAILABLE"
    });
  });

  it("keeps no-file facts as explicit not-applicable results", async () => {
    const result = await verifyArchiveManifestItems({
      storage: { readObject: vi.fn() },
      items: [{ id: "item-1", file: null }]
    });
    expect(result).toEqual([
      { itemId: "item-1", status: "NOT_APPLICABLE", actualSha256: null, actualSize: null }
    ]);
  });
});
