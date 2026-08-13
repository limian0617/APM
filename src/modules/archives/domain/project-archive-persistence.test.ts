import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ArchiveVersionStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

describe("project archive persistence contract", () => {
  it("exposes immutable archive version states to the database layer", () => {
    expect(ArchiveVersionStatus.VERIFYING).toBe("VERIFYING");
    expect(ArchiveVersionStatus.READY).toBe("READY");
    expect(ArchiveVersionStatus.FAILED).toBe("FAILED");
    expect(ArchiveVersionStatus.FINALIZED).toBe("FINALIZED");
  });

  it("freezes APM-104 archive formula and legacy migration compatibility", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260812010000_apm_104_retrospectives_knowledge_closure_policy/migration.sql"
      ),
      "utf8"
    );

    expect(schema).toContain("enum ArchiveSourceFormulaVersion");
    expect(schema).toMatch(
      /archiveSourceFormulaVersion\s+ArchiveSourceFormulaVersion\s+@map\("archive_source_formula_version"\)/
    );
    expect(schema).toMatch(/retrospectiveInputApplicability\s+RetrospectiveInputApplicability/);
    expect(schema).toContain("@@unique([id, projectId])");
    expect(migration).toContain(
      "ALTER TYPE \"ArchiveManifestSourceType\" ADD VALUE IF NOT EXISTS 'PROJECT_RETROSPECTIVE_VERSION'"
    );
    expect(migration).toContain("ARCHIVE.SOURCE@1");
    expect(migration).toContain("NOT_APPLICABLE");
    expect(migration).toContain("archive_version_retrospective_input_check");
    expect(migration).toContain("validate_project_archive_version_mutation");
    expect(migration).toContain("APM104_LEGACY_DDL TABLE project_archive_versions");
    expect(migration).toContain("project_gate_policy_tuple_check");
    expect(migration).toContain("project_archive_versions_latest_integrity_check_passed");
  });
});
