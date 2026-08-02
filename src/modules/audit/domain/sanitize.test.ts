import { describe, expect, it } from "vitest";

import { AuditSerializationError, sanitizeAuditText, sanitizeAuditValue } from "./sanitize";

describe("sanitizeAuditValue", () => {
  it("keeps only recursively whitelisted fields and removes sensitive keys", () => {
    expect(
      sanitizeAuditValue(
        {
          projectId: "project-1",
          ignored: "not-audit-data",
          nested: {
            userId: "user-1",
            password: "never-store",
            actualSalary: 999999,
            实际工资: 888888,
            accessToken: "never-store",
            details: [{ reason: "approved", cookie: "session=secret" }]
          }
        },
        [
          "projectId",
          "nested",
          "userId",
          "password",
          "actualSalary",
          "accessToken",
          "实际工资",
          "details",
          "reason",
          "cookie"
        ]
      )
    ).toEqual({
      projectId: "project-1",
      nested: { userId: "user-1", details: [{ reason: "approved" }] }
    });
  });

  it("redacts complete URLs and credential-like text values", () => {
    expect(
      sanitizeAuditValue(
        {
          download: "https://files.example.test/item?signature=secret",
          reason: "Bearer abc123 token=xyz password=hunter2"
        },
        ["download", "reason"]
      )
    ).toEqual({
      download: "[REDACTED_URL]",
      reason: "Bearer [REDACTED] token=[REDACTED] password=[REDACTED]"
    });
    expect(sanitizeAuditText("see https://example.test/file?token=secret")).toBe(
      "see [REDACTED_URL]"
    );
  });

  it("reports circular and unsupported values explicitly", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => sanitizeAuditValue(circular, ["self"])).toThrowError(
      expect.objectContaining<Partial<AuditSerializationError>>({ reason: "CIRCULAR_REFERENCE" })
    );
    expect(() => sanitizeAuditValue({ count: 1n }, ["count"])).toThrowError(
      expect.objectContaining<Partial<AuditSerializationError>>({ reason: "UNSUPPORTED_VALUE" })
    );
    expect(() => sanitizeAuditValue({ data: new Map() }, ["data"])).toThrowError(
      expect.objectContaining<Partial<AuditSerializationError>>({ reason: "UNSUPPORTED_VALUE" })
    );
  });

  it("allows a shared non-circular object and serializes dates", () => {
    const shared = { reason: "same" };
    expect(
      sanitizeAuditValue(
        { first: shared, second: shared, occurredAt: new Date("2026-08-02T12:00:00.000Z") },
        ["first", "second", "reason", "occurredAt"]
      )
    ).toEqual({
      first: { reason: "same" },
      second: { reason: "same" },
      occurredAt: "2026-08-02T12:00:00.000Z"
    });
  });
});
