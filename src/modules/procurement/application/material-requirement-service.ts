import {
  Prisma,
  ProjectStatus,
  type MaterialRequirementSource,
  type ProcurementBusinessType,
  type ProcurementMode,
  type ProcurementSource
} from "@prisma/client";

import { db, inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  MATERIAL_REFERENCE_AUDIT_FIELDS,
  MATERIAL_REQUIREMENT_AUDIT_FIELDS,
  SUPPLIER_REFERENCE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { validateRequirementDraft } from "@/modules/procurement/domain/procurement-policy";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import { appendReadinessRecalculationRequest } from "./readiness-service";
import { detectAndRecordProcurementChangeImpact } from "./change-impact-service";

export class ProcurementServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "ProcurementServiceError";
  }
}

type ProcurementWriteContext = {
  projectId: string;
  companyEnabled: boolean;
  selectedEnabled: boolean;
};

export function assertProcurementCapabilityEnabled(context: ProcurementWriteContext) {
  if (!context.companyEnabled || !context.selectedEnabled) {
    throw new ProcurementServiceError(
      "PROC_CAPABILITY_DISABLED",
      "项目采购与物料协同能力未有效启用。",
      409
    );
  }
}

export function assertErpReferenceFieldsReadOnly(input: {
  projectId: string;
  mode: "LOCAL" | "ERP";
  source: "LOCAL" | "ERP";
  hasErpOwnedFieldEdits: boolean;
}) {
  if (input.mode === "ERP" && input.source === "ERP" && input.hasErpOwnedFieldEdits) {
    throw new ProcurementServiceError(
      "PROC_ERP_FIELD_READ_ONLY",
      "ERP 权威物料和供应商字段只能通过只读投影更新。",
      409
    );
  }
}

export function assertDrawingRequirementReference(input: {
  projectId: string;
  drawingProjectId: string | null;
  drawingVersionStatus: string | null;
}) {
  if (input.drawingProjectId !== input.projectId) {
    throw new ProcurementServiceError(
      "PROC_DRAWING_PROJECT_MISMATCH",
      "图纸必须属于当前项目。",
      422
    );
  }
  if (input.drawingVersionStatus !== "PUBLISHED") {
    throw new ProcurementServiceError(
      "PROC_DRAWING_VERSION_NOT_PUBLISHED",
      "图纸定制加工必须引用已发布图纸版本。",
      422
    );
  }
}

type RequirementFields = {
  materialReferenceId: string;
  deliveryUnitId?: string | null;
  moduleId?: string | null;
  responsibilityPackageId?: string | null;
  taskId?: string | null;
  quantity: string;
  trackingUnit: string;
  requiredOn: string;
  predictedAssemblyStartOn?: string | null;
  isCritical: boolean;
  businessType: ProcurementBusinessType;
  source: MaterialRequirementSource;
  sourceReference?: string | null;
  sourceVersion?: string | null;
  drawingId?: string | null;
  drawingVersionId?: string | null;
  outsourcedProcess?: string | null;
};

export type CreateMaterialRequirementInput = RequirementFields & {
  projectId: string;
  actorId: string;
  auditContext: AuditContext;
};

export type ReviseMaterialRequirementInput = RequirementFields & {
  projectId: string;
  requirementId: string;
  version: unknown;
  reason: unknown;
  actorId: string;
  auditContext: AuditContext;
};

export type RequirementVersionCommandInput = {
  projectId: string;
  requirementId: string;
  version: unknown;
  reason: unknown;
  actorId: string;
  auditContext: AuditContext;
};

export type MaterialReferenceQuery = {
  projectId: string;
  cursor?: string;
  limit: number;
  status?: "ACTIVE" | "DISABLED";
};

export type SupplierReferenceQuery = {
  projectId: string;
  cursor?: string;
  limit: number;
  status?: "ACTIVE" | "DISABLED";
};

export type MaterialRequirementQuery = {
  projectId: string;
  cursor?: string;
  limit: number;
  status?: "DRAFT" | "CONFIRMED" | "CANCELED";
};

