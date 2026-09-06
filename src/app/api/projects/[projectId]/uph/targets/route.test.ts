import { describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const service = vi.hoisted(() => ({
  createUphPerformanceTarget: vi.fn(),
  listUphPerformanceTargets: vi.fn()
}));
vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/uph/application/uph-performance-target-service", () => service);
import { GET, POST } from "./route";

const actor = { id: "u1", status: "ACTIVE", grants: [] };
const project = { id: "p1", departmentId: null, memberRoles: ["ENGINEER"] };
const body = { topologyRootNodeId: "root", targetUph: "10", reason: "target" };
const ctx = { params: Promise.resolve({ projectId: "p1" }) };
function req(method: "GET" | "POST", payload?: unknown) {
  const h = new Headers({ "x-user-id": "u1" });
  if (method === "POST") {
    h.set("content-type", "application/json");
    h.set("idempotency-key", "k1");
  }
  return new Request("http://x", {
    method,
    headers: h,
    ...(method === "POST" ? { body: JSON.stringify(payload ?? body) } : {})
  });
}
describe("targets route", () => {
  it("denies before parsing", async () => {
    guard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 })
    });
    const r = await POST(req("POST", { extra: true }), ctx);
    expect(r.status).toBe(401);
  });
  it("rejects strict DTO", async () => {
    guard.authorizeProjectRequest.mockResolvedValue({ authorized: true, actor, project });
    const r = await POST(req("POST", { ...body, extra: true }), ctx);
    expect(r.status).toBe(422);
  });
  it("lists with read guard", async () => {
    guard.authorizeProjectRequest.mockResolvedValue({ authorized: true, actor, project });
    service.listUphPerformanceTargets.mockResolvedValue({ items: [] });
    const r = await GET(req("GET"), ctx);
    expect(r.status).toBe(200);
  });
  it("creates through idempotent command", async () => {
    guard.authorizeProjectRequest.mockResolvedValue({ authorized: true, actor, project });
    command.idempotentCommandResponse.mockImplementation(async (x: any) => {
      const result = await x.execute({});
      return Response.json(result.body, { status: result.status });
    });
    service.createUphPerformanceTarget.mockResolvedValue({ id: "v1" });
    const r = await POST(req("POST"), ctx);
    expect(r.status).toBe(201);
  });
});
