import { Prisma } from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  SUPPLIER_MANUFACTURING_CAPABILITY_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  ManufacturingClassificationError,
  matchesSupplierCapability,
  normalizeManufacturingCategoryCode,
  normalizeProcessTagCodes
} from "../domain/manufacturing-classification";

type Category = {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  version: number;
};

type ProcessTag = Category;

type Supplier = {
  id: string;
  projectId: string;
  code: string;
  name: string;
  status: string;
  version: number;
};

type ProcessCapability = {
  id: string;
  projectId: string;
  supplierCapabilityId: string;
  processTagId: string;
  isActive: boolean;
  version: number;
  processTag: ProcessTag;
};

type ManufacturingCapability = {
  id: string;
  projectId: string;
  supplierReferenceId: string;
  manufacturingCategoryId: string;
  isActive: boolean;
  version: number;
  manufacturingCategory: Category;
  supplierReference: Supplier;
  processCapabilities: ProcessCapability[];
};

type Client = Prisma.TransactionClient | typeof db;

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ManufacturingClassificationError("VERSION_CONFLICT", "version 必须是正整数。", 422);
  }
  return value as number;
}

function commandReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new ManufacturingClassificationError(
      "INVALID_NAME",
      "操作原因必须是 1 到 1024 个字符。",
      422
    );
  }
  return value.trim();
}

function distinctIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ManufacturingClassificationError(
      "PROCESS_TAG_CODE_INVALID",
      "工艺标签必须是 ID 数组。",
      422
    );
  }
  const ids = value.map((item) => item.trim());
  if (new Set(ids).size !== ids.length) {
    throw new ManufacturingClassificationError("PROCESS_TAG_DUPLICATE", "工艺标签不能重复。", 409);
  }
  return ids;
}

function notFound(message: string): never {
  throw new ManufacturingClassificationError("NOT_FOUND", message, 404);
}

function categoryNotFound(): never {
  throw new ManufacturingClassificationError(
    "MANUFACTURING_CATEGORY_NOT_FOUND",
    "制造分类不存在。",
    404
  );
}

function processTagsNotFound(): never {
  throw new ManufacturingClassificationError("PROCESS_TAG_NOT_FOUND", "工艺标签不存在。", 404);
}

function categorySnapshot(category: Category) {
  return {
    id: category.id,
    code: category.code,
    name: category.name,
    sortOrder: category.sortOrder,
    isActive: category.isActive,
    version: category.version
  };
}

function tagSnapshot(tag: ProcessTag) {
  return {
    id: tag.id,
    code: tag.code,
    name: tag.name,
    sortOrder: tag.sortOrder,
    isActive: tag.isActive,
    version: tag.version
  };
}

function capabilitySnapshot(capability: ManufacturingCapability) {
  const processTags = capability.processCapabilities
    .filter((link) => link.isActive)
    .map((link) => tagSnapshot(link.processTag))
    .sort((left, right) => left.code.localeCompare(right.code));
  return {
    capabilityId: capability.id,
    projectId: capability.projectId,
    supplierReferenceId: capability.supplierReferenceId,
    category: categorySnapshot(capability.manufacturingCategory),
    processTagCodes: processTags.map((tag) => tag.code),
    isActive: capability.isActive,
    version: capability.version
  };
}

async function resolveCategory(
  client: Client,
  input: { categoryId?: string; categoryCode?: unknown }
) {
  const category = await client.manufacturingCategory.findUnique({
    where: input.categoryId
      ? { id: input.categoryId }
      : { code: normalizeManufacturingCategoryCode(input.categoryCode) }
  });
  if (!category) categoryNotFound();
  return category as Category;
}

async function resolveTags(
  client: Client,
  input: { processTagIds?: unknown; processTagCodes?: unknown }
) {
  const ids = input.processTagIds === undefined ? null : distinctIds(input.processTagIds);
  const codes = ids === null ? normalizeProcessTagCodes(input.processTagCodes) : null;
  if ((ids ?? codes!).length === 0) return [] as ProcessTag[];
  const tags = await client.processTag.findMany({
    where: ids === null ? { code: { in: codes! } } : { id: { in: ids } }
  });
  const requestedCount = ids?.length ?? codes!.length;
  if (tags.length !== requestedCount) processTagsNotFound();
  return tags as ProcessTag[];
}

async function readCapability(client: Client, input: { projectId: string; id: string }) {
  return (await client.supplierReferenceManufacturingCapability.findUniqueOrThrow({
    where: { id: input.id },
    include: {
      manufacturingCategory: true,
      supplierReference: true,
      processCapabilities: { include: { processTag: true } }
    }
  })) as ManufacturingCapability | null;
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      throw new ManufacturingClassificationError("CODE_CONFLICT", "供应商制造能力已经配置。", 409);
    }
    if (error.code === "P2003" || error.code === "P2004") {
      throw new ManufacturingClassificationError("NOT_FOUND", "供应商制造能力关系无效。", 404);
    }
  }
  throw error;
}

