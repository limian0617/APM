import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeSystemRequest: vi.fn() }));
const service = vi.hoisted(() => ({
  createAssetReleaseRecall: vi.fn(),
  listAssetReleaseRecalls: vi.fn(),
  reviseAssetReleaseRecall: vi.fn(),
  createAssetUpgradeCandidate: vi.fn(),
  listAssetUpgradeCandidates: vi.fn()
}));
const idempotency = vi.hoisted(() => ({
  idempotentCommandResponse: vi.fn(
    async (input: {
      execute: (transaction: unknown) => Promise<{ status: number; body: unknown }>;
    }) => {
      const result = await input.execute({});
      return Response.json(result.body, { status: result.status });
    }
  )
}));

vi.mock("@/lib/auth/system-guard", () => guard);
vi.mock("@/modules/assets/application/asset-upgrade-impact-service", () => service);
vi.mock("@/modules/platform-api/application/idempotent-command", () => idempotency);

import {
  GET as listRecalls,
  POST as createRecall
} from "@/app/api/technical-assets/[technicalAssetId]/releases/[releaseId]/recalls/route";
import { POST as reviseRecall } from "@/app/api/technical-assets/[technicalAssetId]/recalls/[recallId]/revisions/route";
import {
  GET as listCandidates,
  POST as createCandidate
} from "@/app/api/technical-assets/[technicalAssetId]/upgrade-candidates/route";

const actor = {
  id: "owner-1",
  name: "Owner",
  status: "ACTIVE",
  departmentId: "engineering",
  systemRoles: ["TECHNICAL_ASSET_MAINTAINER"],
  grants: [
    {
      permission: "TECHNICAL_ASSET_MANAGE",
      scope: "ALL",
      systemRole: "TECHNICAL_ASSET_MAINTAINER"
    }
  ]
};

function commandRequest(url: string, body: unknown, ifMatch = "1") {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-apm-user-id": actor.id,
      "idempotency-key": "apm-064-command-1",
      "if-match": ifMatch
    },
    body: JSON.stringify(body)
  });
}

