import { CAPABILITY_CODE_VALUES, isCapabilityCode, type CapabilityCodeValue } from "./definitions";

export type CapabilityPolicy = {
  code: CapabilityCodeValue;
  templateAllowed: boolean;
  templateRequired: boolean;
  sourceSnapshotComponentId: string | null;
};

export type CapabilitySelection = CapabilityPolicy & {
  selectedEnabled: boolean;
};

export type CapabilityDisabledReason =
  "COMPANY_DISABLED" | "TEMPLATE_NOT_ALLOWED" | "PROJECT_NOT_SELECTED";

export class ProjectCapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "ProjectCapabilityError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function resolveTemplateCapabilityPolicy(
  components: ReadonlyArray<{ id: string; contentJson: unknown }>
): CapabilityPolicy[] {
  const byCode = new Map<CapabilityCodeValue, CapabilityPolicy>();

  for (const component of components) {
    const content = record(component.contentJson);
    if (!content || !Array.isArray(content.capabilities)) {
      throw new ProjectCapabilityError(
        "INVALID_TEMPLATE_CAPABILITY_RULE",
        "项目模板快照中的能力规则格式无效。",
        409
      );
    }
    for (const value of content.capabilities) {
      const item = record(value);
      if (!item || !isCapabilityCode(String(item.code)) || typeof item.required !== "boolean") {
        throw new ProjectCapabilityError(
          "INVALID_TEMPLATE_CAPABILITY_RULE",
          "项目模板快照包含无效能力规则。",
          409
        );
      }
      const code = String(item.code) as CapabilityCodeValue;
      if (byCode.has(code)) {
        throw new ProjectCapabilityError(
          "DUPLICATE_TEMPLATE_CAPABILITY",
          `项目模板快照重复定义能力 ${code}。`,
          409
        );
      }
      byCode.set(code, {
        code,
        templateAllowed: true,
        templateRequired: item.required,
        sourceSnapshotComponentId: component.id
      });
    }
  }

  return CAPABILITY_CODE_VALUES.map(
    (code): CapabilityPolicy =>
      byCode.get(code) ?? {
        code,
        templateAllowed: false,
        templateRequired: false,
        sourceSnapshotComponentId: null
      }
  );
}

export function resolveProjectCapabilitySelections(
  policies: ReadonlyArray<CapabilityPolicy>,
  requested: ReadonlyArray<{ code: unknown; enabled: unknown }>
): CapabilitySelection[] {
  const requestedByCode = new Map<CapabilityCodeValue, boolean>();
  for (const item of requested) {
    if (typeof item.code !== "string" || !isCapabilityCode(item.code)) {
      throw new ProjectCapabilityError("UNKNOWN_CAPABILITY", "项目能力代码不存在。", 404);
    }
    if (typeof item.enabled !== "boolean") {
      throw new ProjectCapabilityError("INVALID_CAPABILITY_SELECTION", "enabled 必须是布尔值。");
    }
    if (requestedByCode.has(item.code)) {
      throw new ProjectCapabilityError(
        "DUPLICATE_CAPABILITY_SELECTION",
        `项目能力 ${item.code} 不能重复提交。`,
        409
      );
    }
    requestedByCode.set(item.code, item.enabled);
  }

  return policies.map((policy) => {
    const requestedEnabled = requestedByCode.get(policy.code);
    if (policy.templateRequired && requestedEnabled === false) {
      throw new ProjectCapabilityError(
        "TEMPLATE_CAPABILITY_REQUIRED",
        `模板要求项目启用能力 ${policy.code}。`,
        409
      );
    }
    if (!policy.templateAllowed && requestedEnabled === true) {
      throw new ProjectCapabilityError(
        "TEMPLATE_CAPABILITY_NOT_ALLOWED",
        `模板未允许项目启用能力 ${policy.code}。`,
        409
      );
    }
    return {
      ...policy,
      selectedEnabled: policy.templateRequired || requestedEnabled === true
    };
  });
}

export function capabilityEffectiveState(input: {
  companyEnabled: boolean;
  templateAllowed: boolean;
  selectedEnabled: boolean;
}) {
  const disabledReasons: CapabilityDisabledReason[] = [];
  if (!input.companyEnabled) disabledReasons.push("COMPANY_DISABLED");
  if (!input.templateAllowed) disabledReasons.push("TEMPLATE_NOT_ALLOWED");
  if (!input.selectedEnabled) disabledReasons.push("PROJECT_NOT_SELECTED");
  return {
    effectiveEnabled: disabledReasons.length === 0,
    disabledReasons
  };
}

export function assertCapabilityChangeAllowed(input: {
  code: CapabilityCodeValue;
  templateAllowed: boolean;
  templateRequired: boolean;
  enabled: unknown;
}): boolean {
  if (typeof input.enabled !== "boolean") {
    throw new ProjectCapabilityError("INVALID_CAPABILITY_SELECTION", "enabled 必须是布尔值。");
  }
  if (!input.templateAllowed && input.enabled) {
    throw new ProjectCapabilityError(
      "TEMPLATE_CAPABILITY_NOT_ALLOWED",
      `模板未允许项目启用能力 ${input.code}。`,
      409
    );
  }
  if (input.templateRequired && !input.enabled) {
    throw new ProjectCapabilityError(
      "TEMPLATE_CAPABILITY_REQUIRED",
      `模板要求项目启用能力 ${input.code}。`,
      409
    );
  }
  return input.enabled;
}
