import { describe, expect, it, vi } from "vitest";

import type { JobExecution } from "@/modules/governance/contracts/jobs";

import { calculateAndPublishReadiness } from "./readiness-service";
import { createReadinessRecalculationHandler } from "./readiness-recalculation-handler";

vi.mock("./readiness-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./readiness-service")>();
  return { ...actual, calculateAndPublishReadiness: vi.fn() };
});

describe("APM-091B readiness recalculation worker", () => {
  it("rejects malformed payloads so the durable worker retries or dead-letters them", async () => {
    const job: JobExecution = {
      id: "invalid-readiness-job",
      jobType: "procurement.readiness-recalculation.requested",
      payload: {},
      payloadHash: "a".repeat(64),
      idempotencyKey: "invalid-readiness-job",
      traceId: "a".repeat(32),
      attemptId: "invalid-readiness-attempt",
      attemptNumber: 1,
      maxAttempts: 3,
      isReplay: false,
      workerId: "test-worker"
    };

    await expect(createReadinessRecalculationHandler()(job)).rejects.toMatchObject({
      code: "INVALID_READINESS_RECALCULATION_PAYLOAD"
    });
  });

  it("recalculates the current snapshot for a transactionally queued procurement write", async () => {
    const job: JobExecution = {
      id: "write-triggered-readiness-job",
      jobType: "procurement.readiness-recalculation.requested",
      payload: { projectId: "project-1" },
      payloadHash: "a".repeat(64),
      idempotencyKey: "write-triggered-readiness-job",
      traceId: "a".repeat(32),
      attemptId: "write-triggered-attempt",
      attemptNumber: 1,
      maxAttempts: 3,
      isReplay: false,
      workerId: "test-worker"
    };

    await createReadinessRecalculationHandler()(job);

    expect(calculateAndPublishReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1" })
    );
  });
});
