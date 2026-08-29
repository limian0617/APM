import type { ErrorReporter, ObservabilityMetrics, StructuredLogger } from "../contracts/telemetry";
import { createErrorReporterFromEnvironment } from "./error-reporter";
import { PrometheusMetrics } from "./metrics";
import { createStructuredLogger } from "./structured-logger";

type ObservabilityRuntime = {
  logger: StructuredLogger;
  metrics: PrometheusMetrics;
  reporter: ErrorReporter;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  apmObservability?: ObservabilityRuntime;
};

function createRuntime(): ObservabilityRuntime {
  const logger = createStructuredLogger();
  return {
    logger,
    metrics: new PrometheusMetrics(),
    reporter: createErrorReporterFromEnvironment(logger)
  };
}

export const observabilityRuntime = runtimeGlobal.apmObservability ?? createRuntime();

if (process.env.NODE_ENV !== "production") runtimeGlobal.apmObservability = observabilityRuntime;

export type RuntimeMetrics = ObservabilityMetrics;
