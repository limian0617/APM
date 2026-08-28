import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "prisma/migrations/20260812010000_apm_104_retrospectives_knowledge_closure_policy/migration.sql"
  ),
  "utf8"
);

describe("APM-104 retrospective persistence contract", () => {
  it("seeds the six runtime permissions with the exact role scope matrix", () => {
    expect(migration).toContain("permission-project-retrospective-read");
    expect(migration).toContain("permission-project-retrospective-manage");
    expect(migration).toContain("permission-project-retrospective-review");
    expect(migration).toContain("permission-knowledge-read");
    expect(migration).toContain("permission-knowledge-review");
    expect(migration).toContain("permission-knowledge-reuse-confirm");
    for (const row of [
      ["role-project-manager", "permission-project-retrospective-read", "PROJECT"],
      ["role-department-lead", "permission-project-retrospective-read", "DEPARTMENT"],
      ["role-quality", "permission-project-retrospective-read", "PROJECT"],
      ["role-admin", "permission-project-retrospective-read", "ALL"],
      ["role-project-manager", "permission-project-retrospective-manage", "PROJECT"],
      ["role-department-lead", "permission-project-retrospective-manage", "DEPARTMENT"],
      ["role-admin", "permission-project-retrospective-manage", "ALL"],
      ["role-department-lead", "permission-project-retrospective-review", "DEPARTMENT"],
      ["role-quality", "permission-project-retrospective-review", "PROJECT"],
      ["role-admin", "permission-project-retrospective-review", "ALL"],
      ["role-project-manager", "permission-knowledge-reuse-confirm", "PROJECT"],
      ["role-quality", "permission-knowledge-reuse-confirm", "PROJECT"],
      ["role-admin", "permission-knowledge-reuse-confirm", "ALL"]
    ]) {
      expect(migration).toContain(`('${row[0]}', '${row[1]}', '${row[2]}')`);
    }
    for (const roleId of [
      "role-project-manager",
      "role-department-lead",
      "role-engineer",
      "role-procurement",
      "role-quality",
      "role-technical-asset-maintainer",
      "role-executive",
      "role-admin"
    ]) {
      expect(migration).toContain(`('${roleId}', 'permission-knowledge-read', 'ALL')`);
    }
    expect(migration).not.toContain("('role-engineer', 'permission-knowledge-review'");
    expect(migration).not.toContain("('role-project-manager', 'permission-knowledge-review'");
    expect(migration).not.toContain("('role-engineer', 'permission-knowledge-reuse-confirm'");
  });
  it("declares immutable project retrospective aggregates and composite project relations", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    for (const model of [
      "ProjectRetrospective",
      "ProjectRetrospectiveVersion",
      "ProjectRetrospectiveContribution",
      "ProjectRetrospectiveParticipant",
      "ProjectRetrospectiveIssueSource",
      "ProjectRetrospectiveReview"
    ]) {
      expect(schema).toContain(`model ${model}`);
    }
    for (const enumName of [
      "RetrospectiveInputApplicability",
      "RetrospectiveScopeType",
      "ProjectRetrospectiveStatus",
      "RetrospectiveReviewDecision"
    ]) {
      expect(schema).toContain(`enum ${enumName}`);
    }
    for (const declaration of [
      'CREATE TABLE "project_retrospectives"',
      'CREATE TABLE "project_retrospective_versions"',
      'CREATE TABLE "project_retrospective_contributions"',
      'CREATE TABLE "project_retrospective_participants"',
      'CREATE TABLE "project_retrospective_issue_sources"',
      'CREATE TABLE "project_retrospective_reviews"',
      "retrospective_versions_immutable",
      "retrospective_input_archive_fkey",
      "retrospective_contribution_scope_check",
      "retrospective_review_version_pair_fkey",
      "project_retrospective_pointer_check"
    ]) {
      expect(migration).toContain(declaration);
    }
  });
});
