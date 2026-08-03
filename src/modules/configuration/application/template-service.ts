import { Prisma } from "@prisma/client";

import { inTransaction } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  TEMPLATE_AUDIT_FIELDS
} from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import {
  componentChecksum,
  TEMPLATE_COMPONENT_TYPES,
  TEMPLATE_MASTER_STATUSES,
  templateChecksum,
  TemplateValidationError,
  type TemplateComponentContent,
  type TemplateComponentTypeCode,
  type TemplateReference,
  validateTemplateComponentContent,
  validateTemplateMilestoneCodesUnique,
  validateTemplateReferences
} from "../domain/template-policy";

type TemplateReferenceInput = Omit<TemplateReference, "checksum">;

function expectedVersion(value: unknown, allowZero = false): number {
  if (!Number.isInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    throw new TemplateValidationError("INVALID_VERSION", "版本号无效。", 400);
  }
  return value as number;
}

function identityCode(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_.-]{2,100}$/u.test(value.trim())) {
    throw new TemplateValidationError("INVALID_CODE", `${label}代码无效。`);
  }
  return value.trim();
}

function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) {
    throw new TemplateValidationError("INVALID_NAME", "名称必须是 1 到 200 个字符。");
  }
  return value.trim();
}

function description(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > 2000) {
    throw new TemplateValidationError("INVALID_DESCRIPTION", "说明不能超过 2000 个字符。");
  }
  return value.trim() || null;
}

function reason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1024) {
    throw new TemplateValidationError("REASON_REQUIRED", "变更原因必须是 1 到 1024 个字符。");
  }
  return value.trim();
}

function componentAudit(component: {
  id: string;
  code: string;
  componentType: string;
  name: string;
  status: string;
  currentVersion: number;
  version: number;
}) {
  return {
    componentId: component.id,
    componentCode: component.code,
    componentType: component.componentType,
    name: component.name,
    status: component.status,
    componentVersion: component.currentVersion,
    version: component.version
  };
}

function templateAudit(
  template: {
    id: string;
    code: string;
    name: string;
    status: string;
    currentVersion: number;
    version: number;
  },
  referenceCount?: number
) {
  return {
    templateId: template.id,
    templateCode: template.code,
    name: template.name,
    status: template.status,
    templateVersion: template.currentVersion,
    version: template.version,
    ...(referenceCount === undefined ? {} : { referenceCount })
  };
}

export async function saveTemplateComponentDraft(
  input: {
    code: string;
    componentType: TemplateComponentTypeCode;
    name: string;
    description?: string | null;
    content: unknown;
    version: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const code = identityCode(input.code, "组件");
  const componentName = name(input.name);
  const componentDescription = description(input.description);
  const content = validateTemplateComponentContent(input.componentType, input.content);
  const version = expectedVersion(input.version, true);
  const changeReason = reason(input.reason);

  return inTransaction(transaction, async (client) => {
    const current = await client.templateComponent.findUnique({ where: { code } });
    let component;
    if (!current) {
      if (version !== 0) {
        throw new TemplateValidationError(
          "VERSION_CONFLICT",
          "模板组件已变化或尚不存在，请刷新后重试。",
          409
        );
      }
      component = await client.templateComponent.create({
        data: {
          code,
          componentType: input.componentType,
          name: componentName,
          description: componentDescription,
          draftContent: content as Prisma.InputJsonValue,
          createdById: input.actorId,
          updatedById: input.actorId
        }
      });
    } else {
      if (current.version !== version) {
        throw new TemplateValidationError(
          "VERSION_CONFLICT",
          "模板组件已变化，请刷新后重试。",
          409
        );
      }
      if (current.componentType !== input.componentType) {
        throw new TemplateValidationError(
          "COMPONENT_TYPE_IMMUTABLE",
          "组件类型创建后不可变更。",
          409
        );
      }
      const updated = await client.templateComponent.updateMany({
        where: { id: current.id, version },
        data: {
          name: componentName,
          description: componentDescription,
          draftContent: content as Prisma.InputJsonValue,
          updatedById: input.actorId,
          version: { increment: 1 }
        }
      });
      if (updated.count !== 1) {
        throw new TemplateValidationError("VERSION_CONFLICT", "模板组件已变化。", 409);
      }
      component = await client.templateComponent.findUniqueOrThrow({ where: { id: current.id } });
    }

    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.TEMPLATE_COMPONENT_DRAFT_SAVED,
      objectType: AUDIT_OBJECT_TYPES.TEMPLATE_COMPONENT,
      objectId: component.id,
      context: { ...input.auditContext, actorId: input.actorId, reason: changeReason },
      ...(current
        ? {
            before: { value: componentAudit(current), allowedFields: TEMPLATE_AUDIT_FIELDS }
          }
        : {}),
      after: { value: componentAudit(component), allowedFields: TEMPLATE_AUDIT_FIELDS }
    });
    return { component, auditId: audit.id };
  });
}

