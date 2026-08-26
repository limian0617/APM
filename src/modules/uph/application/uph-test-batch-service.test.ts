import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const queryRaw = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  return {
    calls: [] as string[],
    client: { $queryRaw: queryRaw },
    queryRaw
  };
});

vi.mock("@/lib/db", () => ({
  inTransaction: (
    transaction: unknown,
    operation: (client: unknown) => Promise<unknown>
  ): Promise<unknown> => operation(transaction ?? database.client)
}));

import {
  getUphTestBatch,
  getUphTestBatchRevision,
  listUphTestBatches,
  UphTestBatchServiceError
} from "./uph-test-batch-service";

const serviceSource = readFileSync(new URL("./uph-test-batch-service.ts", import.meta.url), "utf8");

function sqlText(value: unknown): string {
  if (typeof value !== "object" || value === null || !("strings" in value)) return "";
  const strings = (value as { strings?: unknown }).strings;
  return Array.isArray(strings) ? strings.join("?") : "";
}

function readActor(grants: Array<{ permission: string; scope: string; systemRole: string }>) {
  return {
    id: "user-uph-service",
    name: "UPH reader",
    status: "ACTIVE" as const,
    departmentId: null,
    systemRoles: [],
    grants
  };
}

function resetQueryMock() {
  database.calls.length = 0;
  database.queryRaw.mockImplementation(async (...args: unknown[]) => {
    const query = sqlText(args[0]);
    database.calls.push(query);
    if (query.includes("FROM projects")) {
      return [{ departmentId: null, status: "ACTIVE", structureStatus: "READY" }];
    }
    if (query.includes("FROM project_capabilities")) return [{ enabled: true }];
    if (query.includes("FROM project_members")) return [{ role: "ENGINEER" }];
    return [];
  });
}

function serviceFunction(name: string, nextName: string): string {
  const start = serviceSource.indexOf(`export async function ${name}`);
  const end = serviceSource.indexOf(`export async function ${nextName}`, start + 1);
  return serviceSource.slice(start, end < 0 ? undefined : end);
}

