import { createHash, randomUUID } from "node:crypto";

import type {
  CompletedStoragePart,
  ObjectStoragePort,
  StorageArea
} from "../contracts/file-storage";

type MultipartUpload = {
  area: StorageArea;
  objectKey: string;
  mimeType: string;
  parts: Map<number, { bytes: Uint8Array; etag: string }>;
};

function objectId(area: StorageArea, key: string): string {
  return `${area}:${key}`;
}

export class MemoryObjectStorage implements ObjectStoragePort {
  private readonly uploads = new Map<string, MultipartUpload>();
  private readonly partUrls = new Map<string, { uploadId: string; partNumber: number }>();
  private readonly objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  private readonly downloads = new Map<string, string>();

  async beginMultipartUpload(input: {
    area: StorageArea;
    objectKey: string;
    mimeType: string;
  }): Promise<{ uploadId: string }> {
    const uploadId = randomUUID();
    this.uploads.set(uploadId, { ...input, parts: new Map() });
    return { uploadId };
  }

  async createPartUploadUrl(input: {
    area: StorageArea;
    objectKey: string;
    uploadId: string;
    partNumber: number;
    expiresInSeconds: number;
  }): Promise<string> {
    const upload = this.uploads.get(input.uploadId);
    if (!upload || upload.area !== input.area || upload.objectKey !== input.objectKey) {
      throw new Error("multipart upload 不存在。");
    }
    const token = randomUUID();
    this.partUrls.set(token, { uploadId: input.uploadId, partNumber: input.partNumber });
    return `memory://upload-part/${token}`;
  }

  uploadPart(url: string, bytes: Uint8Array): string {
    const token = url.replace("memory://upload-part/", "");
    const target = this.partUrls.get(token);
    const upload = target ? this.uploads.get(target.uploadId) : null;
    if (!target || !upload) throw new Error("分片 URL 无效。");
    const etag = createHash("sha256").update(bytes).digest("hex");
    upload.parts.set(target.partNumber, { bytes, etag });
    return etag;
  }

  async completeMultipartUpload(input: {
    area: StorageArea;
    objectKey: string;
    uploadId: string;
    parts: CompletedStoragePart[];
  }): Promise<void> {
    const upload = this.uploads.get(input.uploadId);
    if (!upload) throw new Error("multipart upload 不存在。");
    const buffers = input.parts.map((part) => {
      const stored = upload.parts.get(part.partNumber);
      if (!stored || stored.etag !== part.etag) throw new Error("分片 ETag 不匹配。");
      return Buffer.from(stored.bytes);
    });
    this.objects.set(objectId(input.area, input.objectKey), {
      bytes: Buffer.concat(buffers),
      mimeType: upload.mimeType
    });
    this.uploads.delete(input.uploadId);
  }

  async abortMultipartUpload(input: { uploadId: string }): Promise<void> {
    this.uploads.delete(input.uploadId);
  }

  async headObject(input: { area: StorageArea; objectKey: string }) {
    const object = this.objects.get(objectId(input.area, input.objectKey));
    return object ? { size: object.bytes.byteLength, mimeType: object.mimeType } : null;
  }

  async readObject(input: { area: StorageArea; objectKey: string }) {
    const object = this.objects.get(objectId(input.area, input.objectKey));
    if (!object) throw new Error("对象不存在。");
    return (async function* () {
      yield object.bytes;
    })();
  }

  async copyObject(input: {
    sourceArea: StorageArea;
    destinationArea: StorageArea;
    objectKey: string;
    mimeType: string;
  }): Promise<void> {
    const object = this.objects.get(objectId(input.sourceArea, input.objectKey));
    if (!object) throw new Error("源对象不存在。");
    this.objects.set(objectId(input.destinationArea, input.objectKey), {
      bytes: object.bytes.slice(),
      mimeType: input.mimeType
    });
  }

  async deleteObject(input: { area: StorageArea; objectKey: string }): Promise<void> {
    this.objects.delete(objectId(input.area, input.objectKey));
  }

  async createDownloadUrl(input: {
    area: StorageArea;
    objectKey: string;
    downloadName: string;
    mimeType: string;
    expiresInSeconds: number;
  }): Promise<string> {
    if (!this.objects.has(objectId(input.area, input.objectKey))) throw new Error("对象不存在。");
    const token = randomUUID();
    this.downloads.set(token, objectId(input.area, input.objectKey));
    return `memory://download/${token}`;
  }

  readDownloadUrl(url: string): Uint8Array {
    const id = this.downloads.get(url.replace("memory://download/", ""));
    const object = id ? this.objects.get(id) : null;
    if (!object) throw new Error("下载 URL 无效。");
    return object.bytes;
  }
}
