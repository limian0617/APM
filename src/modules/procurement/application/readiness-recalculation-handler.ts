import type { JobExecution, JobHandler } from "@/modules/governance/contracts/jobs";
import type { JsonValue } from "@/modules/governance/domain/idempotency";

import {
  READINESS_FORMULA_VERSION,
  ProcurementReadinessError,
  calculateAndPublishReadiness
} from "./readiness-service";

type RecalculationPayload = Readonly<{
  projectId: string;
  inputWatermark?: string;
  formulaVersion?: string;
}>;

function payload(job: JobExecution): RecalculationPayload {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new ProcurementReadinessError(
      "INVALID_READINESS_RECALCULATION_PAYLOAD",
      "采购齐套重算负载无效。"
    );
  }
  const value = job.payload as Record<string, JsonValue>;
  if (
    typeof value.projectId !== "string" ||
    !value.projectId.trim() ||
    (value.inputWatermark !== undefined &&
      (typeof value.inputWatermark !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.inputWatermark))) ||
    (value.formulaVersion !== undefined &&
      (typeof value.formulaVersion !== "string" ||
        !value.formulaVersion.trim() ||
        value.formulaVersion !== READINESS_FORMULA_VERSION)) ||
    (value.inputWatermark === undefined) !== (value.formulaVersion === undefined)
  ) {
    throw new ProcurementReadinessError(
      "INVALID_READINESS_RECALCULATION_PAYLOAD",
      "采购齐套重算负载无效。"
    );
  }
  return {
    projectId: value.projectId.trim(),
    ...(value.inputWatermark === undefined
      ? {}
      : { inputWatermark: value.inputWatermark, formulaVersion: value.formulaVersion })
  };
}

export function createReadinessRecalculationHandler(): JobHandler {
  return async (job) => {
    const input = payload(job);
    await calculateAndPublishReadiness({
      ...input,
      auditContext: {
        actorId: null,
        requestId: null,
        traceId: job.traceId ?? null,
        source: "WORKER",
        sourceIp: null,
        userAgent: null,
        reason: null,
        projectId: input.projectId,
        departmentId: null,
        operationId: job.id
      }
    });
  };
}
