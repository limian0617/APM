import { describe, expect, it } from "vitest";

import { PrometheusMetrics, authorizeMetricsRequest } from "./metrics";

describe("PrometheusMetrics", () => {
  it("exports controlled HTTP, authorization, Worker, and readiness signals", async () => {
    const metrics = new PrometheusMetrics();
    metrics.recordHttp({
      module: "authorization",
      operation: "read-member",
      method: "GET",
      status: 403,
      durationSeconds: 0.125
    });
    metrics.recordWorker({
      jobType: "notification.email.requested",
      result: "dead_letter",
      durationSeconds: 1.5
    });
    metrics.recordReadiness("database", false);
    const output = await metrics.render();

    expect(output).toContain(
      'apm_http_requests_total{module="authorization",operation="read-member",method="GET",status_class="4xx",result="client_error",service="apm"} 1'
    );
    expect(output).toContain("apm_authorization_denials_total");
    expect(output).toContain(
      'apm_worker_jobs_total{job_type="notification.email.requested",result="dead_letter",service="apm"} 1'
    );
    expect(output).toContain('apm_readiness{dependency="database",service="apm"} 0');
    expect(output).not.toContain("trace_id");
  });
});

describe("authorizeMetricsRequest", () => {
  it("requires a configured bearer token in production", () => {
    const request = new Request("http://localhost/api/metrics", {
      headers: { authorization: "Bearer correct" }
    });
    expect(authorizeMetricsRequest(request, { NODE_ENV: "development" })).toEqual({
      authorized: true
    });
    expect(authorizeMetricsRequest(request, { NODE_ENV: "production" })).toMatchObject({
      authorized: false,
      status: 503
    });
    expect(
      authorizeMetricsRequest(request, {
        NODE_ENV: "production",
        OBSERVABILITY_METRICS_TOKEN: "correct"
      })
    ).toEqual({ authorized: true });
  });
});
