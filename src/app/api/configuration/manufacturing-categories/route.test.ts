import { beforeEach, describe, expect, it, vi } from "vitest";

const systemGuard = vi.hoisted(() => ({ authorizeSystemRequest: vi.fn() }));
const configuration = vi.hoisted(() => ({
  listManufacturingCategories: vi.fn(),
  createManufacturingCategory: vi.fn()
}));
const idempotent = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));

vi.mock("@/lib/auth/system-guard", () => systemGuard);
vi.mock("@/modules/drawings/application/manufacturing-configuration-service", () => configuration);
vi.mock("@/modules/platform-api/application/idempotent-command", () => idempotent);

import { GET, POST } from "./route";

describe("manufacturing category routes", () => {
  beforeEach(() => {
    systemGuard.authorizeSystemRequest.mockReset();
    configuration.listManufacturingCategories.mockReset();
    configuration.createManufacturingCategory.mockReset();
    idempotent.idempotentCommandResponse.mockReset();
    idempotent.idempotentCommandResponse.mockImplementation(
      async (input: {
        execute: (transaction: unknown) => Promise<{ status: number; body: unknown }>;
      }) => {
        const result = await input.execute({});
        return Response.json(result.body, { status: result.status });
      }
    );
  });

  it("requires configuration read before listing", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });
    const response = await GET(
      new Request("http://localhost/api/configuration/manufacturing-categories"),
      {}
    );
    expect(response.status).toBe(403);
    expect(configuration.listManufacturingCategories).not.toHaveBeenCalled();
  });

  it("uses configuration write and idempotency for creation", async () => {
    systemGuard.authorizeSystemRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "admin-1" }
    });
    configuration.createManufacturingCategory.mockResolvedValue({ category: { id: "cat-1" } });
    const response = await POST(
      new Request("http://localhost/api/configuration/manufacturing-categories", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-1" },
        body: JSON.stringify({ code: "MACHINING", name: "Machining", sortOrder: 1, reason: "seed" })
      }),
      {}
    );
    expect(response.status).toBe(201);
    expect(systemGuard.authorizeSystemRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "CONFIGURATION_WRITE",
      "MANUFACTURING_CATEGORY"
    );
  });
});
