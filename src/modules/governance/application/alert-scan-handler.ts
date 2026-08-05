import type { JobExecution, JobHandler } from "../contracts/jobs";
import type { JsonValue } from "../domain/idempotency";
import { runProjectAlertScan } from "./alert-service";

function payload(job: JobExecution): { projectId: string; scanId: string } {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload))
    throw new Error("预警扫描负载无效。 ");
  const value = job.payload as Record<string, JsonValue>;
  if (
    typeof value.projectId !== "string" ||
    typeof value.scanId !== "string" ||
    !value.projectId ||
    !value.scanId
  )
    throw new Error("预警扫描负载无效。 ");
  return { projectId: value.projectId, scanId: value.scanId };
}

export function createAlertScanHandler(): JobHandler {
  return async (job) => {
    await runProjectAlertScan(payload(job));
  };
}