describe("APM-081 UPH test batch service safety regressions", () => {
  it("default-denies every read before project or batch facts and allows READ to reach each entry", async () => {
    resetQueryMock();
    const denied = readActor([]);

    await expect(
      listUphTestBatches({
        projectId: "project-uph-service",
        authorizationActor: denied,
        projectMemberRoles: []
      })
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_DENIED",
      status: 403
    } satisfies Partial<UphTestBatchServiceError>);
    await expect(
      getUphTestBatch({
        projectId: "project-uph-service",
        batchId: "batch-uph-service",
        selection: "currentWork",
        authorizationActor: denied,
        projectMemberRoles: []
      })
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_DENIED",
      status: 403
    } satisfies Partial<UphTestBatchServiceError>);
    await expect(
      getUphTestBatchRevision({
        projectId: "project-uph-service",
        batchId: "batch-uph-service",
        revisionId: "revision-uph-service",
        authorizationActor: denied,
        projectMemberRoles: []
      })
    ).rejects.toMatchObject({
      code: "AUTHORIZATION_DENIED",
      status: 403
    } satisfies Partial<UphTestBatchServiceError>);
    expect(
      database.calls.some((query) =>
        [
          "FROM projects",
          "FROM project_capabilities",
          "project_uph_test_batches",
          "project_uph_test_batch_revisions"
        ].some((forbidden) => query.includes(forbidden))
      )
    ).toBe(false);

    resetQueryMock();
    const allowed = readActor([
      { permission: "PROJECT_UPH_READ", scope: "PROJECT", systemRole: "ENGINEER" }
    ]);
    await expect(
      listUphTestBatches({
        projectId: "project-uph-service",
        authorizationActor: allowed,
        projectMemberRoles: []
      })
    ).resolves.toMatchObject({ batches: [] });
    await expect(
      getUphTestBatch({
        projectId: "project-uph-service",
        batchId: "batch-uph-service",
        selection: "currentWork",
        authorizationActor: allowed,
        projectMemberRoles: []
      })
    ).rejects.toMatchObject({ code: "TEST_BATCH_REVISION_NOT_FOUND", status: 404 });
    expect(database.calls.some((query) => query.includes("project_uph_test_batches"))).toBe(true);
    await expect(
      getUphTestBatchRevision({
        projectId: "project-uph-service",
        batchId: "batch-uph-service",
        revisionId: "revision-uph-service",
        authorizationActor: allowed,
        projectMemberRoles: []
      })
    ).rejects.toMatchObject({ code: "TEST_BATCH_REVISION_NOT_FOUND", status: 404 });
    expect(database.calls.some((query) => query.includes("project_uph_test_batch_revisions"))).toBe(
      true
    );
  });

  it("discovers source lock sets without locks, then locks roots, versions, and selected sources in stable order", () => {
    const topologyLocator = serviceSource.slice(
      serviceSource.indexOf("async function locateTopologyRootSources"),
      serviceSource.indexOf("async function locateCurrentPublishedSourceLockSet")
    );
    const currentLocator = serviceSource.slice(
      serviceSource.indexOf("async function locateCurrentPublishedSourceLockSet"),
      serviceSource.indexOf("function sameCurrentSourceLockSet")
    );
    const frozenLocator = serviceSource.slice(
      serviceSource.indexOf("async function locateFrozenSourceLockSet"),
      serviceSource.indexOf("function sameFrozenSourceLockSet")
    );
    const currentSource = serviceSource.slice(
      serviceSource.indexOf("async function lockCurrentPublishedSource"),
      serviceSource.indexOf("async function locateFrozenSourceLockSet")
    );
    const frozenSource = serviceSource.slice(
      serviceSource.indexOf("async function lockFrozenSource"),
      serviceSource.indexOf("async function lockedRevision")
    );

    expect(topologyLocator).toContain("COALESCE(delivery_unit_id, project_module_id)");
    expect(topologyLocator).not.toContain("FOR UPDATE");
    expect(currentLocator).toContain("project_uph_topology_nodes");
    expect(currentLocator).not.toContain("FOR UPDATE");
    expect(frozenLocator).toContain("project_uph_test_batch_revision_module_bindings");
    expect(frozenLocator).not.toContain("FOR UPDATE");
    expect(serviceSource).toContain("function stableExactVersionLocks");
    expect(serviceSource).toContain(
      "left.id.localeCompare(right.id) || left.type.localeCompare(right.type)"
    );
    expect(serviceSource).toContain("for (const key of stableExactVersionLocks(keys))");
    expect(serviceSource).toContain("function stableSourceLocks");
    expect(serviceSource).toContain("left.sourceType.localeCompare(right.sourceType)");
    expect(currentSource.indexOf("await lockCurrentSourceRoots")).toBeLessThan(
      currentSource.indexOf("await lockExactVersions")
    );
    expect(currentSource.indexOf("await lockExactVersions")).toBeLessThan(
      currentSource.indexOf("await lockSelectedSources")
    );
    expect(frozenSource.indexOf("await lockFrozenSourceRoots")).toBeLessThan(
      frozenSource.indexOf("await lockExactVersions")
    );
    expect(frozenSource.indexOf("await lockExactVersions")).toBeLessThan(
      frozenSource.indexOf("await lockSelectedSources")
    );
    expect(frozenSource).toContain("sameFrozenSourceLockSet(discovered, verified)");
    expect(serviceSource).toContain("AND project_id = ${projectId} FOR UPDATE");
  });

  it("releases non-deferrable current indexes before successor promotion and validates only APM-081 deferred constraints before an outer commit", () => {
    const lock = serviceFunction("lockUphTestBatch", "replaceUphTestBatchRevision");
    const replace = serviceFunction("replaceUphTestBatchRevision", "");
    const correction = serviceSource.slice(
      serviceSource.indexOf("export async function correctUphCycleSample"),
      serviceSource.indexOf("export async function updateUphTestBatchProductionCount")
    );

    expect(replace.indexOf("status = 'SUPERSEDED'")).toBeLessThan(
      replace.indexOf("insertSuccessor(client")
    );
    expect(
      lock.indexOf("await supersedeCurrentLockedLineageAncestor(client, revision)")
    ).toBeLessThan(lock.indexOf("await promoteLocked(client, revision, membership)"));
    expect(serviceSource).toContain("revision.currentLockedRevisionId");
    expect(serviceSource).toContain("WITH RECURSIVE lineage AS");
    expect(serviceSource).toContain('"23505"');
    expect(serviceSource).toContain("function isApm081DeferredConstraintError");
    expect(serviceSource).toContain('String(code) !== "23514"');
    expect(serviceSource).toContain("UPH_CONSTRAINT_VIOLATION");
    expect(serviceSource).toContain("async function validateDeferredUphConstraints");
    for (const constraint of [
      "project_uph_test_batch_binding_guard",
      "project_uph_test_batch_revision_checksum_guard",
      "project_uph_test_batch_sample_append_guard",
      "project_uph_test_batch_pointer_commit_guard",
      "project_uph_test_batch_revision_successor_guard"
    ]) {
      expect(serviceSource).toContain(`"${constraint}"`);
    }
    expect(serviceSource).toContain("const result = await operation(client);");
    const commandSource = serviceSource.slice(
      serviceSource.indexOf("async function command"),
      serviceSource.indexOf("async function responseForRevision")
    );
    expect(commandSource).toContain("if (transaction) {");
    expect(serviceSource.indexOf("await validateDeferredUphConstraints(client)")).toBeGreaterThan(
      serviceSource.indexOf("const result = await operation(client);")
    );
    expect(replace).toContain("supersedesRevisionId: predecessor.revisionId");
    expect(replace).toContain("successorRevisionId: successorId");
    expect(replace).toContain("reason,");
    expect(correction).toContain("correctedSampleId: input.sampleId");
    expect(correction).toContain("replacementSampleId: replacementId");
  });
});
