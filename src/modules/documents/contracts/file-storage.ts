export const STORAGE_AREAS = {
  QUARANTINE: "QUARANTINE",
  CONTROLLED: "CONTROLLED"
} as const;

export type StorageArea = (typeof STORAGE_AREAS)[keyof typeof STORAGE_AREAS];

export type CompletedStoragePart = {
  partNumber: number;
  etag: string;
};

export type StoredObjectFacts = {
  size: number;
  mimeType: string | null;
};

export interface ObjectStoragePort {
  beginMultipartUpload(input: {
    area: StorageArea;
    objectKey: string;
    mimeType: string;
  }): Promise<{ uploadId: string }>;
  createPartUploadUrl(input: {
    area: StorageArea;
    objectKey: string;
    uploadId: string;
    partNumber: number;
    expiresInSeconds: number;
  }): Promise<string>;
  completeMultipartUpload(input: {
    area: StorageArea;
    objectKey: string;
    uploadId: string;
    parts: CompletedStoragePart[];
  }): Promise<void>;
  abortMultipartUpload(input: {
    area: StorageArea;
    objectKey: string;
    uploadId: string;
  }): Promise<void>;
  headObject(input: { area: StorageArea; objectKey: string }): Promise<StoredObjectFacts | null>;
  readObject(input: { area: StorageArea; objectKey: string }): Promise<AsyncIterable<Uint8Array>>;
  copyObject(input: {
    sourceArea: StorageArea;
    destinationArea: StorageArea;
    objectKey: string;
    mimeType: string;
  }): Promise<void>;
  deleteObject(input: { area: StorageArea; objectKey: string }): Promise<void>;
  createDownloadUrl(input: {
    area: StorageArea;
    objectKey: string;
    downloadName: string;
    mimeType: string;
    expiresInSeconds: number;
  }): Promise<string>;
}

export type VirusScanResult =
  | { result: "CLEAN"; engine: string; version: string }
  | { result: "INFECTED"; engine: string; version: string; signature: string };

export interface VirusScannerPort {
  scan(stream: AsyncIterable<Uint8Array>): Promise<VirusScanResult>;
}
