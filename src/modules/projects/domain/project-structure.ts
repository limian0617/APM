import { payloadHash } from "@/modules/governance/domain/idempotency";

export const PROJECT_TYPES = {
  CUSTOMER_DELIVERY: "CUSTOMER_DELIVERY",
  INTERNAL_RND: "INTERNAL_RND"
} as const;

export const EQUIPMENT_SHAPES = {
  SINGLE_MACHINE: "SINGLE_MACHINE",
  LINE: "LINE"
} as const;

export const DELIVERY_UNIT_TYPES = {
  LINE: "LINE",
  AREA: "AREA",
  MACHINE: "MACHINE"
} as const;

export type ProjectTypeCode = (typeof PROJECT_TYPES)[keyof typeof PROJECT_TYPES];
export type EquipmentShapeCode = (typeof EQUIPMENT_SHAPES)[keyof typeof EQUIPMENT_SHAPES];
export type DeliveryUnitTypeCode = (typeof DELIVERY_UNIT_TYPES)[keyof typeof DELIVERY_UNIT_TYPES];

export class ProjectStructureError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422
  ) {
    super(message);
    this.name = "ProjectStructureError";
  }
}

export type DeliveryUnitDefinition = {
  code: string;
  name: string;
  unitType: DeliveryUnitTypeCode;
  parentCode: string | null;
  position: number;
};

export type ProjectModuleDefinition = {
  code: string;
  name: string;
  machineCode: string;
  position: number;
};

export type ProjectStructurePlan = {
  projectType: ProjectTypeCode;
  equipmentShape: EquipmentShapeCode | null;
  deliveryUnits: DeliveryUnitDefinition[];
  modules: ProjectModuleDefinition[];
  checksum: string;
};

const unitTypeRank: Record<DeliveryUnitTypeCode, number> = {
  LINE: 0,
  AREA: 1,
  MACHINE: 2
};

function stableCode(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Z][A-Z0-9_.-]{1,99}$/u.test(normalized)) {
    throw new ProjectStructureError("INVALID_STRUCTURE_CODE", `${field} 必须是稳定的大写代码。`);
  }
  return normalized;
}

function displayName(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 200) {
    throw new ProjectStructureError("INVALID_STRUCTURE_NAME", `${field} 必须是 1 到 200 个字符。`);
  }
  return normalized;
}

function position(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProjectStructureError("INVALID_STRUCTURE_POSITION", `${field} 必须是非负整数。`);
  }
  return value as number;
}

function ensureUnique(values: string[], code: string, message: string) {
  if (new Set(values).size !== values.length) {
    throw new ProjectStructureError(code, message, 409);
  }
}

function assertAcyclic(units: DeliveryUnitDefinition[]) {
  const parentByCode = new Map(units.map((unit) => [unit.code, unit.parentCode]));
  const complete = new Set<string>();
  const active = new Set<string>();

  function visit(code: string) {
    if (complete.has(code)) return;
    if (active.has(code)) {
      throw new ProjectStructureError("STRUCTURE_CYCLE", "交付单元树不能包含循环。", 409);
    }
    active.add(code);
    const parentCode = parentByCode.get(code);
    if (parentCode) visit(parentCode);
    active.delete(code);
    complete.add(code);
  }

  units.forEach(({ code }) => visit(code));
}

