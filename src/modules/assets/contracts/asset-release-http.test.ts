import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  assetReleasePathSchema,
  assetReleaseVersionPathSchema,
  createAssetReleaseBodySchema,
  publishAssetReleaseVersionBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

describe("APM-062 asset release HTTP contracts", () => {
  it("accepts strict create, publish, and read paths", () => {
    expect(
      parseDto(
        createAssetReleaseBodySchema,
        {
          releaseCode: "rel-mech-01",
          releaseNotes: "首版机械资产发布",
          components: [
            {
              position: 1,
              componentType: "MECHANICAL_DRAWING",
              sourceProjectId: "project-1",
              sourceDocumentVersionId: "document-version-1",
              sourceVersion: 4,
              sourceStatus: "PUBLISHED",
              sourceChecksum: "a".repeat(64),
              files: [
                {
                  fileId: "file-1",
                  sha256: "b".repeat(64),
                  mimeType: "application/acad",
                  size: 42
                }
              ],
              metadata: { drawingNumber: "DWG-001" }
            }
          ],
          reason: "冻结首版资产 Release"
        },
        "body"
      )
    ).toMatchObject({ releaseCode: "REL-MECH-01", components: [{ position: 1 }] });
    expect(
      parseDto(
        publishAssetReleaseVersionBodySchema,
        { version: 1, releaseVersion: 1, reason: "发布冻结版本" },
        "body"
      )
    ).toMatchObject({ version: 1, releaseVersion: 1 });
    expect(
      parseDto(
        assetReleasePathSchema,
        { technicalAssetId: "asset-1", releaseId: "release-1" },
        "path"
      )
    ).toEqual({ technicalAssetId: "asset-1", releaseId: "release-1" });
    expect(
      parseDto(
        assetReleaseVersionPathSchema,
        { technicalAssetId: "asset-1", releaseId: "release-1", version: "2" },
        "path"
      )
    ).toEqual({ technicalAssetId: "asset-1", releaseId: "release-1", version: 2 });
  });

  it("rejects unknown fields, malformed hashes, and empty components", () => {
    expect(() =>
      parseDto(
        createAssetReleaseBodySchema,
        {
          releaseCode: "REL-01",
          releaseNotes: null,
          technicalAssetVersion: 1,
          components: [],
          reason: "冻结",
          usageProjectId: "must-not-be-accepted"
        },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        createAssetReleaseBodySchema,
        {
          releaseCode: "REL-01",
          releaseNotes: null,
          technicalAssetVersion: 1,
          components: [
            {
              position: 0,
              componentType: "SOFTWARE",
              sourceProjectId: "project-1",
              sourceDocumentVersionId: "document-version-1",
              sourceVersion: 1,
              sourceStatus: "PUBLISHED",
              sourceChecksum: "not-a-sha",
              files: [],
              metadata: {}
            }
          ],
          reason: "冻结"
        },
        "body"
      )
    ).toThrowError(ApiContractError);
  });
});
