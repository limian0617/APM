import type { ArchiveManifestSourceInput } from "../application/archive-manifest-service";

export const APM_054_ARCHIVE_V1 = {
  projectId: "archive-project-v1-fixture",
  sources: [
    {
      sourceType: "CONTROLLED_DOCUMENT_VERSION",
      sourceId: "document-version-1",
      sourceVersion: "3",
      snapshotJson: {
        documentCode: "DOC-001",
        status: "PUBLISHED"
      }
    },
    {
      sourceType: "GATE_SUBMISSION",
      sourceId: "legacy-g9-submission",
      sourceVersion: "1",
      snapshotJson: {
        gateInstanceId: "legacy-g9",
        status: "APPROVED"
      }
    }
  ] satisfies readonly ArchiveManifestSourceInput[],
  snapshotJsonText:
    '{"externalPublication":{"applicability":"NOT_APPLICABLE","reason":"外部供应商包能力尚未实现。"},"items":[{"fileMimeType":null,"fileObjectId":null,"fileSha256":null,"fileSize":null,"position":0,"snapshotJson":{"documentCode":"DOC-001","status":"PUBLISHED"},"sourceChecksum":"c09953d01f6858cb49cd562a28be25f551cbf9bd10d41fe13c4b1380e07bb3cd","sourceId":"document-version-1","sourceType":"CONTROLLED_DOCUMENT_VERSION","sourceVersion":"3"},{"fileMimeType":null,"fileObjectId":null,"fileSha256":null,"fileSize":null,"position":1,"snapshotJson":{"gateInstanceId":"legacy-g9","status":"APPROVED"},"sourceChecksum":"0b6f36e85a9508f283e4cbc64aa38cbef96f241ccafbd2c3296ff6d69b8951eb","sourceId":"legacy-g9-submission","sourceType":"GATE_SUBMISSION","sourceVersion":"1"}],"projectId":"archive-project-v1-fixture"}',
  manifestChecksum: "8318fcc9f74d07e7294f50c8f804f35ed90d7a17791faf9c5dc9bdb0018c3796",
  sourceWatermark: "409c8d330a9d12ed3ca1cfefa6f48329984382f304a7937b1c37608736e635e6",
  itemChecksums: [
    "c09953d01f6858cb49cd562a28be25f551cbf9bd10d41fe13c4b1380e07bb3cd",
    "0b6f36e85a9508f283e4cbc64aa38cbef96f241ccafbd2c3296ff6d69b8951eb"
  ]
} as const;
