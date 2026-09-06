import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../..",
  "prisma/migrations/20260827010000_apm_084_uph_performance_issue_retest/migration.sql"
);

describe("APM-084 performance issue migration contract", () => {
  it("adds project-scoped immutable target versions and historical UPH relation uniqueness", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, "utf8");
    for (const token of [
      'CREATE TABLE "project_uph_performance_targets"',
      'CREATE TABLE "project_uph_performance_target_versions"',
      'FOREIGN KEY ("topology_root_node_id", "project_id")',
      'CREATE UNIQUE INDEX "issue_relations_uph_historical_target_key"',
      "\"relation_type\" IN ('UPH_SOURCE_BATCH', 'UPH_ANALYSIS', 'UPH_RETEST_BATCH')",
      "project_uph_performance_target_root_guard",
      "project_uph_performance_target_version_immutable_guard"
    ]) {
      expect(migration).toContain(token);
    }
  });

  it("permits only the published-to-superseded lifecycle transition", () => {
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain("OLD.\"status\" = 'PUBLISHED' AND NEW.\"status\" <> 'SUPERSEDED'");
    expect(migration).toContain("OLD.\"status\" = 'SUPERSEDED'");
    for (const field of [
      "revision",
      "target_uph",
      "reason",
      "checksum",
      "effective_at",
      "resource_version",
      "published_by_id",
      "published_at"
    ]) {
      expect(migration).toContain(`NEW.\"${field}\" IS DISTINCT FROM OLD.\"${field}\"`);
    }
    expect(migration).toContain("OLD.\"status\" = 'DRAFT' AND NEW.\"status\" = 'SUPERSEDED'");
    expect(migration).toContain("UPH performance target version facts are immutable");
  });
});
