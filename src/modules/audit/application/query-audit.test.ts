import { describe, expect, it } from "vitest";

import { AuditQueryError, parseAuditQuery } from "./query-audit";

describe("parseAuditQuery", () => {
  it("parses object, actor, action, project, department and time filters", () => {
    const query = parseAuditQuery(
      new URLSearchParams({
        objectType: "PROJECT_MEMBER",
        objectId: "member-1",
        actorId: "user-1",
        action: "PROJECT_MEMBER_ADDED",
        projectId: "project-1",
        departmentId: "mechanical",
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-02T00:00:00.000Z",
        limit: "25"
      })
    );

    expect(query).toMatchObject({
      objectType: "PROJECT_MEMBER",
      objectId: "member-1",
      actorId: "user-1",
      action: "PROJECT_MEMBER_ADDED",
      projectId: "project-1",
      departmentId: "mechanical",
      limit: 25
    });
    expect(query.from?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("rejects unknown vocabulary, invalid ranges and oversized pages", () => {
    expect(() => parseAuditQuery(new URLSearchParams({ action: "MADE_UP" }))).toThrowError(
      AuditQueryError
    );
    expect(() => parseAuditQuery(new URLSearchParams({ limit: "101" }))).toThrowError(
      AuditQueryError
    );
    expect(() =>
      parseAuditQuery(
        new URLSearchParams({
          from: "2026-08-03T00:00:00.000Z",
          to: "2026-08-02T00:00:00.000Z"
        })
      )
    ).toThrowError(AuditQueryError);
  });
});
