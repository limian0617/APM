import { describe, expect, it, vi } from "vitest";

import type { Prisma } from "@prisma/client";
import type { AuthorizationActor } from "@/lib/auth/authorize";

const state = vi.hoisted(() => ({
  query: [] as unknown[],
  executed: [] as string[],
  events: [] as string[],
  outboxKeys: [] as string[]
}));

vi.mock("@/lib/db", () => ({
  inTransaction: async (transaction: unknown, operation: (client: unknown) => Promise<unknown>) =>
    operation(transaction ?? client)
}));

const client = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  issueHistory: { create: vi.fn() },
  issue: { updateMany: vi.fn() }
}));

vi.mock("@/modules/audit/infrastructure/write-audit", () => ({
  writeAudit: vi.fn(async () => {
    state.events.push("audit");
    return { id: "audit-1" };
  })
}));
vi.mock("@/modules/governance/infrastructure/outbox", () => ({
  appendOutboxEvent: vi.fn(async (_client: unknown, input: { idempotencyKey?: string }) => {
    state.events.push("outbox");
    if (input.idempotencyKey) state.outboxKeys.push(input.idempotencyKey);
    return { id: "outbox-1" };
  })
}));

import {
  createUphPerformanceIssue,
  UphPerformanceIssueServiceError,
  type CreateUphPerformanceIssueInput
} from "./uph-performance-issue-service";

const date = new Date("2026-08-26T00:00:00.000Z");
const actor: AuthorizationActor = {
  id: "user-1",
  name: "Engineer",
  status: "ACTIVE" as const,
  departmentId: null,
  systemRoles: ["ENGINEER"],
  grants: [
    { permission: "PROJECT_UPH_READ", scope: "PROJECT", systemRole: "ENGINEER" },
    { permission: "PROJECT_ISSUE_CREATE", scope: "PROJECT", systemRole: "ENGINEER" }
  ]
};
const context: CreateUphPerformanceIssueInput = {
  projectId: "project-1",
  batchId: "batch-1",
  revisionId: "revision-1",
  analysisId: "analysis-1",
  actorId: "user-1",
  authorizationActor: actor,
  auditContext: {
    actorId: "user-1",
    requestId: "request-1",
    traceId: null,
    source: "API",
    sourceIp: null,
    userAgent: null,
    reason: "shortfall",
    projectId: "project-1",
    departmentId: null,
    operationId: "op-1"
  },
  title: "UPH below target",
  confirmedText: "Actual good UPH is below target.",
  severity: "MEDIUM",
  reason: "Record locked analysis"
};

function sqlText(value: unknown): string {
  if (typeof value !== "object" || value === null || !("strings" in value)) return "";
  const strings = (value as { strings?: readonly string[] }).strings;
  return strings?.join(" ") ?? "";
}

function configureQueue(
  options: {
    target?: unknown[];
    existingSource?: unknown[];
    issueHistory?: unknown[];
    analysisId?: string;
    secondAnalysis?: { id: string; actualGoodUph: string };
    actualGoodUph?: string;
    memberRoles?: string[];
  } = {}
) {
  state.query = [];
  state.executed = [];
  state.events = [];
  state.outboxKeys = [];
  client.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
    const sql = sqlText(query);
    if (sql.includes("FROM project_members")) {
      return (options.memberRoles ?? ["ENGINEER"]).map((role) => ({ role }));
    }
    if (sql.includes("FROM projects")) {
      return [
        { id: "project-1", code: "P-1", name: "Project", departmentId: null, status: "ACTIVE" }
      ];
    }
    if (sql.includes("FROM project_uph_test_batches")) {
      return [
        {
          id: "batch-1",
          projectId: "project-1",
          batchNumber: "B-1",
          currentLockedRevisionId: "revision-1"
        }
      ];
    }
    if (sql.includes("FROM project_uph_test_batch_revisions")) {
      return [
        {
          id: "revision-1",
          projectId: "project-1",
          batchId: "batch-1",
          revisionNumber: 1,
          status: "LOCKED",
          topologyRootNodeId: "root-1",
          topologyVersionId: "topology-1",
          formulaVersionId: "formula-1",
          lockedAt: date,
          lockedChecksum: "a".repeat(64)
        }
      ];
    }
    if (sql.includes("FROM project_uph_analysis_snapshots")) {
      return [
        {
          id: options.analysisId ?? "analysis-1",
          projectId: "project-1",
          batchId: "batch-1",
          revisionId: "revision-1",
          lockedChecksum: "a".repeat(64),
          formulaVersionId: "formula-1",
          formulaChecksum: "b".repeat(64),
          engineCode: "UPH_ANALYSIS@1",
          inputSnapshotJson: {},
          resultSnapshotJson: { bottleneck: [{ sourceId: "module-1" }], secondBottleneck: null },
          status: "COMPUTED",
          warningsJson: ["A_GT_ONE"],
          rootMeasuredCapacityUph: "120.000000",
          actualGoodUph:
            options.secondAnalysis?.id === (options.analysisId ?? "analysis-1")
              ? options.secondAnalysis.actualGoodUph
              : (options.actualGoodUph ?? "90.000000"),
          utilizationA: "0.750000",
          createdAt: date
        }
      ];
    }
    if (sql.includes("FROM project_uph_performance_targets")) {
      return (
        options.target ?? [
          {
            targetId: "target-1",
            targetVersionId: "target-version-1",
            targetRevision: 1,
            targetUph: "100.000000",
            targetChecksum: "c".repeat(64),
            effectiveAt: date,
            publishedAt: date
          }
        ]
      );
    }
    if (sql.includes("FROM issue_relations") && sql.includes("UPH_SOURCE_BATCH")) {
      return options.existingSource ?? [];
    }
    if (sql.includes("FROM issue_relations") && sql.includes("UPH_ANALYSIS")) return [];
    if (sql.includes("FROM issue_relations")) {
      return [
        {
          id: "relation-1",
          issueId: "issue-1",
          relationType: "UPH_SOURCE_BATCH",
          targetId: "batch-1",
          status: "ACTIVE",
          reason: "Record locked analysis",
          createdById: "user-1",
          createdAt: date
        }
      ];
    }
    if (sql.includes("MAX(sequence)")) return [{ sequence: 0 }];
    if (sql.includes("INSERT INTO issue_relations")) {
      return [
        {
          id: "relation-1",
          issueId: "issue-1",
          relationType: "UPH_SOURCE_BATCH",
          targetId: "batch-1",
          status: "ACTIVE",
          reason: "Record locked analysis",
          createdById: "user-1",
          createdAt: date
        }
      ];
    }
    if (sql.includes("FROM issues")) {
      return [
        {
          id: "issue-1",
          projectId: "project-1",
          title: context.title,
          confirmedText: context.confirmedText,
          sourceType: "PROJECT",
          category: "PERFORMANCE",
          severity: "MEDIUM",
          phenomenonDescription: context.confirmedText,
          rootCauseCategory: null,
          rootCauseDescription: null,
          status: "PENDING_ACCEPTANCE",
          version: 1,
          createdById: "user-1",
          updatedById: "user-1",
          createdAt: date,
          updatedAt: date
        }
      ];
    }
    if (sql.includes("FROM issue_histories")) return options.issueHistory ?? [];
    throw new Error(`unexpected query: ${sql}`);
  });
  client.$executeRaw.mockImplementation(async (query: Prisma.Sql) => {
    state.executed.push(sqlText(query));
    return 1;
  });
  client.issueHistory.create.mockResolvedValue({ id: "history-1" });
  client.issue.updateMany.mockResolvedValue({ count: 1 });
}

