import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const closeService = vi.hoisted(() => ({ closeProject: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/observability/application/request-observer", () => ({
  withRequestObservability: (_metadata: unknown, handler: unknown) => handler
}));
vi.mock("@/modules/projects/application/project-close-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./project-close-service")>()),
  closeProject: closeService.closeProject
}));

import {
  assertProjectCanClose,
  type CloseProjectInput,
  ProjectCloseError
} from "./project-close-service";
import { POST } from "@/app/api/projects/[projectId]/close/route";

describe("project close contract", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    closeService.closeProject.mockReset();
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "quality-user" },
      project: { departmentId: "quality" }
    });
  });

  it("accepts only trusted close command facts and service-owned idempotency", () => {
    expectTypeOf<CloseProjectInput>().toMatchTypeOf<{
      projectId: string;
      archiveVersionId: string;
      g9SubmissionId: string;
      expectedProjectVersion: number;
      actorId: string;
      operationId: string;
      idempotencyKey: string;
    }>();
    expectTypeOf<CloseProjectInput>().not.toHaveProperty("client");
  });

  it("rejects stale closure facts as a conflict", () => {
    expect(() =>
      assertProjectCanClose({
        projectId: "p1",
        projectStatus: "IN_PROGRESS",
        projectVersion: 3,
        expectedProjectVersion: 2,
        g9Approved: true,
        g9SubmissionProjectId: "p1",
        g9ArchiveVersionId: "av1",
        g9ClosurePolicyVersionId: "policy-1",
        g9ClosurePolicyChecksum: "c".repeat(64),
        g9ArchiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
        g9SnapshotStatus: "PASSED",
        archiveVersionId: "av1",
        archiveStatus: "READY",
        archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
        manifestChecksum: "m",
        g9ManifestChecksum: "m",
        sourceWatermark: "w",
        g9SourceWatermark: "w",
        sourceFactsCurrent: true,
        latestIntegrityStatus: "PASSED",
        archiveInputWatermark: "i",
        archiveInputApplicability: "APPLICABLE",
        g9ArchiveInputWatermark: "i",
        archiveAInputWatermark: "i",
        archiveAActualInputWatermark: "i",
        archiveAId: "archive-a",
        archiveAStatus: "READY",
        archiveAFormula: "ARCHIVE.SOURCE@2",
        archiveAInputApplicability: "APPLICABLE",
        retrospectiveInputArchiveVersionId: "archive-a",
        retrospectiveInputArchiveManifestChecksum: "archive-manifest",
        retrospectiveInputArchiveSourceWatermark: "archive-watermark",
        archiveAManifestChecksum: "archive-manifest",
        archiveASourceWatermark: "archive-watermark",
        policyVersionId: "policy-1",
        policyChecksum: "c".repeat(64),
        policyArchiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
        policyBindingsValid: true,
        snapshotCheckerBindingsValid: true,
        sourceGateDefinitionBindingsValid: true,
        policyFactsValid: true,
        policySourceGateDefinitionMatches: true,
        policyIsActive: true,
        policyIsCurrent: true,
        gateInstancePolicyVersionId: "policy-1",
        gateInstancePolicyChecksum: "c".repeat(64),
        gateInstanceArchiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
        gateSnapshotPolicyVersionId: "policy-1",
        gateSnapshotPolicyChecksum: "c".repeat(64),
        gateSnapshotArchiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
        archiveCheckerPassed: true,
        retrospectiveCheckerPassed: true,
        retrospectiveVersionId: "retro-1",
        retrospectiveStatus: "APPROVED",
        retrospectiveContentChecksum: "e".repeat(64),
        g9RetrospectiveContentChecksum: "e".repeat(64),
        currentRetrospectiveVersionId: "retro-1",
        latestApprovedRetrospectiveVersionId: "retro-1",
        archiveBIncludesRetrospectiveVersion: true,
        openResidualItemIds: []
      })
    ).toThrowError(
      expect.objectContaining({
        code: "PROJECT_VERSION_CONFLICT",
        status: 409
      } satisfies Partial<ProjectCloseError>)
    );
  });

  it("rejects caller-selected policy fields before invoking the close service", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects/project-1/close", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "close-key-1" },
        body: JSON.stringify({
          archiveVersionId: "archive-b",
          g9SubmissionId: "g9-submission",
          expectedProjectVersion: 7,
          operationId: "close-operation",
          closurePolicyVersionId: "policy-forged-by-client"
        })
      }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(response.status).toBe(422);
    expect(closeService.closeProject).not.toHaveBeenCalled();
  });

  it("maps a cross-project G9 submission conflict and exposes idempotent replays", async () => {
    closeService.closeProject
      .mockRejectedValueOnce(
        new ProjectCloseError("CLOSURE_SUBMISSION_PROJECT_MISMATCH", "G9 申请不属于当前项目。")
      )
      .mockResolvedValueOnce({
        projectId: "project-1",
        status: "CLOSED",
        finalArchiveVersionId: "archive-b",
        idempotent: true
      });
    const request = () =>
      new Request("http://localhost/api/projects/project-1/close", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "close-key-2" },
        body: JSON.stringify({
          archiveVersionId: "archive-b",
          g9SubmissionId: "g9-submission",
          expectedProjectVersion: 7,
          operationId: "close-operation"
        })
      });

    const conflict = await POST(request(), { params: Promise.resolve({ projectId: "project-1" }) });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "CLOSURE_SUBMISSION_PROJECT_MISMATCH" }
    });

    const replay = await POST(request(), { params: Promise.resolve({ projectId: "project-1" }) });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(closeService.closeProject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        actorId: "quality-user",
        idempotencyKey: "close-key-2"
      })
    );
  });

  it("returns a retryable 409 when serializable close retries are exhausted", async () => {
    closeService.closeProject.mockRejectedValueOnce(
      new ProjectCloseError("CLOSURE_TRANSACTION_CONFLICT", "结项事实正在并发变化，请刷新后重试。")
    );
    const response = await POST(
      new Request("http://localhost/api/projects/project-1/close", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "close-retry-key" },
        body: JSON.stringify({
          archiveVersionId: "archive-b",
          g9SubmissionId: "g9-submission",
          expectedProjectVersion: 7,
          operationId: "close-retry-operation"
        })
      }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CLOSURE_TRANSACTION_CONFLICT" }
    });
  });
});
