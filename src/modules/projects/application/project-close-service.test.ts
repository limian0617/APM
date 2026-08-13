import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  db: {
    $transaction: vi.fn(),
    apiIdempotencyRecord: { findUnique: vi.fn() }
  }
}));

vi.mock("@/lib/db", () => database);

import {
  CLOSE_PROJECT_LOCK_ORDER,
  CLOSE_PROJECT_TRANSACTION_MAX_ATTEMPTS,
  CLOSE_PROJECT_TRANSACTION_OPTIONS,
  ProjectCloseError,
  archiveFormulaForClose,
  assertProjectCanClose,
  closeProject,
  evaluateClosurePolicyBinding,
  isRetryableCloseTransactionError,
  latestIntegrityStatus
} from "./project-close-service";

const facts = {
  projectId: "project-1",
  projectStatus: "IN_PROGRESS",
  projectVersion: 4,
  expectedProjectVersion: 4,
  g9Approved: true,
  g9SubmissionProjectId: "project-1",
  g9ArchiveVersionId: "archive-version-1",
  g9ClosurePolicyVersionId: "policy-version-1",
  g9ClosurePolicyChecksum: "c".repeat(64),
  g9ArchiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
  g9SnapshotStatus: "PASSED",
  archiveVersionId: "archive-version-1",
  archiveStatus: "READY",
  archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
  manifestChecksum: "a".repeat(64),
  g9ManifestChecksum: "a".repeat(64),
  sourceWatermark: "b".repeat(64),
  g9SourceWatermark: "b".repeat(64),
  sourceFactsCurrent: true,
  latestIntegrityStatus: "PASSED",
  archiveInputWatermark: "d".repeat(64),
  archiveInputApplicability: "APPLICABLE",
  g9ArchiveInputWatermark: "d".repeat(64),
  archiveAInputWatermark: "d".repeat(64),
  archiveAActualInputWatermark: "d".repeat(64),
  archiveAId: "archive-a",
  archiveAStatus: "READY",
  archiveAFormula: "ARCHIVE.SOURCE@2",
  archiveAInputApplicability: "APPLICABLE",
  retrospectiveInputArchiveVersionId: "archive-a",
  retrospectiveInputArchiveManifestChecksum: "f".repeat(64),
  retrospectiveInputArchiveSourceWatermark: "g".repeat(64),
  archiveAManifestChecksum: "f".repeat(64),
  archiveASourceWatermark: "g".repeat(64),
  policyVersionId: "policy-version-1",
  policyChecksum: "c".repeat(64),
  policyArchiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
  policyBindingsValid: true,
  snapshotCheckerBindingsValid: true,
  sourceGateDefinitionBindingsValid: true,
  policyFactsValid: true,
  policySourceGateDefinitionMatches: true,
  policyIsActive: true,
  policyIsCurrent: true,
  gateInstancePolicyVersionId: "policy-version-1",
  gateInstancePolicyChecksum: "c".repeat(64),
  gateInstanceArchiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
  gateSnapshotPolicyVersionId: "policy-version-1",
  gateSnapshotPolicyChecksum: "c".repeat(64),
  gateSnapshotArchiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
  archiveCheckerPassed: true,
  retrospectiveCheckerPassed: true,
  retrospectiveVersionId: "retrospective-version-1",
  retrospectiveStatus: "APPROVED",
  retrospectiveContentChecksum: "e".repeat(64),
  g9RetrospectiveContentChecksum: "e".repeat(64),
  currentRetrospectiveVersionId: "retrospective-version-1",
  latestApprovedRetrospectiveVersionId: "retrospective-version-1",
  archiveBIncludesRetrospectiveVersion: true,
  openResidualItemIds: [] as string[]
};

