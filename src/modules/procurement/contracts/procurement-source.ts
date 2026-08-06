import { db } from "@/lib/db";

export const ERP_OWNED_FIELDS = [
  "materialCode",
  "materialName",
  "specification",
  "categoryPath",
  "baseUnit",
  "supplierCode",
  "requisitionNumber",
  "purchaseOrderNumber",
  "orderedQuantity",
  "erpReceiptNumber",
  "externalStatus"
] as const;

export type ErpOwnedField = (typeof ERP_OWNED_FIELDS)[number];

export type ProcurementProjectionEnvelope = {
  sourceSystem: string;
  objectType: string;
  externalId: string;
  externalLineId: string;
  sourceVersion: string;
  sourceHash: string;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
};

export type ProjectionResult = {
  accepted: true;
  idempotent: boolean;
  sourceVersion: string;
};

export type SyncFreshness = {
  sourceSystem: string;
  objectType: string;
  status: "UNKNOWN" | "FRESH" | "STALE" | "FAILED";
  cursor: string | null;
  syncedAt: string | null;
  failureCode: string | null;
};

export class ProcurementSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "ProcurementSourceError";
  }
}

function assertProjectionEnvelope(input: ProcurementProjectionEnvelope) {
  const required = [
    ["sourceSystem", input.sourceSystem],
    ["objectType", input.objectType],
    ["externalId", input.externalId],
    ["externalLineId", input.externalLineId],
    ["sourceVersion", input.sourceVersion],
    ["sourceHash", input.sourceHash]
  ] as const;
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 191) {
      throw new ProcurementSourceError(
        field === "externalId" || field === "externalLineId"
          ? "PROC_EXTERNAL_ID_REQUIRED"
          : "PROC_SOURCE_FIELD_REQUIRED",
        `${field} 必须是非空稳定字符串。`
      );
    }
  }
  if (!Number.isFinite(Date.parse(input.occurredAt))) {
    throw new ProcurementSourceError(
      "PROC_OCCURRED_AT_INVALID",
      "occurredAt 必须是有效时间。",
      422
    );
  }
}

export interface ProcurementSourcePort {
  readonly mode: "LOCAL" | "ERP";
  upsertProjection(input: ProcurementProjectionEnvelope): Promise<ProjectionResult>;
  readFreshness(input: { sourceSystem: string; objectType: string }): Promise<SyncFreshness>;
}

export class MemoryErpProjectionSource implements ProcurementSourcePort {
  readonly mode = "ERP" as const;
  private readonly projections = new Map<string, ProcurementProjectionEnvelope>();

  async upsertProjection(input: ProcurementProjectionEnvelope): Promise<ProjectionResult> {
    assertProjectionEnvelope(input);
    const key = [input.sourceSystem, input.objectType, input.externalId, input.externalLineId].join(
      "|"
    );
    const existing = this.projections.get(key);
    if (
      existing &&
      existing.sourceVersion === input.sourceVersion &&
      existing.sourceHash === input.sourceHash
    ) {
      return { accepted: true, idempotent: true, sourceVersion: existing.sourceVersion };
    }
    this.projections.set(key, { ...input, payload: { ...input.payload } });
    return { accepted: true, idempotent: false, sourceVersion: input.sourceVersion };
  }

  async readFreshness(input: { sourceSystem: string; objectType: string }): Promise<SyncFreshness> {
    const values = [...this.projections.values()].filter(
      (projection) =>
        projection.sourceSystem === input.sourceSystem && projection.objectType === input.objectType
    );
    const latest = values.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
    return {
      sourceSystem: input.sourceSystem,
      objectType: input.objectType,
      status: latest ? "FRESH" : "UNKNOWN",
      cursor: latest?.sourceVersion ?? null,
      syncedAt: latest?.occurredAt ?? null,
      failureCode: null
    };
  }
}

export class PrismaLocalProcurementSource implements ProcurementSourcePort {
  readonly mode = "LOCAL" as const;

  async upsertProjection(_input: ProcurementProjectionEnvelope): Promise<ProjectionResult> {
    throw new ProcurementSourceError(
      "PROC_ERP_PROJECTION_NOT_ALLOWED",
      "LOCAL 模式不接受 ERP 投影。",
      409
    );
  }

  async readFreshness(input: { sourceSystem: string; objectType: string }): Promise<SyncFreshness> {
    const state = await db.procurementSyncState.findUnique({
      where: { sourceSystem_objectType: input }
    });
    return {
      sourceSystem: input.sourceSystem,
      objectType: input.objectType,
      status:
        state?.status === "STALE" ? "STALE" : state?.status === "FAILED" ? "FAILED" : "UNKNOWN",
      cursor: state?.cursor ?? null,
      syncedAt: state?.lastSuccessfulAt?.toISOString() ?? null,
      failureCode: state?.failureCode ?? null
    };
  }
}
