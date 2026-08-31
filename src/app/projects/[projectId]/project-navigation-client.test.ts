import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProjectNavigationContent } from "./project-navigation-client";

describe("ProjectNavigationContent", () => {
  it("renders the published cockpit, plan, issues, procurement, FAT/SAT and governance links while unfinished entries remain inert", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectNavigationContent, {
        projectId: "project 7",
        pathname: "/projects/project%207/execution"
      })
    );

    expect(markup).toContain('class="project-navigation"');
    expect(markup).toContain('class="project-navigation-more"');
    expect(markup).toContain('href="/projects/project%207/execution"');
    expect(markup).toContain('href="/projects/project%207/cockpit?view=overview"');
    expect(markup).toContain('href="/projects/project%207/procurement?view=overview"');
    expect(markup).toContain('href="/projects/project%207/issues"');
    expect(markup).toContain('href="/projects/project%207/acceptance"');
    expect(markup).toContain('href="/projects/project%207/uph"');
    expect(markup).toContain('href="/projects/project%207/governance"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("尚未开放");
    expect(markup).not.toContain('href="/projects/project%207/responsibility-packages"');
    expect(markup).not.toContain('href="/projects/project%207/changes"');
  });

  it("marks nested UPH paths as the active project navigation item", () => {
    const markup = renderToStaticMarkup(
      createElement(ProjectNavigationContent, {
        projectId: "project 7",
        pathname: "/projects/project%207/uph/test-batches/batch-1"
      })
    );
    expect(markup).toContain('href="/projects/project%207/uph" aria-current="page"');
  });
});
