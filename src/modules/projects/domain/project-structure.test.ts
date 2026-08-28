import { describe, expect, it } from "vitest";

import { buildProjectStructure } from "./project-structure";

const machine = {
  code: "MACHINE.01",
  name: "一号单机",
  unitType: "MACHINE" as const,
  parentCode: null,
  position: 0
};

describe("APM-012 project structure rules", () => {
  it("builds the simplified single-machine hierarchy deterministically", () => {
    const first = buildProjectStructure({
      projectType: "CUSTOMER_DELIVERY",
      equipmentShape: "SINGLE_MACHINE",
      deliveryUnits: [machine],
      modules: [
        { code: "MODULE.B", name: "下料模块", machineCode: machine.code, position: 1 },
        { code: "MODULE.A", name: "上料模块", machineCode: machine.code, position: 0 }
      ]
    });
    const reordered = buildProjectStructure({
      projectType: "CUSTOMER_DELIVERY",
      equipmentShape: "SINGLE_MACHINE",
      deliveryUnits: [machine],
      modules: [...first.modules].reverse()
    });

    expect(first.deliveryUnits).toEqual([machine]);
    expect(first.modules.map(({ code }) => code)).toEqual(["MODULE.A", "MODULE.B"]);
    expect(reordered.checksum).toBe(first.checksum);
  });

  it("accepts line-area-machine and line-machine branches", () => {
    const plan = buildProjectStructure({
      projectType: "CUSTOMER_DELIVERY",
      equipmentShape: "LINE",
      deliveryUnits: [
        {
          code: "MACHINE.02",
          name: "二号单机",
          unitType: "MACHINE",
          parentCode: "LINE.01",
          position: 1
        },
        { code: "AREA.01", name: "装配工段", unitType: "AREA", parentCode: "LINE.01", position: 0 },
        { code: "LINE.01", name: "总装线", unitType: "LINE", parentCode: null, position: 0 },
        {
          code: "MACHINE.01",
          name: "一号单机",
          unitType: "MACHINE",
          parentCode: "AREA.01",
          position: 0
        }
      ],
      modules: [
        { code: "MODULE.01", name: "上料模块", machineCode: "MACHINE.01", position: 0 },
        { code: "MODULE.02", name: "检测模块", machineCode: "MACHINE.02", position: 0 }
      ]
    });

    expect(plan.deliveryUnits.map(({ code }) => code)).toEqual([
      "LINE.01",
      "AREA.01",
      "MACHINE.01",
      "MACHINE.02"
    ]);
  });

  it("keeps internal R&D projects outside the customer delivery hierarchy", () => {
    expect(
      buildProjectStructure({
        projectType: "INTERNAL_RND",
        equipmentShape: null,
        deliveryUnits: [],
        modules: []
      })
    ).toMatchObject({ projectType: "INTERNAL_RND", equipmentShape: null });

    expect(() =>
      buildProjectStructure({
        projectType: "INTERNAL_RND",
        equipmentShape: "SINGLE_MACHINE",
        deliveryUnits: [machine],
        modules: []
      })
    ).toThrowError(expect.objectContaining({ code: "INTERNAL_RND_STRUCTURE_FORBIDDEN" }));
  });

  it("rejects missing parents, cycles, and illegal hierarchy types", () => {
    expect(() =>
      buildProjectStructure({
        projectType: "CUSTOMER_DELIVERY",
        equipmentShape: "LINE",
        deliveryUnits: [
          { code: "LINE.01", name: "总装线", unitType: "LINE", parentCode: null, position: 0 },
          {
            code: "MACHINE.01",
            name: "单机",
            unitType: "MACHINE",
            parentCode: "AREA.MISSING",
            position: 0
          }
        ],
        modules: []
      })
    ).toThrowError(expect.objectContaining({ code: "DELIVERY_UNIT_PARENT_NOT_FOUND" }));

    expect(() =>
      buildProjectStructure({
        projectType: "CUSTOMER_DELIVERY",
        equipmentShape: "LINE",
        deliveryUnits: [
          { code: "AREA.01", name: "工段一", unitType: "AREA", parentCode: "AREA.02", position: 0 },
          { code: "AREA.02", name: "工段二", unitType: "AREA", parentCode: "AREA.01", position: 0 },
          { code: "LINE.01", name: "总装线", unitType: "LINE", parentCode: null, position: 0 },
          {
            code: "MACHINE.01",
            name: "单机",
            unitType: "MACHINE",
            parentCode: "LINE.01",
            position: 0
          }
        ],
        modules: []
      })
    ).toThrowError(expect.objectContaining({ code: "STRUCTURE_CYCLE" }));

    expect(() =>
      buildProjectStructure({
        projectType: "CUSTOMER_DELIVERY",
        equipmentShape: "LINE",
        deliveryUnits: [
          { code: "LINE.01", name: "总装线", unitType: "LINE", parentCode: null, position: 0 },
          { code: "AREA.01", name: "错误根工段", unitType: "AREA", parentCode: null, position: 1 },
          {
            code: "MACHINE.01",
            name: "单机",
            unitType: "MACHINE",
            parentCode: "LINE.01",
            position: 0
          }
        ],
        modules: []
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_UNIT_HIERARCHY" }));
  });

  it("rejects duplicates and modules owned by non-machine nodes", () => {
    expect(() =>
      buildProjectStructure({
        projectType: "CUSTOMER_DELIVERY",
        equipmentShape: "SINGLE_MACHINE",
        deliveryUnits: [machine],
        modules: [
          { code: "MODULE.01", name: "模块一", machineCode: machine.code, position: 0 },
          { code: "MODULE.01", name: "模块二", machineCode: machine.code, position: 1 }
        ]
      })
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_MODULE_CODE" }));

    expect(() =>
      buildProjectStructure({
        projectType: "CUSTOMER_DELIVERY",
        equipmentShape: "LINE",
        deliveryUnits: [
          { code: "LINE.01", name: "总装线", unitType: "LINE", parentCode: null, position: 0 },
          {
            code: "MACHINE.01",
            name: "单机",
            unitType: "MACHINE",
            parentCode: "LINE.01",
            position: 0
          }
        ],
        modules: [{ code: "MODULE.01", name: "模块", machineCode: "LINE.01", position: 0 }]
      })
    ).toThrowError(expect.objectContaining({ code: "MODULE_MACHINE_REQUIRED" }));
  });
});
