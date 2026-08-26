import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const service = vi.hoisted(() => {
  class UphAnalysisServiceError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: 403 | 404 | 409 | 422
    ) {
      super(message);
      this.name = "UphAnalysisServiceError";
    }
  }

  return { UphAnalysisServiceError, getUphAnalysis: vi.fn() };
});

vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/uph/application/uph-analysis-service", () => service);

import { GET } from "./route";

const actor = {
  id: "analysis-reader",
  name: "UPH reader",
  status: "ACTIVE",
  departmentId: "engineering",
  systemRoles: [],
  grants: []
};
const project = {
  id: "project-1",
  departmentId: "engineering",
  memberRoles: ["QUALITY"]
};
const path = {
  projectId: "project-1",
  batchId: "batch-1",
  revisionId: "revision-1",
  analysisId: "analysis-1"
};

function context(overrides: Partial<typeof path> = {}) {
  return { params: Promise.resolve({ ...path, ...overrides }) };
}

function request(query = "") {
  return new Request(
    `http://localhost/api/projects/${path.projectId}/uph/test-batches/${path.batchId}/revisions/${path.revisionId}/analyses/${path.analysisId}${query}`,
    { headers: { "x-user-id": actor.id } }
  );
}

function analysisError(
  code: string,
  status: 403 | 404 | 409 | 422
): InstanceType<typeof service.UphAnalysisServiceError> {
  return new service.UphAnalysisServiceError(code, `analysis ${code}`, status);
}

describe("APM-082 UPH analysis detail Route Handler", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest
      .mockReset()
      .mockResolvedValue({ authorized: true, actor, project });
    command.idempotentCommandResponse.mockReset();
    service.getUphAnalysis.mockReset().mockResolvedValue({ analysisId: path.analysisId });
  });

  it("strictly parses the four path identities before project guard evaluation", async () => {
    const response = await GET(request(), context({ analysisId: " " }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(guard.authorizeProjectRequest).not.toHaveBeenCalled();
    expect(service.getUphAnalysis).not.toHaveBeenCalled();
  });

  it("returns the guard denial before service access despite a forged query selector", async () => {
    guard.authorizeProjectRequest.mockResolvedValueOnce({
      authorized: false,
      response: Response.json({ error: { code: "PROJECT_NOT_FOUND" } }, { status: 404 })
    });

    const response = await GET(request("?analysisId=forged&unknown=true"), context());

    expect(response.status).toBe(404);
    expect(service.getUphAnalysis).not.toHaveBeenCalled();
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
  });

  it("uses the read guard and all trusted path facts for an IDOR-safe detail lookup", async () => {
    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(guard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      path.projectId,
      "PROJECT_UPH_READ",
      { requireProjectMembership: true }
    );
    expect(service.getUphAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        ...path,
        actorId: actor.id,
        authorizationActor: actor,
        projectMemberRoles: project.memberRoles,
        auditContext: expect.objectContaining({ actorId: actor.id, projectId: path.projectId })
      })
    );
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
  });

  it("always uses the analysisId from the strict path rather than a query override", async () => {
    const response = await GET(request("?analysisId=forged"), context());

    expect(response.status).toBe(200);
    expect(service.getUphAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ analysisId: path.analysisId })
    );
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
  });

  it.each([
    ["AUTHORIZATION_DENIED", 403],
    ["ANALYSIS_NOT_FOUND", 404],
    ["LOCKED_REVISION_REQUIRED", 409],
    ["ANALYSIS_CONFLICT", 409],
    ["ANALYSIS_INPUT_INVALID", 422],
    ["ANALYSIS_FORMULA_UNSUPPORTED", 422]
  ] as const)("maps the structured %s service error", async (code, status) => {
    service.getUphAnalysis.mockRejectedValueOnce(analysisError(code, status));

    const response = await GET(request(), context());

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
  });

  it("leaves an unknown service error to request observability", async () => {
    service.getUphAnalysis.mockRejectedValueOnce(new Error("unexpected failure"));

    const response = await GET(request(), context());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });
});
