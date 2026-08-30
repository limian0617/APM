import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const guard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const command = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));
const service = vi.hoisted(() => ({
  createUphTestBatch: vi.fn(),
  listUphTestBatches: vi.fn(),
  getUphTestBatch: vi.fn(),
  patchUphTestBatchRevision: vi.fn(),
  appendUphCycleSample: vi.fn(),
  correctUphCycleSample: vi.fn(),
  updateUphTestBatchProductionCount: vi.fn(),
  updateUphTestBatchModuleQualityCount: vi.fn(),
  attachUphTestBatchEvidence: vi.fn(),
  confirmUphTestBatch: vi.fn(),
  lockUphTestBatch: vi.fn(),
  replaceUphTestBatchRevision: vi.fn()
}));

vi.mock("@/lib/auth/project-guard", () => guard);
vi.mock("@/modules/platform-api/application/idempotent-command", () => command);
vi.mock("@/modules/uph/application/uph-test-batch-service", () => service);

const apiRoot = resolve(import.meta.dirname);
const actor = {
  id: "user-engineer",
  name: "Process engineer",
  status: "ACTIVE",
  departmentId: "engineering",
  systemRoles: [],
  grants: []
};
const project = {
  id: "project-1",
  departmentId: "engineering",
  memberRoles: ["ENGINEER"]
};
const createBody = {
  batchNumber: "UPH-LINE-A-001",
  topologyRootNodeId: "line-a",
  plannedProductionSeconds: 3600,
  planDeclarationReason: "Initial controlled production declaration",
  observationStartedAt: "2026-08-25T08:00:00.000Z",
  observationEndedAt: null,
  timezone: "Asia/Shanghai"
};

type CommandRoute = {
  file: string;
  method: "POST" | "PATCH" | "PUT";
  permission: "PROJECT_UPH_BATCH_MANAGE" | "PROJECT_UPH_BATCH_CONFIRM" | "PROJECT_UPH_BATCH_LOCK";
  operation: string;
  serviceMethod: keyof typeof service;
  body: Record<string, unknown>;
  pathParams?: Record<string, string>;
  headers?: Record<string, string>;
  requiresIfMatch?: boolean;
};