function text(value: unknown, field: string, maximum = 191): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new ProcurementServiceError(
      "PROC_INVALID_INPUT",
      `${field} 必须是 1 到 ${maximum} 个字符。`
    );
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maximum = 191): string | null {
  if (value === undefined || value === null) return null;
  return text(value, field, maximum);
}

function id(value: unknown, field: string): string {
  return text(value, field, 191);
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProcurementServiceError("PROC_INVALID_VERSION", "version 必须是正整数。");
  }
  return value as number;
}

function requirementDate(value: unknown, field: string): Date {
  const date = text(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) {
    throw new ProcurementServiceError("PROC_INVALID_INPUT", `${field} 必须是 YYYY-MM-DD。`);
  }
  return new Date(`${date}T00:00:00.000Z`);
}

function source(value: unknown): ProcurementSource {
  if (value !== "LOCAL" && value !== "ERP") {
    throw new ProcurementServiceError("PROC_INVALID_INPUT", "source 必须为 LOCAL 或 ERP。");
  }
  return value;
}

function referenceCode(value: unknown): string {
  const code = text(value, "code", 64).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/u.test(code)) {
    throw new ProcurementServiceError("PROC_INVALID_INPUT", "code 不是受控引用代码。", 422);
  }
  return code;
}

function trackingUnit(value: unknown): string {
  const unit = text(value, "trackingUnit", 32).toUpperCase();
  if (!/^[A-Z][A-Z0-9._-]{0,31}$/u.test(unit)) {
    throw new ProcurementServiceError(
      "PROC_UNIT_INVALID",
      "trackingUnit 必须是受控单位代码。",
      422
    );
  }
  return unit;
}

function prepareRequirementFields(input: RequirementFields) {
  const business = validateRequirementDraft({
    businessType: input.businessType,
    quantity: input.quantity,
    trackingUnit: input.trackingUnit,
    drawingId: input.drawingId ?? null,
    drawingVersionId: input.drawingVersionId ?? null,
    outsourcedProcess: input.outsourcedProcess ?? null
  });
  return {
    materialReferenceId: id(input.materialReferenceId, "materialReferenceId"),
    deliveryUnitId: optionalText(input.deliveryUnitId, "deliveryUnitId"),
    moduleId: optionalText(input.moduleId, "moduleId"),
    responsibilityPackageId: optionalText(input.responsibilityPackageId, "responsibilityPackageId"),
    taskId: optionalText(input.taskId, "taskId"),
    quantity: new Prisma.Decimal(business.quantity),
    trackingUnit: business.trackingUnit,
    requiredOn: requirementDate(input.requiredOn, "requiredOn"),
    predictedAssemblyStartOn: input.predictedAssemblyStartOn
      ? requirementDate(input.predictedAssemblyStartOn, "predictedAssemblyStartOn")
      : null,
    isCritical: input.isCritical === true,
    businessType: business.businessType,
    source: input.source,
    sourceReference: optionalText(input.sourceReference, "sourceReference", 1024),
    sourceVersion: optionalText(input.sourceVersion, "sourceVersion"),
    drawingId: business.drawingId,
    drawingVersionId: business.drawingVersionId,
    outsourcedProcess: business.outsourcedProcess
  };
}

async function loadWriteContext(client: Prisma.TransactionClient, projectId: string) {
  const [project, capability, companyCapability, settings] = await Promise.all([
    client.project.findUnique({ where: { id: projectId } }),
    client.projectCapability.findUnique({
      where: {
        projectId_capabilityCode: { projectId, capabilityCode: "PROCUREMENT_COLLABORATION" }
      }
    }),
    client.companyCapability.findUnique({ where: { code: "PROCUREMENT_COLLABORATION" } }),
    client.projectProcurementSettings.findUnique({ where: { projectId } })
  ]);
  if (!project) throw new ProcurementServiceError("PROJECT_NOT_FOUND", "项目不存在。", 404);
  if (project.status === ProjectStatus.CLOSED || project.status === ProjectStatus.CANCELED) {
    throw new ProcurementServiceError(
      "PROJECT_READ_ONLY",
      "已关闭或取消项目不能修改采购事实。",
      409
    );
  }
  assertProcurementCapabilityEnabled({
    projectId,
    companyEnabled: companyCapability?.enabled === true,
    selectedEnabled: capability?.selectedEnabled === true
  });
  if (!settings) {
    throw new ProcurementServiceError(
      "PROC_SETTINGS_NOT_CONFIGURED",
      "项目采购运行模式尚未配置。",
      409
    );
  }
  return { project, settings };
}

