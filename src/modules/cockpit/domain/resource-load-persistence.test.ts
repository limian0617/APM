import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("APM-042 resource-load projection persistence contract", () => {
  it("defines immutable project-scoped snapshots and person load rows", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migrationPath = resolve(
      process.cwd(),
      "prisma/migrations/20260805060000_apm_042_resource_load_projection/migration.sql"
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

    for (const declaration of [
      "model ResourceLoadProjection",
      "model ResourceLoadPersonProjection",
      "model ResourceLoadTaskProjection",
      "COCKPIT_RESOURCE_LOAD_REFRESHED",
      "COCKPIT_RESOURCE_LOAD"
    ]) {
      expect(schema).toContain(declaration);
    }

    for (const declaration of [
      'CREATE TABLE "resource_load_projections"',
      'CREATE TABLE "resource_load_person_projections"',
      'CREATE TABLE "resource_load_task_projections"',
      'CREATE UNIQUE INDEX "resource_load_projections_project_id_source_checksum_key"',
      'FOREIGN KEY ("owner_membership_id", "project_id")',
      "CREATE FUNCTION reject_resource_load_projection_mutation()",
      "CREATE FUNCTION reject_resource_load_projection_removal()",
      "resource_load_projections_reject_mutation",
      "resource_load_person_projections_reject_delete",
      "ADD VALUE 'COCKPIT_RESOURCE_LOAD_REFRESHED'",
      "ADD VALUE 'COCKPIT_RESOURCE_LOAD'"
    ]) {
      expect(migration).toContain(declaration);
    }
  });

  it("moves CI upgrade coverage from the APM-040 source boundary", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("Validate APM-040 to APM-042 upgrade migration");
    expect(workflow).toContain("20260805050000_apm_040_cockpit_projection");
  });
});
