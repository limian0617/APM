import { timingSafeEqual } from "node:crypto";

import { Counter, Gauge, Histogram, Registry } from "prom-client";

import { db } from "@/lib/db";

import type { ObservabilityMetrics } from "../contracts/telemetry";

const LABEL = /^[a-z][a-z0-9_.-]{0,99}$/u;

class BoundedLabels {
  private readonly values = new Map<string, Set<string>>();

  value(dimension: string, candidate: string, maximum = 100): string {
    const normalized = candidate.trim().toLowerCase();
    if (!LABEL.test(normalized)) return "other";
    const values = this.values.get(dimension) ?? new Set<string>();
    this.values.set(dimension, values);
    if (values.has(normalized)) return normalized;
    if (values.size >= maximum) return "other";
    values.add(normalized);
    return normalized;
  }
}

export class PrometheusMetrics implements ObservabilityMetrics {
  readonly registry: Registry;
  private readonly labels = new BoundedLabels();
  private readonly httpRequests: Counter;
  private readonly httpDuration: Histogram;
  private readonly authorizationDenials: Counter;
  private readonly workerJobs: Counter;
  private readonly workerDuration: Histogram;
  private readonly errorReports: Counter;
  private readonly readiness: Gauge;
  private readonly queueDepth: Gauge;
  private readonly oldestWaiting: Gauge;
  private readonly fileStates: Gauge;
  private readonly notificationDeliveryStates: Gauge;
  private readonly collectionFailures: Counter;

