import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DrawingWorkspaceContent,
  loadDrawingWorkspaceState,
  supplierMatchPathForDrawing
} from "./drawing-workspace-client";
import {
  buildDrawingWorkspacePageState,
  toDrawingWorkspaceFetchResult
} from "@/modules/drawings/contracts/drawing-workspace-page-state";

describe("drawing workspace client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a controlled same-project supplier-match path from the selected drawing classification", () => {
    expect(
      supplierMatchPathForDrawing("project-1", {
        id: "drawing-1",
        classification: {
          category: { code: "MACHINING" },
          processTags: [{ code: "MILLING" }, { code: "TURNING" }]
        }
      })
    ).toBe(
      "/api/projects/project-1/drawing-supplier-matches?categoryCode=MACHINING&processTagCodes=MILLING%2CTURNING"
    );
  });

  it("does not treat the generic procurement supplier list as a manufacturing match source", async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        paths.push(input);
        return new Response(
          JSON.stringify({ drawings: [], selectionSets: [], categories: [], processTags: [] }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      })
    );

    await loadDrawingWorkspaceState("project-1");

    expect(paths).not.toContain("/api/projects/project-1/procurement/suppliers?limit=100");
  });

  it("renders a no-match selection state and does not create external package controls", () => {
    const state = buildDrawingWorkspacePageState({
      projectId: "project-1",
      drawings: toDrawingWorkspaceFetchResult({
        status: 200,
        body: {
          drawings: [
            {
              id: "drawing-1",
              drawingNumber: "DWG-001",
              drawingType: "PART",
              version: 2,
              resourceVersion: 2
            }
          ]
        }
      }),
      selections: toDrawingWorkspaceFetchResult({ status: 200, body: [] }),
      categories: toDrawingWorkspaceFetchResult({
        status: 200,
        body: [{ id: "category-1", code: "MACHINING", name: "机加工" }]
      }),
      processTags: toDrawingWorkspaceFetchResult({ status: 200, body: [] }),
      suppliers: toDrawingWorkspaceFetchResult({ status: 200, body: { matches: [] } })
    });

    const markup = renderToStaticMarkup(
      createElement(DrawingWorkspaceContent, {
        projectId: "project-1",
        state,
        onRetry: () => undefined
      })
    );
    expect(markup).toContain("无匹配供应商");
    expect(markup).toContain("drawing-workspace-state");
    expect(markup).toContain("drawing-classification-list");
    expect(markup).toContain("drawing-supplier-match-list");
    expect(markup).toContain(">2<");
    expect(markup).not.toContain("RFQ");
    expect(markup).not.toContain("供应商门户");
  });

  it("renders a denied project state without work-item detail", () => {
    const markup = renderToStaticMarkup(
      createElement(DrawingWorkspaceContent, {
        projectId: "project-1",
        state: { projectId: "project-1", status: "denied" },
        onRetry: () => undefined
      })
    );
    expect(markup).toContain("无权查看项目图纸工作区");
    expect(markup).not.toContain("DWG-001");
  });
});
