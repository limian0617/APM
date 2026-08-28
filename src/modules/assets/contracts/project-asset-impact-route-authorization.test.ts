import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const service = vi.hoisted(() => ({
  listProjectAssetImpacts: vi.fn(),
  getProjectAssetImpact: vi.fn(),
  refreshProjectAssetImpact: vi.fn(),
  recordProjectAssetImpactDisposition: vi.fn()
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

import { GET as listImpacts } from "@/app/api/projects/[projectId]/asset-impacts/route";
import { GET as getImpact } from "@/app/api/projects/[projectId]/asset-impacts/[impactId]/route";
import { POST as refreshImpact } from "@/app/api/projects/[projectId]/asset-impacts/[impactId]/refreshes/route";
import { POST as acknowledgeImpact } from "@/app/api/projects/[projectId]/asset-impacts/[impactId]/acknowledgements/route";
import { POST as startAssessment } from "@/app/api/projects/[projectId]/asset-impacts/[impactId]/assessment-starts/route";
import { POST as planUpgrade } from "@/app/api/projects/[projectId]/asset-impacts/[impactId]/upgrade-plans/route";

const actor = {
  id: "manager-1",
  name: "Manager",
  status: "ACTIVE" as const,
  departmentId: "engineering",
  systemRoles: ["PROJECT_MANAGER"],
  grants: [
    { permission: "PROJECT_ASSET_USAGE_READ", scope: "PROJECT", systemRole: "PROJECT_MANAGER" },
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
const listContext = { params: Promise.resolve({ projectId: "project-1" }) };
const detailContext = {
  params: Promise.resolve({ projectId: "project-1", impactId: "impact-1" })
};

function commandRequest(path: string, version = 1, ifMatch = "1") {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-apm-user-id": actor.id,
      "idempotency-key": "apm-064-impact-command",
      "if-match": ifMatch
    },
    body: JSON.stringify({ version, reason: "review impact", evidence: { report: "report-1" } })
  });
}

describe("APM-064 project asset impact route authorization", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest.mockReset().mockResolvedValue({
      authorized: true,
      actor,
      project
    });
    for (const mock of Object.values(service)) {
      mock.mockReset().mockResolvedValue({ item: { id: "impact-1" } });
    }
    service.listProjectAssetImpacts.mockResolvedValue({ items: [] });
    idempotency.idempotentCommandResponse.mockClear();
  });

  it("requires project asset and technical asset read for list and detail", async () => {
    expect(
      (
        await listImpacts(
          new Request("http://localhost/api/projects/project-1/asset-impacts?limit=25"),
          listContext
        )
      ).status
    ).toBe(200);
    expect(
      (
        await getImpact(
          new Request("http://localhost/api/projects/project-1/asset-impacts/impact-1"),
          detailContext
        )
      ).status
    ).toBe(200);

    expect(guard.authorizeProjectRequest).toHaveBeenNthCalledWith(
      1,
      expect.any(Request),
      "project-1",
      "PROJECT_ASSET_USAGE_READ",
      { requireProjectMembership: true }
    );
    expect(guard.authorizeProjectRequest).toHaveBeenNthCalledWith(
      2,
      expect.any(Request),
      "project-1",
      "TECHNICAL_ASSET_READ",
      { requireProjectMembership: true }
    );
    expect(service.listProjectAssetImpacts).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        limit: 25,
        actorId: actor.id,
        authorizationActor: actor,
        canManage: true,
        auditContext: expect.objectContaining({ actorId: actor.id, projectId: "project-1" })
      })
    );
    expect(service.getProjectAssetImpact).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        impactId: "impact-1",
        actorId: actor.id,
        authorizationActor: actor,
        canManage: true
      })
    );
  });

  it("preserves project-scoped current risk facts and service-derived allowed actions on detail", async () => {
    service.getProjectAssetImpact.mockResolvedValue({
      item: {
        id: "impact-1",
        projectId: "project-1",
        status: "RISK_ACCEPTANCE_PENDING",
        resourceVersion: 4,
        currentRiskAcceptanceRequest: {
          requestId: "risk-request-1",
          status: "PENDING",
          resourceVersion: 2,
          decision: null
        },
        allowedActions: ["APPROVE_RISK", "REJECT_RISK"]
      },
      allowedActions: ["APPROVE_RISK", "REJECT_RISK"],
      auditId: "audit-read-1",
      outboxEventId: null
    });

    const response = await getImpact(
      new Request("http://localhost/api/projects/project-1/asset-impacts/impact-1"),
      detailContext
    );

    expect(service.getProjectAssetImpact).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        impactId: "impact-1",
        actorId: actor.id,
        authorizationActor: actor,
        canManage: true,
        auditContext: expect.objectContaining({ projectId: "project-1" })
      })
    );
    await expect(response.json()).resolves.toEqual({
      item: {
        id: "impact-1",
        projectId: "project-1",
        status: "RISK_ACCEPTANCE_PENDING",
        resourceVersion: 4,
        currentRiskAcceptanceRequest: {
          requestId: "risk-request-1",
          status: "PENDING",
          resourceVersion: 2,
          decision: null
        },
        allowedActions: ["APPROVE_RISK", "REJECT_RISK"]
      },
      allowedActions: ["APPROVE_RISK", "REJECT_RISK"],
      auditId: "audit-read-1",
      outboxEventId: null
    });
  });

  it("does not write a denial audit for missing optional manage authority on reads", async () => {
    const readOnlyActor = {
      ...actor,
      grants: actor.grants.filter((grant) => grant.permission !== "PROJECT_ASSET_USAGE_MANAGE")
    };
    guard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: readOnlyActor,
      project
    });

    const response = await listImpacts(
      new Request("http://localhost/api/projects/project-1/asset-impacts"),
      listContext
    );

    expect(response.status).toBe(200);
    expect(guard.authorizeProjectRequest).toHaveBeenCalledTimes(2);
    expect(service.listProjectAssetImpacts).toHaveBeenCalledWith(
      expect.objectContaining({ canManage: false })
    );
  });

  it("does not call read services when technical asset access is denied", async () => {
    guard.authorizeProjectRequest
      .mockResolvedValueOnce({ authorized: true, actor, project })
      .mockResolvedValueOnce({
        authorized: false,
        response: Response.json({ error: { code: "NOT_FOUND_OR_DENIED" } }, { status: 404 })
      });

    const response = await getImpact(
      new Request("http://localhost/api/projects/project-1/asset-impacts/impact-1"),
      detailContext
    );

    expect(response.status).toBe(404);
    expect(service.getProjectAssetImpact).not.toHaveBeenCalled();
    expect(service.listProjectAssetImpacts).not.toHaveBeenCalled();
  });

  it("default-denies writes unless manage and technical asset read both pass", async () => {
    guard.authorizeProjectRequest
      .mockResolvedValueOnce({ authorized: true, actor, project })
      .mockResolvedValueOnce({
        authorized: false,
        response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
      });

    const response = await acknowledgeImpact(
      commandRequest("/api/projects/project-1/asset-impacts/impact-1/acknowledgements"),
      detailContext
    );

    expect(response.status).toBe(403);
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
    expect(service.recordProjectAssetImpactDisposition).not.toHaveBeenCalled();
  });

  it("uses exact idempotent operations and disposition actions for all four commands", async () => {
    const commands = [
      {
        handler: refreshImpact,
        path: "/api/projects/project-1/asset-impacts/impact-1/refreshes",
        operation: "projects.asset-impact.refresh",
        service: "refresh"
      },
      {
        handler: acknowledgeImpact,
        path: "/api/projects/project-1/asset-impacts/impact-1/acknowledgements",
        operation: "projects.asset-impact.acknowledge",
        action: "ACKNOWLEDGE"
      },
      {
        handler: startAssessment,
        path: "/api/projects/project-1/asset-impacts/impact-1/assessment-starts",
        operation: "projects.asset-impact.start",
        action: "START_ASSESSMENT"
      },
      {
        handler: planUpgrade,
        path: "/api/projects/project-1/asset-impacts/impact-1/upgrade-plans",
        operation: "projects.asset-impact.plan",
        action: "PLAN_UPGRADE"
      }
    ] as const;

    for (const command of commands) {
      const response = await command.handler(commandRequest(command.path), detailContext);
      expect(response.status).toBe(201);
    }

    expect(idempotency.idempotentCommandResponse).toHaveBeenCalledTimes(4);
    commands.forEach((command, index) => {
      expect(idempotency.idempotentCommandResponse).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({ operation: command.operation, actorId: actor.id })
      );
    });
    expect(service.refreshProjectAssetImpact).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        actorId: actor.id,
        authorizationActor: actor
      }),
      expect.anything()
    );
    expect(service.recordProjectAssetImpactDisposition).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: "ACKNOWLEDGE", version: 1 }),
      expect.anything()
    );
    expect(service.recordProjectAssetImpactDisposition).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: "START_ASSESSMENT", version: 1 }),
      expect.anything()
    );
    expect(service.recordProjectAssetImpactDisposition).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ action: "PLAN_UPGRADE", version: 1 }),
      expect.anything()
    );
  });

  it("rejects If-Match mismatch and unknown command fields before idempotency", async () => {
    const mismatch = await refreshImpact(
      commandRequest("/api/projects/project-1/asset-impacts/impact-1/refreshes", 2, "1"),
      detailContext
    );
    const unknown = new Request(
      "http://localhost/api/projects/project-1/asset-impacts/impact-1/refreshes",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "apm-064-impact-unknown",
          "if-match": "1"
        },
        body: JSON.stringify({
          version: 1,
          reason: "refresh",
          evidence: { report: "report-1" },
          unexpected: true
        })
      }
    );
    const unknownResponse = await refreshImpact(unknown, detailContext);

    expect(mismatch.status).toBe(409);
    expect(unknownResponse.status).toBe(422);
    expect(idempotency.idempotentCommandResponse).not.toHaveBeenCalled();
  });
});
