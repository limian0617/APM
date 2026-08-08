import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const changeImpactService = vi.hoisted(() => ({ resolveProcurementChangeImpact: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/procurement/application/change-impact-service", () => changeImpactService);

import { POST } from "./route";

describe("POST /api/projects/[projectId]/procurement/change-impacts/[impactId]/obligations/[obligationId]/resolve", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    command.idempotentCommandResponse.mockReset();
    changeImpactService.resolveProcurementChangeImpact.mockReset();
  });

  it("requires tracking-manage permission before accepting a strict versioned disposition", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: false,
      response: Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 })
    });

    const response = await POST(
      new Request(
        "http://localhost/api/projects/project-1/procurement/change-impacts/impact-1/obligations/obligation-1/resolve",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version: 1,
            disposition: "OWNER_PLAN_CONFIRMED",
            evidenceReference: "record:1",
            reason: "采购负责人确认"
          })
        }
      ),
      {
        params: Promise.resolve({
          projectId: "project-1",
          impactId: "impact-1",
          obligationId: "obligation-1"
        })
      }
    );

    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "project-1",
      "PROJECT_PROCUREMENT_TRACKING_MANAGE"
    );
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  it("sends the strict project-scoped command through idempotency with actor and audit context", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "manager-1" },
      project: { departmentId: "engineering" }
    });
    changeImpactService.resolveProcurementChangeImpact.mockResolvedValue({
      impact: { id: "impact-1", projectId: "project-1", status: "OPEN" },
      obligation: { id: "obligation-1", resolution: "OWNER_PLAN_CONFIRMED" }
    });
    command.idempotentCommandResponse.mockImplementation(async (input) => {
      const result = await input.execute({});
      return Response.json(result.body, { status: result.status });
    });

    const response = await POST(
      new Request(
        "http://localhost/api/projects/project-1/procurement/change-impacts/impact-1/obligations/obligation-1/resolve",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "resolve-impact-1-v2",
            "x-request-id": "request-1",
            "x-trace-id": "trace-1"
          },
          body: JSON.stringify({
            version: 2,
            disposition: "OWNER_PLAN_CONFIRMED",
            evidenceReference: "record:1",
            reason: "采购负责人确认"
          })
        }
      ),
      {
        params: Promise.resolve({
          projectId: "project-1",
          impactId: "impact-1",
          obligationId: "obligation-1"
        })
      }
    );

    expect(command.idempotentCommandResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "manager-1",
        operation: "projects.procurement.change-impact.resolve-obligation",
        idempotencyKey: "resolve-impact-1-v2",
        request: {
          path: {
            projectId: "project-1",
            impactId: "impact-1",
            obligationId: "obligation-1"
          },
          body: {
            version: 2,
            disposition: "OWNER_PLAN_CONFIRMED",
            evidenceReference: "record:1",
            reason: "采购负责人确认"
          }
        },
        execute: expect.any(Function)
      })
    );
    expect(changeImpactService.resolveProcurementChangeImpact).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        impactId: "impact-1",
        obligationId: "obligation-1",
        version: 2,
        disposition: "OWNER_PLAN_CONFIRMED",
        evidenceReference: "record:1",
        reason: "采购负责人确认",
        actorId: "manager-1",
        auditContext: expect.objectContaining({
          actorId: "manager-1",
          projectId: "project-1",
          departmentId: "engineering",
          reason: "采购负责人确认",
          operationId: "resolve-impact-1-v2"
        })
      }),
      expect.anything()
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      impact: { id: "impact-1", projectId: "project-1" },
      obligation: { id: "obligation-1", resolution: "OWNER_PLAN_CONFIRMED" }
    });
  });
});
