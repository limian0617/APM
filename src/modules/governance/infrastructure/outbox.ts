import { Prisma } from "@prisma/client";

import { currentObservabilityContext } from "@/modules/observability/application/context";
import { normalizeTraceId } from "@/modules/observability/domain/correlation";

import type { OutboxEventInput } from "../contracts/jobs";
import { payloadHash } from "../domain/idempotency";

export type OutboxWriteClient = Pick<Prisma.TransactionClient, "outboxEvent">;

export class OutboxIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super("相同事件类型和幂等键已绑定到不同负载。");
  }
}

function stableText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 191) {
    throw new TypeError(`${field} 必须是 1 到 191 个字符。`);
  }
  return normalized;
}

export async function appendOutboxEvent(client: OutboxWriteClient, input: OutboxEventInput) {
  const eventType = stableText(input.eventType, "eventType");
  const aggregateType = stableText(input.aggregateType, "aggregateType");
  const idempotencyKey = stableText(input.idempotencyKey, "idempotencyKey");
  const aggregateId = input.aggregateId?.trim().slice(0, 191) || null;
  const suppliedTraceId =
    input.traceId === undefined ? currentObservabilityContext()?.traceId : input.traceId;
  const traceId = suppliedTraceId ? normalizeTraceId(suppliedTraceId) : null;
  if (suppliedTraceId && !traceId) throw new TypeError("traceId 必须是有效的 W3C trace id。");
  const canonical = payloadHash(input.payload);

  const event = await client.outboxEvent.upsert({
    where: { eventType_idempotencyKey: { eventType, idempotencyKey } },
    create: {
      eventType,
      aggregateType,
      aggregateId,
      payload: canonical.value as Prisma.InputJsonValue,
      payloadHash: canonical.hash,
      idempotencyKey,
      traceId
    },
    update: {}
  });

  if (
    event.payloadHash !== canonical.hash ||
    event.aggregateType !== aggregateType ||
    event.aggregateId !== aggregateId
  ) {
    throw new OutboxIdempotencyConflictError();
  }

  return event;
}
