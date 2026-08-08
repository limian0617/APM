import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getChangeImpacts } from "@/app/api/projects/[projectId]/procurement/change-impacts/route";
import { GET as getOverview } from "@/app/api/projects/[projectId]/procurement/overview/route";
import { GET as getReadiness } from "@/app/api/projects/[projectId]/procurement/readiness/route";
import {
  buildProcurementPageState,
  toProcurementFetchResult
} from "@/modules/procurement/contracts/procurement-page-state";

import { ProcurementPageContent } from "./procurement-page-client";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const readinessService = vi.hoisted(() => ({
  readProjectProcurementOverview: vi.fn(),
  readProcurementReadinessTree: vi.fn()
}));
const changeImpactService = vi.hoisted(() => ({ listProcurementChangeImpacts: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/procurement/application/readiness-service", () => readinessService);
vi.mock("@/modules/procurement/application/change-impact-service", () => changeImpactService);

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
});
