import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const schemaPath = resolve(process.cwd(), "prisma/schema.prisma");
const migrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260820070000_apm_062_asset_releases/migration.sql"
);

describe("APM-062 persistence contract", () => {
  it("declares the Release master, immutable versions, and component snapshots", () => {
    const schema = readFileSync(schemaPath, "utf8");
    expect(schema).toContain("model AssetRelease {");
    expect(schema).toContain("model AssetReleaseVersion {");
    expect(schema).toContain("model AssetComponentSnapshot {");
    expect(schema).toContain("enum AssetReleaseVersionStatus {");
    expect(schema).toContain("enum AssetComponentType {");
  });

  it("ships the migration with immutable-history and restrictive relation guards", () => {
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain('CREATE TABLE "asset_releases"');
    expect(migration).toContain('CREATE TABLE "asset_release_versions"');
    expect(migration).toContain('CREATE TABLE "asset_component_snapshots"');
    expect(migration).toContain("ON DELETE RESTRICT");
    expect(migration).toContain("cannot be deleted");
    expect(migration).toContain("cannot be truncated");
    expect(migration).toContain("PUBLISHED");
    expect(migration).toContain("SUPERSEDED");
  });
});
