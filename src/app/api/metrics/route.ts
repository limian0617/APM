import { withRequestObservability } from "@/modules/observability/application/request-observer";
import { observeSafely } from "@/modules/observability/domain/safety";
import { authorizeMetricsRequest } from "@/modules/observability/infrastructure/metrics";
import { observabilityRuntime } from "@/modules/observability/infrastructure/runtime";

async function metrics(request: Request) {
  const authorization = authorizeMetricsRequest(request);
  if (!authorization.authorized) {
    return Response.json(
      { error: { code: authorization.code, message: "指标端点不可用或身份无效。" } },
      { status: authorization.status }
    );
  }

  await observabilityRuntime.metrics.refreshDatabaseMetrics().catch((error: unknown) => {
    observeSafely(() => {
      observabilityRuntime.logger.warn("metrics.database_collection_failed", { error });
    });
  });
  return new Response(await observabilityRuntime.metrics.render(), {
    headers: { "content-type": observabilityRuntime.metrics.registry.contentType }
  });
}

export const GET = withRequestObservability(
  { module: "observability", operation: "metrics" },
  metrics
);