describe("APM-084 performance issue application service", () => {
  it("freezes the locked analysis evidence and creates fixed PERFORMANCE/PROJECT facts atomically", async () => {
    configureQueue();
    const result = await createUphPerformanceIssue(
      context,
      client as unknown as Prisma.TransactionClient
    );
    expect(result.deduplicated).toBe(false);
    expect(result.sourceSnapshot).toMatchObject({
      lockedChecksum: "a".repeat(64),
      targetUph: "100.000000",
      actualGoodUph: "90.000000",
      createdAt: date.toISOString(),
      shortfallUph: "10.000000",
      warnings: ["A_GT_ONE"],
      bottleneck: [{ sourceId: "module-1" }]
    });
    expect(result.issue).toMatchObject({
      category: "PERFORMANCE",
      sourceType: "PROJECT",
      rootCauseCategory: null,
      rootCauseDescription: null
    });
    expect(state.events).toEqual(["audit", "outbox"]);
    expect(state.executed.some((sql) => sql.includes("'PERFORMANCE'"))).toBe(true);
    expect(client.issueHistory.create).toHaveBeenCalled();
  });

  it("returns the stable target-not-configured error before creating any issue", async () => {
    configureQueue({ target: [] });
    await expect(
      createUphPerformanceIssue(context, client as unknown as Prisma.TransactionClient)
    ).rejects.toMatchObject({
      code: "UPH_TARGET_NOT_CONFIGURED",
      status: 409
    } satisfies Partial<UphPerformanceIssueServiceError>);
    expect(state.executed).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it("treats equality as achieved and never creates an issue", async () => {
    configureQueue({ actualGoodUph: "100.000000" });
    await expect(
      createUphPerformanceIssue(context, client as unknown as Prisma.TransactionClient)
    ).rejects.toMatchObject({ code: "UPH_TARGET_MET", status: 409 });
    expect(state.executed).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it("requires both the UPH read and issue-create grants", async () => {
    configureQueue();
    const unauthorized = {
      ...context,
      authorizationActor: { ...actor, grants: actor.grants.slice(0, 1) }
    };
    await expect(
      createUphPerformanceIssue(unauthorized, client as unknown as Prisma.TransactionClient)
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED", status: 403 });
    expect(state.executed).toEqual([]);
  });

  it("uses the current analysis snapshot when appending evidence to a deduplicated issue", async () => {
    const frozen = { analysisId: "analysis-1", actualGoodUph: "90.000000" };
    configureQueue({
      existingSource: [
        {
          id: "relation-source",
          issueId: "issue-1",
          relationType: "UPH_SOURCE_BATCH",
          targetId: "batch-1",
          status: "ACTIVE",
          reason: "first",
          createdById: "user-1",
          createdAt: date
        }
      ],
      analysisId: "analysis-2",
      secondAnalysis: { id: "analysis-2", actualGoodUph: "80.000000" },
      issueHistory: [
        {
          id: "history-1",
          sequence: 1,
          eventType: "CREATED",
          reason: "first",
          snapshotJson: {
            sourceSnapshot: { analysisId: frozen.analysisId, actualGoodUph: frozen.actualGoodUph }
          },
          actorId: "user-1",
          createdAt: date
        }
      ]
    });
    const result = await createUphPerformanceIssue(
      { ...context, analysisId: "analysis-2" },
      client as unknown as Prisma.TransactionClient
    );
    expect(result.deduplicated).toBe(true);
    expect(result.sourceSnapshot).toMatchObject({
      analysisId: "analysis-1",
      actualGoodUph: "90.000000"
    });
    expect(state.outboxKeys).toContain(
      "uph-performance-issue:issue-1:UPH_ANALYSIS:analysis-2:deduplicated"
    );
  });
});
