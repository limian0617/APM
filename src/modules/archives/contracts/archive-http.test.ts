import { describe, expect, it } from "vitest";

import {
  archiveCloseBodySchema,
  archiveGenerationBodySchema,
  archiveVersionPathSchema
} from "./archive-http";

describe("archive HTTP contracts", () => {
  it("accepts only a strict optimistic archive generation request", () => {
    expect(archiveGenerationBodySchema.parse({ version: 3 })).toEqual({ version: 3 });
    expect(() => archiveGenerationBodySchema.parse({ version: 3, anything: true })).toThrow();
    expect(() => archiveGenerationBodySchema.parse({ version: 0 })).toThrow();
  });

  it("requires exact project-close facts and rejects extra client fields", () => {
    expect(
      archiveCloseBodySchema.parse({ archiveVersionId: "av1", g9SubmissionId: "g9-1", version: 4 })
    ).toEqual({
      archiveVersionId: "av1",
      g9SubmissionId: "g9-1",
      version: 4
    });
    expect(() =>
      archiveCloseBodySchema.parse({
        archiveVersionId: "av1",
        g9SubmissionId: "g9-1",
        version: 4,
        status: "CLOSED"
      })
    ).toThrow();
    expect(() =>
      archiveVersionPathSchema.parse({ projectId: "p1", archiveVersionId: "" })
    ).toThrow();
  });
});