async function assertScopeRelations(
  client: Prisma.TransactionClient,
  projectId: string,
  fields: ReturnType<typeof prepareRequirementFields>
) {
  const checks = await Promise.all([
    fields.deliveryUnitId
      ? client.deliveryUnit.findFirst({
          where: { id: fields.deliveryUnitId, projectId },
          select: { id: true }
        })
      : Promise.resolve(true),
    fields.moduleId
      ? client.projectModule.findFirst({
          where: { id: fields.moduleId, projectId },
          select: { id: true }
        })
      : Promise.resolve(true),
    fields.responsibilityPackageId
      ? client.responsibilityPackage.findFirst({
          where: { id: fields.responsibilityPackageId, projectId },
          select: { id: true }
        })
      : Promise.resolve(true),
    fields.taskId
      ? client.planningTask.findFirst({
          where: { id: fields.taskId, projectId },
          select: { id: true }
        })
      : Promise.resolve(true)
  ]);
  if (checks.some((item) => !item)) {
    throw new ProcurementServiceError(
      "PROC_SCOPE_PROJECT_MISMATCH",
      "需求范围对象不存在或不属于当前项目。",
      422
    );
  }
}

async function assertRequirementReferences(
  client: Prisma.TransactionClient,
  projectId: string,
  fields: ReturnType<typeof prepareRequirementFields>
) {
  const material = await client.materialReference.findFirst({
    where: { id: fields.materialReferenceId, projectId, status: "ACTIVE" }
  });
  if (!material) {
    throw new ProcurementServiceError(
      "PROC_MATERIAL_REFERENCE_NOT_FOUND",
      "物料引用不存在、已停用或不属于当前项目。",
      422
    );
  }
  if (material.trackingUnit !== fields.trackingUnit) {
    throw new ProcurementServiceError(
      "PROC_UNIT_MISMATCH",
      "需求单位必须与物料跟踪单位一致。",
      422
    );
  }
  if (!fields.drawingId || !fields.drawingVersionId) return material;
  const [drawing, version] = await Promise.all([
    client.mechanicalDrawing.findFirst({ where: { id: fields.drawingId, projectId } }),
    client.controlledDocumentVersion.findFirst({
      where: { id: fields.drawingVersionId, projectId }
    })
  ]);
  assertDrawingRequirementReference({
    projectId,
    drawingProjectId: drawing?.projectId ?? null,
    drawingVersionStatus: version?.status ?? null
  });
  if (version?.documentId !== drawing?.documentId) {
    throw new ProcurementServiceError(
      "PROC_DRAWING_VERSION_MISMATCH",
      "图纸版本不属于指定图纸。",
      422
    );
  }
  return material;
}

function auditContext(
  input: { actorId: string; auditContext: AuditContext },
  projectId: string,
  departmentId: string | null,
  reason: string
) {
  return { ...input.auditContext, actorId: input.actorId, projectId, departmentId, reason };
}

function materialAuditValue(material: {
  id: string;
  projectId: string;
  source: ProcurementSource;
  externalId: string | null;
  code: string;
  name: string;
  trackingUnit: string;
  status: string;
  version: number;
}) {
  return {
    projectId: material.projectId,
    materialReferenceId: material.id,
    source: material.source,
    externalId: material.externalId,
    code: material.code,
    name: material.name,
    trackingUnit: material.trackingUnit,
    status: material.status,
    version: material.version
  };
}

