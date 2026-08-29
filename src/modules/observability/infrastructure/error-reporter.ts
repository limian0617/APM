import { createHash } from "node:crypto";

import type {
  ErrorReport,
  ErrorReporter,
  LogFields,
  ObservabilityContext,
  ObservabilityMetrics,
  StructuredLogger
} from "../contracts/telemetry";
import { sanitizeLogFields, sanitizeTelemetry } from "../domain/sanitize";
import { observeSafely } from "../domain/safety";

export class MemoryErrorReporter implements ErrorReporter {
  readonly reports: ErrorReport[] = [];

  async capture(report: ErrorReport): Promise<void> {
    this.reports.push(report);
  }
}

export class LoggingErrorReporter implements ErrorReporter {
  constructor(private readonly logger: StructuredLogger) {}

  async capture(report: ErrorReport): Promise<void> {
    this.logger.error("error.reported", {
      fingerprint: report.fingerprint,
      error_name: report.name,
      message: report.message,
      stack: report.stack,
      context: report.context,
      metadata: report.metadata
    });
  }
}

export class HttpErrorReporter implements ErrorReporter {
  constructor(
    private readonly endpoint: URL,
    private readonly token: string | null,
    private readonly timeoutMs = 2000
  ) {}

  async capture(report: ErrorReport): Promise<void> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
      },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw new Error(`错误报告端点返回 HTTP ${response.status}。`);
  }
}

export function createErrorReporterFromEnvironment(
  logger: StructuredLogger,
  environment: NodeJS.ProcessEnv = process.env
): ErrorReporter {
  const endpoint = environment.OBSERVABILITY_ERROR_ENDPOINT?.trim();
  if (!endpoint) return new LoggingErrorReporter(logger);
  const url = new URL(endpoint);
  if (environment.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("生产错误报告端点必须使用 HTTPS。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("错误报告端点必须使用 HTTP 或 HTTPS。");
  }
  return new HttpErrorReporter(url, environment.OBSERVABILITY_ERROR_TOKEN?.trim() || null);
}

export function createErrorReport(
  error: unknown,
  context: ObservabilityContext,
  metadata: LogFields = {}
): ErrorReport {
  const source = error instanceof Error ? error : new Error("Unknown error");
  let rawName = "Error";
  let rawMessage = "Unknown error";
  let rawStack: string | null = null;
  try {
    rawName = source.name || rawName;
    rawMessage = source.message || rawMessage;
    rawStack = source.stack?.slice(0, 4096) ?? null;
  } catch {
    // A hostile Error subclass must not break reporting isolation.
  }
  const name = String(sanitizeTelemetry(rawName));
  const message = String(sanitizeTelemetry(rawMessage));
  const stack = rawStack ? String(sanitizeTelemetry(rawStack)) : null;
  const fingerprint = createHash("sha256")
    .update(`${context.module}\n${context.operation}\n${name}\n${message}`)
    .digest("hex");
  return {
    fingerprint,
    name,
    message,
    stack,
    context,
    metadata: sanitizeLogFields(metadata)
  };
}

export async function reportErrorSafely(input: {
  error: unknown;
  context: ObservabilityContext;
  metadata?: LogFields;
  reporter: ErrorReporter;
  logger: StructuredLogger;
  metrics: ObservabilityMetrics;
}): Promise<void> {
  const report = createErrorReport(input.error, input.context, input.metadata);
  try {
    await input.reporter.capture(report);
    observeSafely(() => {
      input.metrics.recordErrorReport({
        module: input.context.module,
        errorName: report.name,
        outcome: "reported"
      });
    });
  } catch (reportingError) {
    observeSafely(() => {
      input.metrics.recordErrorReport({
        module: input.context.module,
        errorName: report.name,
        outcome: "failed"
      });
    });
    observeSafely(() => {
      input.logger.warn("error.reporting_failed", {
        trace_id: input.context.traceId,
        module: input.context.module,
        operation: input.context.operation,
        reporter_error: reportingError
      });
    });
  }
}
