import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";

import * as readinessDomain from "../domain/readiness";

import {
  calculateAndPublishReadiness,
  configureReadinessPolicy,
  readProcurementGateFacts,
  readProcurementReadinessTree,
  readProjectProcurementOverview,
  requestReadinessRecalculation
} from "./readiness-service";

const auditContext = {
  actorId: "user-1",
  requestId: "request-1",
  traceId: "a".repeat(32),
  source: "API" as const,
  sourceIp: null,
  userAgent: "Vitest",
  reason: null,
  projectId: "project-1",
  departmentId: "engineering",
  operationId: "readiness-test"
};

function readinessClient() {
  const state: any = {
    policy: {
      id: "policy-1",
      version: 1,
      formulaVersion: "PROCUREMENT.READINESS@1",
      dueGraceDays: 0
    },
    policyVersions: [],
    settings: null,
    requirements: [],
    events: [],
    trackingLines: [],
    deliveryUnits: [],
    modules: [],
    syncStates: [],
    results: [],
    audits: [],
    outbox: []
  };
  state.settings = {
    projectId: "project-1",
    mode: "LOCAL",
    sourceSystem: null,
    currentReadinessPolicyVersionId: state.policy.id,
    version: 1,
    currentReadinessPolicyVersion: state.policy
  };
  state.policyVersions.push(state.policy);
  state.requirements.push({
    id: "requirement-1",
    version: 1,
    status: "CONFIRMED",
    currentRevision: {
      id: "revision-1",
      status: "CONFIRMED",
      revision: 1,
      deliveryUnitId: null,
      responsibilityPackageId: null,
      taskId: null,
      materialReferenceId: "material-1",
      trackingUnit: "PCS",
      quantity: { toString: () => "2" },
      isCritical: true,
      isLongLead: false,
      requiredOn: new Date("2026-08-01T00:00:00.000Z"),
      predictedAssemblyStartOn: null,
      moduleId: null,
      businessType: "STANDARD_PURCHASE",
      source: "MANUAL",
      sourceReference: null,
      sourceVersion: null,
      drawingId: null,
      drawingVersionId: null,
      outsourcedProcess: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z")
    }
  });
  const client: any = {
    $queryRaw: async () => [{ now: new Date("2026-08-07T00:00:00.000Z") }],
    project: { findUnique: async () => ({ id: "project-1", status: "ACTIVE" }) },
    projectCapability: { findUnique: async () => ({ selectedEnabled: true }) },
    companyCapability: { findUnique: async () => ({ enabled: true }) },
    projectProcurementSettings: {
      findUnique: async () => state.settings,
      update: async ({ data }: any) => {
        state.settings = {
          ...state.settings,
          ...data,
          version:
            typeof data.version === "object" && data.version.increment
              ? state.settings.version + data.version.increment
              : (data.version ?? state.settings.version)
        };
        return state.settings;
      }
    },
    procurementReadinessPolicyVersion: {
      aggregate: async () => ({ _max: { version: state.policyVersions.at(-1)?.version ?? null } }),
      create: async ({ data }: any) => {
        const policy = { id: `policy-${state.policyVersions.length + 1}`, ...data };
        state.policy = policy;
        state.policyVersions.push(policy);
        return policy;
      }
    },
    projectMaterialRequirement: { findMany: async () => state.requirements },
    procurementFulfillmentEvent: { findMany: async () => state.events },
    procurementTrackingLine: { findMany: async () => state.trackingLines },
    deliveryUnit: { findMany: async () => state.deliveryUnits },
    projectModule: { findMany: async () => state.modules },
    procurementSyncState: { findMany: async () => state.syncStates },
    procurementReadinessResult: {
      findMany: async () => state.results,
      findFirst: async ({ where }: any) =>
        state.results.find(
          (result: any) =>
            result.projectId === where.projectId &&
            result.scopeType === where.scopeType &&
            result.scopeId === where.scopeId &&
            result.inputWatermark === where.inputWatermark &&
            result.formulaVersion === where.formulaVersion
        ) ?? null,
      createMany: async ({ data }: any) => {
        state.results.push(...data);
        return { count: data.length };
      }
    },
    auditLog: {
      create: async ({ data }: any) => {
        const audit = { id: `audit-${state.audits.length + 1}`, ...data };
        state.audits.push(audit);
        return audit;
      }
    },
    outboxEvent: {
      upsert: async ({ create }: any) => {
        const existing = state.outbox.find(
          (event: any) =>
            event.eventType === create.eventType && event.idempotencyKey === create.idempotencyKey
        );
        if (existing) return existing;
        const event = { id: `outbox-${state.outbox.length + 1}`, ...create };
        state.outbox.push(event);
        return event;
      }
    }
  };
  vi.spyOn(db, "$transaction").mockImplementation(((
    operation: (transactionClient: typeof client) => unknown
  ) => operation(client)) as never);
  return { client, state };
}

