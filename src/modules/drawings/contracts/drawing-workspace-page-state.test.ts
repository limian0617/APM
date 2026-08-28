import { describe, expect, it } from "vitest";

import {
  buildDrawingWorkspacePageState,
  resolveDrawingWorkspaceFixture,
  toDrawingWorkspaceFetchResult
} from "./drawing-workspace-page-state";

describe("APM-053 drawing workspace page state", () => {
  const projectId = "project-1";
  const drawings = toDrawingWorkspaceFetchResult({
    status: 200,
    body: { drawings: [{ id: "drawing-1", projectId, drawingNumber: "DWG-001" }] },
    fetchedAt: "2026-08-11T02:00:00.000Z"
  });
  const selections = toDrawingWorkspaceFetchResult({ status: 200, body: [] });
  const configuration = toDrawingWorkspaceFetchResult({
    status: 200,
    body: [{ id: "category-1", code: "MACHINING", isActive: true }]
  });

  it("allows only explicit development workspace fixtures", () => {
    expect(resolveDrawingWorkspaceFixture("normal", "development")).toBe("normal");
    expect(resolveDrawingWorkspaceFixture("unexpected", "development")).toBeNull();
    expect(resolveDrawingWorkspaceFixture("normal", "production")).toBeNull();
  });

  it("keeps supplier access restricted without names or IDs", () => {
    const state = buildDrawingWorkspacePageState({
      projectId,
      drawings,
      selections,
      categories: configuration,
      processTags: configuration,
      suppliers: toDrawingWorkspaceFetchResult({
        status: 403,
        body: { suppliers: [{ id: "hidden-supplier", name: "Hidden" }] }
      })
    });

    expect(state).toMatchObject({ status: "ready", suppliers: { status: "restricted" } });
    expect(JSON.stringify(state)).not.toContain("hidden-supplier");
    expect(JSON.stringify(state)).not.toContain("Hidden");
  });

  it("maps denied primary project data to a page-level denied state", () => {
    expect(
      buildDrawingWorkspacePageState({
        projectId,
        drawings: toDrawingWorkspaceFetchResult({ status: 403 }),
        selections,
        categories: configuration,
        processTags: configuration,
        suppliers: toDrawingWorkspaceFetchResult({ status: 200, body: { suppliers: [] } })
      })
    ).toEqual({ projectId, status: "denied" });
  });

  it("keeps unavailable global configuration local to the classification section", () => {
    const state = buildDrawingWorkspacePageState({
      projectId,
      drawings,
      selections,
      categories: toDrawingWorkspaceFetchResult({ status: 403 }),
      processTags: toDrawingWorkspaceFetchResult({ status: 403 }),
      suppliers: toDrawingWorkspaceFetchResult({ status: 200, body: { suppliers: [] } })
    });

    expect(state).toMatchObject({
      status: "ready",
      categories: { status: "restricted" },
      processTags: { status: "restricted" }
    });
  });

  it("returns explicit empty and stale states from real source responses", () => {
    expect(
      buildDrawingWorkspacePageState({
        projectId,
        drawings: toDrawingWorkspaceFetchResult({
          status: 200,
          body: { drawings: [] },
          stale: true
        }),
        selections,
        categories: configuration,
        processTags: configuration,
        suppliers: toDrawingWorkspaceFetchResult({ status: 200, body: { suppliers: [] } })
      })
    ).toMatchObject({ status: "empty", stale: true });
  });
});
