import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const service = vi.hoisted(() => ({
  requestProjectAssetImpactRiskAcceptance: vi.fn(),
  decideProjectAssetImpactRiskAcceptance: vi.fn(),
  closeProjectAssetImpact: vi.fn()
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

vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/assets/application/project-asset-impact-service", () => service);
vi.mock("@/modules/platform-api/application/idempotent-command", () => idempotency);

import { POST as requestRiskAcceptance } from "@/app/api/projects/[projectId]/asset-impacts/[impactId]/risk-acceptances/route";
import { POST as approveRiskAcceptance } from "@/app/api/projects/[projectId]/asset-impacts/[impactId]/risk-acceptances/[requestId]/approvals/route";
import { POST as rejectRiskAcceptance } from "@/app/api/projects/[projectId]/asset-impacts/[impactId]/risk-acceptances/[requestId]/rejections/route";
import { POST as closeImpact } from "@/app/api/projects/[projectId]/asset-impacts/[impactId]/closures/route";

const actor = {
  id: "manager-or-quality-1",
  name: "Project actor",
  status: "ACTIVE" as const,
  departmentId: "quality",
  systemRoles: ["PROJECT_MANAGER"],
  grants: [
    {
      permission: "PROJECT_ASSET_USAGE_MANAGE",
      scope: "PROJECT",
      systemRole: "PROJECT_MANAGER"
    },
    { permission: "TECHNICAL_ASSET_READ", scope: "PROJECT", systemRole: "PROJECT_MANAGER" }
  ]
};
const project = {
  id: "project-1",
  departmentId: "engineering",
  memberRoles: ["PROJECT_MANAGER"]
};
const impactContext = {
  params: Promise.resolve({ projectId: "project-1", impactId: "impact-1" })
};
const decisionContext = {
  params: Promise.resolve({
    projectId: "project-1",
    impactId: "impact-1",
    requestId: "risk-request-1"
  })
};

function commandRequest(path: string, version = 1, ifMatch = "1", extra = {}) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-apm-user-id": actor.id,
      "idempotency-key": "apm-064-risk-command",
      "if-match": ifMatch
    },
    body: JSON.stringify({
      version,
      reason: "review residual asset risk",
      evidence: { report: "risk-report-1" },
      ...extra
    })
  });
}

describe("APM-064 project asset impact risk routes", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest
      .mockReset()
      .mockResolvedValue({ authorized: true, actor, project });
    for (const mock of Object.values(service)) {
      mock.mockReset().mockResolvedValue({ item: { id: "impact-1" } });
    }
    idempotency.idempotentCommandResponse.mockClear();
  });

  it("requires active project manage then technical asset read for every command", async () => {
    guard.authorizeProjectRequest
      .mockResolvedValueOnce({ authorized: true, actor, project })
      .mockResolvedValueOnce({
        authorized: false,
        response: Response.json({ error: { code: "NOT_FOUND_OR_DENIED" } }, { status: 404 })
      });

    const response = await approveRiskAcceptance(
      commandRequest(
        "/api/projects/project-1/asset-impacts/impact-1/risk-acceptances/risk-request-1/approvals"
      ),
      decisionContext
    );

    expect(response.status).toBe(404);
    expect(guard.authorizeProjectRequest).toHaveBeenNthCalledWith(
      1,
      expect.any(Request),
      "project-1",
      "PROJECT_ASSET_USAGE_MANAGE",
      { requireProjectMembership: true }
    );
    expect(guard.authorizeProjectRequest).toHaveBeenNthCalledWith(
      2,
      expect.any(Request),
      "project-1",
      "TECHNICAL_ASSET_READ",
      { requireProjectMembership: true }
    );
    expect(idempotency.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.decideProjectAssetImpactRiskAcceptance).not.toHaveBeenCalled();
  });

  it("uses exact operations, path identities and decision values", async () => {
    const commands = [
      {
        handler: requestRiskAcceptance,
        context: impactContext,
        path: "/api/projects/project-1/asset-impacts/impact-1/risk-acceptances",
        operation: "projects.asset-impact.accept-risk.request"
      },
      {
        handler: approveRiskAcceptance,
        context: decisionContext,
        path: "/api/projects/project-1/asset-impacts/impact-1/risk-acceptances/risk-request-1/approvals",
        operation: "projects.asset-impact.accept-risk.approve",
        decision: "APPROVE"
      },
      {
        handler: rejectRiskAcceptance,
        context: decisionContext,
        path: "/api/projects/project-1/asset-impacts/impact-1/risk-acceptances/risk-request-1/rejections",
        operation: "projects.asset-impact.accept-risk.reject",
        decision: "REJECT"
      },
      {
        handler: closeImpact,
        context: impactContext,
        path: "/api/projects/project-1/asset-impacts/impact-1/closures",
        operation: "projects.asset-impact.close"
      }
    ] as const;

    for (const command of commands) {
      const response = await command.handler(commandRequest(command.path), command.context);
      expect(response.status).toBe(201);
    }

    commands.forEach((command, index) => {
      expect(idempotency.idempotentCommandResponse).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({ operation: command.operation, actorId: actor.id })
      );
    });
    expect(service.requestProjectAssetImpactRiskAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        impactId: "impact-1",
        version: 1,
        actorId: actor.id,
        authorizationActor: actor
      }),
      expect.anything()
    );
    expect(service.decideProjectAssetImpactRiskAcceptance).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ requestId: "risk-request-1", version: 1, decision: "APPROVE" }),
      expect.anything()
    );
    expect(service.decideProjectAssetImpactRiskAcceptance).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ requestId: "risk-request-1", version: 1, decision: "REJECT" }),
      expect.anything()
    );
    expect(service.closeProjectAssetImpact).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", impactId: "impact-1", version: 1 }),
      expect.anything()
    );
  });

  it("rejects If-Match mismatch and undeclared fields before idempotency", async () => {
    const mismatch = await requestRiskAcceptance(
      commandRequest("/api/projects/project-1/asset-impacts/impact-1/risk-acceptances", 2, "1"),
      impactContext
    );
    const unknown = await closeImpact(
      commandRequest("/api/projects/project-1/asset-impacts/impact-1/closures", 1, "1", {
        status: "CLOSED"
      }),
      impactContext
    );

    expect(mismatch.status).toBe(409);
    expect(unknown.status).toBe(422);
    expect(idempotency.idempotentCommandResponse).not.toHaveBeenCalled();
  });
});
