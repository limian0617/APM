import { describe, expect, it, vi } from "vitest";
import type { AuthorizationActor } from "@/lib/auth/authorize";

const date = new Date("2026-09-05T10:00:00.000Z");

vi.mock("@/lib/db", () => ({
  db: {},
  inTransaction: async (transaction: unknown, fn: (client: unknown) => Promise<unknown>) =>
    fn(transaction)
}));

import { publishUphPerformanceTarget } from "./uph-performance-target-service";

describe("APM-084 target publish service", () => {
  it("writes a JSON-safe canonical outbox payload after rereading PUBLISHED facts", async () => {
    const outboxEvent = {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: "outbox-1",
        ...create
      }))
    };
    const client = {
      $queryRaw: vi.fn(async (query: { strings?: readonly string[] }) => {
        const sql = query.strings?.join(" ") ?? "";
        if (sql.includes("FROM project_members")) return [{ role: "QUALITY" }];
        if (sql.includes("FROM projects")) return [{ id: "project-1", status: "ACTIVE" }];
        if (sql.includes("current_published_version_id")) {
          return [{ id: "target-1", currentPublishedVersionId: null }];
        }
        if (
          sql.includes("FROM project_uph_performance_target_versions") &&
          sql.includes("WHERE id") &&
          !sql.includes("FOR UPDATE")
        ) {
          return [
            {
              id: "version-1",
              targetId: "target-1",
              targetUph: "100.000000",
              checksum: "a".repeat(64),
              revision: 1,
              resourceVersion: 2,
              status: "PUBLISHED",
              reason: "version reason",
              effectiveAt: date,
              publishedById: "user-1",
              publishedAt: date
            }
          ];
        }
        if (sql.includes("FROM project_uph_performance_target_versions")) {
          return [
            {
              id: "version-1",
              targetId: "target-1",
              targetUph: "100.000000",
              checksum: "a".repeat(64),
              revision: 1,
              resourceVersion: 2,
              status: "DRAFT"
            }
          ];
        }
        return [];
      }),
      $executeRaw: vi.fn(async () => 1),
      auditLog: { create: vi.fn(async () => ({ id: "audit-1" })) },
      outboxEvent
    };
    const actor: AuthorizationActor = {
      id: "user-1",
      name: "Quality",
      status: "ACTIVE" as const,
      departmentId: null,
      systemRoles: ["QUALITY"],
      grants: [{ permission: "PROJECT_UPH_PUBLISH", scope: "PROJECT", systemRole: "QUALITY" }]
    };
    const result = await publishUphPerformanceTarget(
      {
        projectId: "project-1",
        targetVersionId: "version-1",
        actorId: "user-1",
        authorizationActor: actor,
        projectMemberRoles: ["QUALITY"],
        resourceVersion: 2,
        reason: "publish operation",
        auditContext: {
          actorId: "user-1",
          requestId: "request-1",
          traceId: null,
          source: "API",
          sourceIp: null,
          userAgent: null,
          reason: "publish operation",
          projectId: "project-1",
          departmentId: null,
          operationId: "op-1"
        }
      },
      client as never
    );
    expect(result).toMatchObject({
      status: "PUBLISHED",
      publishedById: "user-1",
      publishedAt: date.toISOString(),
      versionReason: "version reason",
      operationReason: "publish operation"
    });
    const payload = outboxEvent.upsert.mock.calls[0]?.[0]?.create?.payload as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      publishedAt: date.toISOString(),
      versionReason: "version reason",
      operationReason: "publish operation"
    });
    expect(() => JSON.stringify(payload)).not.toThrow();
    expect(client.auditLog.create).toHaveBeenCalled();
  });
});
