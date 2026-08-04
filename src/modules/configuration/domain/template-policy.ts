import { PROJECT_ROLE_VALUES, type ProjectRoleCode } from "@/lib/auth/permissions";
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

export const GATE_SCOPES = ["PROJECT", "DELIVERY_UNIT", "MODULE"] as const;

export type GateScope = (typeof GATE_SCOPES)[number];

export type GateCheckerBinding = {
  code: string;
  version: number;
};

export type GateApprovalRule = {
  mode: "ALL" | "ANY";
  projectRoles: ProjectRoleCode[];
};

export type GateDefinitionRule = {
  code: string;
  name: string;
  stageCode: string;
  scope: GateScope;
  definitionJson: JsonValue;
  checkerBindings: GateCheckerBinding[];
  approval?: GateApprovalRule;
  bindingFormat: "LEGACY" | "EXPLICIT";
};

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

function gateName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
    throw new TemplateValidationError(
      "INVALID_COMPONENT_RULES",
      "Gate 名称必须是 1 到 200 个字符。"
    );
  }
  return value;
}

function checkerBindings(value: unknown, field: string): GateCheckerBinding[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TemplateValidationError(
      "INCOMPLETE_COMPONENT_RULES",
      "Gate 必须配置至少一个检查器。"
    );
  }
  const bindings = value.map((item) => {
    const binding = record(item);
    rejectUnknownKeys(binding, ["code", "version"], field);
    const code = stableCode(binding.code, `${field}.code`);
    const version = binding.version;
    if (!Number.isSafeInteger(version) || (version as number) <= 0) {
      throw new TemplateValidationError(
        "INVALID_COMPONENT_RULES",
        `${field}.version 必须是正安全整数。`
      );
    }
    return { code, version: version as number };
  });
  const keys = bindings.map(({ code, version }) => `${code}@${version}`);
  if (new Set(keys).size !== keys.length) {
    throw new TemplateValidationError("DUPLICATE_RULE_CODE", "Gate 包含重复检查器绑定。");
  }
  return bindings;
}

function gateApproval(value: unknown, field: string): GateApprovalRule {
  const approval = record(value);
  rejectUnknownKeys(approval, ["mode", "projectRoles"], field);
  if (approval.mode !== "ALL" && approval.mode !== "ANY") {
    throw new TemplateValidationError(
      "INVALID_COMPONENT_RULES",
      `${field}.mode 必须是 ALL 或 ANY。`
    );
  }
  if (!Array.isArray(approval.projectRoles) || approval.projectRoles.length === 0) {
    throw new TemplateValidationError(
      "INCOMPLETE_COMPONENT_RULES",
      `${field}.projectRoles 必须至少包含一个项目角色。`
    );
  }
  if (approval.projectRoles.length > PROJECT_ROLE_VALUES.length) {
    throw new TemplateValidationError(
      "INVALID_COMPONENT_RULES",
      `${field}.projectRoles 超过项目角色上限。`
    );
  }
  const projectRoles = approval.projectRoles.map((projectRole, index) => {
    if (
      typeof projectRole !== "string" ||
      !PROJECT_ROLE_VALUES.includes(projectRole as ProjectRoleCode)
    ) {
      throw new TemplateValidationError(
        "INVALID_COMPONENT_RULES",
        `${field}.projectRoles.${index} 不是有效项目角色。`
      );
    }
    return projectRole as ProjectRoleCode;
  });
  if (new Set(projectRoles).size !== projectRoles.length) {
    throw new TemplateValidationError(
      "DUPLICATE_RULE_CODE",
      `${field}.projectRoles 包含重复项目角色。`
    );
  }
  return { mode: approval.mode, projectRoles };
}

function legacyCheckerBindings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TemplateValidationError(
      "INCOMPLETE_COMPONENT_RULES",
      "Gate 必须配置至少一个检查器。"
    );
  }
  const codes = value.map((code) => stableCode(code, "gates.requiredCheckerCodes"));
  if (new Set(codes).size !== codes.length) {
    throw new TemplateValidationError("DUPLICATE_RULE_CODE", "Gate 包含重复检查器代码。");
  }
  return codes;
}

