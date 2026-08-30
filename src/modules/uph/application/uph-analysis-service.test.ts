import { readFileSync } from "node:fs";

import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  queue: [] as unknown[],
  calls: [] as string[],
  events: [] as string[],
  transactions: [] as unknown[],
  client: null as unknown
}));

vi.mock("@/lib/db", () => ({
  inTransaction: async (
    transaction: unknown,
    operation: (client: unknown) => Promise<unknown>
  ): Promise<unknown> => {
    const client = transaction ?? state.client;
    state.transactions.push(client);
    return operation(client);
  }
}));

vi.mock("@/modules/audit/infrastructure/write-audit", () => ({
  writeAudit: vi.fn(async () => {
    state.events.push("audit");
    return { id: "audit-1" };
  })
}));

vi.mock("@/modules/governance/infrastructure/outbox", () => ({
  appendOutboxEvent: vi.fn(async () => {
    state.events.push("outbox");
    return { id: "outbox-1" };
  })
}));

import {
  createUphAnalysis,
  getUphAnalysis,
  listUphAnalyses,
  UphAnalysisServiceError,
  type CreateUphAnalysisInput
} from "./uph-analysis-service";

const checksum = (character: string) => character.repeat(64);

function mockClient() {
  return {
    $queryRaw: async (query: unknown) => {
      const sql = (query as { strings?: readonly string[] }).strings?.join(" ") ?? String(query);
      state.calls.push(sql);
      const next = state.queue.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error(`unexpected query: ${sql}`);
      return next;
    },
    $executeRaw: async () => {
      state.events.push("constraints");
      return 0;
    }
  } as unknown as Prisma.TransactionClient;
}

function context(): CreateUphAnalysisInput {
  return {
    projectId: "project-1",
    batchId: "batch-1",
    revisionId: "revision-1",
    actorId: "actor-1",
    authorizationActor: {
      id: "actor-1",
      name: "Engineer",
      status: "ACTIVE",
      departmentId: null,
      systemRoles: ["ENGINEER"],
      grants: [
        {
          permission: "PROJECT_UPH_ANALYZE",
          scope: "PROJECT",
          systemRole: "ENGINEER"
        },
        { permission: "PROJECT_UPH_READ", scope: "PROJECT", systemRole: "ENGINEER" }
      ]
    },
    auditContext: {
      actorId: "actor-1",
      requestId: "request-1",
      traceId: null,
      source: "API",
      sourceIp: null,
      userAgent: null,
      reason: null,
      projectId: "project-1",
      departmentId: null,
      operationId: "operation-1"
    }
  };
}

function lockedRevision() {
  return {
    id: "revision-1",
    projectId: "project-1",
    batchId: "batch-1",
    status: "LOCKED",
    topologyVersionId: "topology-version-1",
    topologyRootNodeId: "topology-root-1",
    formulaVersionId: "formula-version-1",
    plannedProductionSeconds: "3600",
    confirmedInputChecksum: checksum("b"),
    statisticsChecksum: checksum("c"),
    lockedChecksum: checksum("a"),
    checksumChainValid: true
  };
}

function snapshot() {
  return {
    analysisId: "analysis-1",
    projectId: "project-1",
    batchId: "batch-1",
    revisionId: "revision-1",
    lockedChecksum: checksum("a"),
    formulaVersionId: "formula-version-1",
    formulaChecksum: checksum("d"),
    engineCode: "UPH_ANALYSIS@1",
    inputSnapshot: {},
    resultSnapshot: {},
    status: "COMPUTED",
    warnings: [],
    rootMeasuredCapacityUph: "1200.000000",
    actualGoodUph: "90.000000",
    a: "0.083333",
    resourceVersion: 1,
    createdById: "actor-1",
    createdAt: new Date("2026-08-26T00:00:00.000Z")
  };
}