export async function publishTemplateComponent(
  input: {
    code: string;
    version: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const code = identityCode(input.code, "组件");
  const version = expectedVersion(input.version);
  const changeReason = reason(input.reason);

  return inTransaction(transaction, async (client) => {
    const current = await client.templateComponent.findUnique({ where: { code } });
    if (!current) {
      throw new TemplateValidationError("COMPONENT_NOT_FOUND", "模板组件不存在。", 404);
    }
    if (current.version !== version) {
      throw new TemplateValidationError("VERSION_CONFLICT", "模板组件已变化。", 409);
    }
    const content = validateTemplateComponentContent(
      current.componentType as TemplateComponentTypeCode,
      current.draftContent
    );
    const checksum = componentChecksum({
      componentType: current.componentType as TemplateComponentTypeCode,
      name: current.name,
      description: current.description,
      content
    });
    const nextVersion = current.currentVersion + 1;
    const updated = await client.templateComponent.updateMany({
      where: { id: current.id, version },
      data: {
        currentVersion: nextVersion,
        status: TEMPLATE_MASTER_STATUSES.ACTIVE,
        updatedById: input.actorId,
        version: { increment: 1 }
      }
    });
    if (updated.count !== 1) {
      throw new TemplateValidationError("VERSION_CONFLICT", "模板组件已变化。", 409);
    }
    const published = await client.templateComponentVersion.create({
      data: {
        componentId: current.id,
        version: nextVersion,
        componentType: current.componentType,
        name: current.name,
        description: current.description,
        contentJson: content as Prisma.InputJsonValue,
        checksum,
        publishedById: input.actorId
      }
    });
    const component = await client.templateComponent.findUniqueOrThrow({
      where: { id: current.id }
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.TEMPLATE_COMPONENT_PUBLISHED,
      objectType: AUDIT_OBJECT_TYPES.TEMPLATE_COMPONENT,
      objectId: current.id,
      context: { ...input.auditContext, actorId: input.actorId, reason: changeReason },
      after: {
        value: {
          ...componentAudit(component),
          componentVersionId: published.id,
          checksum
        },
        allowedFields: TEMPLATE_AUDIT_FIELDS
      }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "configuration.template-component.published",
      aggregateType: "TEMPLATE_COMPONENT",
      aggregateId: current.id,
      idempotencyKey: `${current.id}:v${nextVersion}`,
      payload: {
        componentId: current.id,
        componentVersionId: published.id,
        componentType: current.componentType,
        version: nextVersion,
        checksum
      }
    });
    return { component, publishedVersion: published, auditId: audit.id, outboxEventId: event.id };
  });
}

export async function setTemplateComponentEnabled(
  input: {
    code: string;
    version: number;
    enabled: boolean;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const code = identityCode(input.code, "组件");
  const version = expectedVersion(input.version);
  const changeReason = reason(input.reason);
  const status = input.enabled
    ? TEMPLATE_MASTER_STATUSES.ACTIVE
    : TEMPLATE_MASTER_STATUSES.DISABLED;

  return inTransaction(transaction, async (client) => {
    const current = await client.templateComponent.findUnique({ where: { code } });
    if (!current) throw new TemplateValidationError("COMPONENT_NOT_FOUND", "模板组件不存在。", 404);
    if (current.version !== version) {
      throw new TemplateValidationError("VERSION_CONFLICT", "模板组件已变化。", 409);
    }
    if (current.currentVersion === 0) {
      throw new TemplateValidationError(
        "COMPONENT_NOT_PUBLISHED",
        "未发布组件不能变更启停状态。",
        409
      );
    }
    if (current.status === status) return { component: current, repeated: true, auditId: null };
    const updated = await client.templateComponent.updateMany({
      where: { id: current.id, version },
      data: { status, updatedById: input.actorId, version: { increment: 1 } }
    });
    if (updated.count !== 1)
      throw new TemplateValidationError("VERSION_CONFLICT", "模板组件已变化。", 409);
    const component = await client.templateComponent.findUniqueOrThrow({
      where: { id: current.id }
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.TEMPLATE_COMPONENT_STATUS_CHANGED,
      objectType: AUDIT_OBJECT_TYPES.TEMPLATE_COMPONENT,
      objectId: current.id,
      context: { ...input.auditContext, actorId: input.actorId, reason: changeReason },
      before: { value: componentAudit(current), allowedFields: TEMPLATE_AUDIT_FIELDS },
      after: { value: componentAudit(component), allowedFields: TEMPLATE_AUDIT_FIELDS }
    });
    return { component, repeated: false, auditId: audit.id };
  });
}

async function resolvedReferences(
  client: Prisma.TransactionClient,
  references: TemplateReferenceInput[]
) {
  const slots = references.map(({ slot }) => slot);
  const positions = references.map(({ position }) => position);
  if (new Set(slots).size !== slots.length) {
    throw new TemplateValidationError("DUPLICATE_TEMPLATE_SLOT", "模板组件位置代码不能重复。");
  }
  if (new Set(positions).size !== positions.length) {
    throw new TemplateValidationError("DUPLICATE_TEMPLATE_POSITION", "模板组件排序位置不能重复。");
  }
  const ids = [...new Set(references.map(({ componentVersionId }) => componentVersionId))];
  const versions = await client.templateComponentVersion.findMany({
    where: { id: { in: ids } },
    include: { component: true }
  });
  if (versions.length !== ids.length) {
    throw new TemplateValidationError(
      "COMPONENT_VERSION_NOT_FOUND",
      "模板引用了不存在或未发布的组件版本。",
      422
    );
  }
  const byId = new Map(versions.map((version) => [version.id, version]));
  return references.map((reference) => {
    const version = byId.get(reference.componentVersionId)!;
    if (version.componentType !== reference.componentType) {
      throw new TemplateValidationError(
        "COMPONENT_TYPE_MISMATCH",
        `位置 ${reference.slot} 的组件类型与发布版本不一致。`
      );
    }
    return { ...reference, checksum: version.checksum, version };
  });
}

export async function saveProjectTemplateDraft(
  input: {
    code: string;
    name: string;
    description?: string | null;
    components: TemplateReferenceInput[];
    version: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const code = identityCode(input.code, "模板");
  const templateName = name(input.name);
  const templateDescription = description(input.description);
  const version = expectedVersion(input.version, true);
  const changeReason = reason(input.reason);

  return inTransaction(transaction, async (client) => {
    const references = await resolvedReferences(client, input.components);
    const current = await client.projectTemplate.findUnique({ where: { code } });
    let template;
    if (!current) {
      if (version !== 0) {
        throw new TemplateValidationError(
          "VERSION_CONFLICT",
          "模板已变化或尚不存在，请刷新后重试。",
          409
        );
      }
      template = await client.projectTemplate.create({
        data: {
          code,
          name: templateName,
          description: templateDescription,
          createdById: input.actorId,
          updatedById: input.actorId
        }
      });
    } else {
      if (current.version !== version) {
        throw new TemplateValidationError("VERSION_CONFLICT", "模板已变化，请刷新后重试。", 409);
      }
      const updated = await client.projectTemplate.updateMany({
        where: { id: current.id, version },
        data: {
          name: templateName,
          description: templateDescription,
          updatedById: input.actorId,
          version: { increment: 1 }
        }
      });
      if (updated.count !== 1)
        throw new TemplateValidationError("VERSION_CONFLICT", "模板已变化。", 409);
      template = await client.projectTemplate.findUniqueOrThrow({ where: { id: current.id } });
      await client.templateDraftComponent.deleteMany({ where: { templateId: current.id } });
    }
    await client.templateDraftComponent.createMany({
      data: references.map((reference) => ({
        templateId: template.id,
        componentVersionId: reference.componentVersionId,
        componentType: reference.componentType,
        slot: reference.slot,
        position: reference.position
      }))
    });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.TEMPLATE_DRAFT_SAVED,
      objectType: AUDIT_OBJECT_TYPES.TEMPLATE,
      objectId: template.id,
      context: { ...input.auditContext, actorId: input.actorId, reason: changeReason },
      ...(current
        ? { before: { value: templateAudit(current), allowedFields: TEMPLATE_AUDIT_FIELDS } }
        : {}),
      after: {
        value: templateAudit(template, references.length),
        allowedFields: TEMPLATE_AUDIT_FIELDS
      }
    });
    return { template, referenceCount: references.length, auditId: audit.id };
  });
}

function collectRuleCodes(value: unknown, field: string): string[] {
  const content = value as Record<string, Array<{ code: string; stageCode?: string }>>;
  return (content[field] ?? []).map(({ code }) => code);
}

function validateCrossComponentRules(
  references: Array<{
    componentType: string;
    version: { contentJson: unknown; component: { status: string } };
  }>
) {
  if (
    references.some(({ version }) => version.component.status !== TEMPLATE_MASTER_STATUSES.ACTIVE)
  ) {
    throw new TemplateValidationError(
      "COMPONENT_DISABLED",
      "模板不能发布对已停用组件的新增引用。",
      409
    );
  }
  const contents = references.map((reference) => ({
    componentType: reference.componentType as TemplateComponentTypeCode,
    content: validateTemplateComponentContent(
      reference.componentType as TemplateComponentTypeCode,
      reference.version.contentJson
    )
  }));
  const stageCodes = contents.flatMap(({ componentType, content }) =>
    componentType === TEMPLATE_COMPONENT_TYPES.STAGE ? collectRuleCodes(content, "stages") : []
  );
  if (new Set(stageCodes).size !== stageCodes.length) {
    throw new TemplateValidationError("DUPLICATE_RULE_CODE", "模板包含重复阶段代码。");
  }
  const stageCodeSet = new Set(stageCodes);
  for (const { componentType, content } of contents) {
    if (
      componentType !== TEMPLATE_COMPONENT_TYPES.GATE &&
      componentType !== TEMPLATE_COMPONENT_TYPES.WBS
    )
      continue;
    const field = componentType === TEMPLATE_COMPONENT_TYPES.GATE ? "gates" : "packages";
    const rules = (content as Record<string, Array<{ stageCode: string }>>)[field] ?? [];
    if (rules.some(({ stageCode }) => !stageCodeSet.has(stageCode))) {
      throw new TemplateValidationError(
        "UNKNOWN_STAGE_REFERENCE",
        `${componentType} 规则引用了模板中不存在的阶段。`
      );
    }
  }
}

export async function publishProjectTemplate(
  input: {
    code: string;
    version: number;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const code = identityCode(input.code, "模板");
  const version = expectedVersion(input.version);
  const changeReason = reason(input.reason);

  return inTransaction(transaction, async (client) => {
    const current = await client.projectTemplate.findUnique({
      where: { code },
      include: {
        draftComponents: {
          include: { componentVersion: { include: { component: true } } },
          orderBy: [{ position: "asc" }, { slot: "asc" }]
        }
      }
    });
    if (!current) throw new TemplateValidationError("TEMPLATE_NOT_FOUND", "模板不存在。", 404);
    if (current.version !== version) {
      throw new TemplateValidationError("VERSION_CONFLICT", "模板已变化。", 409);
    }
    const references = validateTemplateReferences(
      current.draftComponents.map((reference) => ({
        componentVersionId: reference.componentVersionId,
        componentType: reference.componentType as TemplateComponentTypeCode,
        slot: reference.slot,
        position: reference.position,
        checksum: reference.componentVersion.checksum
      }))
    );
    validateCrossComponentRules(
      current.draftComponents.map((reference) => ({
        componentType: reference.componentType,
        version: reference.componentVersion
      }))
    );
    validateTemplateMilestoneCodesUnique(
      current.draftComponents.map((reference) => ({
        componentType: reference.componentType as TemplateComponentTypeCode,
        content: reference.componentVersion.contentJson
      }))
    );
    const checksum = templateChecksum({
      name: current.name,
      description: current.description,
      references
    });
    const nextVersion = current.currentVersion + 1;
    const updated = await client.projectTemplate.updateMany({
      where: { id: current.id, version },
      data: {
        currentVersion: nextVersion,
        status: TEMPLATE_MASTER_STATUSES.ACTIVE,
        updatedById: input.actorId,
        version: { increment: 1 }
      }
    });
    if (updated.count !== 1)
      throw new TemplateValidationError("VERSION_CONFLICT", "模板已变化。", 409);
    const published = await client.projectTemplateVersion.create({
      data: {
        templateId: current.id,
        version: nextVersion,
        name: current.name,
        description: current.description,
        checksum,
        publishedById: input.actorId,
        components: {
          create: references.map((reference) => ({
            componentVersionId: reference.componentVersionId,
            componentType: reference.componentType,
            slot: reference.slot,
            position: reference.position
          }))
        }
      },
      include: { components: { orderBy: [{ position: "asc" }, { slot: "asc" }] } }
    });
    const template = await client.projectTemplate.findUniqueOrThrow({ where: { id: current.id } });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.TEMPLATE_PUBLISHED,
      objectType: AUDIT_OBJECT_TYPES.TEMPLATE_VERSION,
      objectId: published.id,
      context: { ...input.auditContext, actorId: input.actorId, reason: changeReason },
      after: {
        value: {
          ...templateAudit(template, references.length),
          templateVersionId: published.id,
          checksum
        },
        allowedFields: TEMPLATE_AUDIT_FIELDS
      }
    });
    const event = await appendOutboxEvent(client, {
      eventType: "configuration.template.published",
      aggregateType: "TEMPLATE_VERSION",
      aggregateId: published.id,
      idempotencyKey: `${current.id}:v${nextVersion}`,
      payload: {
        templateId: current.id,
        templateVersionId: published.id,
        version: nextVersion,
        checksum,
        referenceCount: references.length
      }
    });
    return { template, publishedVersion: published, auditId: audit.id, outboxEventId: event.id };
  });
}

