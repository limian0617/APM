import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { observeSafely } from "@/modules/observability/domain/safety";
import { observabilityRuntime } from "@/modules/observability/infrastructure/runtime";
import {
  checkReadiness,
  databaseReadinessProbes
} from "@/modules/observability/infrastructure/readiness";

async function readiness() {
  const result = await checkReadiness({ probes: databaseReadinessProbes() });
  for (const check of result.checks) {
    observeSafely(() => {
      observabilityRuntime.metrics.recordReadiness(check.name, check.status === "ready");
    });
  }
  return Response.json(result, { status: result.status === "ready" ? 200 : 503 });
}

export const GET = withRequestObservability(
  { module: "health", operation: "readiness" },
  readiness
);
