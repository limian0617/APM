import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationRoot = resolve(process.cwd(), "prisma/migrations");
const stageMigration = readFileSync(
  resolve(migrationRoot, "20260804010000_apm_030_project_stages/migration.sql"),
  "utf8"
);
const hardeningMigrationPath = resolve(
  migrationRoot,
  "20260804020000_apm_030_stage_invariants/migration.sql"
);
const stagePersistenceMigrations = [
  stageMigration,
  existsSync(hardeningMigrationPath) ? readFileSync(hardeningMigrationPath, "utf8") : ""
].join("\n");

describe("project stage persistence migrations", () => {
  it("synchronizes the selected main-control stage summary after a stage status update", () => {
    expect(stagePersistenceMigrations).toContain(
      "CREATE OR REPLACE FUNCTION synchronize_project_main_control_stage_summary()"
    );
    expect(stagePersistenceMigrations).toContain(
      'AFTER UPDATE OF "status", "status_changed_at"\n  ON "project_stages"'
    );
    expect(stagePersistenceMigrations).toContain('"main_control_stage_status" = NEW."status"');
    expect(stagePersistenceMigrations).toContain(
      '"main_control_stage_updated_at" = NEW."status_changed_at"'
    );
  });

  it("treats each persisted stage fact primary key as stable identity", () => {
    expect(stagePersistenceMigrations).toContain(
      "CREATE OR REPLACE FUNCTION enforce_project_stage_stable_identity()"
    );
    expect(stagePersistenceMigrations).toContain(
      'IF OLD."id" IS DISTINCT FROM NEW."id"\n    OR OLD."project_id"'
    );
    expect(stagePersistenceMigrations).toContain(
      "CREATE OR REPLACE FUNCTION enforce_delivery_unit_stage_stable_identity()"
    );
    expect(stagePersistenceMigrations).toContain(
      'IF OLD."id" IS DISTINCT FROM NEW."id"\n    OR OLD."project_id"'
    );
    expect(stagePersistenceMigrations).toContain(
      "CREATE OR REPLACE FUNCTION enforce_stage_release_authorization_stability()"
    );
    expect(stagePersistenceMigrations).toContain(
      'IF OLD."id" IS DISTINCT FROM NEW."id"\n    OR OLD."project_id"'
    );
  });
});