export async function setProjectTemplateEnabled(
  input: {
    code: string;
    version: number;
    enabled: boolean;
    reason: string;
    actorId: string;
    auditContext: AuditContext;
  },
  transaction?: Prisma.TransactionClient
) {
  const code = identityCode(input.code, "模板");
  const version = expectedVersion(input.version);
  const changeReason = reason(input.reason);
  const status = input.enabled
    ? TEMPLATE_MASTER_STATUSES.ACTIVE
    : TEMPLATE_MASTER_STATUSES.DISABLED;
  return inTransaction(transaction, async (client) => {
    const current = await client.projectTemplate.findUnique({ where: { code } });
    if (!current) throw new TemplateValidationError("TEMPLATE_NOT_FOUND", "模板不存在。", 404);
    if (current.version !== version) {
      throw new TemplateValidationError("VERSION_CONFLICT", "模板已变化。", 409);
    }
    if (current.currentVersion === 0) {
      throw new TemplateValidationError(
        "TEMPLATE_NOT_PUBLISHED",
        "未发布模板不能变更启停状态。",
        409
      );
    }
    if (current.status === status) return { template: current, repeated: true, auditId: null };
    const updated = await client.projectTemplate.updateMany({
      where: { id: current.id, version },
      data: { status, updatedById: input.actorId, version: { increment: 1 } }
    });
    if (updated.count !== 1)
      throw new TemplateValidationError("VERSION_CONFLICT", "模板已变化。", 409);
    const template = await client.projectTemplate.findUniqueOrThrow({ where: { id: current.id } });
    const audit = await writeAudit(client, {
      action: AUDIT_ACTIONS.TEMPLATE_STATUS_CHANGED,
      objectType: AUDIT_OBJECT_TYPES.TEMPLATE,
      objectId: current.id,
      context: { ...input.auditContext, actorId: input.actorId, reason: changeReason },
      before: { value: templateAudit(current), allowedFields: TEMPLATE_AUDIT_FIELDS },
      after: { value: templateAudit(template), allowedFields: TEMPLATE_AUDIT_FIELDS }
    });
    return { template, repeated: false, auditId: audit.id };
  });
}

