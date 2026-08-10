import { AcceptancePageClient } from "./acceptance-page-client";
import {
  buildAcceptancePageState,
  resolveAcceptanceFixture,
  toAcceptanceFetchResult,
  type AcceptancePageState
} from "@/modules/acceptance/contracts/acceptance-page-state";
import {
  buildAcceptanceReportPageState,
  resolveAcceptanceReportFixture,
  type AcceptanceReportPageState
} from "@/modules/acceptance/contracts/acceptance-report-page-state";

type PageProps = Readonly<{
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ fixture?: string }>;
}>;

const fixtureTimestamp = "2026-08-09T04:00:00.000Z";

export function developmentAcceptanceFixture(
  projectId: string,
  fixture: string | undefined
): AcceptancePageState | null {
  const allowed = resolveAcceptanceFixture(fixture, "development");
  if (!allowed) return null;
  if (allowed === "loading") return { projectId, status: "loading" };
  if (allowed === "denied") {
    return buildAcceptancePageState({
      projectId,
      templates: toAcceptanceFetchResult({ status: 403, body: { restricted: true } }),
      batches: toAcceptanceFetchResult({ status: 200, body: { batches: [] } })
    });
  }
  if (allowed === "error") {
    return buildAcceptancePageState({
      projectId,
      templates: toAcceptanceFetchResult({ status: 503 }),
      batches: toAcceptanceFetchResult({ status: 200, body: { batches: [] } })
    });
  }
  const templates =
    allowed === "empty"
      ? []
      : [
          {
            id: "acceptance-template-demo",
            acceptanceType: allowed === "offline" ? "SAT" : "FAT",
            version: 1,
            template: {
              code: allowed === "offline" ? "SAT.DEMO" : "FAT.DEMO",
              name: allowed === "offline" ? "SAT 离线草稿演示模板" : "FAT 演示模板"
            },
            items: [{ id: "acceptance-item-demo", unit: "V" }]
          }
        ];
  const batches =
    allowed === "empty"
      ? []
      : [
          {
            id: "acceptance-batch-demo",
            projectId,
            acceptanceType: allowed === "offline" ? "SAT" : "FAT",
            scopeType: "MACHINE",
            scopeId: "machine-demo",
            status: allowed === "offline" ? "IN_PROGRESS" : "LOCKED",
            version: allowed === "offline" ? 2 : 3
          }
        ];
  return buildAcceptancePageState({
    projectId,
    templates: toAcceptanceFetchResult({
      status: 200,
      body: { templates },
      fetchedAt: fixtureTimestamp,
      stale: allowed === "stale"
    }),
    batches: toAcceptanceFetchResult({
      status: 200,
      body: {
        batches,
        allowedActions: ["CREATE_BATCH", "RECORD_RESULT", "REVISE_RESULT", "LOCK_BATCH"]
      },
      fetchedAt: fixtureTimestamp
    }),
    batchDetail:
      batches.length === 0
        ? undefined
        : toAcceptanceFetchResult({
            status: 200,
            fetchedAt: fixtureTimestamp,
            body: {
              batch: {
                ...batches[0],
                templateVersion: {
                  items: [
                    {
                      id: "acceptance-item-demo",
                      code: "POWER",
                      name: "通电检查",
                      unit: "V",
                      required: true,
                      evidenceRequired: true
                    }
                  ]
                },
                results: [
                  {
                    itemId: "acceptance-item-demo",
                    revisions:
                      allowed === "offline"
                        ? []
                        : [
                            {
                              id: "acceptance-revision-demo",
                              decision: "PASS",
                              measuredValue: "230V",
                              measuredUnit: "V"
                            }
                          ]
                  }
                ]
              },
              summary:
                allowed === "offline"
                  ? { passRate: null, denominator: 0, outcome: "NOT_CALCULABLE" }
                  : { passRate: 1, denominator: 1, outcome: "PASS" },
              allowedActions:
                allowed === "offline" ? ["RECORD_RESULT", "REVISE_RESULT", "LOCK_BATCH"] : []
            }
          })
  });
}

export function developmentAcceptanceReportFixture(
  projectId: string,
  fixture: string | undefined
): AcceptanceReportPageState | null {
  const allowed = resolveAcceptanceReportFixture(fixture, "development");
  if (!allowed) return null;
  if (allowed === "loading") return { projectId, status: "loading" };
  if (allowed === "denied") return { projectId, status: "denied" };
  if (allowed === "error") return { projectId, status: "error", retryable: true };
  const reports =
    allowed === "empty"
      ? []
      : [
          {
            id: "acceptance-report-demo",
            projectId,
            reportNumber: "APM-FAT-DEMO",
            reportVersion: 1,
            acceptanceType: "FAT",
            scopeType: "PROJECT",
            scopeId: projectId,
            status:
              allowed === "generating" ? "GENERATING" : allowed === "failed" ? "FAILED" : "READY",
            snapshotChecksum: "a".repeat(64),
            pdfSha256: "b".repeat(64),
            generatedAt: fixtureTimestamp,
            confirmations: []
          }
        ];
  return buildAcceptanceReportPageState({
    projectId,
    result: {
      status: 200,
      body: {
        projectId,
        reports,
        allowedActions: ["GENERATE_REPORT", "RECORD_CONFIRMATION"]
      },
      fetchedAt: fixtureTimestamp,
      stale: allowed === "stale",
      retryable: false
    }
  });
}

export default async function AcceptancePage({ params, searchParams }: PageProps) {
  const { projectId } = await params;
  const { fixture } = await searchParams;
  const initialState =
    process.env.NODE_ENV === "production" ? null : developmentAcceptanceFixture(projectId, fixture);
  const initialReportState =
    process.env.NODE_ENV === "production"
      ? null
      : developmentAcceptanceReportFixture(projectId, fixture);
  return (
    <AcceptancePageClient
      projectId={projectId}
      initialState={initialState}
      initialReportState={initialReportState}
    />
  );
}
