import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CockpitNavigationContent } from "./cockpit-navigation-client";

describe("CockpitNavigationContent", () => {
  it("renders all four real cockpit links and keeps resource load on its APM-042 route", () => {
    const markup = renderToStaticMarkup(
      createElement(CockpitNavigationContent, {
        projectId: "project 7",
        pathname: "/projects/project%207/cockpit/resource-load"
      })
    );

    expect(markup).toContain('class="cockpit-view-navigation"');
    expect(markup).toContain('href="/projects/project%207/cockpit?view=overview"');
    expect(markup).toContain('href="/projects/project%207/cockpit?view=progress"');
    expect(markup).toContain('href="/projects/project%207/cockpit?view=risks"');
    expect(markup).toContain('href="/projects/project%207/cockpit/resource-load"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).not.toContain('aria-disabled="true"');
    expect(markup).not.toContain('href="/projects/project%207/cockpit/progress"');
  });
});
