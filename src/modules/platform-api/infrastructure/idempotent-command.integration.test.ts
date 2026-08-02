import { randomUUID } from "node:crypto";

import { describe, expect, it, beforeAll } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import { AUDIT_ACTIONS, AUDIT_OBJECT_TYPES } from "@/modules/audit/domain/vocabulary";
import { writeAudit } from "@/modules/audit/infrastructure/write-audit";
import { appendOutboxEvent } from "@/modules/governance/infrastructure/outbox";

import { executeIdempotentCommand } from "../application/idempotent-command";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const actors = {
  first: `api-actor-a-${suffix}`,
  second: `api-actor-b-${suffix}`
};

function auditContext(actorId: string, operationId: string): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: `trace-${operationId}`,
    source: "API",
    sourceIp: "127.0.0.1",
    userAgent: "Vitest",
    reason: "APM-009 integration test",
    projectId: null,
    departmentId: null,
    operationId
  };
}

describeDatabase("APM-009 PostgreSQL API idempotency", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: actors.first,
          employeeNo: `API-A-${suffix}`,
          name: "API actor A",
          departmentId: "engineering"
        },
        {
          id: actors.second,
          employeeNo: `API-B-${suffix}`,
          name: "API actor B",
          departmentId: "quality"
        }
      ]
    });
  });

  it("executes one concurrent command and replays the identical committed result", async () => {
    const operation = `test.project.create.concurrent.${suffix}`;
    const idempotencyKey = `concurrent-${suffix}`;
    const projectId = `api-project-concurrent-${suffix}`;
    const eventType = `test.api.project.created.${suffix}`;
    let executions = 0;

    const execute = () =>
      executeIdempotentCommand({
        actorId: actors.first,
        operation,
        idempotencyKey,
        request: { projectId, name: "Concurrent project" },
        execute: async (transaction) => {
          executions += 1;
          const project = await transaction.project.create({
            data: {
              id: projectId,
              code: `API-CONCURRENT-${suffix}`,
              name: "Concurrent project",
              createdById: actors.first
            }
          });
          const audit = await writeAudit(transaction, {
            action: AUDIT_ACTIONS.PROJECT_MEMBER_ADDED,
            objectType: AUDIT_OBJECT_TYPES.PROJECT,
            objectId: project.id,
            context: auditContext(actors.first, operation)
          });
          const outbox = await appendOutboxEvent(transaction, {
            eventType,
            aggregateType: "PROJECT",
            aggregateId: project.id,
            idempotencyKey,
            payload: { projectId: project.id }
          });
          return {
            status: 201,
            body: { projectId: project.id, auditId: audit.id, outboxEventId: outbox.id }
          };
        }
      });

    const [first, second] = await Promise.all([execute(), execute()]);
    expect(executions).toBe(1);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.body).toEqual(second.body);
    await expect(db.project.count({ where: { id: projectId } })).resolves.toBe(1);
    await expect(db.auditLog.count({ where: { operationId: operation } })).resolves.toBe(1);
    await expect(db.outboxEvent.count({ where: { eventType } })).resolves.toBe(1);
    await expect(
      db.apiIdempotencyRecord.count({ where: { actorId: actors.first, operation, idempotencyKey } })
    ).resolves.toBe(1);
  });

  it("returns 409 when the same actor, operation, and key carries a different payload", async () => {
    const operation = `test.payload-conflict.${suffix}`;
    const idempotencyKey = `payload-conflict-${suffix}`;
    const first = await executeIdempotentCommand({
      actorId: actors.first,
      operation,
      idempotencyKey,
      request: { version: 1 },
      execute: async () => ({ status: 200, body: { acceptedVersion: 1 } })
    });
    expect(first.replayed).toBe(false);

    await expect(
      executeIdempotentCommand({
        actorId: actors.first,
        operation,
        idempotencyKey,
        request: { version: 2 },
        execute: async () => ({ status: 200, body: { acceptedVersion: 2 } })
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
  });

  it("rolls business data, audit, Outbox, and the success record back together", async () => {
    const operation = `test.rollback.${suffix}`;
    const idempotencyKey = `rollback-${suffix}`;
    const projectId = `api-project-rollback-${suffix}`;
    const eventType = `test.api.rollback.${suffix}`;

    await expect(
      executeIdempotentCommand({
        actorId: actors.first,
        operation,
        idempotencyKey,
        request: { projectId },
        execute: async (transaction) => {
          await transaction.project.create({
            data: {
              id: projectId,
              code: `API-ROLLBACK-${suffix}`,
              name: "Rollback project",
              createdById: actors.first
            }
          });
          await writeAudit(transaction, {
            action: AUDIT_ACTIONS.PROJECT_MEMBER_ADDED,
            objectType: AUDIT_OBJECT_TYPES.PROJECT,
            objectId: projectId,
            context: auditContext(actors.first, operation)
          });
          await appendOutboxEvent(transaction, {
            eventType,
            aggregateType: "PROJECT",
            aggregateId: projectId,
            idempotencyKey,
            payload: { projectId }
          });
          throw new Error("BUSINESS_WRITE_FAILED");
        }
      })
    ).rejects.toThrow("BUSINESS_WRITE_FAILED");

    await expect(db.project.count({ where: { id: projectId } })).resolves.toBe(0);
    await expect(db.auditLog.count({ where: { operationId: operation } })).resolves.toBe(0);
    await expect(db.outboxEvent.count({ where: { eventType } })).resolves.toBe(0);
    await expect(
      db.apiIdempotencyRecord.count({ where: { actorId: actors.first, operation, idempotencyKey } })
    ).resolves.toBe(0);
  });

  it("scopes the same key and operation independently for each actor", async () => {
    const operation = `test.actor-scope.${suffix}`;
    const idempotencyKey = `shared-${suffix}`;
    const request = { action: "acknowledge" };
    let executions = 0;
    const run = (actorId: string) =>
      executeIdempotentCommand({
        actorId,
        operation,
        idempotencyKey,
        request,
        execute: async () => {
          executions += 1;
          return { status: 200, body: { actorId } };
        }
      });

    const [first, second] = await Promise.all([run(actors.first), run(actors.second)]);
    expect(executions).toBe(2);
    expect(first.body).toEqual({ actorId: actors.first });
    expect(second.body).toEqual({ actorId: actors.second });
    await expect(
      db.apiIdempotencyRecord.count({ where: { operation, idempotencyKey } })
    ).resolves.toBe(2);
  });

  it("makes a completed success fact immutable", async () => {
    const operation = `test.immutable.${suffix}`;
    const idempotencyKey = `immutable-${suffix}`;
    await executeIdempotentCommand({
      actorId: actors.first,
      operation,
      idempotencyKey,
      request: { stable: true },
      execute: async () => ({ status: 200, body: { stable: true } })
    });

    await expect(
      db.apiIdempotencyRecord.update({
        where: {
          actorId_operation_idempotencyKey: {
            actorId: actors.first,
            operation,
            idempotencyKey
          }
        },
        data: { responseStatus: 201 }
      })
    ).rejects.toThrow(/immutable/u);
  });
});
