import { describe, expect, it, vi } from "vitest";
import type { AuthorizationActor } from "@/lib/auth/authorize";

const batchService = vi.hoisted(() => ({ createUphTestBatch: vi.fn() }));
vi.mock("./uph-test-batch-service", () => batchService);
vi.mock("@/modules/audit/infrastructure/write-audit", () => ({
  writeAudit: vi.fn(async () => ({ id: "audit-1" }))
}));
vi.mock("@/modules/governance/infrastructure/outbox", () => ({
  appendOutboxEvent: vi.fn(async () => ({ id: "outbox-1" }))
}));

import {
  createUphRetest,
  UphRetestServiceError,
  type CreateUphRetestInput
} from "./uph-retest-service";

const actor: AuthorizationActor = {
  id: "user-1",
  name: "Engineer",
  status: "ACTIVE" as const,
  departmentId: null,
  systemRoles: ["ENGINEER"],
  grants: [
    { permission: "PROJECT_UPH_BATCH_MANAGE", scope: "PROJECT", systemRole: "ENGINEER" },
    { permission: "PROJECT_ISSUE_UPDATE", scope: "PROJECT", systemRole: "ENGINEER" }
  ]
};
const input: CreateUphRetestInput = {
  projectId: "project-1",
  issueId: "issue-1",
  actorId: "user-1",
  authorizationActor: actor,
  auditContext: {
    actorId: "user-1",
    requestId: "request-1",
    traceId: null,
    source: "API",
    sourceIp: null,
    userAgent: null,
    reason: "retest",
    projectId: "project-1",
    departmentId: null,
    operationId: "op-1"
  },
  issueVersion: 1,
  reason: "retest",
  body: {
    batchNumber: "RETEST-1",
    plannedProductionSeconds: 3600,
    planDeclarationReason: "repeat",
    observationStartedAt: "2026-09-05T02:00:00.000Z",
    observationEndedAt: null,
    timezone: "Asia/Shanghai"
  }
};

function clientFor(options: { issue?: unknown[]; source?: unknown[]; revision?: unknown[] }) {
  return {
    $queryRaw: vi.fn(async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join(" ") ?? "";
      if (sql.includes("FROM project_members")) return [{ role: "ENGINEER" }];
      if (sql.includes("FROM issues") && sql.includes("SELECT id FROM issues")) {
        return options.issue ?? [{ id: "issue-1" }];
      }
      if (sql.includes("FROM projects")) return [{ id: "project-1", status: "ACTIVE" }];
      if (sql.includes("FROM issue_relations")) {
        return (
          options.source ?? [
            {
              issueId: "issue-1",
              sourceBatchId: "source-batch-1",
              currentLockedRevisionId: "locked-revision-1"
            }
          ]
        );
      }
      if (sql.includes("FROM project_uph_test_batch_revisions")) {
        return options.revision ?? [{ topologyRootNodeId: "root-1", revisionStatus: "LOCKED" }];
      }
      if (sql.includes("FROM issues")) {
        return [
          {
            id: "issue-1",
            status: "OPEN",
            version: 1,
            category: "PERFORMANCE",
            sourceType: "PROJECT"
          }
        ];
      }
      if (sql.includes("INSERT INTO issue_relations")) {
        return [
          {
            id: "relation-1",
            issueId: "issue-1",
            relationType: "UPH_RETEST_BATCH",
            targetId: "retest-batch",
            status: "ACTIVE",
            createdAt: new Date()
          }
        ];
      }
      if (sql.includes("UPDATE issues")) return [{ version: 2 }];
      if (sql.includes("MAX(sequence)")) return [{ sequence: 1 }];
      return [];
    }),
    issueHistory: { create: vi.fn() }
  };
}

describe("APM-084 retest service", () => {
  it("returns ISSUE_NOT_FOUND before source inspection for a cross-project issue", async () => {
    const client = clientFor({ issue: [] });
    await expect(createUphRetest(input, client as never)).rejects.toMatchObject({
      code: "ISSUE_NOT_FOUND",
      status: 404
    } satisfies Partial<UphRetestServiceError>);
  });

  it("returns LOCKED_REVISION_REQUIRED when source batch has no current locked revision", async () => {
    const client = clientFor({
      source: [
        { issueId: "issue-1", sourceBatchId: "source-batch-1", currentLockedRevisionId: null }
      ]
    });
    await expect(createUphRetest(input, client as never)).rejects.toMatchObject({
      code: "LOCKED_REVISION_REQUIRED",
      status: 409
    } satisfies Partial<UphRetestServiceError>);
    expect(batchService.createUphTestBatch).not.toHaveBeenCalled();
  });
});
