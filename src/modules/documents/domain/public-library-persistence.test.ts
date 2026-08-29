import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260805070000_apm_060_public_library/migration.sql"
);

describe("APM-060 public-library persistence migration", () => {
  it("creates immutable public versions and project exact-version references", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain('CREATE TABLE "public_library_documents"');
    expect(migration).toContain('CREATE TABLE "public_library_document_versions"');
    expect(migration).toContain('CREATE TABLE "project_public_library_references"');
    expect(migration).toContain("public_library_documents_single_current_published");
    expect(migration).toContain("public_library_versions_reject_mutation");
    expect(migration).toContain("project_public_library_references_reject_delete");
    expect(migration).toContain("source_file_sha256");
    expect(migration).toContain("public_document_version_id");
  });
});

describe("APM-060 public-library CI upgrade migration", () => {
  it("replays the APM-050 fixture before applying APM-060", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("APM-050 to APM-060");
    expect(workflow).toContain("20260805030000_apm_050_controlled_documents");
    expect(workflow).toContain(
      'npx prisma migrate deploy --schema "$upgrade_root/prisma/schema.prisma"'
    );
  });
});
