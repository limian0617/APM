import type { JsonValue } from "../domain/idempotency";

export type OutboxEventInput = {
  eventType: string;
  aggregateType: string;
  aggregateId?: string | null;
  idempotencyKey: string;
  payload: unknown;
};

export type JobExecution = {
  id: string;
  jobType: string;
  payload: JsonValue;
  payloadHash: string;
  idempotencyKey: string;
  attemptId: string;
  attemptNumber: number;
  maxAttempts: number;
  isReplay: boolean;
  workerId: string;
};

export type JobHandler = (job: JobExecution) => Promise<void>;

export type WorkerPolicy = {
  claimBatchSize: number;
  leaseSeconds: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
};
