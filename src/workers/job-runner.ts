import { db } from "@/lib/db";
import {
  RUNTIME_SETTING_DEFINITIONS,
  validateRuntimeSettingValue
} from "@/modules/configuration/domain/definitions";
import type { JobHandler, WorkerPolicy } from "@/modules/governance/contracts/jobs";
import {
  claimJobs,
  completeClaimedJob,
  failClaimedJob,
  materializeOutboxEvents
} from "@/modules/governance/infrastructure/job-store";

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

export async function runJobBatch(input: {
  workerId: string;
  handlers: Readonly<Record<string, JobHandler>>;
  policy?: WorkerPolicy & { defaultMaxAttempts: number };
}) {
  const policy = input.policy ?? (await loadWorkerPolicy());
  const materializedJobIds = await materializeOutboxEvents({
    limit: policy.claimBatchSize,
    maxAttempts: policy.defaultMaxAttempts
  });
  const claimed = await claimJobs({ workerId: input.workerId, policy });
  const outcomes: Array<{ jobId: string; status: "SUCCEEDED" | "FAILED" }> = [];

  for (const job of claimed) {
    const handler = input.handlers[job.jobType];
    try {
      if (!handler) {
        throw new Error(`未注册作业处理器：${job.jobType}`);
      }
      await handler(job);
      await completeClaimedJob(job);
      outcomes.push({ jobId: job.id, status: "SUCCEEDED" });
    } catch (error) {
      await failClaimedJob(job, handlerFailure(error), policy);
      outcomes.push({ jobId: job.id, status: "FAILED" });
    }
  }

  return { materializedJobIds, claimedCount: claimed.length, outcomes };
}