function successfulCreateQueue() {
  return [
    [{ role: "ENGINEER" }],
    [{ id: "project-1" }],
    [{ enabled: true }],
    [{ id: "batch-1", currentLockedRevisionId: "revision-1" }],
    [lockedRevision()],
    [],
    [
      {
        id: "topology-root-1",
        parentNodeId: null,
        parentRelation: "ROOT",
        sourceType: "DELIVERY_UNIT",
        sourceId: "line-1",
        topologyPath: "topology-root-1",
        sourceSnapshotJson: { id: "line-1" },
        sourceChecksum: checksum("1"),
        sourceWatermark: checksum("2")
      },
      {
        id: "module-node-1",
        parentNodeId: "topology-root-1",
        parentRelation: "MANDATORY",
        sourceType: "PROJECT_MODULE",
        sourceId: "module-1",
        topologyPath: "topology-root-1/module-node-1",
        sourceSnapshotJson: { id: "module-1" },
        sourceChecksum: checksum("3"),
        sourceWatermark: checksum("4")
      }
    ],
    [
      {
        id: "binding-1",
        projectModuleId: "module-1",
        ctDefinitionId: "ct-root-1",
        ctVersionId: "ct-version-1",
        ctSourceSnapshotJson: { frozen: true },
        ctSourceChecksum: checksum("5"),
        ctSourceWatermark: checksum("6"),
        exactSnapshotJson: { frozen: true },
        exactSnapshotChecksum: checksum("5"),
        exactSourceWatermark: checksum("6"),
        sourceMatchesExact: true,
        intrinsicCtSeconds: "3.000000",
        outputPerCycleTotal: "1",
        parallelChannelCount: "1",
        cavityCount: "1",
        qualityInputCount: "100",
        firstPassGoodCount: "90",
        validSampleCount: "10",
        p90Seconds: "3.000000",
        statisticsMatch: true
      }
    ],
    [
      {
        id: "formula-version-1",
        formulaCode: "CANONICAL_UPH_V1",
        formulaJson: { formula: "canonical" },
        snapshotChecksum: checksum("d")
      }
    ],
    [{ actualGrossOutputCount: "100", finalGoodOutputCount: "90" }],
    [{ checksum: checksum("e") }],
    [{ checksum: checksum("f") }],
    [snapshot()]
  ];
}

beforeEach(() => {
  state.queue = [];
  state.calls = [];
  state.events = [];
  state.transactions = [];
  state.client = mockClient();
});