describe("APM-064 recall and candidate route authorization", () => {
  beforeEach(() => {
    guard.authorizeSystemRequest.mockReset().mockResolvedValue({ authorized: true, actor });
    for (const mock of Object.values(service)) mock.mockReset().mockResolvedValue({ items: [] });
    idempotency.idempotentCommandResponse.mockClear();
  });

  it("requires only READ for lists and passes optional manage authority plus read audit context", async () => {
    const recallResponse = await listRecalls(
      new Request("http://localhost/api/technical-assets/asset-1/releases/release-1/recalls"),
      { params: Promise.resolve({ technicalAssetId: "asset-1", releaseId: "release-1" }) }
    );
    const candidateResponse = await listCandidates(
      new Request("http://localhost/api/technical-assets/asset-1/upgrade-candidates"),
      { params: Promise.resolve({ technicalAssetId: "asset-1" }) }
    );

    expect(recallResponse.status).toBe(200);
    expect(candidateResponse.status).toBe(200);
    expect(guard.authorizeSystemRequest).toHaveBeenCalledTimes(2);
    expect(service.listAssetReleaseRecalls).toHaveBeenCalledWith(
      expect.objectContaining({
        technicalAssetId: "asset-1",
        releaseId: "release-1",
        actorId: actor.id,
        canManage: true,
        auditContext: expect.objectContaining({ actorId: actor.id })
      })
    );
    expect(service.listAssetUpgradeCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ technicalAssetId: "asset-1", actorId: actor.id, canManage: true })
    );
  });

  it("does not turn missing optional MANAGE authority into a denied list request", async () => {
    const readOnlyActor = { ...actor, grants: [] };
    guard.authorizeSystemRequest.mockResolvedValue({ authorized: true, actor: readOnlyActor });

    const response = await listCandidates(
      new Request("http://localhost/api/technical-assets/asset-1/upgrade-candidates"),
      { params: Promise.resolve({ technicalAssetId: "asset-1" }) }
    );

    expect(response.status).toBe(200);
    expect(guard.authorizeSystemRequest).toHaveBeenCalledTimes(1);
    expect(service.listAssetUpgradeCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: actor.id, canManage: false })
    );
  });

  it("default-denies writes unless READ and MANAGE both pass", async () => {
    guard.authorizeSystemRequest
      .mockResolvedValueOnce({ authorized: true, actor })
      .mockResolvedValueOnce({
        authorized: false,
        response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
      });
    const response = await createRecall(
      commandRequest("http://localhost/api/technical-assets/asset-1/releases/release-1/recalls", {
        releaseResourceVersion: 1,
        scope: "RELEASE",
        sourceAssetReleaseVersionId: "release-version-1",
        severity: "HIGH",
        reason: "recall",
        evidence: { report: "report-1" }
      }),
      { params: Promise.resolve({ technicalAssetId: "asset-1", releaseId: "release-1" }) }
    );

    expect(response.status).toBe(403);
    expect(guard.authorizeSystemRequest).toHaveBeenNthCalledWith(
      1,
      expect.any(Request),
      "TECHNICAL_ASSET_READ",
      "TECHNICAL_ASSET",
      "asset-1"
    );
    expect(guard.authorizeSystemRequest).toHaveBeenNthCalledWith(
      2,
      expect.any(Request),
      "TECHNICAL_ASSET_MANAGE",
      "TECHNICAL_ASSET",
      "asset-1"
    );
    expect(idempotency.idempotentCommandResponse).not.toHaveBeenCalled();
  });

  it("validates aggregate If-Match and passes the exact actor to each idempotent command", async () => {
    const recall = await createRecall(
      commandRequest("http://localhost/api/technical-assets/asset-1/releases/release-1/recalls", {
        releaseResourceVersion: 1,
        scope: "RELEASE_VERSION",
        targetReleaseVersionId: "release-version-1",
        sourceAssetReleaseVersionId: "release-version-1",
        severity: "HIGH",
        reason: "recall",
        evidence: { report: "report-1" }
      }),
      { params: Promise.resolve({ technicalAssetId: "asset-1", releaseId: "release-1" }) }
    );
    const revision = await reviseRecall(
      commandRequest("http://localhost/api/technical-assets/asset-1/recalls/recall-1/revisions", {
        version: 1,
        kind: "CORRECTED",
        sourceAssetReleaseVersionId: "release-version-1",
        severity: "MEDIUM",
        reason: "correct",
        evidence: { report: "report-2" }
      }),
      { params: Promise.resolve({ technicalAssetId: "asset-1", recallId: "recall-1" }) }
    );
    const candidate = await createCandidate(
      commandRequest("http://localhost/api/technical-assets/asset-1/upgrade-candidates", {
        assetVersion: 1,
        sourceAssetReleaseVersionId: "release-version-1",
        targetAssetReleaseVersionId: "release-version-2",
        compatibility: {
          level: "FULL",
          summary: "compatible",
          constraints: [],
          evidence: { report: "report-3" }
        },
        reason: "candidate"
      }),
      { params: Promise.resolve({ technicalAssetId: "asset-1" }) }
    );

    expect([recall.status, revision.status, candidate.status]).toEqual([201, 200, 201]);
    expect(idempotency.idempotentCommandResponse).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ operation: "assets.release-recall.create", actorId: actor.id })
    );
    expect(idempotency.idempotentCommandResponse).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ operation: "assets.release-recall.revise", actorId: actor.id })
    );
    expect(idempotency.idempotentCommandResponse).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ operation: "assets.upgrade-candidate.create", actorId: actor.id })
    );
    expect(service.createAssetReleaseRecall).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationActor: actor, releaseResourceVersion: 1 }),
      expect.anything()
    );
    expect(service.reviseAssetReleaseRecall).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationActor: actor, version: 1 }),
      expect.anything()
    );
    expect(service.createAssetUpgradeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationActor: actor, assetVersion: 1 }),
      expect.anything()
    );
  });

  it("rejects an If-Match mismatch before entering idempotency", async () => {
    const response = await createCandidate(
      commandRequest(
        "http://localhost/api/technical-assets/asset-1/upgrade-candidates",
        {
          assetVersion: 2,
          sourceAssetReleaseVersionId: "release-version-1",
          targetAssetReleaseVersionId: "release-version-2",
          compatibility: {
            level: "FULL",
            summary: "compatible",
            constraints: [],
            evidence: { report: "report-3" }
          },
          reason: "candidate"
        },
        "1"
      ),
      { params: Promise.resolve({ technicalAssetId: "asset-1" }) }
    );

    expect(response.status).toBe(409);
    expect(idempotency.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.createAssetUpgradeCandidate).not.toHaveBeenCalled();
  });
});