function validateGateRules(content: Record<string, unknown>) {
  rejectUnknownKeys(content, ["gates"], "Gate 组件");
  const items = array(content.gates, "gates");
  if (items.length > 100) {
    throw new TemplateValidationError("INVALID_COMPONENT_RULES", "Gate 最多包含 100 项。");
  }
  uniqueCodes(items, "gates");
  for (const item of items) {
    rejectUnknownKeys(
      item,
      ["code", "name", "stageCode", "scope", "requiredCheckerCodes", "checkers", "approval"],
      "Gate"
    );
    stableCode(item.code, "gates.code");
    gateName(item.name);
    stableCode(item.stageCode, "gates.stageCode");

    const hasLegacyBindings = Object.hasOwn(item, "requiredCheckerCodes");
    const hasExplicitBindings = Object.hasOwn(item, "checkers");
    if (hasLegacyBindings && hasExplicitBindings) {
      throw new TemplateValidationError(
        "INVALID_COMPONENT_RULES",
        "Gate 不能同时配置旧检查器代码和版本化检查器绑定。"
      );
    }
    if (!hasLegacyBindings && !hasExplicitBindings) {
      throw new TemplateValidationError(
        "INCOMPLETE_COMPONENT_RULES",
        "Gate 必须配置至少一个检查器。"
      );
    }
    if (hasLegacyBindings) {
      rejectUnknownKeys(
        item,
        ["code", "name", "stageCode", "requiredCheckerCodes", "approval"],
        "Gate"
      );
      legacyCheckerBindings(item.requiredCheckerCodes);
      if (item.approval !== undefined) gateApproval(item.approval, "Gate.approval");
      continue;
    }

    rejectUnknownKeys(item, ["code", "name", "stageCode", "scope", "checkers", "approval"], "Gate");
    if (
      item.scope !== undefined &&
      (typeof item.scope !== "string" || !GATE_SCOPES.includes(item.scope as GateScope))
    ) {
      throw new TemplateValidationError("INVALID_COMPONENT_RULES", "Gate 范围无效。");
    }
    checkerBindings(item.checkers, "gates.checkers");
    if (item.approval !== undefined) gateApproval(item.approval, "Gate.approval");
  }
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
      if (items.length > 9) {
        throw new TemplateValidationError(
          "INVALID_COMPONENT_RULES",
          "阶段最多包含 S0 至 S8 九项。"
        );
      }
      const stages = items.map((item) => {
        rejectUnknownKeys(item, ["code", "name", "description", "sequence"], "阶段");
        const code = trimmedStableCode(item.code, "stages.code");
        const stageCode = /^S([0-8])$/u.exec(code);
        if (!stageCode) {
          throw new TemplateValidationError("INVALID_COMPONENT_RULES", "阶段代码必须是 S0 至 S8。");
        }
        const name = trimmedText(item.name, "阶段名称", 1, 200);
        const description =
          item.description === undefined
            ? undefined
            : trimmedText(item.description, "阶段描述", 1, 2000);
        const sequence = item.sequence;
        if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
          throw new TemplateValidationError(
            "INVALID_COMPONENT_RULES",
            "阶段顺序必须是非负安全整数。"
          );
        }
        if (sequence !== Number(stageCode[1])) {
          throw new TemplateValidationError(
            "INVALID_COMPONENT_RULES",
            "阶段顺序必须与阶段代码中的序号一致。"
          );
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
      validateGateRules(content);
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

export function parseGateDefinitionRules(value: unknown): GateDefinitionRule[] {
  const validated = validateTemplateComponentContent(
    TEMPLATE_COMPONENT_TYPES.GATE,
    value
  ) as unknown as {
    gates: Array<{
      code: string;
      name: string;
      stageCode: string;
      scope?: GateScope;
      requiredCheckerCodes?: string[];
      checkers?: GateCheckerBinding[];
      approval?: GateApprovalRule;
    }>;
  };
  return validated.gates.map((gate) => {
    if (gate.requiredCheckerCodes !== undefined) {
      return {
        code: gate.code,
        name: gate.name,
        stageCode: gate.stageCode,
        scope: "PROJECT",
        definitionJson: gate as JsonValue,
        checkerBindings: gate.requiredCheckerCodes.map((code) => ({ code, version: 1 })),
        ...(gate.approval === undefined ? {} : { approval: gate.approval }),
        bindingFormat: "LEGACY"
      };
    }
    return {
      code: gate.code,
      name: gate.name,
      stageCode: gate.stageCode,
      scope: gate.scope ?? "PROJECT",
      definitionJson: gate as JsonValue,
      checkerBindings: gate.checkers ?? [],
      ...(gate.approval === undefined ? {} : { approval: gate.approval }),
      bindingFormat: "EXPLICIT"
    };
  });
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

export function validateTemplateGateCodesUnique(
  components: ReadonlyArray<{ componentType: TemplateComponentTypeCode; content: unknown }>
) {
  const codes = components.flatMap(({ componentType, content }) => {
    if (componentType !== TEMPLATE_COMPONENT_TYPES.GATE) return [];
    const validated = validateTemplateComponentContent(componentType, content) as {
      gates: Array<{ code: string }>;
    };
    return validated.gates.map(({ code }) => code);
  });
  if (new Set(codes).size !== codes.length) {
    throw new TemplateValidationError("DUPLICATE_RULE_CODE", "模板包含重复 Gate 代码。");
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
