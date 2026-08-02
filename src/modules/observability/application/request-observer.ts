import type {
  ErrorReporter,
  ObservabilityContext,
  ObservabilityMetrics,
  StructuredLogger
} from "../contracts/telemetry";
import { createCorrelationIds, normalizeRequestId } from "../domain/correlation";
import { observeSafely } from "../domain/safety";
import { reportErrorSafely } from "../infrastructure/error-reporter";
import { observabilityRuntime } from "../infrastructure/runtime";
import { runWithObservabilityContext } from "./context";

const STABLE_NAME = /^[a-z][a-z0-9_.-]{0,99}$/u;

export type RouteObservation = { module: string; operation: string };

export type RequestObserverDependencies = {
  logger: StructuredLogger;
  metrics: ObservabilityMetrics;
  reporter: ErrorReporter;
  now: () => number;
  createId?: () => string;
};

type RouteHandler<TContext> = (request: Request, context: TContext) => Response | Promise<Response>;
type ObservedRouteHandler<TContext> = (
  request: Request,
  context?: TContext
) => Response | Promise<Response>;

function stableMetadata(metadata: RouteObservation): RouteObservation {
  if (!STABLE_NAME.test(metadata.module) || !STABLE_NAME.test(metadata.operation)) {
    throw new TypeError("可观测模块和操作名必须是稳定的低基数标识。 ");
  }
  return metadata;
}

function projectIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/projects\/([^/]+)/u);
  if (!match) return null;
  try {
    const value = decodeURIComponent(match[1]!).trim();
    return value && value.length <= 191 ? value : null;
  } catch {
    return null;
  }
}

function observedResponse(response: Response, requestId: string, traceId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  headers.set("x-trace-id", traceId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function requestResult(status: number): "success" | "client_error" | "server_error" {
  return status >= 500 ? "server_error" : status >= 400 ? "client_error" : "success";
}

export function withRequestObservability<TContext>(
  observation: RouteObservation,
  handler: RouteHandler<TContext>,
  dependencies: RequestObserverDependencies = {
    ...observabilityRuntime,
    now: () => performance.now()
  }
): ObservedRouteHandler<TContext> {
  const metadata = stableMetadata(observation);
  return async (request, routeContext) => {
    const startedAt = dependencies.now();
    const { requestId, traceId } = createCorrelationIds(request.headers, dependencies.createId);
    const url = new URL(request.url);
    const context: ObservabilityContext = {
      traceId,
      requestId,
      jobId: null,
      actorId: normalizeRequestId(request.headers.get("x-apm-user-id")),
      projectId: projectIdFromPath(url.pathname),
      module: metadata.module,
      operation: metadata.operation
    };
    return runWithObservabilityContext(context, async () => {
      try {
        const response = await handler(request, routeContext as TContext);
        const durationSeconds = Math.max(0, dependencies.now() - startedAt) / 1000;
        observeSafely(() => {
          dependencies.metrics.recordHttp({
            module: metadata.module,
            operation: metadata.operation,
            method: request.method,
            status: response.status,
            durationSeconds
          });
        });
        observeSafely(() => {
          dependencies.logger.info("request.completed", {
            trace_id: traceId,
            request_id: requestId,
            actor: context.actorId,
            project_id: context.projectId,
            module: metadata.module,
            operation: metadata.operation,
            method: request.method,
            path: url.pathname,
            status: response.status,
            duration_ms: Math.round(durationSeconds * 1000),
            result: requestResult(response.status)
          });
        });
        if (response.status >= 500) {
          await reportErrorSafely({
            error: new Error(`HTTP ${response.status}`),
            context,
            metadata: { method: request.method, path: url.pathname, status: response.status },
            reporter: dependencies.reporter,
            logger: dependencies.logger,
            metrics: dependencies.metrics
          });
        }
        return observedResponse(response, requestId, traceId);
      } catch (error) {
        const durationSeconds = Math.max(0, dependencies.now() - startedAt) / 1000;
        observeSafely(() => {
          dependencies.metrics.recordHttp({
            module: metadata.module,
            operation: metadata.operation,
            method: request.method,
            status: 500,
            durationSeconds
          });
        });
        observeSafely(() => {
          dependencies.logger.error("request.failed", {
            trace_id: traceId,
            request_id: requestId,
            actor: context.actorId,
            project_id: context.projectId,
            module: metadata.module,
            operation: metadata.operation,
            method: request.method,
            path: url.pathname,
            status: 500,
            duration_ms: Math.round(durationSeconds * 1000),
            result: "server_error",
            error
          });
        });
        await reportErrorSafely({
          error,
          context,
          metadata: { method: request.method, path: url.pathname },
          reporter: dependencies.reporter,
          logger: dependencies.logger,
          metrics: dependencies.metrics
        });
        throw error;
      }
    });
  };
}
