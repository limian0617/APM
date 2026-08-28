import { describe, expect, it } from "vitest";

import type { JobExecution } from "../contracts/jobs";

import { createAlertScanHandler } from "./alert-scan-handler";

describe("APM-034 alert scan worker", () => {
  it("rejects malformed payloads so the durable worker can retry or Dead Letter them", async () => {
    const job: JobExecution = {
      id: "invalid-alert-scan-job",
      jobType: "governance.alert-scan.requested",
      payload: { projectId: "project-1" },
      payloadHash: "a".repeat(64),
      idempotencyKey: "invalid-alert-scan-job",
      traceId: "a".repeat(32),
      attemptId: "invalid-alert-scan-attempt",
      attemptNumber: 1,
      maxAttempts: 3,
      isReplay: false,
      workerId: "test-worker"
    };

    await expect(createAlertScanHandler()(job)).rejects.toThrow("预警扫描负载无效。");
  });
});
