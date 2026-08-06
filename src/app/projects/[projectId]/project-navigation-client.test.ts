import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProjectNavigationContent } from "./project-navigation-client";

describe("ProjectNavigationContent", () => {
  it("renders the published cockpit and plan links while unfinished entries remain inert", () => {
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
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("尚未开放");
    expect(markup).not.toContain('href="/projects/project%207/responsibility-packages"');
    expect(markup).not.toContain('href="/projects/project%207/changes"');
  });
});
