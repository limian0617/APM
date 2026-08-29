import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectAssetUsageError } from "@/modules/assets/domain/project-asset-usage";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const service = vi.hoisted(() => ({
  createProjectAssetReference: vi.fn(),
  createProjectAssetDerivation: vi.fn(),
  retireProjectAssetReference: vi.fn(),
  recordProjectAssetCommandFailure: vi.fn()
}));
const idempotency = vi.hoisted(() => ({
  idempotentCommandResponse: vi.fn(
    async (input: { execute: (transaction: unknown) => Promise<unknown> }) => {
      await input.execute({});
      return Response.json({ ok: true }, { status: 201 });
    }
  )
}));

vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/assets/application/project-asset-usage-service", () => service);
vi.mock("@/modules/platform-api/application/idempotent-command", () => idempotency);

import { POST as createReference } from "@/app/api/projects/[projectId]/asset-references/route";
import { POST as retireReference } from "@/app/api/projects/[projectId]/asset-references/[referenceId]/retire/route";
import { POST as createDerivation } from "@/app/api/projects/[projectId]/asset-usages/[usageId]/derivations/route";

const actor = {
  id: "actor-1",
  name: "Engineer",
  status: "ACTIVE",
  departmentId: "dept-1",
  systemRoles: [],
  grants: [
    { permission: "PROJECT_ASSET_USAGE_MANAGE", scope: "PROJECT", systemRole: "ENGINEER" },
    { permission: "TECHNICAL_ASSET_READ", scope: "PROJECT", systemRole: "ENGINEER" },
    { permission: "CONTROLLED_DOCUMENT_READ", scope: "PROJECT", systemRole: "ENGINEER" },
    { permission: "SENSITIVE_FILE_READ", scope: "PROJECT", systemRole: "ENGINEER" }
  ]
};
const project = { id: "project-1", departmentId: "dept-1", memberRoles: ["ENGINEER"] };
const context = { params: Promise.resolve({ projectId: "project-1", usageId: "usage-1" }) };

function request(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "if-match": "1",
      "idempotency-key": "idem-1",
      "x-apm-user-id": actor.id
    },
    body: JSON.stringify(body)
  });
}

describe("APM-063 write authorization composition", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest.mockReset();
    service.createProjectAssetReference.mockReset().mockResolvedValue({});
    service.createProjectAssetDerivation.mockReset().mockResolvedValue({});
    service.retireProjectAssetReference.mockReset().mockResolvedValue({});
    service.recordProjectAssetCommandFailure.mockReset().mockResolvedValue(undefined);
    idempotency.idempotentCommandResponse.mockClear();
    guard.authorizeProjectRequest.mockResolvedValue({ authorized: true, actor, project });
  });

  it("requires TECHNICAL_ASSET_READ and passes the exact actor, not a target-project sensitive boolean", async () => {
    const response = await createReference(
      request("http://localhost/api/projects/project-1/asset-references", {
        assetReleaseId: "release-1",
        assetReleaseVersionId: "version-1",
        projectVersion: 1,
        reason: "reference"
      }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(response.status).toBe(201);
    expect(guard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "project-1",
      "TECHNICAL_ASSET_READ",
      { requireProjectMembership: true }
    );
    expect(service.createProjectAssetReference).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationActor: actor }),
      expect.anything()
    );
    expect(service.createProjectAssetReference.mock.calls[0]?.[0]).not.toHaveProperty(
      "canReadSensitiveFiles"
    );
  });

  it("default-denies a write when the composed technical asset authority is missing", async () => {
    guard.authorizeProjectRequest
      .mockResolvedValueOnce({ authorized: true, actor, project })
      .mockResolvedValueOnce({
        authorized: false,
        response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
      });

    const response = await createReference(
      request("http://localhost/api/projects/project-1/asset-references", {
        assetReleaseId: "release-1",
        assetReleaseVersionId: "version-1",
        projectVersion: 1,
        reason: "reference"
      }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(response.status).toBe(403);
    expect(service.createProjectAssetReference).not.toHaveBeenCalled();
    expect(idempotency.idempotentCommandResponse).not.toHaveBeenCalled();
  });

  it("passes the same exact actor into reference retirement for restricted-source authorization", async () => {
    const response = await retireReference(
      request("http://localhost/api/projects/project-1/asset-references/reference-1/retire", {
        version: 1,
        reason: "retire"
      }),
      { params: Promise.resolve({ projectId: "project-1", referenceId: "reference-1" }) }
    );

    expect(response.status).toBe(201);
    expect(service.retireProjectAssetReference).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationActor: actor }),
      expect.anything()
    );
  });

  it("records a failed asset command after the transactional write rejects", async () => {
    service.createProjectAssetReference.mockRejectedValueOnce(
      new ProjectAssetUsageError("PROJECT_ASSET_SENSITIVE_FILE_DENIED", "denied", 403)
    );

    const response = await createReference(
      request("http://localhost/api/projects/project-1/asset-references", {
        assetReleaseId: "release-1",
        assetReleaseVersionId: "version-1",
        projectVersion: 1,
        reason: "reference"
      }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(response.status).toBe(403);
    expect(service.recordProjectAssetCommandFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PROJECT_ASSET_REFERENCE_CREATED",
        objectType: "PROJECT_ASSET_REFERENCE",
        objectId: "project-1"
      })
    );
  });

  it("requires controlled-document read in addition to technical asset read for derivation", async () => {
    const response = await createDerivation(
      request("http://localhost/api/projects/project-1/asset-usages/usage-1/derivations", {
        usageVersion: 1,
        targetType: "CONTROLLED_DOCUMENT_VERSION",
        targetControlledDocumentVersionId: "doc-version-1",
        targetSourceFileId: "file-1",
        targetSourceFileSha256: "a".repeat(64),
        targetDocumentVersion: 1,
        targetDocumentVersionStatus: "PUBLISHED",
        targetFileStatus: "AVAILABLE",
        reason: "derive"
      }),
      context
    );

    expect(response.status).toBe(201);
    expect(guard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "project-1",
      "TECHNICAL_ASSET_READ",
      { requireProjectMembership: true }
    );
    expect(guard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "project-1",
      "CONTROLLED_DOCUMENT_READ",
      { requireProjectMembership: true }
    );
    expect(service.createProjectAssetDerivation).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationActor: actor }),
      expect.anything()
    );
  });
});
