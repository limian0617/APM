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

  it("publishes real cockpit, execution, procurement, FAT/SAT and governance pages while unfinished entries remain inert", () => {
    const navigation = buildProjectNavigation("demo project/1");
    const plan = navigation.primary.find((entry) => entry.id === "plan");
    const overview = navigation.primary.find((entry) => entry.id === "overview");
    const procurement = navigation.primary.find((entry) => entry.id === "procurement");
    const acceptance = navigation.primary.find((entry) => entry.id === "acceptance");
    const governance = navigation.more.find((entry) => entry.id === "governance");

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
    expect(procurement).toEqual({
      id: "procurement",
      label: "采购",
      available: true,
      href: "/projects/demo%20project%2F1/procurement?view=overview"
    });
    expect(acceptance).toEqual({
      id: "acceptance",
      label: "FAT/SAT",
      available: true,
      href: "/projects/demo%20project%2F1/acceptance"
    });
    expect(governance).toEqual({
      id: "governance",
      label: "审批与记录",
      available: true,
      href: "/projects/demo%20project%2F1/governance"
    });
    expect(
      navigation.primary
        .filter((entry) => !["plan", "overview", "procurement", "acceptance"].includes(entry.id))
        .every((entry) => !entry.available)
    ).toBe(true);
    expect(
      navigation.more
        .filter((entry) => entry.id !== "governance")
        .every((entry) => !entry.available && !("href" in entry))
    ).toBe(true);
  });

  it("keeps the current project context and selects overview for cockpit resource load", () => {
    expect(
      selectedProjectNavigation("project-7", "/projects/project-7/cockpit/resource-load")
    ).toBe("overview");
    expect(selectedProjectNavigation("project-7", "/projects/project-7/execution")).toBe("plan");
    expect(selectedProjectNavigation("project-7", "/projects/project-7/procurement")).toBe(
      "procurement"
    );
    expect(selectedProjectNavigation("project-7", "/projects/project-7/acceptance")).toBe(
      "acceptance"
    );
    expect(selectedProjectNavigation("project-7", "/projects/project-7/governance")).toBe(
      "governance"
    );
    expect(selectedProjectNavigation("project-7", "/projects/project-8/execution")).toBeNull();
    expect(selectedProjectNavigation("project-7", "/projects/project-7/unknown")).toBeNull();
  });
});