describe("APM-091B procurement readiness service", () => {
  it("exposes the fixed command and read-port surface", () => {
    expect(configureReadinessPolicy).toBeTypeOf("function");
    expect(requestReadinessRecalculation).toBeTypeOf("function");
    expect(calculateAndPublishReadiness).toBeTypeOf("function");
    expect(readProjectProcurementOverview).toBeTypeOf("function");
    expect(readProcurementReadinessTree).toBeTypeOf("function");
    expect(readProcurementGateFacts).toBeTypeOf("function");
  });

  it("appends readiness policy versions and advances only the current pointer", async () => {
    const { client, state } = readinessClient();
    const policy = () =>
      configureReadinessPolicy(
        {
          projectId: "project-1",
          inspectionRequired: true,
          arrivalAutoUsable: false,
          criticalRule: {},
          dueGraceDays: 0,
          gateThreshold: {},
          reason: "policy",
          actorId: "user-1",
          auditContext
        },
        client
      );

    const second = await policy();
    const third = await policy();

    expect(state.policyVersions.map((version: any) => version.version)).toEqual([1, 2, 3]);
    expect(second.policy.id).not.toBe(third.policy.id);
    expect(state.settings.currentReadinessPolicyVersionId).toBe(third.policy.id);
    expect(state.settings.version).toBe(3);
    expect(
      state.outbox.filter(
        (event: any) => event.eventType === "procurement.readiness-recalculation.requested"
      )
    ).toHaveLength(2);
  });

  it("changes the input watermark for requirement, tracking, event, policy, and assembly-date facts", async () => {
    const { state } = readinessClient();
    const request = () =>
      requestReadinessRecalculation({
        projectId: "project-1",
        actorId: "user-1",
        reason: "test",
        auditContext
      });

    const initial = await request();
    state.requirements[0].version += 1;
    const requirementChanged = await request();
    state.trackingLines.push({
      id: "tracking-1",
      version: 1,
      updatedAt: new Date("2026-08-07T01:00:00.000Z")
    });
    const trackingChanged = await request();
    state.events.push({
      id: "event-1",
      requirementId: "requirement-1",
      requirementRevisionId: "revision-1",
      eventType: "ACCEPTED",
      quantity: { toString: () => "1" },
      trackingUnit: "PCS",
      reversesEventId: null,
      businessOccurredAt: new Date("2026-08-07T01:00:00.000Z"),
      recordedAt: new Date("2026-08-07T01:00:00.000Z")
    });
    const eventChanged = await request();
    state.policy = { ...state.policy, id: "policy-2", version: 2 };
    state.settings.currentReadinessPolicyVersionId = state.policy.id;
    state.settings.currentReadinessPolicyVersion = state.policy;
    const policyChanged = await request();
    state.requirements[0].currentRevision.predictedAssemblyStartOn = new Date(
      "2026-08-09T00:00:00.000Z"
    );
    const assemblyChanged = await request();

    expect(
      new Set([
        initial.inputWatermark,
        requirementChanged.inputWatermark,
        trackingChanged.inputWatermark,
        eventChanged.inputWatermark,
        policyChanged.inputWatermark,
        assemblyChanged.inputWatermark
      ]).size
    ).toBe(6);
  });

  it("treats repeated requests for the same calculation input as the same outbox command", async () => {
    const { state } = readinessClient();
    const first = await requestReadinessRecalculation({
      projectId: "project-1",
      actorId: "user-1",
      reason: "first",
      auditContext
    });
    const repeated = await requestReadinessRecalculation({
      projectId: "project-1",
      actorId: "user-2",
      reason: "retry",
      auditContext
    });

    expect(repeated.outboxEventId).toBe(first.outboxEventId);
    expect(state.outbox).toHaveLength(1);
  });

  it("uses REPEATABLE READ for internally-owned request and calculation snapshots", async () => {
    const { client } = readinessClient();
    const transaction = vi
      .spyOn(db, "$transaction")
      .mockImplementation(((operation: (transactionClient: typeof client) => unknown) =>
        operation(client)) as never);
    try {
      transaction.mockClear();
      const request = await requestReadinessRecalculation({
        projectId: "project-1",
        actorId: "user-1",
        reason: "test",
        auditContext
      });
      await calculateAndPublishReadiness({
        projectId: "project-1",
        inputWatermark: request.inputWatermark,
        auditContext
      });

      expect(transaction.mock.calls).toHaveLength(2);
      expect(transaction.mock.calls.every((call) => call[1])).toBe(true);
      expect(transaction.mock.calls.map((call) => call[1])).toEqual([
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
      ]);
    } finally {
      transaction.mockRestore();
    }
  });

  it("rejects a caller-supplied transaction so a snapshot cannot silently use a weaker isolation", async () => {
    const { client } = readinessClient();
    const transaction = vi.spyOn(db, "$transaction");
    try {
      await expect(
        requestReadinessRecalculation(
          { projectId: "project-1", actorId: "user-1", reason: "test", auditContext },
          client
        )
      ).rejects.toMatchObject({ code: "PROC_READINESS_EXTERNAL_TRANSACTION_FORBIDDEN" });
      await expect(
        calculateAndPublishReadiness({ projectId: "project-1", auditContext }, client)
      ).rejects.toMatchObject({ code: "PROC_READINESS_EXTERNAL_TRANSACTION_FORBIDDEN" });

      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
  });

  it("publishes a hierarchical snapshot once for the same project watermark and formula", async () => {
    const { state } = readinessClient();
    const request = await requestReadinessRecalculation({
      projectId: "project-1",
      actorId: "user-1",
      reason: "test",
      auditContext
    });

    const first = await calculateAndPublishReadiness({
      projectId: "project-1",
      inputWatermark: request.inputWatermark,
      auditContext
    });
    const repeated = await calculateAndPublishReadiness({
      projectId: "project-1",
      inputWatermark: request.inputWatermark,
      auditContext
    });

    expect(first.status).toBe("PUBLISHED");
    expect(first.results.map((result) => result.scopeType)).toEqual(["PROJECT", "REQUIREMENT"]);
    expect(repeated.status).toBe("IDEMPOTENT");
    expect(state.results).toHaveLength(2);
    expect(state.audits).toHaveLength(1);
    expect(
      state.outbox.filter((event: any) => event.eventType === "procurement.readiness.published")
    ).toHaveLength(1);
  });

  it("does not let an older worker watermark overwrite a newer snapshot", async () => {
    const { state } = readinessClient();
    const request = await requestReadinessRecalculation({
      projectId: "project-1",
      actorId: "user-1",
      reason: "test",
      auditContext
    });
    state.requirements[0].version += 1;

    const result = await calculateAndPublishReadiness({
      projectId: "project-1",
      inputWatermark: request.inputWatermark,
      auditContext
    });

    expect(result.status).toBe("SUPERSEDED");
    expect(state.results).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it("publishes immutable FAILED facts after a calculation failure without removing prior results", async () => {
    const { state } = readinessClient();
    const firstRequest = await requestReadinessRecalculation({
      projectId: "project-1",
      actorId: "user-1",
      reason: "initial",
      auditContext
    });
    await calculateAndPublishReadiness({
      projectId: "project-1",
      inputWatermark: firstRequest.inputWatermark,
      auditContext
    });
    const publishedRows = [...state.results];
    state.requirements[0].version += 1;
    const failedRequest = await requestReadinessRecalculation({
      projectId: "project-1",
      actorId: "user-1",
      reason: "failure",
      auditContext
    });
    const calculation = vi.spyOn(readinessDomain, "calculateReadiness").mockImplementation(() => {
      throw new Error("calculation failed");
    });
    try {
      const failed = await calculateAndPublishReadiness({
        projectId: "project-1",
        inputWatermark: failedRequest.inputWatermark,
        auditContext
      });

      expect(failed.status).toBe("FAILED");
      expect(failed.results).toHaveLength(2);
      expect(failed.results.every((result) => result.status === "FAILED")).toBe(true);
      expect(state.results).toHaveLength(4);
      expect(state.results.slice(0, 2)).toEqual(publishedRows);
      expect(state.results.slice(2).every((result: any) => result.status === "FAILED")).toBe(true);
    } finally {
      calculation.mockRestore();
    }
  });

  it("maps an ERP stale watermark to a STALE readiness fact", async () => {
    const { state } = readinessClient();
    state.settings.mode = "ERP";
    state.settings.sourceSystem = "NUS-M9";
    state.syncStates.push({
      id: "sync-1",
      version: 1,
      status: "STALE",
      lastSuccessfulAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-07T00:00:00.000Z")
    });
    const request = await requestReadinessRecalculation({
      projectId: "project-1",
      actorId: "user-1",
      reason: "test",
      auditContext
    });

    const result = await calculateAndPublishReadiness({
      projectId: "project-1",
      inputWatermark: request.inputWatermark,
      auditContext
    });

    expect(result.results.find((fact) => fact.scopeType === "PROJECT")?.status).toBe("STALE");
  });

  it("does not derive a current revision usable date from an older revision event", async () => {
    const { state } = readinessClient();
    state.events.push(
      {
        id: "current-accepted",
        requirementId: "requirement-1",
        requirementRevisionId: "revision-1",
        eventType: "ACCEPTED",
        quantity: { toString: () => "2" },
        trackingUnit: "PCS",
        reversesEventId: null,
        businessOccurredAt: new Date("2026-08-01T00:00:00.000Z"),
        recordedAt: new Date("2026-08-01T00:00:00.000Z")
      },
      {
        id: "current-usable",
        requirementId: "requirement-1",
        requirementRevisionId: "revision-1",
        eventType: "MARKED_USABLE",
        quantity: { toString: () => "2" },
        trackingUnit: "PCS",
        reversesEventId: null,
        businessOccurredAt: new Date("2026-08-01T00:00:00.000Z"),
        recordedAt: new Date("2026-08-01T00:00:00.000Z")
      },
      {
        id: "old-revision-usable",
        requirementId: "requirement-1",
        requirementRevisionId: "revision-0",
        eventType: "MARKED_USABLE",
        quantity: { toString: () => "2" },
        trackingUnit: "PCS",
        reversesEventId: null,
        businessOccurredAt: new Date("2026-08-05T00:00:00.000Z"),
        recordedAt: new Date("2026-08-05T00:00:00.000Z")
      }
    );
    const request = await requestReadinessRecalculation({
      projectId: "project-1",
      actorId: "user-1",
      reason: "test",
      auditContext
    });

    const result = await calculateAndPublishReadiness({
      projectId: "project-1",
      inputWatermark: request.inputWatermark,
      auditContext
    });

    expect(result.results.find((fact) => fact.scopeType === "PROJECT")?.overdueLines).toBe(0);
  });

  it("does not derive a usable date from a current revision event that was reversed", async () => {
    const { state } = readinessClient();
    state.events.push(
      {
        id: "on-time-accepted",
        requirementId: "requirement-1",
        requirementRevisionId: "revision-1",
        eventType: "ACCEPTED",
        quantity: { toString: () => "2" },
        trackingUnit: "PCS",
        reversesEventId: null,
        businessOccurredAt: new Date("2026-08-01T00:00:00.000Z"),
        recordedAt: new Date("2026-08-01T00:00:00.000Z")
      },
      {
        id: "on-time-usable",
        requirementId: "requirement-1",
        requirementRevisionId: "revision-1",
        eventType: "MARKED_USABLE",
        quantity: { toString: () => "2" },
        trackingUnit: "PCS",
        reversesEventId: null,
        businessOccurredAt: new Date("2026-08-01T00:00:00.000Z"),
        recordedAt: new Date("2026-08-01T00:00:00.000Z")
      },
      {
        id: "reversed-late-usable",
        requirementId: "requirement-1",
        requirementRevisionId: "revision-1",
        eventType: "MARKED_USABLE",
        quantity: { toString: () => "2" },
        trackingUnit: "PCS",
        reversesEventId: null,
        businessOccurredAt: new Date("2026-08-05T00:00:00.000Z"),
        recordedAt: new Date("2026-08-05T00:00:00.000Z")
      },
      {
        id: "reversal",
        requirementId: "requirement-1",
        requirementRevisionId: "revision-1",
        eventType: "REVERSED",
        quantity: { toString: () => "2" },
        trackingUnit: "PCS",
        reversesEventId: "reversed-late-usable",
        businessOccurredAt: new Date("2026-08-06T00:00:00.000Z"),
        recordedAt: new Date("2026-08-06T00:00:00.000Z")
      }
    );
    const request = await requestReadinessRecalculation({
      projectId: "project-1",
      actorId: "user-1",
      reason: "test",
      auditContext
    });

    const result = await calculateAndPublishReadiness({
      projectId: "project-1",
      inputWatermark: request.inputWatermark,
      auditContext
    });

    expect(result.results.find((fact) => fact.scopeType === "PROJECT")?.overdueLines).toBe(0);
  });

  it("reads a coherent tree from the newest project root snapshot and marks only that set stale", async () => {
    const { state } = readinessClient();
    const request = await requestReadinessRecalculation({
      projectId: "project-1",
      actorId: "user-1",
      reason: "seed current root snapshot",
      auditContext
    });
    const fact = (overrides: Record<string, unknown>) => ({
      id: "result-1",
      projectId: "project-1",
      scopeType: "PROJECT" as const,
      scopeId: "project-1",
      policyVersionId: "policy-1",
      formulaVersion: "PROCUREMENT.READINESS@1",
      inputWatermark: request.inputWatermark,
      status: "READY" as const,
      totalLines: 1,
      readyLines: 1,
      readinessRate: { toString: () => "1" },
      criticalTotalLines: 0,
      criticalReadyLines: 0,
      criticalReadinessRate: { toString: () => "0" },
      gapLines: 0,
      overdueLines: 0,
      pendingAcceptanceLines: 0,
      blockingCriticalLines: 0,
      sourceMode: "LOCAL" as const,
      sourceSyncedAt: null,
      calculatedAt: new Date("2026-08-07T01:00:00.000Z"),
      ...overrides
    });
    state.results.push(
      fact({ id: "current-root" }),
      fact({ id: "current-requirement", scopeType: "REQUIREMENT", scopeId: "requirement-1" }),
      fact({
        id: "mismatched-formula",
        scopeType: "REQUIREMENT",
        scopeId: "requirement-mismatched-formula",
        formulaVersion: "PROCUREMENT.READINESS@0"
      }),
      fact({
        id: "old-root",
        inputWatermark: "old-watermark",
        calculatedAt: new Date("2026-08-07T00:00:00.000Z")
      }),
      fact({
        id: "canceled-requirement-from-old-snapshot",
        scopeType: "REQUIREMENT",
        scopeId: "requirement-canceled",
        inputWatermark: "old-watermark",
        calculatedAt: new Date("2026-08-07T00:00:00.000Z")
      })
    );

    const current = await readProcurementReadinessTree({ projectId: "project-1" });

    expect(current.stale).toBe(false);
    expect(current.scopes.map((scope) => scope.id)).toEqual([
      "current-root",
      "current-requirement"
    ]);

    state.requirements[0].version += 1;
    const stale = await readProcurementReadinessTree({ projectId: "project-1" });

    expect(stale.stale).toBe(true);
    expect(stale.scopes.map((scope) => scope.id)).toEqual(["current-root", "current-requirement"]);
    expect(stale.scopes.every((scope) => scope.status === "STALE")).toBe(true);
  });

  it("marks an old READY snapshot stale in the overview, tree, and Gate facts after input changes", async () => {
    const { client, state } = readinessClient();
    const publishedWatermark = "published-watermark";
    const fact = {
      id: "result-1",
      projectId: "project-1",
      scopeType: "PROJECT" as const,
      scopeId: "project-1",
      policyVersionId: "policy-1",
      formulaVersion: "PROCUREMENT.READINESS@1",
      inputWatermark: publishedWatermark,
      status: "READY" as const,
      totalLines: 1,
      readyLines: 1,
      readinessRate: { toString: () => "1" },
      criticalTotalLines: 1,
      criticalReadyLines: 1,
      criticalReadinessRate: { toString: () => "1" },
      gapLines: 0,
      overdueLines: 0,
      pendingAcceptanceLines: 0,
      blockingCriticalLines: 0,
      sourceMode: "LOCAL" as const,
      sourceSyncedAt: null,
      calculatedAt: new Date("2026-08-07T00:00:00.000Z")
    };
    state.results.push(fact);
    state.requirements[0].version += 1;
    const latestResults = vi
      .spyOn(db.procurementReadinessResult, "findMany")
      .mockResolvedValue([fact] as never);
    const transaction = vi
      .spyOn(db, "$transaction")
      .mockImplementation(((operation: (transactionClient: typeof client) => unknown) =>
        operation(client)) as never);
    try {
      const [overview, tree, gateFacts] = await Promise.all([
        readProjectProcurementOverview({ projectId: "project-1" }),
        readProcurementReadinessTree({ projectId: "project-1" }),
        readProcurementGateFacts({ projectId: "project-1" })
      ]);

      expect(overview.stale).toBe(true);
      expect(overview.readiness?.status).toBe("STALE");
      expect(tree.scopes.every((scope) => scope.status === "STALE")).toBe(true);
      expect(gateFacts.status).toBe("STALE");
    } finally {
      transaction.mockRestore();
      latestResults.mockRestore();
    }
  });
});
