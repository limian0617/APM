import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";

export const TEMPLATE_COMPONENT_TYPES = {
  STAGE: "STAGE",
  GATE: "GATE",
  ROLE: "ROLE",
  WBS: "WBS",
  CAPABILITY_RULE: "CAPABILITY_RULE",
  MILESTONE: "MILESTONE"
} as const;

export type TemplateComponentTypeCode =
  (typeof TEMPLATE_COMPONENT_TYPES)[keyof typeof TEMPLATE_COMPONENT_TYPES];

export const TEMPLATE_MASTER_STATUSES = {
  DRAFT: "DRAFT",
  ACTIVE: "ACTIVE",
  DISABLED: "DISABLED"
} as const;

export type TemplateMasterStatusCode =
  (typeof TEMPLATE_MASTER_STATUSES)[keyof typeof TEMPLATE_MASTER_STATUSES];

export const REQUIRED_TEMPLATE_COMPONENT_TYPES = [
  TEMPLATE_COMPONENT_TYPES.STAGE,
  TEMPLATE_COMPONENT_TYPES.GATE,
  TEMPLATE_COMPONENT_TYPES.ROLE,
  TEMPLATE_COMPONENT_TYPES.WBS
] as const;

export class TemplateValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "TemplateValidationError";
  }
}

export type TemplateComponentContent = JsonValue & Record<string, JsonValue>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TemplateValidationError("INVALID_COMPONENT_RULES", "组件规则必须是对象。");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TemplateValidationError("INCOMPLETE_COMPONENT_RULES", `${field} 至少包含一项。`);
  }
  return value.map((item) => record(item));
}

function stableCode(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_.-]{1,99}$/u.test(value)) {
    throw new TemplateValidationError("INVALID_COMPONENT_RULES", `${field} 必须是稳定代码。`);
  }
  return value;
}

function uniqueCodes(items: Array<Record<string, unknown>>, field: string): Set<string> {
  const codes = items.map((item) => stableCode(item.code, `${field}.code`));
  if (new Set(codes).size !== codes.length) {
    throw new TemplateValidationError("DUPLICATE_RULE_CODE", `${field} 包含重复代码。`);
  }
  return new Set(codes);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowedKeys: string[], field: string) {
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new TemplateValidationError("INVALID_COMPONENT_RULES", `${field} 包含未知字段。`);
  }
}

function trimmedStableCode(value: unknown, field: string): string {
  return stableCode(typeof value === "string" ? value.trim() : value, field);
}

function trimmedText(value: unknown, field: string, minLength: number, maxLength: number): string {
  if (typeof value !== "string") {
    throw new TemplateValidationError("INVALID_COMPONENT_RULES", `${field} 必须是文本。`);
  }
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new TemplateValidationError(
      "INVALID_COMPONENT_RULES",
      `${field} 必须是 ${minLength} 到 ${maxLength} 个字符。`
    );
  }
  return normalized;
}

