export type ObservabilityContext = {
  traceId: string;
  requestId: string | null;
  jobId: string | null;
  actorId: string | null;
  projectId: string | null;
  module: string;
  operation: string;
};

export type LogFields = Readonly<Record<string, unknown>>;

export interface StructuredLogger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export type ErrorReport = {
  fingerprint: string;
  name: string;
  message: string;
  stack: string | null;
  context: ObservabilityContext;
  metadata: LogFields;
};

export interface ErrorReporter {
  capture(report: ErrorReport): Promise<void>;
}

export interface ObservabilityMetrics {
  recordHttp(input: {
    module: string;
    operation: string;
    method: string;
    status: number;
    durationSeconds: number;
  }): void;
  recordWorker(input: {
    jobType: string;
    result: "succeeded" | "retry_scheduled" | "dead_letter" | "observer_failed";
    durationSeconds: number;
  }): void;
  recordErrorReport(input: {
    module: string;
    errorName: string;
    outcome: "reported" | "failed";
  }): void;
  recordReadiness(dependency: string, ready: boolean): void;
}
