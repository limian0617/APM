import { db } from "@/lib/db";
import {
  RUNTIME_SETTING_DEFINITIONS,
  validateRuntimeSettingValue
} from "@/modules/configuration/domain/definitions";
import { randomUUID } from "node:crypto";

import type { JobExecution, JobHandler, WorkerPolicy } from "@/modules/governance/contracts/jobs";
import {
  claimJobs,
  completeClaimedJob,
  failClaimedJob,
  materializeOutboxEvents
} from "@/modules/governance/infrastructure/job-store";
import { runWithObservabilityContext } from "@/modules/observability/application/context";
import type {
  ErrorReporter,
  ObservabilityContext,
  ObservabilityMetrics,
  StructuredLogger
} from "@/modules/observability/contracts/telemetry";
import { normalizeTraceId, traceIdFromSeed } from "@/modules/observability/domain/correlation";
import { observeSafely } from "@/modules/observability/domain/safety";
import { reportErrorSafely } from "@/modules/observability/infrastructure/error-reporter";
import { observabilityRuntime } from "@/modules/observability/infrastructure/runtime";

export type WorkerObserverDependencies = {
  logger: StructuredLogger;
  metrics: ObservabilityMetrics;
  reporter: ErrorReporter;
  now: () => number;
};

async function integerSetting(key: keyof typeof RUNTIME_SETTING_DEFINITIONS): Promise<number> {
  const setting = await db.systemSetting.findUnique({ where: { key } });
  if (!setting) {
    throw new Error(`运行配置 ${key} 缺失。`);
  }
  return validateRuntimeSettingValue(key, setting.value);
}

export async function loadWorkerPolicy(): Promise<WorkerPolicy & { defaultMaxAttempts: number }> {
  const [claimBatchSize, leaseSeconds, retryBaseSeconds, retryMaxSeconds, defaultMaxAttempts] =
    await Promise.all([
      integerSetting("jobs.claimBatchSize"),
      integerSetting("jobs.leaseSeconds"),
      integerSetting("jobs.retryBaseSeconds"),
      integerSetting("jobs.retryMaxSeconds"),
      integerSetting("jobs.defaultMaxAttempts")
    ]);
  return { claimBatchSize, leaseSeconds, retryBaseSeconds, retryMaxSeconds, defaultMaxAttempts };
}

function handlerFailure(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    return { code: error.name || "HANDLER_FAILED", message: error.message || "作业处理失败。" };
  }
  return { code: "HANDLER_FAILED", message: "作业处理失败。" };
}

function projectIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).projectId;
  return typeof value === "string" && value.trim() && value.length <= 191 ? value.trim() : null;
}

function jobContext(job: {
  id: string;
  jobType: string;
  traceId?: string | null;
  payload: unknown;
}): ObservabilityContext {
  return {
    traceId: normalizeTraceId(job.traceId) ?? traceIdFromSeed(job.id),
    requestId: null,
    jobId: job.id,
    actorId: null,
    projectId: projectIdFromPayload(job.payload),
    module: "worker",
    operation: job.jobType
  };
}

