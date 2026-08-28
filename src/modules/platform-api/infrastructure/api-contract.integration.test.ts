import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { PUT as updateCapability } from "@/app/api/configuration/capabilities/[code]/route";
import { GET as downloadFile } from "@/app/api/projects/[projectId]/files/[fileId]/download/route";
import { db } from "@/lib/db";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);
const ids = {
  admin: `api-contract-admin-${suffix}`,
  engineer: `api-contract-engineer-${suffix}`,
  project: `api-contract-project-${suffix}`
};

function capabilityRequest(input: {
  actorId?: string;
  idempotencyKey?: string;
  requestId: string;
  body: string;
}) {
  return new Request("http://localhost/api/configuration/capabilities/CUSTOMER_PROGRESS_SHARING", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-request-id": input.requestId,
      ...(input.actorId ? { "x-apm-user-id": input.actorId } : {}),
      ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {})
    },
    body: input.body
  });
}

describeDatabase("APM-009 Route Handler contracts", () => {
  beforeAll(async () => {
    await db.user.createMany({
      data: [
        {
          id: ids.admin,
          employeeNo: `API-CONTRACT-ADMIN-${suffix}`,
          name: "API contract admin",
          departmentId: "hq"
        },
        {
          id: ids.engineer,
          employeeNo: `API-CONTRACT-ENGINEER-${suffix}`,
          name: "API contract engineer",
          departmentId: "engineering"
        }
      ]
    });
    await db.userRole.createMany({
      data: [
        { id: `api-contract-admin-role-${suffix}`, userId: ids.admin, roleId: "role-admin" },
        {
          id: `api-contract-engineer-role-${suffix}`,
          userId: ids.engineer,
          roleId: "role-engineer"
        }
      ]
    });
    await db.project.create({
      data: {
        id: ids.project,
        code: `API-CONTRACT-${suffix}`,
        name: "API contract project",
        createdById: ids.admin
      }
    });
  });

  it("keeps 401 and 403 distinct and correlated", async () => {
    const unauthenticated = await updateCapability(
      capabilityRequest({ requestId: `unauthenticated-${suffix}`, body: "{}" }),
      { params: Promise.resolve({ code: "CUSTOMER_PROGRESS_SHARING" }) }
    );
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      error: {
        code: "UNAUTHENTICATED",
        issues: [],
        requestId: `unauthenticated-${suffix}`,
        traceId: expect.stringMatching(/^[0-9a-f]{32}$/u)
      }
    });

    const forbidden = await updateCapability(
      capabilityRequest({
        actorId: ids.engineer,
        idempotencyKey: `forbidden-${suffix}`,
        requestId: `forbidden-${suffix}`,
        body: JSON.stringify({ enabled: true, version: 1, reason: "not authorized" })
      }),
      { params: Promise.resolve({ code: "CUSTOMER_PROGRESS_SHARING" }) }
    );
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({
      error: { code: "FORBIDDEN", requestId: `forbidden-${suffix}` }
    });
  });

  it("maps malformed JSON and semantic DTO failures to 400 and 422", async () => {
    const malformed = await updateCapability(
      capabilityRequest({
        actorId: ids.admin,
        idempotencyKey: `malformed-${suffix}`,
        requestId: `malformed-${suffix}`,
        body: "{"
      }),
      { params: Promise.resolve({ code: "CUSTOMER_PROGRESS_SHARING" }) }
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "INVALID_JSON", issues: [{ field: "body", code: "INVALID_JSON" }] }
    });

    const invalid = await updateCapability(
      capabilityRequest({
        actorId: ids.admin,
        idempotencyKey: `invalid-${suffix}`,
        requestId: `invalid-${suffix}`,
        body: JSON.stringify({
          enabled: "true",
          version: null,
          reason: "invalid fields",
          unknown: true
        })
      }),
      { params: Promise.resolve({ code: "CUSTOMER_PROGRESS_SHARING" }) }
    );
    expect(invalid.status).toBe(422);
    const invalidPayload = await invalid.json();
    expect(invalidPayload).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    expect(invalidPayload.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "body.enabled" }),
        expect.objectContaining({ field: "body.version" }),
        expect.objectContaining({ field: "body.unknown", code: "UNKNOWN_FIELD" })
      ])
    );
  });

  it("preserves hidden 404 semantics without accessing object storage", async () => {
    const response = await downloadFile(
      new Request(
        `http://localhost/api/projects/${ids.project}/files/not-visible-${suffix}/download`,
        {
          headers: {
            "x-apm-user-id": ids.admin,
            "x-request-id": `hidden-file-${suffix}`
          }
        }
      ),
      {
        params: Promise.resolve({ projectId: ids.project, fileId: `not-visible-${suffix}` })
      }
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "FILE_NOT_FOUND", requestId: `hidden-file-${suffix}` }
    });
  });

  it("replays one result and preserves a 409 version conflict for another command", async () => {
    const capability = await db.companyCapability.findUniqueOrThrow({
      where: { code: "CUSTOMER_PROGRESS_SHARING" }
    });
    const body = JSON.stringify({
      enabled: !capability.enabled,
      version: capability.version,
      reason: "APM-009 API contract acceptance"
    });
    const key = `capability-${suffix}`;
    const invoke = (requestId: string) =>
      updateCapability(
        capabilityRequest({
          actorId: ids.admin,
          idempotencyKey: key,
          requestId,
          body
        }),
        { params: Promise.resolve({ code: "CUSTOMER_PROGRESS_SHARING" }) }
      );

    const first = await invoke(`capability-first-${suffix}`);
    const second = await invoke(`capability-second-${suffix}`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("idempotency-replayed")).toBe("false");
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(await first.json()).toEqual(await second.json());

    const conflict = await updateCapability(
      capabilityRequest({
        actorId: ids.admin,
        idempotencyKey: `version-conflict-${suffix}`,
        requestId: `version-conflict-${suffix}`,
        body
      }),
      { params: Promise.resolve({ code: "CUSTOMER_PROGRESS_SHARING" }) }
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "VERSION_CONFLICT", requestId: `version-conflict-${suffix}` }
    });
  });
});
