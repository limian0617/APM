import { AcceptancePageClient } from "./acceptance-page-client";
import {
  buildAcceptancePageState,
  resolveAcceptanceFixture,
  toAcceptanceFetchResult,
  type AcceptancePageState
} from "@/modules/acceptance/contracts/acceptance-page-state";

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
            acceptanceType: "FAT",
            version: 1,
            template: { code: "FAT.DEMO", name: "FAT 演示模板" },
            items: [{ id: "acceptance-item-demo" }]
          }
        ];
  const batches =
    allowed === "empty"
      ? []
      : [
          {
            id: "acceptance-batch-demo",
            projectId,
            acceptanceType: "FAT",
            scopeType: "MACHINE",
            scopeId: "machine-demo",
            status: "IN_PROGRESS",
            version: 2
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
                    revisions: [
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
              summary: { passRate: 1, denominator: 1, outcome: "PASS" },
              allowedActions: ["RECORD_RESULT", "REVISE_RESULT", "LOCK_BATCH"]
            }
          })
  });
}

export default async function AcceptancePage({ params, searchParams }: PageProps) {
  const { projectId } = await params;
  const { fixture } = await searchParams;
  const initialState =
    process.env.NODE_ENV === "production" ? null : developmentAcceptanceFixture(projectId, fixture);
  return <AcceptancePageClient projectId={projectId} initialState={initialState} />;
}