function supplierAuditValue(supplier: {
  id: string;
  projectId: string;
  source: ProcurementSource;
  externalId: string | null;
  code: string;
  name: string;
  status: string;
  version: number;
}) {
  return {
    projectId: supplier.projectId,
    supplierReferenceId: supplier.id,
    source: supplier.source,
    externalId: supplier.externalId,
    code: supplier.code,
    name: supplier.name,
    status: supplier.status,
    version: supplier.version
  };
}

function requirementAuditValue(requirement: {
  id: string;
  projectId: string;
  version: number;
  currentRevision: {
    id: string;
    revision: number;
    materialReferenceId: string;
    quantity: Prisma.Decimal;
    trackingUnit: string;
    requiredOn: Date;
    predictedAssemblyStartOn: Date | null;
    businessType: ProcurementBusinessType;
    status: string;
  } | null;
}) {
  const revision = requirement.currentRevision;
  if (!revision) throw new Error("采购需求缺少当前修订。");
  return {
    projectId: requirement.projectId,
    requirementId: requirement.id,
    revisionId: revision.id,
    revision: revision.revision,
    materialReferenceId: revision.materialReferenceId,
    quantity: revision.quantity.toString(),
    trackingUnit: revision.trackingUnit,
    requiredOn: revision.requiredOn.toISOString().slice(0, 10),
    predictedAssemblyStartOn: revision.predictedAssemblyStartOn?.toISOString().slice(0, 10) ?? null,
    businessType: revision.businessType,
    status: revision.status,
    version: requirement.version
  };
}

const requirementInclude = {
  currentRevision: true
} satisfies Prisma.ProjectMaterialRequirementInclude;

async function readRequirement(
  client: Prisma.TransactionClient,
  projectId: string,
  requirementId: string
) {
  const requirement = await client.projectMaterialRequirement.findFirst({
    where: { id: requirementId, projectId },
    include: requirementInclude
  });
  if (!requirement) {
    throw new ProcurementServiceError(
      "PROC_REQUIREMENT_NOT_FOUND",
      "物料需求不存在或不属于当前项目。",
      404
    );
  }
  return requirement;
}

async function lockRequirement(
  client: Prisma.TransactionClient,
  projectId: string,
  requirementId: string
) {
  await client.$queryRaw`
    SELECT "id" FROM "project_material_requirements"
    WHERE "id" = ${requirementId} AND "project_id" = ${projectId}
    FOR UPDATE
  `;
  return readRequirement(client, projectId, requirementId);
}

