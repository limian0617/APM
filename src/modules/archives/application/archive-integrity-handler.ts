import { createHash } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { db } from "@/lib/db";
import type { JobExecution, JobHandler } from "@/modules/governance/contracts/jobs";
import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";

import type { ObjectStoragePort } from "@/modules/documents/contracts/file-storage";
import {
  ARCHIVE_VERSION_AUDIT_FIELDS,
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  AUDIT_SOURCES
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

export type ArchiveIntegrityManifestFile = {
  id: string;
  status: string;
  storageArea: string;
  objectKey: string;
  sha256: string | null;
  size: bigint | number;
};

export type ArchiveIntegrityItem = {
  id: string;
  file: ArchiveIntegrityManifestFile | null;
};

export type ArchiveIntegrityItemResult =
  | { itemId: string; status: "NOT_APPLICABLE"; actualSha256: null; actualSize: null }
  | {
      itemId: string;
      status: "PASSED" | "FAILED";
      actualSha256: string | null;
      actualSize: bigint | null;
      failureCode?: string;
      failureMessage?: string;
    };

async function hashObject(storage: ObjectStoragePort, file: ArchiveIntegrityManifestFile) {
  const hash = createHash("sha256");
  let size = 0n;
  const stream = await storage.readObject({
    area: file.storageArea as "CONTROLLED" | "QUARANTINE",
    objectKey: file.objectKey
  });
  for await (const chunk of stream) {
    hash.update(chunk);
    size += BigInt(chunk.byteLength);
  }
  return { sha256: hash.digest("hex"), size };
}

export async function verifyArchiveManifestItems(input: {
  storage: Pick<ObjectStoragePort, "readObject">;
  items: readonly ArchiveIntegrityItem[];
}): Promise<ArchiveIntegrityItemResult[]> {
  const results: ArchiveIntegrityItemResult[] = [];
  for (const item of input.items) {
    const file = item.file;
    if (!file) {
      results.push({
        itemId: item.id,
        status: "NOT_APPLICABLE",
        actualSha256: null,
        actualSize: null
      });
      continue;
    }
    if (file.status !== "AVAILABLE" || file.storageArea !== "CONTROLLED") {
      results.push({
        itemId: item.id,
        status: "FAILED",
        actualSha256: null,
        actualSize: null,
        failureCode: "ARCHIVE_FILE_NOT_AVAILABLE",
        failureMessage: "归档文件当前不可用或不在受控存储区。"
      });
      continue;
    }
    try {
      const actual = await hashObject(input.storage as ObjectStoragePort, file);
      const hashMatches = actual.sha256 === file.sha256;
      const sizeMatches = actual.size === BigInt(file.size);
      results.push({
        itemId: item.id,
        status: hashMatches && sizeMatches ? "PASSED" : "FAILED",
        actualSha256: actual.sha256,
        actualSize: actual.size,
        ...(hashMatches && sizeMatches
          ? {}
          : {
              failureCode: hashMatches
                ? "ARCHIVE_FILE_SIZE_MISMATCH"
                : "ARCHIVE_FILE_HASH_MISMATCH",
              failureMessage: hashMatches
                ? "对象实际大小与归档事实不一致。"
                : "对象实际字节 SHA-256 与归档事实不一致。"
            })
      });
    } catch {
      results.push({
        itemId: item.id,
        status: "FAILED",
        actualSha256: null,
        actualSize: null,
        failureCode: "ARCHIVE_FILE_READ_FAILED",
        failureMessage: "无法读取归档对象的实际字节。"
      });
    }
  }
  return results;
}

type IntegrityPayload = { projectId: string; archiveVersionId: string };

function parsePayload(job: JobExecution): IntegrityPayload {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new TypeError("归档完整性作业负载无效。");
  }
  const value = job.payload as Record<string, JsonValue>;
  if (
    typeof value.projectId !== "string" ||
    !value.projectId.trim() ||
    typeof value.archiveVersionId !== "string" ||
    !value.archiveVersionId.trim()
  ) {
    throw new TypeError("归档完整性作业负载无效。");
  }
  return { projectId: value.projectId.trim(), archiveVersionId: value.archiveVersionId.trim() };
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [row] = await client.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!row) throw new Error("无法读取数据库时间。");
  return row.now;
}

