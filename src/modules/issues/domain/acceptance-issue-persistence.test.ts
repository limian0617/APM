import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");

describe("APM-101 acceptance issue persistence", () => {
  it("keeps one active TEST_RESULT relation per issue and failure revision", () => {
    const migration = readFileSync(
      resolve(
        repositoryRoot,
        "prisma/migrations/20260809030000_apm_101_acceptance_issue_gate/migration.sql"
      ),
      "utf8"
    );
    expect(migration).toContain("issue_relations_active_test_result_unique");
    expect(migration).toContain("enforce_issue_test_result_relation");
    expect(migration).toContain("ACCEPTANCE_FAILURE_DECISION_REQUIRED");
  });

  it("records immutable issue and failure-revision sources for acceptance residual items", () => {
    const schema = readFileSync(resolve(repositoryRoot, "prisma/schema.prisma"), "utf8");
    expect(schema).toMatch(/issueId\s+String\?\s+@map\("issue_id"\)/u);
    expect(schema).toMatch(
      /acceptanceResultRevisionId\s+String\?\s+@map\("acceptance_result_revision_id"\)/u
    );
  });
});
