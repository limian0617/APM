import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("APM-104 retrospective persistence contract", () => {
  it("declares immutable project retrospective aggregates and composite project relations", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260812010000_apm_104_retrospectives_knowledge_closure_policy/migration.sql"
      ),
      "utf8"
    );

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