export function buildProjectStructure(input: {
  projectType: unknown;
  equipmentShape: unknown;
  deliveryUnits: ReadonlyArray<{
    code: unknown;
    name: unknown;
    unitType: unknown;
    parentCode?: unknown;
    position: unknown;
  }>;
  modules: ReadonlyArray<{
    code: unknown;
    name: unknown;
    machineCode: unknown;
    position: unknown;
  }>;
}): ProjectStructurePlan {
  if (!Object.values(PROJECT_TYPES).includes(input.projectType as ProjectTypeCode)) {
    throw new ProjectStructureError("INVALID_PROJECT_TYPE", "项目类型无效。");
  }
  const projectType = input.projectType as ProjectTypeCode;
  const equipmentShape =
    input.equipmentShape === null
      ? null
      : Object.values(EQUIPMENT_SHAPES).includes(input.equipmentShape as EquipmentShapeCode)
        ? (input.equipmentShape as EquipmentShapeCode)
        : undefined;
  if (equipmentShape === undefined) {
    throw new ProjectStructureError("INVALID_EQUIPMENT_SHAPE", "设备形态无效。");
  }
  if (input.deliveryUnits.length > 1000 || input.modules.length > 5000) {
    throw new ProjectStructureError("STRUCTURE_TOO_LARGE", "项目结构超过单次初始化上限。", 413);
  }

  const deliveryUnits = input.deliveryUnits.map((unit, index) => {
    if (!Object.values(DELIVERY_UNIT_TYPES).includes(unit.unitType as DeliveryUnitTypeCode)) {
      throw new ProjectStructureError("INVALID_DELIVERY_UNIT_TYPE", "交付单元类型无效。");
    }
    return {
      code: stableCode(unit.code, `deliveryUnits.${index}.code`),
      name: displayName(unit.name, `deliveryUnits.${index}.name`),
      unitType: unit.unitType as DeliveryUnitTypeCode,
      parentCode:
        unit.parentCode === undefined || unit.parentCode === null
          ? null
          : stableCode(unit.parentCode, `deliveryUnits.${index}.parentCode`),
      position: position(unit.position, `deliveryUnits.${index}.position`)
    };
  });
  const modules = input.modules.map((module, index) => ({
    code: stableCode(module.code, `modules.${index}.code`),
    name: displayName(module.name, `modules.${index}.name`),
    machineCode: stableCode(module.machineCode, `modules.${index}.machineCode`),
    position: position(module.position, `modules.${index}.position`)
  }));

  ensureUnique(
    deliveryUnits.map(({ code }) => code),
    "DUPLICATE_DELIVERY_UNIT_CODE",
    "交付单元代码不能重复。"
  );
  ensureUnique(
    modules.map(({ code }) => code),
    "DUPLICATE_MODULE_CODE",
    "模块代码不能重复。"
  );
  ensureUnique(
    deliveryUnits.map(
      ({ parentCode, position: unitPosition }) => `${parentCode ?? "<ROOT>"}:${unitPosition}`
    ),
    "DUPLICATE_DELIVERY_UNIT_POSITION",
    "同一父节点下的交付单元顺序不能重复。"
  );
  ensureUnique(
    modules.map(({ machineCode, position: modulePosition }) => `${machineCode}:${modulePosition}`),
    "DUPLICATE_MODULE_POSITION",
    "同一单机下的模块顺序不能重复。"
  );

  if (projectType === PROJECT_TYPES.INTERNAL_RND) {
    if (equipmentShape !== null || deliveryUnits.length > 0 || modules.length > 0) {
      throw new ProjectStructureError(
        "INTERNAL_RND_STRUCTURE_FORBIDDEN",
        "内部技术研发项目不套用客户设备交付层级。",
        409
      );
    }
  } else {
    if (equipmentShape === null) {
      throw new ProjectStructureError(
        "EQUIPMENT_SHAPE_REQUIRED",
        "客户交付项目必须明确单机或整线设备形态。"
      );
    }
    const unitByCode = new Map(deliveryUnits.map((unit) => [unit.code, unit]));
    for (const unit of deliveryUnits) {
      if (unit.parentCode && !unitByCode.has(unit.parentCode)) {
        throw new ProjectStructureError(
          "DELIVERY_UNIT_PARENT_NOT_FOUND",
          `交付单元 ${unit.code} 的父节点不存在。`,
          409
        );
      }
      if (unit.parentCode === unit.code) {
        throw new ProjectStructureError("STRUCTURE_CYCLE", "交付单元不能以自身作为父节点。", 409);
      }
    }
    assertAcyclic(deliveryUnits);

    if (equipmentShape === EQUIPMENT_SHAPES.SINGLE_MACHINE) {
      if (
        deliveryUnits.length !== 1 ||
        deliveryUnits[0]?.unitType !== DELIVERY_UNIT_TYPES.MACHINE ||
        deliveryUnits[0]?.parentCode !== null
      ) {
        throw new ProjectStructureError(
          "INVALID_SINGLE_MACHINE_STRUCTURE",
          "单机项目必须且只能包含一个项目根下的单机节点。",
          409
        );
      }
    } else {
      if (!deliveryUnits.some(({ unitType }) => unitType === DELIVERY_UNIT_TYPES.LINE)) {
        throw new ProjectStructureError(
          "LINE_UNIT_REQUIRED",
          "整线项目至少需要一个产线节点。",
          409
        );
      }
      if (!deliveryUnits.some(({ unitType }) => unitType === DELIVERY_UNIT_TYPES.MACHINE)) {
        throw new ProjectStructureError(
          "MACHINE_UNIT_REQUIRED",
          "整线项目至少需要一个单机节点。",
          409
        );
      }
      for (const unit of deliveryUnits) {
        const parent = unit.parentCode ? unitByCode.get(unit.parentCode) : null;
        if (unit.unitType === DELIVERY_UNIT_TYPES.LINE && parent) {
          throw new ProjectStructureError(
            "INVALID_UNIT_HIERARCHY",
            "产线节点必须位于项目根。",
            409
          );
        }
        if (unit.unitType === DELIVERY_UNIT_TYPES.AREA && parent?.unitType !== "LINE") {
          throw new ProjectStructureError(
            "INVALID_UNIT_HIERARCHY",
            "区域/工段只能位于产线节点下。",
            409
          );
        }
        if (
          unit.unitType === DELIVERY_UNIT_TYPES.MACHINE &&
          parent?.unitType !== "LINE" &&
          parent?.unitType !== "AREA"
        ) {
          throw new ProjectStructureError(
            "INVALID_UNIT_HIERARCHY",
            "单机只能位于产线或区域/工段节点下。",
            409
          );
        }
      }
    }

    for (const moduleDefinition of modules) {
      if (unitByCode.get(moduleDefinition.machineCode)?.unitType !== DELIVERY_UNIT_TYPES.MACHINE) {
        throw new ProjectStructureError(
          "MODULE_MACHINE_REQUIRED",
          `模块 ${moduleDefinition.code} 必须归属本项目的单机节点。`,
          409
        );
      }
    }
  }

  const orderedUnits = [...deliveryUnits].sort(
    (left, right) =>
      unitTypeRank[left.unitType] - unitTypeRank[right.unitType] ||
      left.position - right.position ||
      left.code.localeCompare(right.code)
  );
  const orderedModules = [...modules].sort(
    (left, right) =>
      left.machineCode.localeCompare(right.machineCode) ||
      left.position - right.position ||
      left.code.localeCompare(right.code)
  );
  const canonical = {
    projectType,
    equipmentShape,
    deliveryUnits: orderedUnits,
    modules: orderedModules
  };
  return { ...canonical, checksum: payloadHash(canonical).hash };
}