type VersionReferenceView = {
  componentVersionId: string;
  componentType: string;
  slot: string;
  position: number;
  checksum: string;
};

export async function compareProjectTemplateVersions(input: {
  code: string;
  fromVersion: number;
  toVersion: number;
}) {
  const code = identityCode(input.code, "模板");
  const fromVersion = expectedVersion(input.fromVersion);
  const toVersion = expectedVersion(input.toVersion);
  const template = await inTransaction(undefined, (client) =>
    client.projectTemplate.findUnique({ where: { code }, select: { id: true, code: true } })
  );
  if (!template) throw new TemplateValidationError("TEMPLATE_NOT_FOUND", "模板不存在。", 404);
  const versions = await inTransaction(undefined, (client) =>
    client.projectTemplateVersion.findMany({
      where: { templateId: template.id, version: { in: [fromVersion, toVersion] } },
      include: {
        components: {
          include: { componentVersion: { select: { checksum: true } } },
          orderBy: [{ position: "asc" }, { slot: "asc" }]
        }
      }
    })
  );
  const from = versions.find(({ version }) => version === fromVersion);
  const to = versions.find(({ version }) => version === toVersion);
  if (!from || !to) {
    throw new TemplateValidationError("TEMPLATE_VERSION_NOT_FOUND", "模板版本不存在。", 404);
  }
  const view = (version: typeof from): VersionReferenceView[] =>
    version.components.map((reference) => ({
      componentVersionId: reference.componentVersionId,
      componentType: reference.componentType,
      slot: reference.slot,
      position: reference.position,
      checksum: reference.componentVersion.checksum
    }));
  const fromReferences = view(from);
  const toReferences = view(to);
  const fromBySlot = new Map(fromReferences.map((reference) => [reference.slot, reference]));
  const toBySlot = new Map(toReferences.map((reference) => [reference.slot, reference]));
  const added = toReferences.filter(({ slot }) => !fromBySlot.has(slot));
  const removed = fromReferences.filter(({ slot }) => !toBySlot.has(slot));
  const changed = fromReferences.flatMap((before) => {
    const after = toBySlot.get(before.slot);
    return after && JSON.stringify(before) !== JSON.stringify(after)
      ? [{ slot: before.slot, before, after }]
      : [];
  });
  const metadata = [
    ...(from.name === to.name ? [] : [{ field: "name", from: from.name, to: to.name }]),
    ...(from.description === to.description
      ? []
      : [{ field: "description", from: from.description, to: to.description }])
  ];
  return {
    templateCode: template.code,
    from: { version: from.version, checksum: from.checksum },
    to: { version: to.version, checksum: to.checksum },
    metadata,
    components: { added, removed, changed }
  };
}
