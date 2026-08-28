import { describe, expect, it } from "vitest";

import {
  ACCEPTANCE_REPORT_PAGE_FIXTURES,
  buildAcceptanceReportPageState,
  resolveAcceptanceReportFixture
} from "./acceptance-report-page-state";

describe("APM-102 report page state", () => {
  it("accepts only named development fixtures and ignores them in production", () => {
    expect(ACCEPTANCE_REPORT_PAGE_FIXTURES).toEqual([
      "normal",
      "loading",
      "empty",
      "error",
      "denied",
      "stale",
      "generating",
      "failed",
      "conflict"
    ]);
    expect(resolveAcceptanceReportFixture("generating", "development")).toBe("generating");
    expect(resolveAcceptanceReportFixture("arbitrary", "development")).toBeNull();
    expect(resolveAcceptanceReportFixture("generating", "production")).toBeNull();
  });

  it("keeps report generation and confirmation states explicit", () => {
    expect(
      buildAcceptanceReportPageState({
        projectId: "project-1",
        result: {
          status: 200,
          body: {
            projectId: "project-1",
            reports: [
              { id: "report-1", status: "GENERATING", projectId: "project-1" },
              { id: "report-2", status: "FAILED", projectId: "project-1" }
            ]
          },
          fetchedAt: "2026-08-09T10:00:00.000Z",
          stale: false,
          retryable: false
        }
      })
    ).toMatchObject({
      projectId: "project-1",
      status: "ready",
      reports: [
        { id: "report-1", status: "GENERATING" },
        { id: "report-2", status: "FAILED" }
      ]
    });
  });
});