export async function runJobBatch(input: {
  workerId: string;
  handlers: Readonly<Record<string, JobHandler>>;
  policy?: WorkerPolicy & { defaultMaxAttempts: number };
  observability?: WorkerObserverDependencies;
}) {
  const observability = input.observability ?? {
    ...observabilityRuntime,
    now: () => performance.now()
  };
  const batchStartedAt = observability.now();
  const batchContext: ObservabilityContext = {
    traceId: traceIdFromSeed(randomUUID()),
    requestId: null,
    jobId: null,
    actorId: null,
    projectId: null,
    module: "worker",
    operation: "run-batch"
  };
  let policy: WorkerPolicy & { defaultMaxAttempts: number };
  let materializedJobIds: string[];
  let claimed: JobExecution[];
  try {
    policy = input.policy ?? (await loadWorkerPolicy());
    const jobTypes = Object.keys(input.handlers);
    materializedJobIds = await materializeOutboxEvents({
      limit: policy.claimBatchSize,
      maxAttempts: policy.defaultMaxAttempts,
      eventTypes: jobTypes
    });
    claimed = await claimJobs({ workerId: input.workerId, policy, jobTypes });
  } catch (error) {
    const durationSeconds = Math.max(0, observability.now() - batchStartedAt) / 1000;
    observeSafely(() => {
      observability.metrics.recordWorker({
        jobType: "worker.batch",
        result: "observer_failed",
        durationSeconds
      });
    });
    observeSafely(() => {
      observability.logger.error("worker.batch_failed", {
        trace_id: batchContext.traceId,
        module: batchContext.module,
        operation: batchContext.operation,
        worker_id: input.workerId,
        duration_ms: Math.round(durationSeconds * 1000),
        result: "observer_failed",
        error
      });
    });
    await reportErrorSafely({
      error,
      context: batchContext,
      metadata: { worker_id: input.workerId, phase: "claim" },
      reporter: observability.reporter,
      logger: observability.logger,
      metrics: observability.metrics
    });
    throw error;
  }
  const outcomes: Array<{ jobId: string; status: "SUCCEEDED" | "FAILED" }> = [];

  for (const job of claimed) {
    const context = jobContext(job);
    await runWithObservabilityContext(context, async () => {
      const startedAt = observability.now();
      const handler = input.handlers[job.jobType];
      try {
        if (!handler) throw new Error(`未注册作业处理器：${job.jobType}`);
        await handler(job);
        await completeClaimedJob(job);
        const durationSeconds = Math.max(0, observability.now() - startedAt) / 1000;
        observeSafely(() => {
          observability.metrics.recordWorker({
            jobType: job.jobType,
            result: "succeeded",
            durationSeconds
          });
        });
        observeSafely(() => {
          observability.logger.info("job.completed", {
            trace_id: context.traceId,
            job_id: job.id,
            attempt_id: job.attemptId,
            attempt_number: job.attemptNumber,
            project_id: context.projectId,
            module: context.module,
            operation: context.operation,
            duration_ms: Math.round(durationSeconds * 1000),
            result: "succeeded"
          });
        });
        outcomes.push({ jobId: job.id, status: "SUCCEEDED" });
      } catch (error) {
        let failed;
        try {
          failed = await failClaimedJob(job, handlerFailure(error), policy);
        } catch (observerError) {
          const durationSeconds = Math.max(0, observability.now() - startedAt) / 1000;
          observeSafely(() => {
            observability.metrics.recordWorker({
              jobType: job.jobType,
              result: "observer_failed",
              durationSeconds
            });
          });
          await reportErrorSafely({
            error: observerError,
            context,
            metadata: { job_id: job.id, phase: "persist_failure" },
            reporter: observability.reporter,
            logger: observability.logger,
            metrics: observability.metrics
          });
          throw observerError;
        }
        const result = failed.status === "DEAD_LETTER" ? "dead_letter" : "retry_scheduled";
        const durationSeconds = Math.max(0, observability.now() - startedAt) / 1000;
        observeSafely(() => {
          observability.metrics.recordWorker({ jobType: job.jobType, result, durationSeconds });
        });
        observeSafely(() => {
          observability.logger.error("job.failed", {
            trace_id: context.traceId,
            job_id: job.id,
            attempt_id: job.attemptId,
            attempt_number: job.attemptNumber,
            project_id: context.projectId,
            module: context.module,
            operation: context.operation,
            duration_ms: Math.round(durationSeconds * 1000),
            result,
            error
          });
        });
        await reportErrorSafely({
          error,
          context,
          metadata: { job_id: job.id, attempt_number: job.attemptNumber, result },
          reporter: observability.reporter,
          logger: observability.logger,
          metrics: observability.metrics
        });
        outcomes.push({ jobId: job.id, status: "FAILED" });
      }
    });
  }

  return { materializedJobIds, claimedCount: claimed.length, outcomes };
}
