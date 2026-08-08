import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getRequirements } from "@/app/api/projects/[projectId]/material-requirements/route";
import { GET as getTracking } from "@/app/api/projects/[projectId]/procurement-tracking-lines/route";
import { GET as getChangeImpacts } from "@/app/api/projects/[projectId]/procurement/change-impacts/route";
import { GET as getArrivals } from "@/app/api/projects/[projectId]/procurement/fulfillment-events/route";
import { GET as getOverview } from "@/app/api/projects/[projectId]/procurement/overview/route";
import { GET as getReadiness } from "@/app/api/projects/[projectId]/procurement/readiness/route";
import { GET as getSuppliers } from "@/app/api/projects/[projectId]/procurement/suppliers/route";
import {
  buildProcurementPageState,
  toProcurementFetchResult
} from "@/modules/procurement/contracts/procurement-page-state";

import { loadProcurementState, ProcurementPageContent } from "./procurement-page-client";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const readinessService = vi.hoisted(() => ({
  readProjectProcurementOverview: vi.fn(),
  readProcurementReadinessTree: vi.fn()
}));
const changeImpactService = vi.hoisted(() => ({ listProcurementChangeImpacts: vi.fn() }));
const materialRequirementService = vi.hoisted(() => ({
  listProjectMaterialRequirements: vi.fn(),
  listSupplierReferences: vi.fn()
}));
const trackingService = vi.hoisted(() => ({ listProcurementTrackingLines: vi.fn() }));
const fulfillmentService = vi.hoisted(() => ({ listProcurementFulfillmentEvents: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/procurement/application/readiness-service", () => readinessService);
vi.mock("@/modules/procurement/application/change-impact-service", () => changeImpactService);
vi.mock(
  "@/modules/procurement/application/material-requirement-service",
  () => materialRequirementService
);
vi.mock("@/modules/procurement/application/procurement-tracking-service", () => trackingService);
vi.mock("@/modules/procurement/application/fulfillment-event-service", () => fulfillmentService);

const projectId = "project-1";

async function routeBody(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("procurement production route contract", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });
    readinessService.readProjectProcurementOverview.mockResolvedValue({
      projectId,
      projectName: "生产采购项目",
      projectCode: "APM-090",
      mode: "LOCAL",
      overallReadinessRate: "0.75",
      criticalReadinessRate: "0.5",
      criticalGapLines: 1,
      notOrderedCount: 1,
      overdueCount: 1,
      pendingAcceptanceCount: 1,
      changePendingCount: 1,
      blockingCount: 2,
      sourceSyncedAt: "2026-08-08T01:00:00.000Z",
      calculatedAt: "2026-08-08T02:00:00.000Z",
      sourceTimestamps: {
        requirements: "2026-08-08T00:00:00.000Z",
        tracking: "2026-08-08T00:30:00.000Z",
        fulfillment: "2026-08-08T01:00:00.000Z",
        changeImpacts: "2026-08-08T01:30:00.000Z",
        readiness: "2026-08-08T02:00:00.000Z"
      },
      stale: false,
      readiness: {
        id: "readiness-project-1",
        projectId,
        scopeType: "PROJECT",
        scopeId: projectId,
        status: "READY",
        totalLines: 4,
        readyLines: 3,
        formulaVersion: "PROCUREMENT.READINESS@1",
        inputWatermark: "watermark-1",
        calculatedAt: "2026-08-08T02:00:00.000Z",
        sourceSyncedAt: "2026-08-08T01:00:00.000Z"
      }
    });
    readinessService.readProcurementReadinessTree.mockResolvedValue({
      projectId,
      inputWatermark: "watermark-1",
      stale: false,
      scopes: [
        {
          id: "readiness-project-1",
          projectId,
          scopeType: "PROJECT",
          scopeId: projectId,
          status: "READY",
          totalLines: 4,
          readyLines: 3,
          formulaVersion: "PROCUREMENT.READINESS@1",
          inputWatermark: "watermark-1",
          calculatedAt: "2026-08-08T02:00:00.000Z",
          sourceSyncedAt: "2026-08-08T01:00:00.000Z"
        }
      ]
    });
    changeImpactService.listProcurementChangeImpacts.mockResolvedValue({
      projectId,
      impacts: [
        {
          id: "impact-1",
          projectId,
          status: "OPEN",
          version: 2,
          requirementId: "requirement-1",
          changedFieldsJson: ["quantity"],
          obligations: []
        }
      ]
    });
    materialRequirementService.listProjectMaterialRequirements.mockResolvedValue({
      requirements: [{ id: "requirement-1", name: "伺服电机", status: "CONFIRMED" }],
      nextCursor: null
    });
    materialRequirementService.listSupplierReferences.mockResolvedValue({
      items: [],
      nextCursor: null
    });
    trackingService.listProcurementTrackingLines.mockResolvedValue({
      items: [
        {
          id: "tracking-1",
          requirementId: "requirement-1",
          status: "ORDERED",
          source: "LOCAL"
        }
      ],
      nextCursor: null
    });
    fulfillmentService.listProcurementFulfillmentEvents.mockResolvedValue({
      events: [{ id: "arrival-1", eventType: "PURCHASE_ARRIVED" }],
      nextCursor: null
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds all five workspace views from actual route response DTOs", async () => {
    const [overviewResponse, readinessResponse, impactsResponse] = await Promise.all([
      getOverview(
        new Request(
          `http://localhost/api/projects/${projectId}/procurement/overview?view=overview`
        ),
        { params: Promise.resolve({ projectId }) }
      ),
      getReadiness(
        new Request(
          `http://localhost/api/projects/${projectId}/procurement/readiness?view=readiness`
        ),
        { params: Promise.resolve({ projectId }) }
      ),
      getChangeImpacts(
        new Request(
          `http://localhost/api/projects/${projectId}/procurement/change-impacts?status=OPEN`
        ),
        { params: Promise.resolve({ projectId }) }
      )
    ]);
    const [overview, readiness, changeImpacts] = await Promise.all([
      routeBody(overviewResponse),
      routeBody(readinessResponse),
      routeBody(impactsResponse)
    ]);
    const state = buildProcurementPageState({
      projectId,
      overview: toProcurementFetchResult({ status: overviewResponse.status, body: overview }),
      readiness: toProcurementFetchResult({ status: readinessResponse.status, body: readiness }),
      changeImpacts: toProcurementFetchResult({
        status: impactsResponse.status,
        body: changeImpacts
      })
    });

    expect(state.status).toBe("ready");
    expect(overview).toMatchObject({
      projectName: "生产采购项目",
      projectCode: "APM-090",
      sourceTimestamps: { changeImpacts: "2026-08-08T01:30:00.000Z" }
    });
    expect(readiness).toMatchObject({
      scopes: [{ totalLines: 4, readyLines: 3 }]
    });
    for (const view of ["overview", "requirements", "tracking", "arrivals", "readiness"] as const) {
      const markup = renderToStaticMarkup(
        createElement(ProcurementPageContent, {
          projectId,
          state,
          view,
          onRetry: () => undefined
        })
      );
      expect(markup).toContain("生产采购项目");
    }
    const readinessMarkup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state,
        view: "readiness",
        onRetry: () => undefined
      })
    );
    expect(readinessMarkup).toContain("3/4 行");
    expect(readinessMarkup).toContain("未处置重大采购变更");
  });

  it("loads requirements, tracking, and arrivals from their real project routes", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      const request = new Request(url);
      const context = { params: Promise.resolve({ projectId }) };
      if (url.pathname.endsWith("/procurement/overview")) return getOverview(request, context);
      if (url.pathname.endsWith("/procurement/readiness")) return getReadiness(request, context);
      if (url.pathname.endsWith("/material-requirements")) return getRequirements(request, context);
      if (url.pathname.endsWith("/procurement-tracking-lines"))
        return getTracking(request, context);
      if (url.pathname.endsWith("/procurement/fulfillment-events"))
        return getArrivals(request, context);
      if (url.pathname.endsWith("/procurement/suppliers")) return getSuppliers(request, context);
      if (url.pathname.endsWith("/procurement/change-impacts")) {
        return getChangeImpacts(request, context);
      }
      throw new Error(`Unexpected procurement path: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await loadProcurementState(projectId);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/material-requirements?limit=100",
      { cache: "no-store" }
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/procurement-tracking-lines?limit=100",
      { cache: "no-store" }
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/procurement/fulfillment-events?limit=100",
      { cache: "no-store" }
    );
    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("expected ready procurement page state");

    const requirementsMarkup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state,
        view: "requirements",
        onRetry: () => undefined
      })
    );
    const trackingMarkup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state,
        view: "tracking",
        onRetry: () => undefined
      })
    );
    const arrivalsMarkup = renderToStaticMarkup(
      createElement(ProcurementPageContent, {
        projectId,
        state,
        view: "arrivals",
        onRetry: () => undefined
      })
    );

    expect(requirementsMarkup).toContain("伺服电机");
    expect(trackingMarkup).toContain("ORDERED");
    expect(arrivalsMarkup).toContain("PURCHASE_ARRIVED");
  });
});
