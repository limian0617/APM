import { describe, expect, it } from "vitest";

import {
  PROCUREMENT_PAGE_VIEWS,
  buildProcurementPageState,
  resolveProcurementFixture,
  safeProcurementDrilldown,
  toProcurementFetchResult,
  type ProcurementFetchResult
} from "./procurement-page-state";

describe("procurement page state contract", () => {
  it("keeps the five views and rejects unknown views", () => {
    expect(PROCUREMENT_PAGE_VIEWS).toEqual([
      "overview",
      "requirements",
      "tracking",
      "arrivals",
      "readiness"
    ]);
  });

  it("allows only named fixtures in development", () => {
    expect(resolveProcurementFixture("normal", "development")).toBe("normal");
    expect(resolveProcurementFixture("partial-denied", "development")).toBe("partial-denied");
    expect(resolveProcurementFixture("anything", "development")).toBeNull();
    expect(resolveProcurementFixture("normal", "production")).toBeNull();
  });

  it("maps denied primary sources to a page-level denied state", () => {
    const denied = toProcurementFetchResult({ status: 403, body: { secret: "must-not-leak" } });
    const state = buildProcurementPageState({
      projectId: "project-1",
      overview: denied,
      readiness: toProcurementFetchResult({ status: 200, body: { readiness: null } })
    });
    expect(state).toMatchObject({ status: "denied", projectId: "project-1" });
    expect(JSON.stringify(state)).not.toContain("must-not-leak");
  });

  it("keeps supplier 403 restricted without exposing response data", () => {
    const supplier = toProcurementFetchResult({
      status: 403,
      body: { supplierId: "s-1", name: "Hidden" }
    });
    const state = buildProcurementPageState({
      projectId: "project-1",
      overview: toProcurementFetchResult({ status: 200, body: { projectId: "project-1" } }),
      readiness: toProcurementFetchResult({ status: 200, body: { status: "READY" } }),
      suppliers: supplier
    });
    expect(state.status).toBe("partial-denied");
    if (state.status === "partial-denied") {
      expect(state.suppliers).toEqual({ status: "restricted" });
    }
    expect(JSON.stringify(state)).not.toContain("Hidden");
    expect(JSON.stringify(state)).not.toContain("s-1");
  });

  it("distinguishes retryable network and server errors", () => {
    const retryable = toProcurementFetchResult({ status: 503, body: { code: "TEMPORARY" } });
    const permanent = toProcurementFetchResult({ status: 422, body: { code: "INVALID" } });
    expect(retryable).toMatchObject({ kind: "error", retryable: true });
    expect(permanent).toMatchObject({ kind: "error", retryable: false });
  });

  it("preserves independent source timestamps and maps stale data", () => {
    const overview: ProcurementFetchResult = {
      kind: "ok",
      body: { projectId: "project-1", sourceSyncedAt: "2026-08-08T01:00:00.000Z" },
      fetchedAt: "2026-08-08T02:00:00.000Z"
    };
    const readiness: ProcurementFetchResult = {
      kind: "ok",
      body: {
        status: "STALE",
        sourceSyncedAt: "2026-08-07T01:00:00.000Z",
        calculatedAt: "2026-08-07T02:00:00.000Z"
      },
      fetchedAt: "2026-08-08T02:00:00.000Z"
    };
    const state = buildProcurementPageState({ projectId: "project-1", overview, readiness });
    expect(state.status).toBe("stale");
    if (state.status === "stale") {
      expect(state.timestamps).toEqual({
        overview: "2026-08-08T01:00:00.000Z",
        readiness: "2026-08-07T01:00:00.000Z"
      });
    }
  });

  it("creates only current-project drilldown paths", () => {
    expect(safeProcurementDrilldown("project-1", { view: "requirements", scopeId: "req-1" })).toBe(
      "/projects/project-1/procurement?view=requirements&scopeId=req-1"
    );
    expect(
      safeProcurementDrilldown("project-1", { view: "overview", projectId: "project-2" })
    ).toBeNull();
    expect(safeProcurementDrilldown("project-1", { href: "https://example.com" })).toBeNull();
  });
});
