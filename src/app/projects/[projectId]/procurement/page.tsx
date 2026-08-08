import { ProcurementPageClient } from "./procurement-page-client";
import {
  buildProcurementPageState,
  resolveProcurementFixture,
  toProcurementFetchResult,
  type ProcurementPageState
} from "@/modules/procurement/contracts/procurement-page-state";

type PageProps = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ fixture?: string }>;
};

const fixtureTimestamp = "2026-08-08T03:00:00.000Z";

function developmentProcurementFixture(
  projectId: string,
  fixture: string | undefined
): ProcurementPageState | null {
  const allowed = resolveProcurementFixture(fixture, "development");
  if (!allowed) return null;
  if (allowed === "loading") return { projectId, status: "loading" };
  if (allowed === "denied") {
    return buildProcurementPageState({
      projectId,
      overview: toProcurementFetchResult({ status: 403, body: { secret: "redacted" } }),
      readiness: toProcurementFetchResult({ status: 200, body: { status: "EMPTY" } })
    });
  }
  if (allowed === "error") {
    return buildProcurementPageState({
      projectId,
      overview: toProcurementFetchResult({ status: 503, body: { code: "TEMPORARY" } }),
      readiness: toProcurementFetchResult({ status: 200, body: { status: "EMPTY" } })
    });
  }

  const overviewStatus = allowed === "empty" ? "EMPTY" : allowed === "stale" ? "STALE" : "READY";
  const readinessStatus =
    allowed === "pending" ? "PENDING" : allowed === "failed" ? "FAILED" : overviewStatus;
  const overview = {
    projectId,
    projectName: "装配线升级项目",
    projectCode: "APM-DEMO-090",
    mode: "LOCAL",
    status: overviewStatus,
    overallReadinessRate: 0.75,
    criticalReadinessRate: 0.5,
    notOrderedCount: 2,
    overdueCount: 1,
    pendingAcceptanceCount: 1,
    changePendingCount: 1,
    blockingCount: 1,
    sourceSyncedAt: fixtureTimestamp,
    requirements: [{ id: "req-1", name: "伺服电机", status: "CONFIRMED" }],
    tracking: [
      { id: "track-1", requirementId: "req-1", status: "ORDERED", promisedOn: "2026-08-20" }
    ],
    arrivals: [
      { id: "event-1", eventType: "PURCHASE_ARRIVED", businessOccurredAt: fixtureTimestamp }
    ]
  };
  const readiness = {
    projectId,
    status: readinessStatus,
    formulaVersion: "PROC-READINESS-1",
    inputWatermark: "wm-demo",
    calculatedAt: fixtureTimestamp,
    sourceSyncedAt: fixtureTimestamp,
    scopes: [{ scopeType: "PROJECT", scopeId: projectId, lineCount: 4, readyLineCount: 3 }]
  };
  return buildProcurementPageState({
    projectId,
    overview: toProcurementFetchResult({ status: 200, body: overview }),
    readiness: toProcurementFetchResult({ status: 200, body: readiness }),
    suppliers:
      allowed === "partial-denied"
        ? toProcurementFetchResult({ status: 403, body: { supplierId: "redacted" } })
        : toProcurementFetchResult({ status: 200, body: { items: [] } })
  });
}

export default async function ProcurementPage({ params, searchParams }: PageProps) {
  const { projectId } = await params;
  const { fixture } = await searchParams;
  const initialState =
    process.env.NODE_ENV === "production"
      ? null
      : developmentProcurementFixture(projectId, fixture);
  return <ProcurementPageClient projectId={projectId} initialState={initialState} />;
}