const commandRoutes: CommandRoute[] = [
  {
    file: "route.ts",
    method: "POST",
    permission: "PROJECT_UPH_BATCH_MANAGE",
    operation: "projects.uph.test-batch.create",
    serviceMethod: "createUphTestBatch",
    body: createBody
  },
  {
    file: "[batchId]/revisions/[revisionId]/route.ts",
    method: "PATCH",
    permission: "PROJECT_UPH_BATCH_MANAGE",
    operation: "projects.uph.test-batch.revision.patch",
    serviceMethod: "patchUphTestBatchRevision",
    body: {
      resourceVersion: 1,
      plannedProductionSeconds: 5400,
      planDeclarationReason: "Adjusted controlled production declaration",
      observationStartedAt: "2026-08-25T08:00:00.000Z",
      observationEndedAt: null,
      timezone: "Asia/Shanghai"
    },
    requiresIfMatch: true
  },
  {
    file: "[batchId]/revisions/[revisionId]/cycle-samples/route.ts",
    method: "POST",
    permission: "PROJECT_UPH_BATCH_MANAGE",
    operation: "projects.uph.test-batch.cycle-sample.append",
    serviceMethod: "appendUphCycleSample",
    body: {
      resourceVersion: 1,
      projectModuleId: "module-1",
      ordinal: 1,
      sourceEventId: "device-event-1",
      cycleDurationSeconds: "12.000000",
      observedAt: "2026-08-25T08:05:00.000Z",
      captureMethod: "DEVICE_EVENT",
      disposition: "INCLUDED"
    },
    requiresIfMatch: true
  },
  {
    file: "[batchId]/revisions/[revisionId]/cycle-samples/[sampleId]/correct/route.ts",
    method: "POST",
    permission: "PROJECT_UPH_BATCH_MANAGE",
    operation: "projects.uph.test-batch.cycle-sample.correct",
    serviceMethod: "correctUphCycleSample",
    body: {
      resourceVersion: 1,
      replacement: {
        cycleDurationSeconds: "12.000000",
        observedAt: "2026-08-25T08:05:00.000Z",
        captureMethod: "MANUAL_ENTRY"
      }
    },
    pathParams: { sampleId: "sample-1" },
    requiresIfMatch: true
  },
  {
    file: "[batchId]/revisions/[revisionId]/production-count/route.ts",
    method: "PUT",
    permission: "PROJECT_UPH_BATCH_MANAGE",
    operation: "projects.uph.test-batch.production-count.put",
    serviceMethod: "updateUphTestBatchProductionCount",
    body: { resourceVersion: 1, actualGrossOutputCount: 0, finalGoodOutputCount: 0 },
    requiresIfMatch: true
  },
  {
    file: "[batchId]/revisions/[revisionId]/module-bindings/[moduleId]/quality-count/route.ts",
    method: "PUT",
    permission: "PROJECT_UPH_BATCH_MANAGE",
    operation: "projects.uph.test-batch.module-quality-count.put",
    serviceMethod: "updateUphTestBatchModuleQualityCount",
    body: {
      resourceVersion: 1,
      qualityInputCount: 10,
      firstPassGoodCount: 8,
      firstPassNonconformingCount: 2,
      reworkInputCount: 2,
      reworkRecoveredGoodCount: 1
    },
    pathParams: { moduleId: "module-1" },
    requiresIfMatch: true
  },
  {
    file: "[batchId]/revisions/[revisionId]/evidence/route.ts",
    method: "POST",
    permission: "PROJECT_UPH_BATCH_MANAGE",
    operation: "projects.uph.test-batch.evidence.attach",
    serviceMethod: "attachUphTestBatchEvidence",
    body: { resourceVersion: 1, fileObjectId: "file-1", purpose: "ROOT_PRODUCTION" },
    requiresIfMatch: true
  },
  {
    file: "[batchId]/revisions/[revisionId]/pm-confirm/route.ts",
    method: "POST",
    permission: "PROJECT_UPH_BATCH_CONFIRM",
    operation: "projects.uph.test-batch.pm-confirm",
    serviceMethod: "confirmUphTestBatch",
    body: { resourceVersion: 1 },
    requiresIfMatch: true
  },
  {
    file: "[batchId]/revisions/[revisionId]/lock/route.ts",
    method: "POST",
    permission: "PROJECT_UPH_BATCH_LOCK",
    operation: "projects.uph.test-batch.lock",
    serviceMethod: "lockUphTestBatch",
    body: { resourceVersion: 1 },
    requiresIfMatch: true
  },
  {
    file: "[batchId]/revisions/[revisionId]/replace/route.ts",
    method: "POST",
    permission: "PROJECT_UPH_BATCH_MANAGE",
    operation: "projects.uph.test-batch.revision.replace",
    serviceMethod: "replaceUphTestBatchRevision",
    body: { resourceVersion: 1, reason: "Correct confirmed input" },
    requiresIfMatch: true
  }
];

const allRouteFiles = [
  "route.ts",
  "[batchId]/route.ts",
  ...commandRoutes.filter((route) => route.file !== "route.ts").map((route) => route.file)
];

function routePath(file: string) {
  return resolve(apiRoot, file);
}

function routesExist() {
  return allRouteFiles.every((file) => existsSync(routePath(file)));
}

async function loadRoute(
  file: string
): Promise<Record<string, (request: Request, context: unknown) => Promise<Response>>> {
  return (await import(/* @vite-ignore */ pathToFileURL(routePath(file)).href)) as Record<
    string,
    (request: Request, context: unknown) => Promise<Response>
  >;
}

function context(params: Record<string, string> = {}) {
  return {
    params: Promise.resolve({
      projectId: "project-1",
      batchId: "batch-1",
      revisionId: "revision-1",
      ...params
    })
  };
}

