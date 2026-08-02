import { PrismaClient } from "@prisma/client";

const prismaGlobal = globalThis as typeof globalThis & {
  apmPrisma?: PrismaClient;
};

export const db = prismaGlobal.apmPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  prismaGlobal.apmPrisma = db;
}