export function validateTemplateComponentContent(
  componentType: TemplateComponentTypeCode,
  value: unknown
): TemplateComponentContent {
  const content = record(value);
  switch (componentType) {
    case TEMPLATE_COMPONENT_TYPES.STAGE: {
      rejectUnknownKeys(content, ["stages"], "阶段组件");
      const items = array(content.stages, "stages");
      if (items.length > 100) {
        throw new TemplateValidationError("INVALID_COMPONENT_RULES", "阶段最多包含 100 项。");
      }
      const stages = items.map((item) => {
        rejectUnknownKeys(item, ["code", "name", "description", "sequence"], "阶段");
        const code = trimmedStableCode(item.code, "stages.code");
        const name = trimmedText(item.name, "阶段名称", 1, 200);
        const description =
          item.description === undefined
            ? undefined
            : trimmedText(item.description, "阶段描述", 1, 2000);
        const sequence = item.sequence;
        if (
          typeof sequence !== "number" ||
          !Number.isSafeInteger(sequence) ||
          sequence < 0
        ) {
          throw new TemplateValidationError("INVALID_COMPONENT_RULES", "阶段顺序必须是非负安全整数。");
        }
        return description === undefined
          ? { code, name, sequence }
          : { code, name, description, sequence };
      });
      const codes = stages.map(({ code }) => code);
      if (new Set(codes).size !== codes.length) {
        throw new TemplateValidationError("DUPLICATE_RULE_CODE", "stages 包含重复代码。");
      }
      const sequences = stages.map(({ sequence }) => sequence);
      if (new Set(sequences).size !== sequences.length) {
        throw new TemplateValidationError("DUPLICATE_RULE_POSITION", "阶段顺序不能重复。");
      }
      return payloadHash({
        stages: [...stages].sort(
          (left, right) => left.sequence - right.sequence || left.code.localeCompare(right.code)
        )
      }).value as TemplateComponentContent;
    }
    case TEMPLATE_COMPONENT_TYPES.GATE: {
      const items = array(content.gates, "gates");
      uniqueCodes(items, "gates");
      for (const item of items) {
        stableCode(item.stageCode, "gates.stageCode");
        if (!Array.isArray(item.requiredCheckerCodes) || item.requiredCheckerCodes.length === 0) {
          throw new TemplateValidationError(
            "INCOMPLETE_COMPONENT_RULES",
            "Gate 必须配置至少一个检查器。"
          );
        }
        item.requiredCheckerCodes.forEach((code) => stableCode(code, "gates.requiredCheckerCodes"));
      }
      break;
    }
    case TEMPLATE_COMPONENT_TYPES.ROLE: {
      const items = array(content.roles, "roles");
      uniqueCodes(items, "roles");
      if (items.some((item) => typeof item.required !== "boolean")) {
        throw new TemplateValidationError("INCOMPLETE_COMPONENT_RULES", "角色必须明确 required。 ");
      }
      break;
    }
    case TEMPLATE_COMPONENT_TYPES.WBS: {
      const items = array(content.packages, "packages");
      uniqueCodes(items, "packages");
      for (const item of items) {
        stableCode(item.stageCode, "packages.stageCode");
        if (typeof item.weight !== "number" || !Number.isFinite(item.weight) || item.weight <= 0) {
          throw new TemplateValidationError("INVALID_COMPONENT_RULES", "责任包权重必须大于零。");
        }
      }
      break;
    }
    case TEMPLATE_COMPONENT_TYPES.MILESTONE: {
      rejectUnknownKeys(content, ["milestones"], "里程碑组件");
      const items = array(content.milestones, "milestones");
      if (items.length > 1000) {
        throw new TemplateValidationError("INVALID_COMPONENT_RULES", "里程碑最多包含 1000 项。");
      }
      const milestones = items.map((item) => {
        rejectUnknownKeys(item, ["code", "name", "description", "position"], "里程碑");
        const code = trimmedStableCode(item.code, "milestones.code");
        const name = trimmedText(item.name, "里程碑名称", 1, 200);
        const description =
          item.description === undefined
            ? undefined
            : trimmedText(item.description, "里程碑描述", 1, 2000);
        const position = item.position;
        if (
          !Number.isSafeInteger(position) ||
          (position as number) < 0 ||
          (position as number) > 1_000_000
        ) {
          throw new TemplateValidationError(
            "INVALID_COMPONENT_RULES",
            "里程碑位置必须是非负安全整数。"
          );
        }
        return description === undefined
          ? { code, name, position }
          : { code, name, description, position };
      });
      const codes = milestones.map(({ code }) => code);
      if (new Set(codes).size !== codes.length) {
        throw new TemplateValidationError("DUPLICATE_RULE_CODE", "milestones 包含重复代码。");
      }
      const positions = milestones.map(({ position }) => position);
      if (new Set(positions).size !== positions.length) {
        throw new TemplateValidationError("DUPLICATE_RULE_POSITION", "里程碑位置不能重复。");
      }
      return payloadHash({ milestones }).value as TemplateComponentContent;
    }
    case TEMPLATE_COMPONENT_TYPES.CAPABILITY_RULE: {
      const items = array(content.capabilities, "capabilities");
      uniqueCodes(items, "capabilities");
      if (items.some((item) => typeof item.required !== "boolean")) {
        throw new TemplateValidationError(
          "INCOMPLETE_COMPONENT_RULES",
          "能力规则必须明确 required。"
        );
      }
      break;
    }
  }
  return payloadHash(content).value as TemplateComponentContent;
}

export function validateTemplateMilestoneCodesUnique(
  components: ReadonlyArray<{ componentType: TemplateComponentTypeCode; content: unknown }>
) {
  const codes = components.flatMap(({ componentType, content }) => {
    if (componentType !== TEMPLATE_COMPONENT_TYPES.MILESTONE) return [];
    const validated = validateTemplateComponentContent(componentType, content) as {
      milestones: Array<{ code: string }>;
    };
    return validated.milestones.map(({ code }) => code);
  });
  if (new Set(codes).size !== codes.length) {
    throw new TemplateValidationError("DUPLICATE_RULE_CODE", "模板包含重复里程碑代码。");
  }
}

export function componentChecksum(input: {
  componentType: TemplateComponentTypeCode;
  name: string;
  description: string | null;
  content: TemplateComponentContent;
}): string {
  return payloadHash(input).hash;
}

export type TemplateReference = {
  componentVersionId: string;
  componentType: TemplateComponentTypeCode;
  slot: string;
  position: number;
  checksum: string;
};

export function validateTemplateReferences(references: TemplateReference[]): TemplateReference[] {
  const slots = references.map(({ slot }) => slot);
  const positions = references.map(({ position }) => position);
  if (new Set(slots).size !== slots.length) {
    throw new TemplateValidationError("DUPLICATE_TEMPLATE_SLOT", "模板组件位置代码不能重复。");
  }
  if (new Set(positions).size !== positions.length) {
    throw new TemplateValidationError("DUPLICATE_TEMPLATE_POSITION", "模板组件排序位置不能重复。");
  }
  for (const required of REQUIRED_TEMPLATE_COMPONENT_TYPES) {
    if (!references.some(({ componentType }) => componentType === required)) {
      throw new TemplateValidationError("INCOMPLETE_TEMPLATE", `模板缺少 ${required} 组件。`);
    }
  }
  return [...references].sort(
    (left, right) => left.position - right.position || left.slot.localeCompare(right.slot)
  );
}

export function templateChecksum(input: {
  name: string;
  description: string | null;
  references: TemplateReference[];
}): string {
  return payloadHash({
    name: input.name,
    description: input.description,
    references: validateTemplateReferences(input.references)
  }).hash;
}