function request(
  method: "GET" | "POST" | "PATCH" | "PUT",
  body?: unknown,
  headers: Record<string, string> = {},
  requiresIfMatch = false,
  query = ""
) {
  return new Request(`http://localhost/api/projects/project-1/uph/test-batches${query}`, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "uph-test-batch-key",
      "x-user-id": actor.id,
      ...(requiresIfMatch ? { "if-match": "1" } : {}),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

describe("APM-081 UPH test-batch routes", () => {
  beforeEach(() => {
    guard.authorizeProjectRequest
      .mockReset()
      .mockResolvedValue({ authorized: true, actor, project });
    command.idempotentCommandResponse.mockReset().mockImplementation(async (input) => {
      const result = await input.execute({});
      return Response.json(result.body, { status: result.status });
    });
    for (const method of Object.values(service))
      method.mockReset().mockResolvedValue({ id: "result-1" });
    service.listUphTestBatches.mockResolvedValue({ batches: [], allowedActions: ["CREATE"] });
    service.getUphTestBatch.mockResolvedValue({
      id: "batch-1",
      allowedActions: ["PATCH", "REPLACE"]
    });
  });

  it.each(allRouteFiles)("requires the APM-081 route file %s before behavior can exist", (file) => {
    expect(existsSync(routePath(file)), `APM-081 route ${file} is required`).toBe(true);
  });

  it("default-denies unauthenticated creation without calling idempotency or service", async () => {
    if (!routesExist()) return;
    const { POST } = await loadRoute("route.ts");
    guard.authorizeProjectRequest.mockResolvedValueOnce({
      authorized: false,
      response: Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 })
    });

    expect((await POST(request("POST", createBody), context())).status).toBe(401);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.createUphTestBatch).not.toHaveBeenCalled();
  });

  it.each(commandRoutes)(
    "returns the $operation guard denial before parsing a forged command body",
    async (route) => {
      if (!routesExist()) return;
      const status = route.file === "route.ts" ? 401 : 404;
      const code = status === 401 ? "UNAUTHENTICATED" : "PROJECT_NOT_FOUND";
      guard.authorizeProjectRequest.mockResolvedValueOnce({
        authorized: false,
        response: Response.json({ error: { code } }, { status })
      });
      const routeModule = await loadRoute(route.file);
      const response = await routeModule[route.method](
        request(
          route.method,
          { ...route.body, unknown: true },
          route.headers,
          route.requiresIfMatch
        ),
        context(route.pathParams)
      );

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
      expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
      expect(service[route.serviceMethod]).not.toHaveBeenCalled();
    }
  );

  it("rejects strict DTO source and identity forgery before idempotency or service", async () => {
    if (!routesExist()) return;
    const { POST } = await loadRoute("route.ts");
    for (const [field, value] of Object.entries({
      source: { topologyVersionId: "client-v1" },
      scope: "PROJECT",
      actorId: "client-actor",
      membershipId: "client-membership",
      projectId: "client-project",
      topologyVersionId: "topology-client-v1",
      formulaVersionId: "formula-client-v1",
      ctVersionIds: ["ct-client-v1"],
      unknown: true
    })) {
      const response = await POST(request("POST", { ...createBody, [field]: value }), context());
      expect(response.status, field).toBe(422);
    }
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
    expect(service.createUphTestBatch).not.toHaveBeenCalled();
  });

  it("maps If-Match/body conflict and a missing idempotency key before command execution", async () => {
    if (!routesExist()) return;
    const revision = await loadRoute("[batchId]/revisions/[revisionId]/route.ts");
    expect(
      (
        await revision.PATCH(
          request(
            "PATCH",
            {
              resourceVersion: 2,
              plannedProductionSeconds: 3600,
              planDeclarationReason: "Adjusted controlled production declaration",
              observationStartedAt: "2026-08-25T08:00:00.000Z",
              observationEndedAt: null,
              timezone: "Asia/Shanghai"
            },
            { "if-match": "1" }
          ),
          context()
        )
      ).status
    ).toBe(409);
    const root = await loadRoute("route.ts");
    expect(
      (await root.POST(request("POST", createBody, { "idempotency-key": "" }), context())).status
    ).toBeGreaterThanOrEqual(400);
    expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
  });

  it.each(commandRoutes.filter((route) => route.requiresIfMatch))(
    "rejects $operation without If-Match before command execution",
    async (route) => {
      if (!routesExist()) return;
      const routeModule = await loadRoute(route.file);
      const response = await routeModule[route.method](
        request(route.method, route.body, route.headers),
        context(route.pathParams)
      );

      expect(response.status).toBe(409);
      expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
      expect(service[route.serviceMethod]).not.toHaveBeenCalled();
    }
  );

  it("default-denies a cross-project detail before reading batch data", async () => {
    if (!routesExist()) return;
    const detail = await loadRoute("[batchId]/route.ts");
    guard.authorizeProjectRequest.mockResolvedValueOnce({
      authorized: false,
      response: Response.json({ error: { code: "PROJECT_NOT_FOUND" } }, { status: 404 })
    });

    expect((await detail.GET(request("GET"), context())).status).toBe(404);
    expect(service.getUphTestBatch).not.toHaveBeenCalled();
  });

  it("returns query guard denials before parsing list or detail queries", async () => {
    if (!routesExist()) return;
    const root = await loadRoute("route.ts");
    const detail = await loadRoute("[batchId]/route.ts");
    guard.authorizeProjectRequest
      .mockResolvedValueOnce({
        authorized: false,
        response: Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 })
      })
      .mockResolvedValueOnce({
        authorized: false,
        response: Response.json({ error: { code: "PROJECT_NOT_FOUND" } }, { status: 404 })
      });

    const listResponse = await root.GET(
      request("GET", undefined, {}, false, "?unknown=true"),
      context()
    );
    expect(listResponse.status).toBe(401);
    await expect(listResponse.json()).resolves.toMatchObject({
      error: { code: "UNAUTHENTICATED" }
    });
    const detailResponse = await detail.GET(
      request("GET", undefined, {}, false, "?selection=unknown"),
      context()
    );
    expect(detailResponse.status).toBe(404);
    await expect(detailResponse.json()).resolves.toMatchObject({
      error: { code: "PROJECT_NOT_FOUND" }
    });
    expect(service.listUphTestBatches).not.toHaveBeenCalled();
    expect(service.getUphTestBatch).not.toHaveBeenCalled();
  });

  it.each(commandRoutes)(
    "invokes $serviceMethod with the trusted route context and $permission",
    async (route) => {
      if (!routesExist()) return;
      const routeModule = await loadRoute(route.file);
      const handler = routeModule[route.method];
      expect(handler, `${route.file} must export its command handler`).toBeTypeOf("function");
      if (!handler) return;
      const response = await handler(
        request(route.method, route.body, route.headers, route.requiresIfMatch),
        context(route.pathParams)
      );

      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(guard.authorizeProjectRequest).toHaveBeenCalledWith(
        expect.any(Request),
        "project-1",
        route.permission,
        expect.anything()
      );
      expect(command.idempotentCommandResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: actor.id,
          operation: route.operation,
          idempotencyKey: "uph-test-batch-key",
          request: {
            path: {
              projectId: "project-1",
              ...(route.file.includes("[batchId]") ? { batchId: "batch-1" } : {}),
              ...(route.file.includes("[revisionId]") ? { revisionId: "revision-1" } : {}),
              ...(route.file.includes("[moduleId]") ? { moduleId: "module-1" } : {}),
              ...(route.file.includes("[sampleId]") ? { sampleId: "sample-1" } : {})
            },
            body: route.body
          }
        })
      );
      const trustedInput = {
        projectId: "project-1",
        actorId: actor.id,
        authorizationActor: actor,
        projectMemberRoles: project.memberRoles,
        ...(route.file.includes("[batchId]") ? { batchId: "batch-1" } : {}),
        ...(route.file.includes("[revisionId]") ? { revisionId: "revision-1" } : {}),
        ...(route.file.includes("[moduleId]") ? { moduleId: "module-1" } : {}),
        ...(route.file.includes("[sampleId]") ? { sampleId: "sample-1" } : {}),
        ...(route.requiresIfMatch ? { resourceVersion: route.body.resourceVersion } : {}),
        body: route.body
      };
      expect(service[route.serviceMethod]).toHaveBeenCalledWith(
        expect.objectContaining(trustedInput),
        expect.anything()
      );
    }
  );

  it("passes strict list filters, real actor/member roles, and service allowedActions", async () => {
    if (!routesExist()) return;
    const root = await loadRoute("route.ts");
    const listResponse = await root.GET(
      request(
        "GET",
        undefined,
        {},
        false,
        "?cursor=batch-cursor&limit=25&status=LOCKED&topologyRootNodeId=line-a"
      ),
      context()
    );

    expect(service.listUphTestBatches).toHaveBeenCalledWith({
      projectId: "project-1",
      authorizationActor: actor,
      projectMemberRoles: project.memberRoles,
      cursor: "batch-cursor",
      limit: 25,
      status: "LOCKED",
      topologyRootNodeId: "line-a"
    });
    expect(guard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "project-1",
      "PROJECT_UPH_READ",
      { requireProjectMembership: true }
    );
    await expect(listResponse.json()).resolves.toMatchObject({ allowedActions: ["CREATE"] });
  });

  it.each(["?unknown=true", "?limit=0", "?limit=101", "?status=UNFROZEN", "?topologyRootNodeId="])(
    "rejects invalid strict list query %s before reading batch data",
    async (query) => {
      if (!routesExist()) return;
      const root = await loadRoute("route.ts");
      const response = await root.GET(request("GET", undefined, {}, false, query), context());
      expect(response.status).toBe(422);
      expect(service.listUphTestBatches).not.toHaveBeenCalled();
    }
  );

  it.each(commandRoutes)(
    "rejects forged $operation bodies before idempotency or $serviceMethod",
    async (route) => {
      if (!routesExist()) return;
      const routeModule = await loadRoute(route.file);
      for (const [field, value] of Object.entries({
        actorId: "client-actor",
        projectId: "client-project",
        membershipId: "client-membership",
        source: { topologyVersionId: "client-v1" },
        versionId: "client-v1",
        unknown: true
      })) {
        const response = await routeModule[route.method](
          request(
            route.method,
            { ...route.body, [field]: value },
            route.headers,
            route.requiresIfMatch
          ),
          context(route.pathParams)
        );
        expect(response.status, `${route.operation}.${field}`).toBe(422);
      }
      expect(command.idempotentCommandResponse).not.toHaveBeenCalled();
      expect(service[route.serviceMethod]).not.toHaveBeenCalled();
    }
  );

  it.each([
    { selection: "exact", revisionId: "revision-1" },
    { selection: "currentWork" },
    { selection: "currentLocked" }
  ])(
    "passes strict detail selection %s to the service and returns its allowedActions",
    async (query) => {
      if (!routesExist()) return;
      const detail = await loadRoute("[batchId]/route.ts");
      const search = new URLSearchParams({ selection: query.selection });
      if (query.revisionId) search.set("revisionId", query.revisionId);
      const response = await detail.GET(
        request("GET", undefined, {}, false, `?${search}`),
        context()
      );

      expect(service.getUphTestBatch).toHaveBeenCalledWith({
        projectId: "project-1",
        batchId: "batch-1",
        selection: query.selection,
        ...(query.revisionId ? { revisionId: query.revisionId } : {}),
        authorizationActor: actor,
        projectMemberRoles: project.memberRoles
      });
      expect(guard.authorizeProjectRequest).toHaveBeenCalledWith(
        expect.any(Request),
        "project-1",
        "PROJECT_UPH_READ",
        { requireProjectMembership: true }
      );
      await expect(response.json()).resolves.toMatchObject({
        allowedActions: ["PATCH", "REPLACE"]
      });
    }
  );

  it("rejects ambiguous or incomplete detail selections before reading batch data", async () => {
    if (!routesExist()) return;
    const detail = await loadRoute("[batchId]/route.ts");
    for (const query of ["", "?selection=exact", "?selection=currentWork&revisionId=revision-1"]) {
      const response = await detail.GET(request("GET", undefined, {}, false, query), context());
      expect(response.status).toBe(422);
    }
    expect(service.getUphTestBatch).not.toHaveBeenCalled();
  });

  it("maps a TestBatch service error through the route while leaving unknown errors to observability", async () => {
    if (!routesExist()) return;
    const revision = await loadRoute("[batchId]/revisions/[revisionId]/route.ts");
    service.patchUphTestBatchRevision.mockRejectedValueOnce({
      name: "UphTestBatchServiceError",
      code: "DRAFT_REQUIRED",
      message: "该操作仅允许在DRAFT修订执行。",
      status: 409
    });
    const mapped = await revision.PATCH(
      request("PATCH", commandRoutes[1]!.body, {}, true),
      context()
    );
    expect(mapped.status).toBe(409);
    await expect(mapped.json()).resolves.toMatchObject({ error: { code: "DRAFT_REQUIRED" } });

    service.patchUphTestBatchRevision.mockRejectedValueOnce(new Error("unexpected route failure"));
    expect(
      (await revision.PATCH(request("PATCH", commandRoutes[1]!.body, {}, true), context())).status
    ).toBe(500);
  });
});
