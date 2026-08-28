import { describe, expect, it } from "vitest";

import { resolveArchiveFixture } from "./page";

describe("APM-054 archive page fixture boundary", () => {
  it("only exposes named fixture data in development", () => {
    expect(resolveArchiveFixture("project-1", "normal", "production")).toBeNull();
    expect(resolveArchiveFixture("project-1", "normal", "development")).toMatchObject({
      projectId: "project-1",
      status: "ready"
    });
  });
});