export function createArchiveIntegrityHandler(input: {
  storage: ObjectStoragePort;
  client?: PrismaClient;
}): JobHandler {
  const client = input.client ?? db;
  return async (job) => {
    const payload = parsePayload(job);
    const version = await client.projectArchiveVersion.findFirst({
      where: { id: payload.archiveVersionId, projectId: payload.projectId },
      include: { manifestItems: { include: { fileObject: true }, orderBy: { position: "asc" } } }
    });
    if (!version) throw new Error("归档版本不存在或不属于当前项目。");
    if (version.status === "FINALIZED") throw new Error("已固定归档版本不能重新检查。");
    const shouldVerify = await client.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT "id"
        FROM "project_archive_versions"
        WHERE "id" = ${payload.archiveVersionId} AND "project_id" = ${payload.projectId}
        FOR UPDATE
      `;
      const locked = await transaction.projectArchiveVersion.findFirst({
        where: { id: version.id, projectId: payload.projectId },
        select: { id: true, status: true }
      });
      if (!locked || locked.status === "FINALIZED") throw new Error("归档版本不能执行完整性检查。");
      const existing = await transaction.projectArchiveIntegrityCheck.findUnique({
        where: { jobId: job.id },
        select: { id: true }
      });
      if (existing) return false;
      if (locked.status !== "VERIFYING") {
        await transaction.projectArchiveVersion.update({
          where: { id: locked.id },
          data: { status: "VERIFYING" }
        });
      }
      return true;
    });
    if (!shouldVerify) return;

    const results = await verifyArchiveManifestItems({
      storage: input.storage,
      items: version.manifestItems.map((item) => ({
        id: item.id,
        file: item.fileObject
          ? {
              id: item.fileObject.id,
              status: item.fileObject.status,
              storageArea: item.fileObject.storageArea,
              objectKey: item.fileObject.objectKey,
              sha256: item.fileSha256,
              size: item.fileSize ?? 0n
            }
          : null
      }))
    });
    const resultChecksum = payloadHash(
      results.map((result) => ({ ...result, actualSize: result.actualSize?.toString() ?? null }))
    ).hash;
    const failed = results.some((result) => result.status === "FAILED");
    await client.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT "id"
        FROM "project_archive_versions"
        WHERE "id" = ${payload.archiveVersionId} AND "project_id" = ${payload.projectId}
        FOR UPDATE
      `;
      const locked = await transaction.projectArchiveVersion.findFirst({
        where: { id: payload.archiveVersionId, projectId: payload.projectId },
        select: { id: true, status: true, manifestChecksum: true }
      });
      if (!locked || locked.status === "FINALIZED") throw new Error("归档版本不能执行完整性检查。");
      const existing = await transaction.projectArchiveIntegrityCheck.findUnique({
        where: { jobId: job.id },
        select: { id: true }
      });
      if (existing) return;
      if (locked.status !== "VERIFYING") {
        await transaction.projectArchiveVersion.update({
          where: { id: locked.id },
          data: { status: "VERIFYING" }
        });
      }
      const last = await transaction.projectArchiveIntegrityCheck.findFirst({
        where: { archiveVersionId: locked.id, projectId: payload.projectId },
        orderBy: { sequence: "desc" },
        select: { sequence: true }
      });
      const checkedAt = await databaseNow(transaction);
      const check = await transaction.projectArchiveIntegrityCheck.create({
        data: {
          projectId: payload.projectId,
          archiveVersionId: locked.id,
          sequence: (last?.sequence ?? 0) + 1,
          jobId: job.id,
          status: failed ? "FAILED" : "PASSED",
          inputChecksum: locked.manifestChecksum,
          resultChecksum,
          checkedAt
        },
        select: { id: true }
      });
      if (results.length > 0) {
        await transaction.projectArchiveIntegrityItemResult.createMany({
          data: results.map((result) => ({
            projectId: payload.projectId,
            integrityCheckId: check.id,
            manifestItemId: result.itemId,
            status: result.status,
            actualSha256: result.actualSha256,
            actualSize: result.actualSize,
            failureCode: "failureCode" in result ? result.failureCode : null,
            failureMessage: "failureMessage" in result ? result.failureMessage : null,
            checkedAt
          }))
        });
      }
      await transaction.projectArchiveVersion.update({
        where: { id: locked.id },
        data: { status: failed ? "FAILED" : "READY" }
      });
      await writeAudit(transaction, {
        action: AUDIT_ACTIONS.PROJECT_ARCHIVE_INTEGRITY_CHECKED,
        objectType: AUDIT_OBJECT_TYPES.PROJECT_ARCHIVE_INTEGRITY_CHECK,
        objectId: check.id,
        context: {
          actorId: null,
          requestId: null,
          traceId: job.traceId ?? job.id,
          source: AUDIT_SOURCES.WORKER,
          sourceIp: null,
          userAgent: null,
          reason: null,
          projectId: payload.projectId,
          departmentId: null,
          operationId: job.idempotencyKey
        },
        after: {
          value: {
            projectId: payload.projectId,
            archiveVersionId: payload.archiveVersionId,
            checkId: check.id,
            status: failed ? "FAILED" : "PASSED",
            resultChecksum
          },
          allowedFields: ARCHIVE_VERSION_AUDIT_FIELDS
        }
      });
      await appendOutboxEvent(transaction, {
        eventType: "archive.integrity.checked",
        aggregateType: AUDIT_OBJECT_TYPES.PROJECT_ARCHIVE_VERSION,
        aggregateId: payload.archiveVersionId,
        idempotencyKey: `${check.id}:completed`,
        payload: {
          projectId: payload.projectId,
          archiveVersionId: payload.archiveVersionId,
          checkId: check.id
        },
        traceId: job.traceId
      });
    });
  };
}
