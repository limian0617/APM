import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260810010000_apm_103_sat_offline_drafts/migration.sql"
);

describe("APM-103 SAT offline draft persistence contract", () => {
  it("defines append-only draft submissions and review history with project-safe keys", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain('CREATE TYPE "OfflineAcceptanceDraftStatus"');
    expect(migration).toContain('CREATE TYPE "OfflineAcceptanceDraftReviewDecision"');
    expect(migration).toContain(
      "ALTER TYPE \"AuditAction\" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_OFFLINE_DRAFT_SUBMITTED'"
    );
    expect(migration).toContain('CREATE TABLE "offline_acceptance_draft_submissions"');
    expect(migration).toContain('CREATE TABLE "offline_acceptance_draft_reviews"');
    expect(migration).toContain('UNIQUE ("project_id", "client_draft_id")');
    expect(migration).toContain('"offline_acceptance_draft_submissions_immutable"');
    expect(migration).toContain('"offline_acceptance_draft_reviews_immutable"');
    expect(migration).toContain('NEW."status" = OLD."status" AND NEW."version" <> OLD."version"');
  });

  it("guards SAT batch and item ownership at the database boundary", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain("ACCEPTANCE_OFFLINE_DRAFT_SAT_ONLY");
    expect(migration).toContain("ACCEPTANCE_OFFLINE_DRAFT_BATCH_STATE");
    expect(migration).toContain("ACCEPTANCE_OFFLINE_DRAFT_ITEM_SCOPE");
  });
});