export async function updateSupplierCapability(
  input: {
    projectId: string;
    supplierReferenceId: string;
    capabilityId?: string;
    manufacturingCategoryId?: string;
    categoryCode?: unknown;
    processTagIds?: unknown;
    processTagCodes?: unknown;
    version: unknown;
    isActive?: boolean;
    reason: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const expectedVersion = positiveVersion(input.version);
  const reason = commandReason(input.reason);

  try {
    return await inTransaction(transaction, async (client) => {
      const supplier = (await client.supplierReference.findFirst({
        where: { id: input.supplierReferenceId, projectId: input.projectId }
      })) as Supplier | null;
      if (!supplier) notFound("供应商不存在。");

      const category = await resolveCategory(client, {
        categoryId: input.manufacturingCategoryId,
        categoryCode: input.categoryCode
      });
      const tags = await resolveTags(client, {
        processTagIds: input.processTagIds,
        processTagCodes: input.processTagCodes
      });

      const current = (await client.supplierReferenceManufacturingCapability.findFirst({
        where: input.capabilityId
          ? { id: input.capabilityId, projectId: input.projectId }
          : {
              projectId: input.projectId,
              supplierReferenceId: input.supplierReferenceId,
              manufacturingCategoryId: category.id
            },
        include: {
          manufacturingCategory: true,
          supplierReference: true,
          processCapabilities: { include: { processTag: true } }
        }
      })) as ManufacturingCapability | null;

      await client.$queryRaw`
        SELECT "id" FROM "supplier_reference_manufacturing_capabilities"
        WHERE "project_id" = ${input.projectId}
          AND "supplier_reference_id" = ${input.supplierReferenceId}
          AND "manufacturing_category_id" = ${category.id}
        FOR UPDATE
      `;

      const currentTagIds = new Set(
        current?.processCapabilities.map((link) => link.processTagId) ?? []
      );
      if (!category.isActive && current?.manufacturingCategoryId !== category.id) {
        throw new ManufacturingClassificationError(
          "INACTIVE_CLASSIFICATION",
          `制造分类 ${category.code} 已停用，不能用于新的供应商能力。`,
          409
        );
      }
      if (!category.isActive && !current) {
        throw new ManufacturingClassificationError(
          "INACTIVE_CLASSIFICATION",
          `制造分类 ${category.code} 已停用，不能用于新的供应商能力。`,
          409
        );
      }
      for (const tag of tags) {
        if (!tag.isActive && !currentTagIds.has(tag.id)) {
          throw new ManufacturingClassificationError(
            "INACTIVE_CLASSIFICATION",
            `工艺标签 ${tag.code} 已停用，不能用于新的供应商能力。`,
            409
          );
        }
      }

      let updated: ManufacturingCapability;
      if (!current) {
        if (expectedVersion !== 1) {
          throw new ManufacturingClassificationError("VERSION_CONFLICT", "供应商能力不存在。", 409);
        }
        updated = (await client.supplierReferenceManufacturingCapability.create({
          data: {
            projectId: input.projectId,
            supplierReferenceId: input.supplierReferenceId,
            manufacturingCategoryId: category.id,
            isActive: input.isActive ?? true
          },
          include: {
            manufacturingCategory: true,
            supplierReference: true,
            processCapabilities: { include: { processTag: true } }
          }
        })) as ManufacturingCapability;
      } else {
        if (current.supplierReferenceId !== input.supplierReferenceId)
          notFound("供应商能力不存在。");
        if (current.version !== expectedVersion) {
          throw new ManufacturingClassificationError(
            "VERSION_CONFLICT",
            "供应商能力已发生变化，请刷新后重试。",
            409
          );
        }
        const result = await client.supplierReferenceManufacturingCapability.updateMany({
          where: { id: current.id, projectId: input.projectId, version: expectedVersion },
          data: {
            isActive: input.isActive ?? current.isActive,
            version: { increment: 1 }
          }
        });
        if (result.count !== 1) {
          throw new ManufacturingClassificationError(
            "VERSION_CONFLICT",
            "供应商能力已发生变化，请刷新后重试。",
            409
          );
        }
        updated = (await readCapability(client, { projectId: input.projectId, id: current.id }))!;
      }

      const targetTagIds = new Set(tags.map((tag) => tag.id));
      await client.supplierReferenceProcessCapability.updateMany({
        where: {
          projectId: input.projectId,
          supplierCapabilityId: updated.id,
          processTagId: { notIn: [...targetTagIds] }
        },
        data: { isActive: false, version: { increment: 1 } }
      });
      await client.supplierReferenceProcessCapability.updateMany({
        where: {
          projectId: input.projectId,
          supplierCapabilityId: updated.id,
          processTagId: { in: [...targetTagIds] }
        },
        data: { isActive: true }
      });
      const additions = tags
        .filter((tag) => !currentTagIds.has(tag.id))
        .map((tag) => ({
          projectId: input.projectId,
          supplierCapabilityId: updated.id,
          processTagId: tag.id,
          isActive: true
        }));
      if (additions.length) {
        await client.supplierReferenceProcessCapability.createMany({ data: additions });
      }

      const refreshed = (await readCapability(client, {
        projectId: input.projectId,
        id: updated.id
      }))!;
      const before = current ? capabilitySnapshot(current) : null;
      const after = capabilitySnapshot(refreshed);
      const context = {
        ...input.auditContext,
        actorId: input.actorId,
        projectId: input.projectId,
        reason
      };
      const audit = await writeAudit(client, {
        action: AUDIT_ACTIONS.SUPPLIER_MANUFACTURING_CAPABILITY_UPDATED,
        objectType: AUDIT_OBJECT_TYPES.SUPPLIER_MANUFACTURING_CAPABILITY,
        objectId: refreshed.id,
        context,
        ...(before
          ? {
              before: {
                value: before,
                allowedFields: SUPPLIER_MANUFACTURING_CAPABILITY_AUDIT_FIELDS
              }
            }
          : {}),
        after: { value: after, allowedFields: SUPPLIER_MANUFACTURING_CAPABILITY_AUDIT_FIELDS }
      });
      const event = await appendOutboxEvent(client, {
        eventType: "drawing.supplier-capability.updated",
        aggregateType: AUDIT_OBJECT_TYPES.SUPPLIER_MANUFACTURING_CAPABILITY,
        aggregateId: refreshed.id,
        idempotencyKey: `${refreshed.id}:v${refreshed.version}`,
        payload: after
      });
      return {
        capability: after,
        resourceVersion: refreshed.version,
        auditId: audit.id,
        outboxEventId: event.id
      };
    });
  } catch (error) {
    if (error instanceof ManufacturingClassificationError) throw error;
    mapDatabaseError(error);
  }
}

export const updateSupplierManufacturingCapability = updateSupplierCapability;

export async function resolveSupplierMatch(
  client: Prisma.TransactionClient | typeof db,
  input: {
    projectId: string;
    supplierReferenceId: string | null;
    classification: { categoryCode: unknown; processTagCodes: unknown };
  }
) {
  if (!input.supplierReferenceId) {
    return {
      status: "NO_MATCH" as const,
      isDefault: false,
      supplierReferenceId: null,
      capabilityId: null
    };
  }
  const result = await listSupplierMatches(
    {
      projectId: input.projectId,
      categoryCode: input.classification.categoryCode,
      processTagCodes: input.classification.processTagCodes
    },
    client
  );
  const match = result.matches.find(
    (candidate) => candidate.supplierReferenceId === input.supplierReferenceId
  );
  return match
    ? {
        ...match,
        status: "MATCHED" as const,
        isDefault: true
      }
    : {
        status: "NO_MATCH" as const,
        isDefault: false,
        supplierReferenceId: input.supplierReferenceId,
        capabilityId: null
      };
}

export async function listSupplierMatches(
  input: { projectId: string; categoryCode: unknown; processTagCodes: unknown },
  transaction?: Prisma.TransactionClient
) {
  const categoryCode = normalizeManufacturingCategoryCode(input.categoryCode);
  const processTagCodes = normalizeProcessTagCodes(input.processTagCodes);
  const client = transaction ?? db;
  const category = (await client.manufacturingCategory.findUnique({
    where: { code: categoryCode }
  })) as Category | null;
  if (!category) categoryNotFound();
  if (!category.isActive) {
    throw new ManufacturingClassificationError(
      "INACTIVE_CLASSIFICATION",
      `制造分类 ${category.code} 已停用。`,
      409
    );
  }

  const rows = (await client.supplierReferenceManufacturingCapability.findMany({
    where: { projectId: input.projectId, manufacturingCategoryId: category.id, isActive: true },
    include: {
      manufacturingCategory: true,
      supplierReference: true,
      processCapabilities: {
        where: { isActive: true },
        include: { processTag: true }
      }
    }
  })) as ManufacturingCapability[];

  const matches = rows
    .filter((row) => row.supplierReference.projectId === input.projectId)
    .filter((row) => row.supplierReference.status === "ACTIVE")
    .map((row) => ({
      supplierReferenceId: row.supplierReferenceId,
      supplierCode: row.supplierReference.code,
      supplierName: row.supplierReference.name,
      capabilityId: row.id,
      categoryCode: row.manufacturingCategory.code,
      processTagCodes: row.processCapabilities
        .filter((link) => link.isActive && link.processTag.isActive)
        .map((link) => link.processTag.code)
        .sort(),
      version: row.version,
      isDefault: true
    }))
    .filter((match) =>
      matchesSupplierCapability(
        { categoryCode, processTagCodes },
        { categoryCode: match.categoryCode, processTagCodes: match.processTagCodes }
      )
    )
    .sort((left, right) => left.supplierCode.localeCompare(right.supplierCode));

  return {
    status: matches.length ? ("MATCHED" as const) : ("NO_MATCH" as const),
    projectId: input.projectId,
    categoryCode,
    processTagCodes,
    matches
  };
}
