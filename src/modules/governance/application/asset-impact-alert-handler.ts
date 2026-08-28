import type { JobExecution, JobHandler } from "../contracts/jobs";
import type { JsonValue } from "../domain/idempotency";
import { projectAssetImpact } from "./alert-service";

const sourceEventTypes = [
  "asset.impact.assessed",
  "asset.impact.disposition-recorded",
  "asset.impact.risk-acceptance.decided",
  "project.asset-upgrade.adopted",
  "asset.impact.closed"
] as const;

export type AssetImpactSourceEventType = (typeof sourceEventTypes)[number];

function identity(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() && value.trim().length <= 191
    ? value.trim()
    : null;
}

function payload(job: JobExecution) {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new Error("资产影响预警投影负载无效。 ");
  }
  const value = job.payload as Record<string, JsonValue>;
  const projectId = identity(value.projectId);
  const impactId = identity(value.impactId);
  const eventAssessmentRevisionId =
    value.assessmentRevisionId === undefined ? null : identity(value.assessmentRevisionId);
  if (
    !projectId ||
    !impactId ||
    (value.assessmentRevisionId !== undefined && !eventAssessmentRevisionId)
  ) {
    throw new Error("资产影响预警投影负载无效。 ");
  }
  return { projectId, impactId, eventAssessmentRevisionId };
}

export function createAssetImpactAlertHandler(
  sourceEventType: AssetImpactSourceEventType,
  project: typeof projectAssetImpact = projectAssetImpact
): JobHandler {
  return async (job) => {
    await project({
      ...payload(job),
      sourceEventType,
      sourceJobId: job.id,
      jobAttemptId: job.attemptId,
      traceId: job.traceId ?? null
    });
  };
}
