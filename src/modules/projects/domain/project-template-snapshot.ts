import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";
import {
  componentChecksum,
  templateChecksum,
  type TemplateComponentContent,
  type TemplateComponentTypeCode,
  validateTemplateComponentContent
} from "@/modules/configuration/domain/template-policy";

export class ProjectCreationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "ProjectCreationError";
  }
}

export type SourceSnapshotComponent = {
  sourceComponentVersionId: string;
  componentCode: string;
  componentType: TemplateComponentTypeCode;
  componentName: string;
  componentVersion: number;
  description: string | null;
  content: TemplateComponentContent;
  sourceChecksum: string;
  slot: string;
  position: number;
};

export type ProjectTemplateSnapshotData = {
  sourceTemplateVersionId: string;
  sourceTemplateChecksum: string;
  snapshotChecksum: string;
  templateCode: string;
  templateName: string;
  templateVersion: number;
  templatePublishedAt: Date;
  components: SourceSnapshotComponent[];
};

export type ProjectStageDefinition = {
  sourceSnapshotComponentId: string;
  code: string;
  name: string;
  description?: string;
  sequence: number;
};

export function extractProjectStageDefinitions(input: {
  id: string;
  componentType: string;
  contentJson: unknown;
}): ProjectStageDefinition[] {
  if (input.componentType !== "STAGE") return [];
  const content = validateTemplateComponentContent("STAGE", input.contentJson) as {
    stages: Array<{ code: string; name: string; description?: string; sequence: number }>;
  };
  return content.stages.map((stage) => ({
    sourceSnapshotComponentId: input.id,
    code: stage.code,
    name: stage.name,
    ...(stage.description === undefined ? {} : { description: stage.description }),
    sequence: stage.sequence
  }));
}

export function validateProjectIdentity(input: {
  code: unknown;
  name: unknown;
  departmentId?: unknown;
}) {
  const code = typeof input.code === "string" ? input.code.trim() : "";
  const projectName = typeof input.name === "string" ? input.name.trim() : "";
  const departmentId =
    input.departmentId === undefined || input.departmentId === null || input.departmentId === ""
      ? null
      : typeof input.departmentId === "string"
        ? input.departmentId.trim()
        : undefined;
  if (!/^[A-Z][A-Z0-9_.-]{2,100}$/u.test(code)) {
    throw new ProjectCreationError("INVALID_PROJECT_CODE", "项目号必须是稳定的大写代码。", 422);
  }
  if (!projectName || projectName.length > 200) {
    throw new ProjectCreationError("INVALID_PROJECT_NAME", "项目名称必须是 1 到 200 个字符。", 422);
  }
  if (departmentId === undefined || (departmentId !== null && departmentId.length > 191)) {
    throw new ProjectCreationError("INVALID_DEPARTMENT", "部门标识格式无效。", 422);
  }
  return { code, name: projectName, departmentId: departmentId || null };
}

export function buildProjectTemplateSnapshot(input: {
  sourceTemplateVersionId: string;
  suppliedTemplateChecksum: string;
  storedTemplateChecksum: string;
  templateCode: string;
  templateName: string;
  templateDescription: string | null;
  templateVersion: number;
  templatePublishedAt: Date;
  components: SourceSnapshotComponent[];
}): ProjectTemplateSnapshotData {
  if (input.suppliedTemplateChecksum !== input.storedTemplateChecksum) {
    throw new ProjectCreationError(
      "TEMPLATE_CHECKSUM_MISMATCH",
      "模板校验和与所选版本不一致，请刷新后重试。",
      409
    );
  }
  const components = [...input.components].sort(
    (left, right) => left.position - right.position || left.slot.localeCompare(right.slot)
  );
  for (const component of components) {
    const checksum = componentChecksum({
      componentType: component.componentType,
      name: component.componentName,
      description: component.description,
      content: component.content
    });
    if (checksum !== component.sourceChecksum) {
      throw new ProjectCreationError(
        "SOURCE_COMPONENT_CHECKSUM_MISMATCH",
        `组件 ${component.slot} 的发布内容校验失败。`,
        409
      );
    }
  }
  const calculatedTemplateChecksum = templateChecksum({
    name: input.templateName,
    description: input.templateDescription,
    references: components.map((component) => ({
      componentVersionId: component.sourceComponentVersionId,
      componentType: component.componentType,
      slot: component.slot,
      position: component.position,
      checksum: component.sourceChecksum
    }))
  });
  if (calculatedTemplateChecksum !== input.storedTemplateChecksum) {
    throw new ProjectCreationError(
      "SOURCE_TEMPLATE_CHECKSUM_MISMATCH",
      "模板发布内容无法通过校验。",
      409
    );
  }
  const canonicalComponents = payloadHash(components).value as JsonValue;
  const snapshotChecksum = payloadHash({
    sourceTemplateVersionId: input.sourceTemplateVersionId,
    sourceTemplateChecksum: input.storedTemplateChecksum,
    templateCode: input.templateCode,
    templateName: input.templateName,
    templateVersion: input.templateVersion,
    templatePublishedAt: input.templatePublishedAt.toISOString(),
    components: canonicalComponents
  }).hash;
  return {
    sourceTemplateVersionId: input.sourceTemplateVersionId,
    sourceTemplateChecksum: input.storedTemplateChecksum,
    snapshotChecksum,
    templateCode: input.templateCode,
    templateName: input.templateName,
    templateVersion: input.templateVersion,
    templatePublishedAt: input.templatePublishedAt,
    components: components.map((component) => ({
      ...component,
      content: payloadHash(component.content).value as TemplateComponentContent
    }))
  };
}