describe("APM-082 UPH analysis application service", () => {
  it("default-denies all three entries after active-membership reads, before project/capability/batch/revision/analysis access", async () => {
    const client = mockClient();
    const denied = {
      ...context(),
      authorizationActor: { ...context().authorizationActor, grants: [] }
    };
    state.queue = [[], [], []];

    await expect(createUphAnalysis(denied, client)).rejects.toMatchObject({ status: 403 });
    await expect(listUphAnalyses(denied)).rejects.toMatchObject({ status: 403 });
    await expect(getUphAnalysis({ ...denied, analysisId: "analysis-1" })).rejects.toMatchObject({
      status: 403
    });
    expect(state.calls).toHaveLength(3);
    for (const query of state.calls) {
      expect(query).toContain("project_members");
      expect(query).toContain("users actor");
      expect(query).not.toContain("FROM projects");
      expect(query).not.toContain("project_capabilities");
      expect(query).not.toContain("project_uph_test_batches");
      expect(query).not.toContain("project_uph_analysis_snapshots");
    }
  });

  it("does not trust caller-provided roles: a database role and an actual PROJECT_UPH_ANALYZE grant are both required", async () => {
    const client = mockClient();
    const denied = {
      ...context(),
      projectMemberRoles: ["ENGINEER"],
      authorizationActor: { ...context().authorizationActor, grants: [] }
    };
    state.queue = [[{ role: "ENGINEER" }]];

    await expect(createUphAnalysis(denied, client)).rejects.toMatchObject({ status: 403 });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toContain("project_members");
  });

  it("rebuilds exact locked facts in stable order, persists one snapshot/Audit/Outbox, then settles the deferred guard", async () => {
    const client = mockClient();
    state.queue = successfulCreateQueue();

    const result = await createUphAnalysis(context(), client);

    expect(result.analysisId).toBe("analysis-1");
    expect(state.calls[1]).toContain("FROM projects");
    expect(state.calls[3]).toContain("project_uph_test_batches");
    expect(state.calls[4]).toContain("project_uph_test_batch_revisions");
    expect(state.calls[6]).toContain("WITH RECURSIVE tree");
    expect(state.calls[7]).toContain("project_uph_test_batch_revision_module_bindings");
    expect(state.calls.some((query) => query.includes("current_published_version_id"))).toBe(false);
    expect(
      state.calls.some((query) => /UPDATE\s+project_uph_(?:topolog|ct|formula|test)/u.test(query))
    ).toBe(false);
    expect(state.events).toEqual(["audit", "outbox", "constraints"]);
    expect(state.transactions).toEqual([client]);
  });

  it("does not insert audit or outbox facts when frozen input cannot produce a valid deterministic result", async () => {
    const client = mockClient();
    const invalid = successfulCreateQueue();
    (invalid[7] as Array<Record<string, unknown>>)[0]!.p90Seconds = null;
    state.queue = invalid;

    await expect(createUphAnalysis(context(), client)).rejects.toMatchObject({
      code: "ANALYSIS_INPUT_INVALID",
      status: 422
    });
    expect(
      state.calls.some((query) => query.includes("INSERT INTO project_uph_analysis_snapshots"))
    ).toBe(false);
    expect(state.events).toEqual([]);
  });

  it("returns an existing exact snapshot without a second SUCCESS Audit or Outbox event", async () => {
    const client = mockClient();
    state.queue = [
      [{ role: "ENGINEER" }],
      [{ id: "project-1" }],
      [{ enabled: true }],
      [{ id: "batch-1", currentLockedRevisionId: "revision-1" }],
      [lockedRevision()],
      [snapshot()]
    ];

    await expect(createUphAnalysis(context(), client)).resolves.toMatchObject({
      analysisId: "analysis-1"
    });
    expect(state.events).toEqual([]);
  });

  it("uses conflict-free INSERT convergence inside the caller's outer transaction without duplicate events", async () => {
    const concurrent = successfulCreateQueue() as unknown[];
    concurrent[12] = [];
    concurrent.push([snapshot()]);
    state.queue = concurrent;
    const outerTransaction = mockClient();

    await expect(createUphAnalysis(context(), outerTransaction)).resolves.toMatchObject({
      analysisId: "analysis-1"
    });
    expect(state.transactions).toEqual([outerTransaction]);
    expect(state.calls.at(-1)).toContain("FROM project_uph_analysis_snapshots");
    expect(state.events).toEqual([]);
  });

  it("maps only recognized database conflicts and known APM-082 deferred constraints while preserving unknown errors", async () => {
    const client = mockClient();
    state.queue = [
      [{ role: "ENGINEER" }],
      [{ id: "project-1" }],
      [{ enabled: true }],
      [{ id: "batch-1", currentLockedRevisionId: "revision-1" }],
      [{ ...lockedRevision(), checksumChainValid: false }]
    ];
    await expect(createUphAnalysis(context(), client)).rejects.toMatchObject({
      code: "ANALYSIS_INPUT_INVALID",
      status: 422
    });

    const deferredClient = mockClient();
    state.queue = [
      [{ role: "ENGINEER" }],
      [{ id: "project-1" }],
      [{ enabled: true }],
      [{ id: "batch-1", currentLockedRevisionId: "revision-1" }],
      Object.assign(new Error("UPH analysis requires the batch current LOCKED revision"), {
        code: "23514"
      })
    ];
    await expect(createUphAnalysis(context(), deferredClient)).rejects.toMatchObject({
      code: "LOCKED_REVISION_REQUIRED",
      status: 409
    });

    const uniqueClient = mockClient();
    state.queue = [
      [{ role: "ENGINEER" }],
      Object.assign(new Error("unique conflict"), { code: "23505" })
    ];
    await expect(createUphAnalysis(context(), uniqueClient)).rejects.toMatchObject({
      code: "ANALYSIS_CONFLICT",
      status: 409
    });

    const unknown = new Error("unknown database failure");
    const unknownClient = mockClient();
    state.queue = [[{ role: "ENGINEER" }], unknown];
    await expect(createUphAnalysis(context(), unknownClient)).rejects.toBe(unknown);
    const unknownConstraint = Object.assign(new Error("unrecognized check"), { code: "23514" });
    const unknownConstraintClient = mockClient();
    state.queue = [[{ role: "ENGINEER" }], unknownConstraint];
    await expect(createUphAnalysis(context(), unknownConstraintClient)).rejects.toBe(
      unknownConstraint
    );
    expect(UphAnalysisServiceError).toBeDefined();
  });

  it("keeps read scope project/batch/revision-bound and permits historical SUPERSEDED snapshot reads without a current-lock check", async () => {
    const readContext = context();
    state.queue = [[{ role: "ENGINEER" }], [{ id: "revision-1" }], [snapshot()]];
    await expect(
      getUphAnalysis({ ...readContext, analysisId: "analysis-1" })
    ).resolves.toMatchObject({
      analysisId: "analysis-1"
    });
    expect(state.events).toEqual([]);
    expect(state.calls.some((query) => query.includes("current_locked_revision_id"))).toBe(false);
  });

  it("documents the locked source sequence and avoids current-PUBLISHED or APM-080/081 write paths", () => {
    const source = readFileSync(new URL("./uph-analysis-service.ts", import.meta.url), "utf8");
    expect(source.indexOf("lockProjectAndCapability")).toBeLessThan(source.indexOf("lockBatch"));
    expect(source.indexOf("lockBatch")).toBeLessThan(source.indexOf("lockRevision"));
    expect(source.indexOf("lockRevision")).toBeLessThan(source.indexOf("existingSnapshot"));
    expect(source).not.toContain("current_published_version_id");
    expect(source).not.toMatch(/UPDATE\s+project_uph_(?:topolog|ct|formula|test)/u);
  });
});
