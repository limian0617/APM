import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { STORAGE_AREAS, type ObjectStoragePort, type StorageArea } from "../contracts/file-storage";

type BucketConfiguration = Record<StorageArea, string>;

function bucketName(buckets: BucketConfiguration, area: StorageArea): string {
  return buckets[area];
}

function attachmentDisposition(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    record.name === "NotFound" ||
    record.name === "NoSuchKey" ||
    record.$metadata?.httpStatusCode === 404
  );
}

export class S3ObjectStorage implements ObjectStoragePort {
  constructor(
    private readonly client: S3Client,
    private readonly buckets: BucketConfiguration
  ) {}

  async beginMultipartUpload(input: {
    area: StorageArea;
    objectKey: string;
    mimeType: string;
  }): Promise<{ uploadId: string }> {
    const output = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucketName(this.buckets, input.area),
        Key: input.objectKey,
        ContentType: input.mimeType
      })
    );
    if (!output.UploadId) throw new Error("对象存储未返回 multipart upload id。");
    return { uploadId: output.UploadId };
  }

  createPartUploadUrl(input: {
    area: StorageArea;
    objectKey: string;
    uploadId: string;
    partNumber: number;
    expiresInSeconds: number;
  }): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: bucketName(this.buckets, input.area),
        Key: input.objectKey,
        UploadId: input.uploadId,
        PartNumber: input.partNumber
      }),
      { expiresIn: input.expiresInSeconds }
    );
  }

  async completeMultipartUpload(input: {
    area: StorageArea;
    objectKey: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucketName(this.buckets, input.area),
        Key: input.objectKey,
        UploadId: input.uploadId,
        MultipartUpload: {
          Parts: input.parts.map((part) => ({ ETag: part.etag, PartNumber: part.partNumber }))
        }
      })
    );
  }

  async abortMultipartUpload(input: {
    area: StorageArea;
    objectKey: string;
    uploadId: string;
  }): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucketName(this.buckets, input.area),
        Key: input.objectKey,
        UploadId: input.uploadId
      })
    );
  }

  async headObject(input: { area: StorageArea; objectKey: string }) {
    try {
      const output = await this.client.send(
        new HeadObjectCommand({
          Bucket: bucketName(this.buckets, input.area),
          Key: input.objectKey
        })
      );
      if (output.ContentLength === undefined) {
        throw new Error("对象存储未返回文件大小。");
      }
      return { size: output.ContentLength, mimeType: output.ContentType ?? null };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async readObject(input: { area: StorageArea; objectKey: string }) {
    const output = await this.client.send(
      new GetObjectCommand({
        Bucket: bucketName(this.buckets, input.area),
        Key: input.objectKey
      })
    );
    if (!output.Body || !(Symbol.asyncIterator in output.Body)) {
      throw new Error("对象存储响应不支持流式读取。");
    }
    return output.Body as AsyncIterable<Uint8Array>;
  }

  async copyObject(input: {
    sourceArea: StorageArea;
    destinationArea: StorageArea;
    objectKey: string;
    mimeType: string;
  }): Promise<void> {
    const sourceBucket = bucketName(this.buckets, input.sourceArea);
    await this.client.send(
      new CopyObjectCommand({
        Bucket: bucketName(this.buckets, input.destinationArea),
        Key: input.objectKey,
        CopySource: `/${sourceBucket}/${encodeURIComponent(input.objectKey)}`,
        ContentType: input.mimeType,
        MetadataDirective: "REPLACE"
      })
    );
  }

  async deleteObject(input: { area: StorageArea; objectKey: string }): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: bucketName(this.buckets, input.area),
        Key: input.objectKey
      })
    );
  }

  createDownloadUrl(input: {
    area: StorageArea;
    objectKey: string;
    downloadName: string;
    mimeType: string;
    expiresInSeconds: number;
  }): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: bucketName(this.buckets, input.area),
        Key: input.objectKey,
        ResponseContentType: input.mimeType,
        ResponseContentDisposition: attachmentDisposition(input.downloadName)
      }),
      { expiresIn: input.expiresInSeconds }
    );
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少对象存储环境变量 ${name}。`);
  return value;
}

export function createS3ObjectStorageFromEnvironment(): S3ObjectStorage {
  const accessKeyId = requiredEnvironment("APM_S3_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnvironment("APM_S3_SECRET_ACCESS_KEY");
  const client = new S3Client({
    endpoint: requiredEnvironment("APM_S3_ENDPOINT"),
    region: process.env.APM_S3_REGION?.trim() || "us-east-1",
    forcePathStyle: process.env.APM_S3_FORCE_PATH_STYLE !== "false",
    credentials: { accessKeyId, secretAccessKey }
  });
  return new S3ObjectStorage(client, {
    [STORAGE_AREAS.QUARANTINE]: process.env.APM_S3_QUARANTINE_BUCKET?.trim() || "apm-quarantine",
    [STORAGE_AREAS.CONTROLLED]: process.env.APM_S3_CONTROLLED_BUCKET?.trim() || "apm-controlled"
  });
}