  constructor(registry = new Registry()) {
    this.registry = registry;
    this.registry.setDefaultLabels({ service: "apm" });
    this.httpRequests = new Counter({
      name: "apm_http_requests_total",
      help: "Completed APM HTTP requests.",
      labelNames: ["module", "operation", "method", "status_class", "result"],
      registers: [registry]
    });
    this.httpDuration = new Histogram({
      name: "apm_http_request_duration_seconds",
      help: "APM HTTP request duration in seconds.",
      labelNames: ["module", "operation", "method"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry]
    });
    this.authorizationDenials = new Counter({
      name: "apm_authorization_denials_total",
      help: "HTTP authorization denials returned by APM.",
      labelNames: ["module", "operation"],
      registers: [registry]
    });
    this.workerJobs = new Counter({
      name: "apm_worker_jobs_total",
      help: "Completed APM Worker job attempts.",
      labelNames: ["job_type", "result"],
      registers: [registry]
    });
    this.workerDuration = new Histogram({
      name: "apm_worker_job_duration_seconds",
      help: "APM Worker job duration in seconds.",
      labelNames: ["job_type"],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 15, 30, 60, 300],
      registers: [registry]
    });
    this.errorReports = new Counter({
      name: "apm_error_reports_total",
      help: "APM error report attempts.",
      labelNames: ["module", "error_name", "outcome"],
      registers: [registry]
    });
    this.readiness = new Gauge({
      name: "apm_readiness",
      help: "Whether an APM readiness dependency is ready.",
      labelNames: ["dependency"],
      registers: [registry]
    });
    this.queueDepth = new Gauge({
      name: "apm_worker_queue_depth",
      help: "Persistent jobs by state.",
      labelNames: ["status"],
      registers: [registry]
    });
    this.oldestWaiting = new Gauge({
      name: "apm_worker_oldest_wait_seconds",
      help: "Age of the oldest due persistent job.",
      registers: [registry]
    });
    this.fileStates = new Gauge({
      name: "apm_file_objects",
      help: "File objects by processing state.",
      labelNames: ["status"],
      registers: [registry]
    });
    this.notificationDeliveryStates = new Gauge({
      name: "apm_notification_deliveries",
      help: "Notification deliveries by state.",
      labelNames: ["status"],
      registers: [registry]
    });
    this.collectionFailures = new Counter({
      name: "apm_observability_collection_failures_total",
      help: "Failures while collecting operational metrics.",
      labelNames: ["collector"],
      registers: [registry]
    });
  }

  recordHttp(input: {
    module: string;
    operation: string;
    method: string;
    status: number;
    durationSeconds: number;
  }): void {
    const moduleLabel = this.labels.value("module", input.module);
    const operation = this.labels.value("operation", input.operation);
    const suppliedMethod = input.method.toUpperCase();
    const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
      suppliedMethod
    )
      ? suppliedMethod
      : "OTHER";
    const statusClass = `${Math.floor(input.status / 100)}xx`;
    const result =
      input.status >= 500 ? "server_error" : input.status >= 400 ? "client_error" : "success";
    this.httpRequests.inc({
      module: moduleLabel,
      operation,
      method,
      status_class: statusClass,
      result
    });
    this.httpDuration.observe(
      { module: moduleLabel, operation, method },
      Math.max(0, input.durationSeconds)
    );
    if (input.status === 403) {
      this.authorizationDenials.inc({ module: moduleLabel, operation });
    }
  }

  recordWorker(input: {
    jobType: string;
    result: "succeeded" | "retry_scheduled" | "dead_letter" | "observer_failed";
    durationSeconds: number;
  }): void {
    const jobType = this.labels.value("job_type", input.jobType);
    this.workerJobs.inc({ job_type: jobType, result: input.result });
    this.workerDuration.observe({ job_type: jobType }, Math.max(0, input.durationSeconds));
  }

  recordErrorReport(input: {
    module: string;
    errorName: string;
    outcome: "reported" | "failed";
  }): void {
    this.errorReports.inc({
      module: this.labels.value("module", input.module),
      error_name: this.labels.value("error_name", input.errorName),
      outcome: input.outcome
    });
  }

  recordReadiness(dependency: string, ready: boolean): void {
    this.readiness.set({ dependency: this.labels.value("dependency", dependency) }, ready ? 1 : 0);
  }

  async refreshDatabaseMetrics(now = new Date()): Promise<void> {
    try {
      const [jobs, oldest, files, deliveries] = await Promise.all([
        db.persistentJob.groupBy({ by: ["status"], _count: { _all: true } }),
        db.persistentJob.aggregate({
          where: { status: { in: ["PENDING", "RETRY_SCHEDULED"] }, nextRunAt: { lte: now } },
          _min: { nextRunAt: true }
        }),
        db.fileObject.groupBy({ by: ["status"], _count: { _all: true } }),
        db.notificationDelivery.groupBy({ by: ["status"], _count: { _all: true } })
      ]);
      this.queueDepth.reset();
      for (const status of ["pending", "running", "retry_scheduled", "succeeded", "dead_letter"]) {
        this.queueDepth.set({ status }, 0);
      }
      for (const row of jobs)
        this.queueDepth.set({ status: row.status.toLowerCase() }, row._count._all);
      const oldestAt = oldest._min.nextRunAt;
      this.oldestWaiting.set(
        oldestAt ? Math.max(0, (now.getTime() - oldestAt.getTime()) / 1000) : 0
      );
      this.fileStates.reset();
      for (const status of ["uploading", "pending_scan", "available", "quarantined", "failed"]) {
        this.fileStates.set({ status }, 0);
      }
      for (const row of files) {
        this.fileStates.set({ status: row.status.toLowerCase() }, row._count._all);
      }
      this.notificationDeliveryStates.reset();
      for (const status of ["pending", "retrying", "sent", "dead_letter"]) {
        this.notificationDeliveryStates.set({ status }, 0);
      }
      for (const row of deliveries) {
        this.notificationDeliveryStates.set({ status: row.status.toLowerCase() }, row._count._all);
      }
    } catch (error) {
      this.collectionFailures.inc({ collector: "database" });
      throw error;
    }
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}

type MetricsEnvironment = { NODE_ENV?: string; OBSERVABILITY_METRICS_TOKEN?: string };

function secretsMatch(expected: string, supplied: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

export function authorizeMetricsRequest(
  request: Request,
  environment: MetricsEnvironment = process.env
): { authorized: true } | { authorized: false; status: 401 | 503; code: string } {
  if (environment.NODE_ENV !== "production") return { authorized: true };
  const expected = environment.OBSERVABILITY_METRICS_TOKEN;
  if (!expected) return { authorized: false, status: 503, code: "METRICS_NOT_CONFIGURED" };
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return secretsMatch(expected, supplied)
    ? { authorized: true }
    : { authorized: false, status: 401, code: "METRICS_UNAUTHORIZED" };
}