async function databaseNow(client: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await client.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS "now"`;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

export async function createMaterialReference(
  input: {
    projectId: string;
    source: unknown;
    externalId?: unknown;
    code: unknown;
    name: unknown;
    specification?: unknown;
    trackingUnit: unknown;
    defaultProcurementDays?: unknown;
    isLongLead?: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = id(input.projectId, "projectId");
  const referenceSource = source(input.source);
  const externalId = optionalText(input.externalId, "externalId");
  const code = referenceCode(input.code);
  const name = text(input.name, "name", 200);
  const unit = trackingUnit(input.trackingUnit);
  const defaultProcurementDays =
    input.defaultProcurementDays === undefined ? null : Number(input.defaultProcurementDays);
  if (
    defaultProcurementDays !== null &&
    (!Number.isSafeInteger(defaultProcurementDays) || defaultProcurementDays < 0)
  ) {
    throw new ProcurementServiceError(
      "PROC_INVALID_INPUT",
      "defaultProcurementDays 必须是非负整数。",
      422
    );
  }
  return inTransaction(transaction, async (client) => {
    const context = await loadWriteContext(client, projectId);
    assertErpReferenceFieldsReadOnly({
      projectId,
      mode: context.settings.mode,
      source: referenceSource,
      hasErpOwnedFieldEdits: true
    });
    if (context.settings.mode === "LOCAL" && referenceSource !== "LOCAL") {
      throw new ProcurementServiceError(
        "PROC_SOURCE_MODE_MISMATCH",
        "LOCAL 模式只能创建本地引用。",
        409
      );
    }
    if ((referenceSource === "LOCAL" && externalId) || (referenceSource === "ERP" && !externalId)) {
      throw new ProcurementServiceError(
        "PROC_REFERENCE_SOURCE_INVALID",
        "引用来源与外部 ID 不一致。",
        422
      );
    }
    const material = await client.materialReference.create({
      data: {
        projectId,
        source: referenceSource,
        externalId,
        code,
        name,
        specification: optionalText(input.specification, "specification", 200),
        trackingUnit: unit,
        defaultProcurementDays,
        isLongLead: input.isLongLead === true,
        createdById: input.actorId,
        updatedById: input.actorId
      }
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.MATERIAL_REFERENCE_CREATED,
      objectType: AUDIT_OBJECT_TYPES.MATERIAL_REFERENCE,
      objectId: material.id,
      context: auditContext(input, projectId, context.project.departmentId, "创建项目物料引用。"),
      after: { value: materialAuditValue(material), allowedFields: MATERIAL_REFERENCE_AUDIT_FIELDS }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "procurement.material-reference.created",
      aggregateType: "MATERIAL_REFERENCE",
      aggregateId: material.id,
      idempotencyKey: material.id,
      payload: { ...materialAuditValue(material), auditId: audit.id }
    });
    return {
      materialReference: material,
      resourceVersion: material.version,
      auditId: audit.id,
      outboxEventId: event.id
    };
  });
}

export async function createSupplierReference(
  input: {
    projectId: string;
    source: unknown;
    externalId?: unknown;
    code: unknown;
    name: unknown;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const projectId = id(input.projectId, "projectId");
  const referenceSource = source(input.source);
  const externalId = optionalText(input.externalId, "externalId");
  const code = referenceCode(input.code);
  const name = text(input.name, "name", 200);
  return inTransaction(transaction, async (client) => {
    const context = await loadWriteContext(client, projectId);
    assertErpReferenceFieldsReadOnly({
      projectId,
      mode: context.settings.mode,
      source: referenceSource,
      hasErpOwnedFieldEdits: true
    });
    if (context.settings.mode === "LOCAL" && referenceSource !== "LOCAL") {
      throw new ProcurementServiceError(
        "PROC_SOURCE_MODE_MISMATCH",
        "LOCAL 模式只能创建本地引用。",
        409
      );
    }
    if ((referenceSource === "LOCAL" && externalId) || (referenceSource === "ERP" && !externalId)) {
      throw new ProcurementServiceError(
        "PROC_REFERENCE_SOURCE_INVALID",
        "引用来源与外部 ID 不一致。",
        422
      );
    }
    const supplier = await client.supplierReference.create({
      data: {
        projectId,
        source: referenceSource,
        externalId,
        code,
        name,
        createdById: input.actorId,
        updatedById: input.actorId
      }
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.SUPPLIER_REFERENCE_CREATED,
      objectType: AUDIT_OBJECT_TYPES.SUPPLIER_REFERENCE,
      objectId: supplier.id,
      context: auditContext(input, projectId, context.project.departmentId, "创建项目供应商引用。"),
      after: { value: supplierAuditValue(supplier), allowedFields: SUPPLIER_REFERENCE_AUDIT_FIELDS }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "procurement.supplier-reference.created",
      aggregateType: "SUPPLIER_REFERENCE",
      aggregateId: supplier.id,
      idempotencyKey: supplier.id,
      payload: { ...supplierAuditValue(supplier), auditId: audit.id }
    });
    return {
      supplierReference: supplier,
      resourceVersion: supplier.version,
      auditId: audit.id,
      outboxEventId: event.id
    };
  });
}

export async function createMaterialRequirementDraft(
  input: CreateMaterialRequirementInput,
  transaction?: Prisma.TransactionClient
) {
  const projectId = id(input.projectId, "projectId");
  const fields = prepareRequirementFields(input);
  return inTransaction(transaction, async (client) => {
    const context = await loadWriteContext(client, projectId);
    const [material] = await Promise.all([
      assertRequirementReferences(client, projectId, fields),
      assertScopeRelations(client, projectId, fields)
    ]);
    const requirement = await client.projectMaterialRequirement.create({
      data: { projectId, status: "DRAFT", createdById: input.actorId, updatedById: input.actorId }
    });
    const revision = await client.projectMaterialRequirementRevision.create({
      data: {
        ...fields,
        projectId,
        requirementId: requirement.id,
        revision: 1,
        materialCodeSnapshot: material.code,
        materialNameSnapshot: material.name,
        materialSpecificationSnapshot: material.specification,
        isLongLead: material.isLongLead,
        status: "DRAFT",
        createdById: input.actorId
      }
    });
    const current = await client.projectMaterialRequirement.update({
      where: { id: requirement.id },
      data: { currentRevisionId: revision.id },
      include: requirementInclude
    });
    const value = requirementAuditValue(current);
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.MATERIAL_REQUIREMENT_DRAFTED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_MATERIAL_REQUIREMENT,
      objectId: requirement.id,
      context: auditContext(
        input,
        projectId,
        context.project.departmentId,
        "创建项目物料需求草稿。"
      ),
      after: { value, allowedFields: MATERIAL_REQUIREMENT_AUDIT_FIELDS }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "procurement.material-requirement.drafted",
      aggregateType: "PROJECT_MATERIAL_REQUIREMENT",
      aggregateId: requirement.id,
      idempotencyKey: `${requirement.id}:r1`,
      payload: { ...value, auditId: audit.id }
    });
    return {
      requirement: current,
      resourceVersion: current.version,
      auditId: audit.id,
      outboxEventId: event.id
    };
  });
}

export async function confirmMaterialRequirement(
  input: RequirementVersionCommandInput,
  transaction?: Prisma.TransactionClient
) {
  const projectId = id(input.projectId, "projectId");
  const requirementId = id(input.requirementId, "requirementId");
  const version = positiveVersion(input.version);
  const reason = text(input.reason, "reason", 1024);
  return inTransaction(transaction, async (client) => {
    const context = await loadWriteContext(client, projectId);
    const requirement = await lockRequirement(client, projectId, requirementId);
    if (requirement.version !== version) {
      throw new ProcurementServiceError(
        "VERSION_CONFLICT",
        "物料需求已发生变化，请刷新后重试。",
        409
      );
    }
    if (
      requirement.status !== "DRAFT" ||
      !requirement.currentRevision ||
      requirement.currentRevision.status !== "DRAFT"
    ) {
      throw new ProcurementServiceError(
        "PROC_REQUIREMENT_CONFIRM_INVALID",
        "只有当前草稿需求可以确认。",
        409
      );
    }
    const confirmedAt = await databaseNow(client);
    await client.projectMaterialRequirementRevision.update({
      where: { id: requirement.currentRevision.id },
      data: { status: "CONFIRMED", confirmedById: input.actorId, confirmedAt }
    });
    const updated = await client.projectMaterialRequirement.update({
      where: { id: requirementId },
      data: { status: "CONFIRMED", version: { increment: 1 }, updatedById: input.actorId },
      include: requirementInclude
    });
    const value = requirementAuditValue(updated);
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.MATERIAL_REQUIREMENT_CONFIRMED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_MATERIAL_REQUIREMENT,
      objectId: requirementId,
      context: auditContext(input, projectId, context.project.departmentId, reason),
      after: { value, allowedFields: MATERIAL_REQUIREMENT_AUDIT_FIELDS }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "procurement.material-requirement.confirmed",
      aggregateType: "PROJECT_MATERIAL_REQUIREMENT",
      aggregateId: requirementId,
      idempotencyKey: `${requirementId}:v${updated.version}`,
      payload: { ...value, auditId: audit.id }
    });
    await appendReadinessRecalculationRequest(client, {
      projectId,
      cause: "material-requirement-confirmed",
      idempotencyKey: `${requirementId}:v${updated.version}`,
      traceId: input.auditContext.traceId
    });
    return {
      requirement: updated,
      resourceVersion: updated.version,
      auditId: audit.id,
      outboxEventId: event.id
    };
  });
}

export async function reviseMaterialRequirement(
  input: ReviseMaterialRequirementInput,
  transaction?: Prisma.TransactionClient
) {
  const projectId = id(input.projectId, "projectId");
  const requirementId = id(input.requirementId, "requirementId");
  const version = positiveVersion(input.version);
  const reason = text(input.reason, "reason", 1024);
  const fields = prepareRequirementFields(input);
  return inTransaction(transaction, async (client) => {
    const context = await loadWriteContext(client, projectId);
    const requirement = await lockRequirement(client, projectId, requirementId);
    if (requirement.version !== version) {
      throw new ProcurementServiceError(
        "VERSION_CONFLICT",
        "物料需求已发生变化，请刷新后重试。",
        409
      );
    }
    if (requirement.status !== "CONFIRMED" || !requirement.currentRevision) {
      throw new ProcurementServiceError(
        "PROC_REQUIREMENT_REVISE_INVALID",
        "只有已确认需求可以创建修订。",
        409
      );
    }
    const [material] = await Promise.all([
      assertRequirementReferences(client, projectId, fields),
      assertScopeRelations(client, projectId, fields)
    ]);
    const confirmedAt = await databaseNow(client);
    const revision = await client.projectMaterialRequirementRevision.create({
      data: {
        ...fields,
        projectId,
        requirementId,
        revision: requirement.currentRevision.revision + 1,
        materialCodeSnapshot: material.code,
        materialNameSnapshot: material.name,
        materialSpecificationSnapshot: material.specification,
        isLongLead: material.isLongLead,
        status: "CONFIRMED",
        confirmedById: input.actorId,
        confirmedAt,
        supersedesRevisionId: requirement.currentRevision.id,
        reason,
        createdById: input.actorId
      }
    });
    const updated = await client.projectMaterialRequirement.update({
      where: { id: requirementId },
      data: {
        currentRevisionId: revision.id,
        version: { increment: 1 },
        updatedById: input.actorId
      },
      include: requirementInclude
    });
    await client.projectMaterialRequirementRevision.update({
      where: { id: requirement.currentRevision.id },
      data: { status: "SUPERSEDED" }
    });
    const changeImpact = await detectAndRecordProcurementChangeImpact(client, {
      projectId,
      requirementId,
      previousRevision: requirement.currentRevision,
      nextRevision: revision,
      previousStatus: requirement.currentRevision.status,
      mode: context.settings.mode,
      actorId: input.actorId,
      auditContext: input.auditContext,
      reason
    });
    const value = requirementAuditValue(updated);
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.MATERIAL_REQUIREMENT_REVISED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_MATERIAL_REQUIREMENT,
      objectId: requirementId,
      context: auditContext(input, projectId, context.project.departmentId, reason),
      after: { value, allowedFields: MATERIAL_REQUIREMENT_AUDIT_FIELDS }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "procurement.material-requirement.revised",
      aggregateType: "PROJECT_MATERIAL_REQUIREMENT",
      aggregateId: requirementId,
      idempotencyKey: `${requirementId}:v${updated.version}`,
      payload: { ...value, auditId: audit.id }
    });
    await appendReadinessRecalculationRequest(client, {
      projectId,
      cause: "material-requirement-revised",
      idempotencyKey: `${requirementId}:v${updated.version}`,
      traceId: input.auditContext.traceId
    });
    return {
      requirement: updated,
      changeImpact,
      resourceVersion: updated.version,
      auditId: audit.id,
      outboxEventId: event.id
    };
  });
}

export async function cancelMaterialRequirement(
  input: RequirementVersionCommandInput,
  transaction?: Prisma.TransactionClient
) {
  const projectId = id(input.projectId, "projectId");
  const requirementId = id(input.requirementId, "requirementId");
  const version = positiveVersion(input.version);
  const reason = text(input.reason, "reason", 1024);
  return inTransaction(transaction, async (client) => {
    const context = await loadWriteContext(client, projectId);
    const requirement = await lockRequirement(client, projectId, requirementId);
    if (requirement.version !== version) {
      throw new ProcurementServiceError(
        "VERSION_CONFLICT",
        "物料需求已发生变化，请刷新后重试。",
        409
      );
    }
    if (requirement.status === "CANCELED" || !requirement.currentRevision) {
      throw new ProcurementServiceError(
        "PROC_REQUIREMENT_CANCEL_INVALID",
        "物料需求已经取消或缺少当前修订。",
        409
      );
    }
    await client.projectMaterialRequirementRevision.update({
      where: { id: requirement.currentRevision.id },
      data: { status: "CANCELED", reason }
    });
    const changeImpact = await detectAndRecordProcurementChangeImpact(client, {
      projectId,
      requirementId,
      previousRevision: requirement.currentRevision,
      nextRevision: null,
      previousStatus: requirement.currentRevision.status,
      mode: context.settings.mode,
      actorId: input.actorId,
      auditContext: input.auditContext,
      reason
    });
    const updated = await client.projectMaterialRequirement.update({
      where: { id: requirementId },
      data: { status: "CANCELED", version: { increment: 1 }, updatedById: input.actorId },
      include: requirementInclude
    });
    const value = requirementAuditValue(updated);
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.MATERIAL_REQUIREMENT_CANCELED,
      objectType: AUDIT_OBJECT_TYPES.PROJECT_MATERIAL_REQUIREMENT,
      objectId: requirementId,
      context: auditContext(input, projectId, context.project.departmentId, reason),
      after: { value, allowedFields: MATERIAL_REQUIREMENT_AUDIT_FIELDS }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "procurement.material-requirement.canceled",
      aggregateType: "PROJECT_MATERIAL_REQUIREMENT",
      aggregateId: requirementId,
      idempotencyKey: `${requirementId}:v${updated.version}`,
      payload: { ...value, auditId: audit.id }
    });
    await appendReadinessRecalculationRequest(client, {
      projectId,
      cause: "material-requirement-canceled",
      idempotencyKey: `${requirementId}:v${updated.version}`,
      traceId: input.auditContext.traceId
    });
    return {
      requirement: updated,
      changeImpact,
      resourceVersion: updated.version,
      auditId: audit.id,
      outboxEventId: event.id
    };
  });
}

export async function listMaterialReferences(input: MaterialReferenceQuery) {
  const rows = await db.materialReference.findMany({
    where: { projectId: input.projectId, ...(input.status ? { status: input.status } : {}) },
    orderBy: [{ code: "asc" }, { id: "asc" }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: input.limit + 1
  });
  const materials = rows.slice(0, input.limit);
  return {
    materials,
    nextCursor: rows.length > input.limit ? (materials.at(-1)?.id ?? null) : null
  };
}

export async function listSupplierReferences(input: SupplierReferenceQuery) {
  const rows = await db.supplierReference.findMany({
    where: { projectId: input.projectId, ...(input.status ? { status: input.status } : {}) },
    orderBy: [{ code: "asc" }, { id: "asc" }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: input.limit + 1
  });
  const suppliers = rows.slice(0, input.limit);
  return {
    suppliers,
    nextCursor: rows.length > input.limit ? (suppliers.at(-1)?.id ?? null) : null
  };
}

export async function listProjectMaterialRequirements(input: MaterialRequirementQuery) {
  const rows = await db.projectMaterialRequirement.findMany({
    where: { projectId: input.projectId, ...(input.status ? { status: input.status } : {}) },
    include: requirementInclude,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    take: input.limit + 1
  });
  const requirements = rows.slice(0, input.limit);
  return {
    requirements,
    nextCursor: rows.length > input.limit ? (requirements.at(-1)?.id ?? null) : null
  };
}
