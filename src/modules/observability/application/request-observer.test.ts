import { describe, expect, it } from "vitest";

import { auditContextFromRequest } from "@/modules/audit/application/context";

import type {
  ErrorReporter,
  LogFields,
  ObservabilityMetrics,
  StructuredLogger
} from "../contracts/telemetry";
import { MemoryErrorReporter } from "../infrastructure/error-reporter";
import { PrometheusMetrics } from "../infrastructure/metrics";
import { currentObservabilityContext } from "./context";
import { withRequestObservability } from "./request-observer";

class MemoryLogger implements StructuredLogger {
  readonly records: Array<{ level: string; event: string; fields: LogFields }> = [];
  info(event: string, fields: LogFields = {}) {
    this.records.push({ level: "info", event, fields });
  }
  warn(event: string, fields: LogFields = {}) {
    this.records.push({ level: "warn", event, fields });
  }
  error(event: string, fields: LogFields = {}) {
    this.records.push({ level: "error", event, fields });
  }
}

describe("withRequestObservability", () => {
  it("propagates generated IDs through request context, audit headers, response, logs, and metrics", async () => {
    const logger = new MemoryLogger();
    const metrics = new PrometheusMetrics();
    const reporter = new MemoryErrorReporter();
    const ids = ["request-generated", "trace-seed"];
    const times = [1000, 1125];
    const handler = withRequestObservability(
      { module: "projects", operation: "read-members" },
      async (request: Request) => {
        const context = currentObservabilityContext();
        expect(context).toMatchObject({
          requestId: "request-generated",
          projectId: "project-1",
          module: "projects",
          operation: "read-members"
        });
        expect(auditContextFromRequest(request, { actorId: null })).toMatchObject({
          requestId: "request-generated",
          traceId: context?.traceId
        });
        return Response.json({ ok: true });
      },
      {
        logger,
        metrics,
        reporter,
        now: () => times.shift()!,
        createId: () => ids.shift()!
      }
    );

    const response = await handler(
      new Request("http://localhost/api/projects/project-1/members", {
        headers: { "x-request-id": "unsafe request" }
      }),
      undefined
    );
    expect(response.headers.get("x-request-id")).toBe("request-generated");
    expect(response.headers.get("x-trace-id")).toMatch(/^[0-9a-f]{32}$/u);
    expect(logger.records).toContainEqual(
      expect.objectContaining({
        event: "request.completed",
        fields: expect.objectContaining({ result: "success", duration_ms: 125 })
      })
    );
    expect(await metrics.render()).toContain("apm_http_requests_total");
    expect(reporter.reports).toHaveLength(0);
  });

  it("reports a sanitized server error without changing the response", async () => {
    const logger = new MemoryLogger();
    const metrics = new PrometheusMetrics();
    const reporter = new MemoryErrorReporter();
    const handler = withRequestObservability(
      { module: "health", operation: "read-ready" },
      async () => Response.json({ status: "not_ready" }, { status: 503 }),
      { logger, metrics, reporter, now: () => 1000, createId: () => "safe-id" }
    );
    const response = await handler(new Request("http://localhost/api/ready"), undefined);
    expect(response.status).toBe(503);
    expect(reporter.reports).toHaveLength(1);
    expect(reporter.reports[0]).toMatchObject({
      context: { module: "health", operation: "read-ready" },
      message: "HTTP 503"
    });
  });

  it("preserves a POST body when correlation headers are injected", async () => {
    const logger = new MemoryLogger();
    const metrics = new PrometheusMetrics();
    const reporter = new MemoryErrorReporter();
    const handler = withRequestObservability(
      { module: "test", operation: "read-body" },
      async (request: Request) => Response.json(await request.json()),
      { logger, metrics, reporter, now: () => 1000, createId: () => "safe-id" }
    );
    const response = await handler(
      new Request("http://localhost/api/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 42 })
      })
    );
    await expect(response.json()).resolves.toEqual({ value: 42 });
  });

  it("normalizes client errors with field and correlation details", async () => {
    const logger = new MemoryLogger();
    const metrics = new PrometheusMetrics();
    const reporter = new MemoryErrorReporter();
    const ids = ["request-error", "trace-error"];
    const handler = withRequestObservability(
      { module: "test", operation: "validation-error" },
      async () =>
        Response.json(
          {
            error: {
              code: "VALIDATION_FAILED",
              message: "请求参数未通过校验。",
              issues: [{ field: "body.version", code: "INVALID_TYPE", message: "类型无效。" }]
            }
          },
          { status: 422 }
        ),
      { logger, metrics, reporter, now: () => 1000, createId: () => ids.shift()! }
    );

    const response = await handler(new Request("http://localhost/api/test"));
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "请求参数未通过校验。",
        issues: [{ field: "body.version", code: "INVALID_TYPE", message: "类型无效。" }],
        requestId: "request-error",
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/u)
      }
    });
  });

  it("returns a safe correlated 500 instead of exposing an unhandled error", async () => {
    const logger = new MemoryLogger();
    const metrics = new PrometheusMetrics();
    const reporter = new MemoryErrorReporter();
    const ids = ["request-failure", "trace-failure"];
    const handler = withRequestObservability(
      { module: "test", operation: "server-error" },
      async () => {
        throw new Error("database password must stay private");
      },
      { logger, metrics, reporter, now: () => 1000, createId: () => ids.shift()! }
    );

    const response = await handler(new Request("http://localhost/api/test"));
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        issues: [],
        requestId: "request-failure",
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/u)
      }
    });
    expect(JSON.stringify(payload)).not.toContain("database password");
    expect(reporter.reports).toHaveLength(1);
  });

  it("does not change the HTTP result when every telemetry adapter fails", async () => {
    const fail = () => {
      throw new Error("telemetry unavailable");
    };
    const logger: StructuredLogger = { info: fail, warn: fail, error: fail };
    const metrics: ObservabilityMetrics = {
      recordHttp: fail,
      recordWorker: fail,
      recordErrorReport: fail,
      recordReadiness: fail
    };
    const reporter: ErrorReporter = {
      async capture() {
        fail();
      }
    };
    const handler = withRequestObservability(
      { module: "test", operation: "telemetry-failure" },
      async () => Response.json({ preserved: true }, { status: 503 }),
      { logger, metrics, reporter, now: () => 1000, createId: () => "safe-id" }
    );
    const response = await handler(new Request("http://localhost/api/test"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ preserved: true });
  });
});
