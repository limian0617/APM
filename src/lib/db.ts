import { Prisma, PrismaClient } from "@prisma/client";

const prismaGlobal = globalThis as typeof globalThis & {
  apmPrisma?: PrismaClient;
};

export const db = prismaGlobal.apmPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  prismaGlobal.apmPrisma = db;
}

type InteractiveTransactionOptions = {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
};

export function inTransaction<T>(
  transaction: Prisma.TransactionClient | undefined,
  operation: (client: Prisma.TransactionClient) => Promise<T>,
  options?: InteractiveTransactionOptions
): Promise<T> {
  return transaction ? operation(transaction) : db.$transaction(operation, options);
}
