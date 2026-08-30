import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const migrationPath = resolve(
  repoRoot,
  "prisma/migrations/20260826010000_apm_082_uph_analysis_snapshots/migration.sql"
);
const schemaPath = resolve(repoRoot, "prisma/schema.prisma");
const permissionsPath = resolve(repoRoot, "src/lib/auth/permissions.ts");
const authorizationPath = resolve(repoRoot, "src/lib/auth/authorize.ts");
const auditVocabularyPath = resolve(repoRoot, "src/modules/audit/domain/vocabulary.ts");

function requireMigration(): string | null {
  expect(
    existsSync(migrationPath),
    "APM-082 RED: migration 60 must exist at 20260826010000_apm_082_uph_analysis_snapshots"
  ).toBe(true);
  return existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : null;
}

describe("APM-082 UPH analysis snapshot migration contract", () => {
  it("creates one immutable, project-scoped AnalysisSnapshot per locked revision, checksum, and engine", () => {
    const migration = requireMigration();
    if (!migration) return;

    for (const requiredToken of [
      'CREATE TABLE "project_uph_analysis_snapshots"',
      '"project_id"',
      '"batch_id"',
      '"revision_id"',
      '"locked_checksum"',
      '"formula_version_id"',
      '"formula_checksum"',
      '"engine_code"',
      '"input_snapshot_json"',
      '"input_checksum"',
      '"result_snapshot_json"',
      '"result_checksum"',
      '"created_by_id"',
      "'COMPUTED'",
      "'NO_OUTPUT'",
      'UNIQUE ("project_id", "revision_id", "locked_checksum", "engine_code")',
      "UPDATE OR DELETE"
    ]) {
      expect(migration, `migration 60 must include ${requiredToken}`).toContain(requiredToken);
    }
  });

  it("adds the analysis permission, audit vocabulary, outbox contract, and PostgreSQL guards without changing APM-080/081 facts", () => {
    const migration = requireMigration();
    if (!migration) return;
    const schema = readFileSync(schemaPath, "utf8");
    const permissions = readFileSync(permissionsPath, "utf8");
    const authorization = readFileSync(authorizationPath, "utf8");
    const auditVocabulary = readFileSync(auditVocabularyPath, "utf8");

    expect(schema).toContain("ProjectUphAnalysisSnapshot");
    expect(permissions).toContain("PROJECT_UPH_ANALYZE");
    expect(authorization).toContain("PROJECT_UPH_ANALYZE");
    expect(auditVocabulary).toContain("UPH_ANALYSIS_SNAPSHOT_CREATED");
    expect(auditVocabulary).toContain("UPH_ANALYSIS_SNAPSHOT");
    for (const requiredToken of [
      "UPH_ANALYSIS_SNAPSHOT_CREATED",
      "UPH_ANALYSIS_SNAPSHOT",
      "PROJECT_UPH_ANALYZE",
      "uph.analysis-snapshot.created",
      "current_locked_revision_id",
      "LOCKED",
      "checksum",
      "immutable"
    ]) {
      expect(migration, `migration 60 must enforce ${requiredToken}`).toContain(requiredToken);
    }
  });

  it("revalidates only newly inserted snapshots at deferred commit so same-transaction pointer or state drift cannot escape", () => {
    const migration = requireMigration();
    if (!migration) return;

    const functionMatch = migration.match(
      /CREATE OR REPLACE FUNCTION "project_uph_analysis_snapshot_commit_guard"\(\) RETURNS TRIGGER AS \$\$([\s\S]*?)\$\$ LANGUAGE plpgsql;/u
    );
    expect(
      functionMatch?.[1],
      "migration 60 must define the deferred snapshot commit guard body"
    ).toBeDefined();
    const body = functionMatch?.[1] ?? "";

    expect(migration).toMatch(
      /CREATE CONSTRAINT TRIGGER "project_uph_analysis_snapshot_commit_guard"\s+AFTER INSERT ON "project_uph_analysis_snapshots"\s+DEFERRABLE INITIALLY DEFERRED\s+FOR EACH ROW EXECUTE FUNCTION "project_uph_analysis_snapshot_commit_guard"\(\);/u
    );
    expect(body).toMatch(/WHERE "id" = NEW\."id" AND "project_id" = NEW\."project_id"/u);
    expect(body).toMatch(/batch\."current_locked_revision_id" = revision\."id"/u);
    expect(body).toMatch(/revision\."status" = 'LOCKED'/u);
    expect(body).toMatch(/"locked_checksum" IS DISTINCT FROM revision_row\."locked_checksum"/u);
    expect(body).toMatch(
      /"formula_version_id" IS DISTINCT FROM revision_row\."formula_version_id"/u
    );
    expect(body).toMatch(/"formula_checksum" IS DISTINCT FROM formula_row\."snapshot_checksum"/u);
    expect(body).toMatch(
      /"uph_analysis_snapshot_checksum"\(snapshot_row\."input_snapshot_json"\)/u
    );
    expect(body).toMatch(
      /"uph_analysis_snapshot_checksum"\(snapshot_row\."result_snapshot_json"\)/u
    );
    expect(body).toMatch(/input_snapshot_json"->>'lockedChecksum'/u);
    expect(body).toMatch(/result_snapshot_json"->>'status'/u);
    expect(body).toContain("RETURN NULL");
  });
});
