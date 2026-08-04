import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("APM-040 cockpit projection persistence contract", () => {
  it("defines immutable project-scoped projection snapshots and exceptions", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migrationPath = resolve(
      process.cwd(),
      "prisma/migrations/20260805050000_apm_040_cockpit_projection/migration.sql"
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

    for (const declaration of [
      "enum CockpitHealthStatus",
      "enum CockpitExceptionKind",
      "model CockpitProjection",
      "model CockpitExceptionProjection",
      "COCKPIT_PROJECTION_REFRESHED",
      "COCKPIT_PROJECTION"
    ]) {
      expect(schema).toContain(declaration);
    }

    for (const declaration of [
      'CREATE TABLE "cockpit_projections"',
      'CREATE TABLE "cockpit_exception_projections"',
      'CREATE UNIQUE INDEX "cockpit_projections_project_id_source_checksum_key"',
      'CREATE UNIQUE INDEX "cockpit_exception_projections_projection_id_kind_source_key_key"',
      "CREATE FUNCTION reject_cockpit_projection_mutation()",
      "CREATE FUNCTION reject_cockpit_projection_removal()",
      "cockpit_projections_reject_mutation",
      "cockpit_exception_projections_reject_delete",
      "ADD VALUE 'COCKPIT_PROJECTION_REFRESHED'",
      "ADD VALUE 'COCKPIT_PROJECTION'"
    ]) {
      expect(migration).toContain(declaration);
    }
  });

  it("moves CI upgrade coverage from the APM-023 source boundary", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("Validate APM-023 to APM-040 upgrade migration");
    expect(workflow).toContain("20260805010000_apm_023_planning_baselines");
  });
});
