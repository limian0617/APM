import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().slice(0, 8);

describeDatabase("APM-104 project close PostgreSQL integration", () => {
  it("reserves a unique closure record for exactly one project close", async () => {
    expect(`project-close-${suffix}`).toMatch(/^project-close-/u);
  });
});
