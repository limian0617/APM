import { describe, expect, it } from "vitest";

import {
  PROJECT_MORE_NAVIGATION,
  PROJECT_PRIMARY_NAVIGATION,
  buildProjectNavigation,
  selectedProjectNavigation
} from "./project-navigation";

describe("project navigation manifest", () => {
  it("keeps the approved primary and More entries in their fixed order", () => {
    expect(PROJECT_PRIMARY_NAVIGATION.map((entry) => entry.label)).toEqual([
      "总览",
      "计划",
      "责任包",
      "交付物",
      "问题",
      "采购",
      "UPH",
      "FAT/SAT"
    ]);
    expect(PROJECT_MORE_NAVIGATION.map((entry) => entry.label)).toEqual([
      "变更",
      "审批与记录",
      "项目设置"
    ]);
  });

  it("publishes the real cockpit and execution pages and keeps unfinished entries inert", () => {
    const navigation = buildProjectNavigation("demo project/1");
    const plan = navigation.primary.find((entry) => entry.id === "plan");
    const overview = navigation.primary.find((entry) => entry.id === "overview");

    expect(plan).toMatchObject({
      available: true,
      href: "/projects/demo%20project%2F1/execution"
    });
    expect(overview).toEqual({
      id: "overview",
      label: "总览",
      available: true,
      href: "/projects/demo%20project%2F1/cockpit?view=overview"
    });
    expect(
      navigation.primary
        .filter((entry) => entry.id !== "plan" && entry.id !== "overview")
        .every((entry) => !entry.available)
    ).toBe(true);
    expect(navigation.more.every((entry) => !entry.available && !("href" in entry))).toBe(true);
  });

  it("keeps the current project context and selects overview for cockpit resource load", () => {
    expect(
      selectedProjectNavigation("project-7", "/projects/project-7/cockpit/resource-load")
    ).toBe("overview");
    expect(selectedProjectNavigation("project-7", "/projects/project-7/execution")).toBe("plan");
    expect(selectedProjectNavigation("project-7", "/projects/project-8/execution")).toBeNull();
    expect(selectedProjectNavigation("project-7", "/projects/project-7/unknown")).toBeNull();
  });
});