describe("project closure", () => {
  beforeEach(() => {
    database.db.$transaction.mockReset();
    database.db.apiIdempotencyRecord.findUnique.mockReset();
  });

  it("does not reinterpret unknown or missing archive formula persistence values", () => {
    expect(archiveFormulaForClose("V2")).toBe("ARCHIVE.SOURCE@2");
    expect(archiveFormulaForClose("V1")).toBe("ARCHIVE.SOURCE@1");
    expect(archiveFormulaForClose(null)).toBeNull();
    expect(archiveFormulaForClose("UNKNOWN")).toBeNull();
  });

  it("owns the close command in one serializable transaction with a deterministic lock order", () => {
    expect(CLOSE_PROJECT_TRANSACTION_OPTIONS).toMatchObject({ isolationLevel: "Serializable" });
    expect(CLOSE_PROJECT_LOCK_ORDER).toEqual([
      "PROJECT",
      "ARCHIVE_B_AND_AGGREGATE",
      "ARCHIVE_A",
      "RETROSPECTIVE_AGGREGATE_AND_VERSION",
      "G9_INSTANCE_SNAPSHOT_AND_SUBMISSION",
      "CLOSURE_POLICY_AND_VERSION",
      "RESIDUALS",
      "CLOSURE_RECORD"
    ]);
  });

  it("classifies only PostgreSQL serialization and deadlock failures as retryable close conflicts", () => {
    expect(isRetryableCloseTransactionError({ code: "P2034" })).toBe(true);
    expect(isRetryableCloseTransactionError({ meta: { code: "40001" } })).toBe(true);
    expect(isRetryableCloseTransactionError({ cause: { code: "40P01" } })).toBe(true);
    expect(isRetryableCloseTransactionError({ code: "P2002" })).toBe(false);
    expect(isRetryableCloseTransactionError(new Error("connection reset"))).toBe(false);
  });

  it("retries exhausted serializable close transactions and returns a retryable conflict", async () => {
    database.db.$transaction.mockRejectedValue({ code: "P2034" });

    await expect(
      closeProject({
        projectId: "project-1",
        archiveVersionId: "archive-b",
        g9SubmissionId: "g9-submission",
        expectedProjectVersion: 6,
        actorId: "quality-user",
        operationId: "close-serialization-conflict",
        idempotencyKey: "serialization-conflict-key"
      })
    ).rejects.toMatchObject({ code: "CLOSURE_TRANSACTION_CONFLICT", status: 409 });
    expect(database.db.$transaction).toHaveBeenCalledTimes(CLOSE_PROJECT_TRANSACTION_MAX_ATTEMPTS);
  });

  it("uses the highest-sequence integrity check as the latest fact", () => {
    expect(
      latestIntegrityStatus([
        { id: "check-1", sequence: 1, status: "FAILED" },
        { id: "check-2", sequence: 2, status: "PASSED" }
      ])
    ).toEqual({ id: "check-2", sequence: 2, status: "PASSED" });
  });

  it("rejects a new close key against a closed project before it can bypass optimistic locking", async () => {
    const record = {
      apiIdempotencyRecord: {
        create: vi.fn().mockResolvedValue({ id: "claim-1" })
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
      project: {
        findUnique: vi.fn().mockResolvedValue({
          id: "project-1",
          status: "CLOSED",
          version: 7,
          finalArchiveVersionId: "archive-b"
        })
      }
    };
    database.db.$transaction.mockImplementation(async (operation: (client: unknown) => unknown) =>
      operation(record)
    );

    await expect(
      closeProject({
        projectId: "project-1",
        archiveVersionId: "archive-b",
        g9SubmissionId: "g9-submission",
        expectedProjectVersion: 6,
        actorId: "quality-user",
        operationId: "close-retry-with-new-key",
        idempotencyKey: "new-close-key"
      })
    ).rejects.toMatchObject({ code: "PROJECT_VERSION_CONFLICT", status: 409 });
    expect(record.apiIdempotencyRecord.create).toHaveBeenCalledOnce();
  });
  it("accepts only an approved, exact ready archive with no residuals", () => {
    expect(assertProjectCanClose(facts)).toBeUndefined();
  });

  it("fails closed when G9 approval, archive facts, residuals, or optimistic version is stale", () => {
    const cases: Array<[string, Partial<typeof facts>]> = [
      ["PROJECT_G9_NOT_APPROVED", { g9Approved: false }],
      ["PROJECT_ARCHIVE_NOT_READY", { archiveStatus: "FAILED" }],
      ["PROJECT_ARCHIVE_FACTS_STALE", { g9ManifestChecksum: "c".repeat(64) }],
      ["PROJECT_RESIDUALS_OPEN", { openResidualItemIds: ["residual-1"] }],
      ["PROJECT_VERSION_CONFLICT", { expectedProjectVersion: 3 }]
    ];
    for (const [code, override] of cases) {
      expect(() => assertProjectCanClose({ ...facts, ...override })).toThrowError(
        expect.objectContaining({ code })
      );
    }
  });

  it("rejects closure when sources changed after the ready archive was checked", () => {
    expect(() => assertProjectCanClose({ ...facts, sourceFactsCurrent: false })).toThrowError(
      expect.objectContaining({ code: "PROJECT_ARCHIVE_FACTS_STALE", status: 409 })
    );
  });

  it("requires the approved G9 to freeze the active V2 closure policy authority", () => {
    const v2Facts = {
      ...facts,
      archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
      g9ArchiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
      g9ClosurePolicyVersionId: null,
      g9ClosurePolicyChecksum: null,
      policyVersionId: "policy-version-1",
      policyChecksum: "c".repeat(64),
      policyArchiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
      policyBindingsValid: true,
      archiveCheckerPassed: true,
      retrospectiveCheckerPassed: true,
      latestIntegrityStatus: "PASSED",
      archiveInputWatermark: "d".repeat(64),
      g9ArchiveInputWatermark: "d".repeat(64),
      retrospectiveVersionId: "retrospective-version-1",
      retrospectiveContentChecksum: "e".repeat(64),
      currentRetrospectiveVersionId: "retrospective-version-1",
      latestApprovedRetrospectiveVersionId: "retrospective-version-1",
      archiveBIncludesRetrospectiveVersion: true
    };

    expect(() => assertProjectCanClose(v2Facts)).toThrowError(
      expect.objectContaining({ code: "CLOSURE_POLICY_VERSION_REQUIRED", status: 409 })
    );
  });

  it("rejects a stale Archive A input watermark or a policy bound to another G9 definition", () => {
    for (const override of [
      { archiveAInputWatermark: "f".repeat(64) },
      { policySourceGateDefinitionMatches: false }
    ]) {
      expect(() => assertProjectCanClose({ ...facts, ...override })).toThrowError(
        expect.objectContaining({ status: 409 })
      );
    }
  });

  it("rejects a forged G9 snapshot checker binding even when the frozen tuple otherwise matches", () => {
    expect(() =>
      assertProjectCanClose({ ...facts, snapshotCheckerBindingsValid: false })
    ).toThrowError(
      expect.objectContaining({ code: "CLOSURE_POLICY_BINDING_MISMATCH", status: 409 })
    );
  });

  it("rejects exact checker bindings when their persisted policy checksum was built for another template", () => {
    const checked = evaluateClosurePolicyBinding({
      projectId: "project-1",
      sourceTemplateSnapshotId: "template-snapshot-1",
      sourceGateDefinitionId: "g9-definition-1",
      sourceGateDefinitionBindings: [
        { code: "CLOSURE.ARCHIVE.G9", version: 2 },
        { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
      ],
      snapshotBindings: [
        { code: "CLOSURE.ARCHIVE.G9", version: 2 },
        { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
      ],
      persisted: {
        archiveCheckerCode: "CLOSURE.ARCHIVE.G9",
        archiveCheckerVersion: 2,
        retrospectiveCheckerCode: "CLOSURE.RETROSPECTIVE.G9",
        retrospectiveCheckerVersion: 1,
        archiveSourceFormulaVersion: "V2",
        selfReferenceExclusionVersion: "CLOSURE.SELF_REFERENCE_EXCLUSION@1",
        bindingChecksum: "a".repeat(64),
        policyChecksum: "b".repeat(64)
      }
    });
    expect(checked).toEqual({
      sourceGateDefinitionBindingsValid: true,
      snapshotCheckerBindingsValid: true,
      policyFactsValid: false
    });
  });

  it("requires the approved retrospective to keep its exact ready Archive A", () => {
    expect(() => assertProjectCanClose({ ...facts, archiveAStatus: "FAILED" })).toThrowError(
      expect.objectContaining({ code: "CLOSURE_RETROSPECTIVE_NOT_CURRENT" })
    );
  });

  it("fails closed for a non-applicable archive or an unapproved retrospective", () => {
    for (const override of [
      { archiveInputApplicability: "NOT_APPLICABLE" },
      { archiveAInputApplicability: "NOT_APPLICABLE" },
      { retrospectiveStatus: "IN_REVIEW" }
    ]) {
      expect(() => assertProjectCanClose({ ...facts, ...override })).toThrowError(
        expect.objectContaining({ status: 409 })
      );
    }
  });

  it("requires the actual Archive A watermark to equal Archive B", () => {
    expect(() =>
      assertProjectCanClose({ ...facts, archiveAActualInputWatermark: "h".repeat(64) })
    ).toThrowError(expect.objectContaining({ code: "PROJECT_ARCHIVE_FACTS_STALE" }));
  });

  it("rejects a submission whose policy is no longer the aggregate current version", () => {
    expect(() => assertProjectCanClose({ ...facts, policyIsCurrent: false })).toThrowError(
      expect.objectContaining({ code: "CLOSURE_POLICY_STALE" })
    );
  });

  it("requires a passed G9 snapshot that freezes the current retrospective checksum", () => {
    for (const override of [
      { g9SnapshotStatus: "WARNING" },
      { g9RetrospectiveContentChecksum: "f".repeat(64) }
    ]) {
      expect(() => assertProjectCanClose({ ...facts, ...override })).toThrowError(
        expect.objectContaining({ status: 409 })
      );
    }
  });
});
