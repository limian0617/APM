import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";

export const EXPECTED_MIGRATION = "20260802060000_apm_007_observability";

export type ReadinessProbe = {
  name: string;
  check: () => Promise<void>;
};

export type ReadinessStatus = {
  service: "apm";
  status: "ready" | "not_ready";
  timestamp: string;
  checks: Array<{ name: string; status: "ready" | "not_ready"; code: string | null }>;
};

async function withTimeout(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("READINESS_TIMEOUT")), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function failureCode(error: unknown): string {
  return error instanceof Error && error.message === "MIGRATION_PENDING"
    ? "MIGRATION_PENDING"
    : error instanceof Error && error.message === "READINESS_TIMEOUT"
      ? "DEPENDENCY_TIMEOUT"
      : "DEPENDENCY_UNAVAILABLE";
}

export async function checkReadiness(input: {
  probes: ReadinessProbe[];
  now?: Date;
  timeoutMs?: number;
}): Promise<ReadinessStatus> {
  const timeoutMs = input.timeoutMs ?? 2000;
  const checks = await Promise.all(
    input.probes.map(async (probe) => {
      try {
        await withTimeout(probe.check(), timeoutMs);
        return { name: probe.name, status: "ready" as const, code: null };
      } catch (error) {
        return { name: probe.name, status: "not_ready" as const, code: failureCode(error) };
      }
    })
  );
  return {
    service: "apm",
    status: checks.every(({ status }) => status === "ready") ? "ready" : "not_ready",
    timestamp: (input.now ?? new Date()).toISOString(),
    checks
  };
}

export function databaseReadinessProbes(): ReadinessProbe[] {
  return [
    {
      name: "database",
      async check() {
        await db.$queryRaw`SELECT 1`;
      }
    },
    {
      name: "migrations",
      async check() {
        const rows = await db.$queryRaw<Array<{ ready: boolean }>>(Prisma.sql`
          SELECT EXISTS (
            SELECT 1
            FROM "_prisma_migrations"
            WHERE "migration_name" = ${EXPECTED_MIGRATION}
              AND "finished_at" IS NOT NULL
              AND "rolled_back_at" IS NULL
          ) AS "ready"
        `);
        if (!rows[0]?.ready) throw new Error("MIGRATION_PENDING");
      }
    }
  ];
}
