import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";
import { materializeOutboxEvents } from "@/modules/governance/infrastructure/job-store";
import {
  currentObservabilityContext,
  runWithObservabilityContext
} from "@/modules/observability/application/context";
import type { ObservabilityContext } from "@/modules/observability/contracts/telemetry";
import {
  checkReadiness,
  databaseReadinessProbes
} from "@/modules/observability/infrastructure/readiness";
import { runJobBatch } from "@/workers/job-runner";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;

describeDatabase("APM-007 PostgreSQL observability", () => {
  it("persists an immutable trace from the Outbox event through Worker execution", async () => {
    const suffix = randomUUID().slice(0, 8);
    const traceId = createHash("sha256").update(`trace-${suffix}`).digest("hex").slice(0, 32);
    const eventType = `test.observability.${suffix}`;
    const context: ObservabilityContext = {
      traceId,
      requestId: `request-${suffix}`,
      jobId: null,
      actorId: null,
      projectId: null,
      module: "test",
      operation: "append-event"
    };
    const event = await runWithObservabilityContext(context, () =>
      appendOutboxEvent(db, {
        eventType,
        aggregateType: "TEST",
        aggregateId: suffix,
        idempotencyKey: `observability-${suffix}`,
        payload: { projectId: `project-${suffix}` }
      })
    );
    expect(event.traceId).toBe(traceId);
    await materializeOutboxEvents({ limit: 500, maxAttempts: 2 });
    const job = await db.persistentJob.findUniqueOrThrow({
      where: { sourceOutboxEventId: event.id }
    });
    const jobId = job.id;
    expect(job.traceId).toBe(traceId);
    await db.persistentJob.update({
      where: { id: jobId },
      data: { nextRunAt: new Date("2000-01-01T00:00:00.000Z") }
    });

    let workerContext: ObservabilityContext | null = null;
    const telemetryFailure = () => {
      throw new Error("telemetry unavailable");
    };
    await runJobBatch({
      workerId: `observability-worker-${suffix}`,
      policy: {
        claimBatchSize: 1,
        leaseSeconds: 60,
        retryBaseSeconds: 1,
        retryMaxSeconds: 10,
        defaultMaxAttempts: 2
      },
      handlers: {
        [eventType]: async () => {
          workerContext = currentObservabilityContext();
        }
      },
      observability: {
        logger: {
          info: telemetryFailure,
          warn: telemetryFailure,
          error: telemetryFailure
        },
        metrics: {
          recordHttp: telemetryFailure,
          recordWorker: telemetryFailure,
          recordErrorReport: telemetryFailure,
          recordReadiness: telemetryFailure
        },
        reporter: {
          async capture() {
            telemetryFailure();
          }
        },
        now: () => performance.now()
      }
    });
    expect(workerContext).toMatchObject({
      traceId,
      jobId,
      projectId: `project-${suffix}`,
      module: "worker",
      operation: eventType
    });
    await expect(
      db.persistentJob.findUniqueOrThrow({ where: { id: jobId } })
    ).resolves.toMatchObject({
      status: "SUCCEEDED",
      traceId
    });

    const replacementTrace = createHash("sha256")
      .update(`replacement-${suffix}`)
      .digest("hex")
      .slice(0, 32);
    await expect(
      db.outboxEvent.update({ where: { id: event.id }, data: { traceId: replacementTrace } })
    ).rejects.toThrow(/immutable/);
    await expect(
      db.persistentJob.update({ where: { id: jobId }, data: { traceId: replacementTrace } })
    ).rejects.toThrow(/immutable/);
  });

  it("reports ready after the APM-007 migration is applied", async () => {
    const result = await checkReadiness({ probes: databaseReadinessProbes() });
    expect(result).toMatchObject({
      status: "ready",
      checks: [
        { name: "database", status: "ready", code: null },
        { name: "migrations", status: "ready", code: null }
      ]
    });
  });
});
