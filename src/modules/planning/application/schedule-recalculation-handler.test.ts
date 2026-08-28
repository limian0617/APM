import { describe, expect, it } from "vitest";

import type { JobExecution } from "@/modules/governance/contracts/jobs";

import { createScheduleRecalculationHandler } from "./schedule-recalculation-handler";

describe("APM-022 schedule recalculation worker", () => {
  it("rejects malformed payloads so the durable worker schedules a retry or Dead Letter", async () => {
    const job: JobExecution = {
      id: "invalid-schedule-job",
      jobType: "planning.schedule-recalculation.requested",
      payload: {},
      payloadHash: "a".repeat(64),
      idempotencyKey: "invalid-schedule-job",
      traceId: "a".repeat(32),
      attemptId: "invalid-schedule-attempt",
      attemptNumber: 1,
      maxAttempts: 3,
      isReplay: false,
      workerId: "test-worker"
    };

    await expect(createScheduleRecalculationHandler()(job)).rejects.toMatchObject({
      code: "INVALID_RECALCULATION_PAYLOAD"
    });
  });
});
