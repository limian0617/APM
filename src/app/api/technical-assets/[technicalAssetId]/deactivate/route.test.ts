import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeSystemRequest: vi.fn() }));
const service = vi.hoisted(() => ({ deactivateTechnicalAsset: vi.fn() }));
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
vi.mock("@/modules/assets/application/technical-asset-service", () => service);
vi.mock("@/modules/platform-api/application/idempotent-command", () => idempotency);

import { POST } from "./route";

const actor = {
  id: "owner-1",
  name: "Owner",
  status: "ACTIVE",
  departmentId: "engineering",
  systemRoles: ["TECHNICAL_ASSET_MAINTAINER"],
  grants: []
};

function request(version = 3, ifMatch = "3") {
  return new Request("http://localhost/api/technical-assets/asset-1/deactivate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-apm-user-id": actor.id,
      "idempotency-key": "deactivate-1",
      "if-match": ifMatch
    },
    body: JSON.stringify({ version, reason: "retire from future use" })
  });
}

describe("APM-064 dedicated technical asset deactivation route", () => {
  beforeEach(() => {
    guard.authorizeSystemRequest.mockReset().mockResolvedValue({ authorized: true, actor });
    service.deactivateTechnicalAsset.mockReset().mockResolvedValue({ asset: { id: "asset-1" } });
    idempotency.idempotentCommandResponse.mockClear();
  });

  it("requires READ and MANAGE before entering the idempotent command", async () => {
    guard.authorizeSystemRequest
      .mockResolvedValueOnce({ authorized: true, actor })
      .mockResolvedValueOnce({
        authorized: false,
        response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
      });

    const response = await POST(request(), {
      params: Promise.resolve({ technicalAssetId: "asset-1" })
    });

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

  it("rejects an If-Match mismatch before idempotency or service work", async () => {
    const response = await POST(request(3, "2"), {
      params: Promise.resolve({ technicalAssetId: "asset-1" })
    });

    expect(response.status).toBe(409);
    expect(idempotency.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.deactivateTechnicalAsset).not.toHaveBeenCalled();
  });

  it("passes the exact actor into the dedicated idempotent service command", async () => {
    const response = await POST(request(), {
      params: Promise.resolve({ technicalAssetId: "asset-1" })
    });

    expect(response.status).toBe(200);
    expect(idempotency.idempotentCommandResponse).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "assets.deactivate", actorId: actor.id })
    );
    expect(service.deactivateTechnicalAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "asset-1",
        version: 3,
        actorId: actor.id,
        authorizationActor: actor
      }),
      expect.anything()
    );
  });
});
