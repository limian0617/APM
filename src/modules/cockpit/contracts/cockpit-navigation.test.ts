import { describe, expect, it } from "vitest";

import {
  COCKPIT_NAVIGATION,
  buildCockpitNavigation,
  selectedCockpitNavigation
} from "./cockpit-navigation";

describe("cockpit navigation manifest", () => {
  it("keeps the four cockpit views in their fixed order", () => {
    expect(COCKPIT_NAVIGATION.map((entry) => entry.label)).toEqual([
      "总览",
      "进度与里程碑",
      "风险与问题",
      "资源负荷"
    ]);
  });

  it("publishes the three real dashboard views and the existing APM-042 resource-load route", () => {
    const navigation = buildCockpitNavigation("demo project/1");
    expect(navigation).toEqual([
      {
        id: "overview",
        label: "总览",
        available: true,
        href: "/projects/demo%20project%2F1/cockpit?view=overview"
      },
      {
        id: "progress",
        label: "进度与里程碑",
        available: true,
        href: "/projects/demo%20project%2F1/cockpit?view=progress"
      },
      {
        id: "risks",
        label: "风险与问题",
        available: true,
        href: "/projects/demo%20project%2F1/cockpit?view=risks"
      },
      {
        id: "resource-load",
        label: "资源负荷",
        available: true,
        href: "/projects/demo%20project%2F1/cockpit/resource-load"
      }
    ]);
    expect(buildCockpitNavigation("demo project/1", "normal").slice(0, 3)).toEqual([
      {
        id: "overview",
        label: "总览",
        available: true,
        href: "/projects/demo%20project%2F1/cockpit?view=overview&fixture=normal"
      },
      {
        id: "progress",
        label: "进度与里程碑",
        available: true,
        href: "/projects/demo%20project%2F1/cockpit?view=progress&fixture=normal"
      },
      {
        id: "risks",
        label: "风险与问题",
        available: true,
        href: "/projects/demo%20project%2F1/cockpit?view=risks&fixture=normal"
      }
    ]);
    expect(buildCockpitNavigation("demo project/1", "untrusted")[0]).toMatchObject({
      href: "/projects/demo%20project%2F1/cockpit?view=overview"
    });
  });

  it("marks resource load as the active cockpit view without losing project context", () => {
    expect(
      selectedCockpitNavigation("project-7", "/projects/project-7/cockpit/resource-load")
    ).toBe("resource-load");
    expect(selectedCockpitNavigation("project-7", "/projects/project-7/cockpit")).toBe("overview");
    expect(
      selectedCockpitNavigation("project-7", "/projects/project-8/cockpit/resource-load")
    ).toBeNull();
    expect(selectedCockpitNavigation("project-7", "/projects/project-7/execution")).toBeNull();
  });
});
