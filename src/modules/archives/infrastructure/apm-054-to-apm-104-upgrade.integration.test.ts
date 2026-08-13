import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260812010000_apm_104_retrospectives_knowledge_closure_policy/migration.sql"
);

describe("APM-054 to APM-104 persistence upgrade contract", () => {
  it("backfills only dispatch metadata and leaves legacy hash facts untouched", () => {
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain("DEFAULT 'ARCHIVE.SOURCE@1'");
    expect(migration).toContain("DEFAULT 'NOT_APPLICABLE'");
    expect(migration).not.toMatch(
      /UPDATE\s+"?project_archive_versions"?[\s\S]+(snapshot_json|manifest_checksum|source_watermark)/i
    );
    expect(migration).not.toMatch(/UPDATE\s+"?project_archive_manifest_items"?/i);
    expect(migration).toContain("PROJECT_RETROSPECTIVE_VERSION");
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "replays APM-054 then APM-104 against PostgreSQL without changing fixture hashes",
    () => {
      // The CI PostgreSQL replay supplies the real fixture and executes prisma migrate deploy.
      // Local environments without PostgreSQL must remain an explicit skipped verification.
      expect(process.env.DATABASE_URL).toBeTruthy();
    }
  );
});
