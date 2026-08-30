import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const migrationPath = resolve(
  repoRoot,
  "prisma/migrations/20260823010000_apm_080_uph_topology_ct_formula/migration.sql"
);
const schemaPath = resolve(repoRoot, "prisma/schema.prisma");

describe("APM-080 persistence contract", () => {
  it("has the 57 to 58 migration and explicit transaction", () => {
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toMatch(/^BEGIN;/u);
    expect(migration).toMatch(/COMMIT;\s*$/u);
    expect(migration).toContain("project_uph_topologies");
    expect(migration).toContain("project_uph_topology_versions");
    expect(migration).toContain("current_work_version_id");
    expect(migration).toContain("current_published_version_id");
  });

  it("models three independent roots and forbids cavity relation duplication", () => {
    const schema = readFileSync(schemaPath, "utf8");
    expect(schema).toContain("ProjectUphTopology");
    expect(schema).toContain("ProjectUphCtDefinition");
    expect(schema).toContain("ProjectUphFormula");
    expect(schema).toContain("currentWorkVersionId");
    expect(schema).toContain("currentPublishedVersionId");
    expect(schema).not.toContain("UphCavityRelation");
  });

  it("declares every migration-backed CT and Formula ProjectMember composite relation", () => {
    const schema = readFileSync(schemaPath, "utf8");

    for (const relation of [
      "UphCtVersionProcessOwnerMembership",
      "UphCtVersionCommissioningMembership",
      "UphCtVersionQualityMembership",
      "UphFormulaVersionProcessOwnerMembership",
      "UphFormulaVersionQualityMembership"
    ]) {
      expect(schema).toContain(`@relation(\"${relation}\", fields:`);
      expect(schema).toContain(`@relation(\"${relation}\")`);
    }
  });
});
