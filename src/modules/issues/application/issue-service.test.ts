import { describe, expect, it } from "vitest";

import { IssueServiceError, assertProjectIssuesWritable } from "./issue-service";

describe("APM-070 issue project writability", () => {
  it.each(["CLOSED", "CANCELED"])("rejects issue writes for a %s project", (status) => {
    expect(() => assertProjectIssuesWritable(status)).toThrow(
      expect.objectContaining({
        code: "PROJECT_READ_ONLY",
        status: 409
      } satisfies Partial<IssueServiceError>)
    );
  });

  it.each(["DRAFT", "ACTIVE", "ON_HOLD", "GATE_PENDING"])(
    "allows issue writes for a %s project",
    (status) => {
      expect(() => assertProjectIssuesWritable(status)).not.toThrow();
    }
  );
});
