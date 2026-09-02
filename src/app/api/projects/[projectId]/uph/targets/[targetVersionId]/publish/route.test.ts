import { beforeEach, describe, expect, it, vi } from "vitest";
const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const service = vi.hoisted(() => ({ publishUphPerformanceTarget: vi.fn() }));
vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/uph/application/uph-performance-target-service", () => service);
import { POST } from "./route";
const actor = { id: "u1", status: "ACTIVE", grants: [] };
const project = { id: "p1", departmentId: null, memberRoles: ["QUALITY"] };
const body = { resourceVersion: 1, reason: "publish" };
function req(ifMatch = "1") {
  const h = new Headers({
    "x-user-id": "u1",
    "content-type": "application/json",
    "idempotency-key": "k1",
    "if-match": ifMatch
  });
  return new Request("http://x", { method: "POST", headers: h, body: JSON.stringify(body) });
}
const ctx = { params: Promise.resolve({ projectId: "p1", targetVersionId: "v1" }) };
describe("publish target route", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest
      .mockReset()
      .mockResolvedValue({ authorized: true, actor, project });
    command.idempotentCommandResponse.mockReset().mockImplementation(async (x: any) => {
      const result = await x.execute({});
      return Response.json(result.body, { status: result.status });
    });
    service.publishUphPerformanceTarget
      .mockReset()
      .mockResolvedValue({ id: "v1", status: "PUBLISHED" });
  });
  it("denies publish permission", async () => {
    guard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });
    const response = await POST(req(), ctx);
    expect(response.status).toBe(403);
  });
  it("uses publish guard, If-Match and idempotency", async () => {
    guard.authorizeProjectRequest.mockResolvedValue({ authorized: true, actor, project });
    command.idempotentCommandResponse.mockImplementation(async (x: any) => {
      const result = await x.execute({});
      return Response.json(result.body, { status: result.status });
    });
    service.publishUphPerformanceTarget.mockResolvedValue({ id: "v1", status: "PUBLISHED" });
    const response = await POST(req(), ctx);
    expect(response.status).toBe(200);
    expect(service.publishUphPerformanceTarget).toHaveBeenCalled();
  });
  it("rejects mismatched If-Match before service", async () => {
    guard.authorizeProjectRequest.mockResolvedValue({ authorized: true, actor, project });
    const response = await POST(req("2"), ctx);
    expect(response.status).toBe(409);
    expect(service.publishUphPerformanceTarget).not.toHaveBeenCalled();
  });
});
