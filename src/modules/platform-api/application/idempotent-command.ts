import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { payloadHash, type JsonValue } from "@/modules/governance/domain/idempotency";

import { ApiContractError } from "../contracts/errors";

type CommandResponse = {
  status: number;
  body: unknown;
};

export type IdempotentCommandResult = {
  status: number;
  body: JsonValue;
  replayed: boolean;
};

class IdempotencyClaimConflict extends Error {}

function stableText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 191) {
    throw new TypeError(`${field} 必须是 1 到 191 个字符。`);
  }
  return normalized;
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function responseJson(value: unknown): JsonValue {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("命令响应必须是可序列化 JSON。");
  }
  if (serialized === undefined) throw new TypeError("命令响应必须是可序列化 JSON。");
  return JSON.parse(serialized) as JsonValue;
}

async function databaseNow(transaction: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>`
    SELECT CURRENT_TIMESTAMP AS "now"
  `;
  if (!clock) throw new Error("无法读取数据库时间。");
  return clock.now;
}

export async function executeIdempotentCommand(input: {
  actorId: string;
  operation: string;
  idempotencyKey: string;
  request: unknown;
  execute(transaction: Prisma.TransactionClient): Promise<CommandResponse>;
}): Promise<IdempotentCommandResult> {
  const actorId = stableText(input.actorId, "actorId");
  const operation = stableText(input.operation, "operation");
  const idempotencyKey = stableText(input.idempotencyKey, "idempotencyKey");
  const request = payloadHash(input.request);

  try {
    return await db.$transaction(
      async (transaction) => {
        let record: { id: string };
        try {
          record = await transaction.apiIdempotencyRecord.create({
            data: { actorId, operation, idempotencyKey, requestHash: request.hash },
            select: { id: true }
          });
        } catch (error) {
          if (isUniqueConflict(error)) throw new IdempotencyClaimConflict();
          throw error;
        }

        const response = await input.execute(transaction);
        if (!Number.isInteger(response.status) || response.status < 200 || response.status > 299) {
          throw new TypeError("幂等命令只能记录成功的 2xx 响应。");
        }
        const body = responseJson(response.body);
        await transaction.apiIdempotencyRecord.update({
          where: { id: record.id },
          data: {
            responseStatus: response.status,
            responseJson: body === null ? Prisma.JsonNull : (body as Prisma.InputJsonValue),
            completedAt: await databaseNow(transaction)
          }
        });
        return { status: response.status, body, replayed: false };
      },
      { maxWait: 5_000, timeout: 30_000 }
    );
  } catch (error) {
    if (!(error instanceof IdempotencyClaimConflict)) throw error;
  }

  const existing = await db.apiIdempotencyRecord.findUnique({
    where: { actorId_operation_idempotencyKey: { actorId, operation, idempotencyKey } }
  });
  if (!existing || existing.responseStatus === null || existing.completedAt === null) {
    throw new Error("幂等命令结果不可用。");
  }
  if (existing.requestHash !== request.hash) {
    throw new ApiContractError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency-Key 已绑定到不同的请求负载。",
      409,
      [
        {
          field: "headers.idempotencyKey",
          code: "CONFLICT",
          message: "请为不同请求使用新的幂等键。"
        }
      ]
    );
  }
  return {
    status: existing.responseStatus,
    body: existing.responseJson as JsonValue,
    replayed: true
  };
}

export async function idempotentCommandResponse(
  input: Parameters<typeof executeIdempotentCommand>[0]
) {
  const result = await executeIdempotentCommand(input);
  return Response.json(result.body, {
    status: result.status,
    headers: { "idempotency-replayed": result.replayed ? "true" : "false" }
  });
}
