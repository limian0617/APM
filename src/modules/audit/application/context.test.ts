import { describe, expect, it } from "vitest";

import { auditContextFromRequest } from "./context";

describe("auditContextFromRequest", () => {
  it("extracts trusted correlation and client context without copying sensitive headers", () => {
    const request = new Request("https://apm.example.test/api/projects/project-1", {
      method: "POST",
      headers: {
        "x-request-id": "request-1",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "x-forwarded-for": "10.0.0.8, 10.0.0.1",
        "user-agent": "APM-Test/1.0",
        "idempotency-key": "operation-1",
        authorization: "Bearer must-not-be-copied",
        cookie: "session=must-not-be-copied"
      }
    });

    expect(
      auditContextFromRequest(request, {
        actorId: "user-1",
        projectId: "project-1",
        departmentId: "mechanical",
        reason: "approved"
      })
    ).toEqual({
      actorId: "user-1",
      requestId: "request-1",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      source: "API",
      sourceIp: "10.0.0.8",
      userAgent: "APM-Test/1.0",
      reason: "approved",
      projectId: "project-1",
      departmentId: "mechanical",
      operationId: "operation-1"
    });
  });

  it("creates a request and operation id when upstream correlation is absent", () => {
    const context = auditContextFromRequest(
      new Request("http://localhost/api/audit"),
      { actorId: "user-1" },
      () => "generated-request-id"
    );

    expect(context.requestId).toBe("generated-request-id");
    expect(context.operationId).toBe("generated-request-id");
  });
});
