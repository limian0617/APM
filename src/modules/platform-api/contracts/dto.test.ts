import { describe, expect, it } from "vitest";

import { parseHeaders, parseJsonBody, parsePath, parseQuery } from "./dto";
import {
  membershipCommandHeadersSchema,
  notificationQuerySchema,
  projectMembershipPathSchema,
  settingBodySchema
} from "./internal-routes";

function jsonRequest(body: string, headers: HeadersInit = {}) {
  return new Request("http://localhost/api/configuration/settings/jobs.claimBatchSize", {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body
  });
}

describe("APM API DTO boundary", () => {
  it("returns a stable malformed JSON problem without parser internals", async () => {
    await expect(parseJsonBody(jsonRequest("{"), settingBodySchema)).rejects.toMatchObject({
      code: "INVALID_JSON",
      status: 400,
      issues: [{ field: "body", code: "INVALID_JSON", message: "JSON 语法无效。" }]
    });
  });

  it("rejects unknown fields, wrong types, invalid nulls, and oversized values", async () => {
    const cases = [
      { value: 3, version: 1, reason: "change", unexpected: true },
      { value: "3", version: 1, reason: "change" },
      { value: 3, version: null, reason: "change" },
      { value: 3, version: 1, reason: "x".repeat(1025) }
    ];

    for (const value of cases) {
      await expect(
        parseJsonBody(jsonRequest(JSON.stringify(value)), settingBodySchema)
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
    }
  });

  it("enforces the request byte limit before DTO parsing", async () => {
    await expect(
      parseJsonBody(
        jsonRequest(JSON.stringify({ value: 3, version: 1, reason: "change" })),
        settingBodySchema,
        8
      )
    ).rejects.toMatchObject({ code: "BODY_TOO_LARGE", status: 413 });
  });

  it("rejects unknown and duplicate query fields with field locations", () => {
    expect(() =>
      parseQuery(
        new Request("http://localhost/api/notifications?limit=10&unexpected=1"),
        notificationQuerySchema
      )
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_QUERY",
        status: 400,
        issues: [expect.objectContaining({ field: "query.unexpected", code: "UNKNOWN_FIELD" })]
      })
    );
    expect(() =>
      parseQuery(
        new Request("http://localhost/api/notifications?limit=10&limit=20"),
        notificationQuerySchema
      )
    ).toThrowError(expect.objectContaining({ code: "INVALID_QUERY", status: 400 }));
  });

  it("strictly parses path and common command headers", () => {
    expect(() =>
      parsePath(projectMembershipPathSchema, {
        projectId: "project-1",
        membershipId: "x".repeat(192)
      })
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED", status: 422 }));

    expect(() =>
      parseHeaders(
        new Request("http://localhost/api/projects/project-1/members/member-1", {
          method: "DELETE",
          headers: { "if-match": '"3"' }
        }),
        membershipCommandHeadersSchema,
        { idempotencyKey: "idempotency-key", ifMatch: "if-match" }
      )
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_HEADERS",
        status: 400,
        issues: [expect.objectContaining({ field: "headers.idempotencyKey" })]
      })
    );
  });
});
