import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const schemaPath = resolve(process.cwd(), "prisma/schema.prisma");
const migrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260821010000_apm_063_project_asset_usage/migration.sql"
);

describe("APM-063 project asset usage persistence contract", () => {
  it("requires exact immutable asset facts and project-scoped hierarchy", async () => {
    const schema = await readFile(schemaPath, "utf8");
    const migration = await readFile(migrationPath, "utf8");

    expect(schema).toContain("model ProjectAssetReference {");
    expect(schema).toContain("model ProjectAssetUsage {");
    expect(schema).toContain("model ProjectAssetDerivation {");
    expect(schema).toMatch(/quantity\s+Decimal/);
    expect(schema).toContain("@db.Decimal(20, 6)");
    expect(schema).toContain(
      'releaseCode           String                      @map("release_code")'
    );
    expect(schema).toContain(
      'assetReleaseId        String                     @map("asset_release_id")'
    );
    expect(schema).toContain(
      "@@unique([id, projectId, technicalAssetId, assetReleaseId, assetReleaseVersionId])"
    );
    expect(schema).toContain(
      "fields: [referenceId, projectId, technicalAssetId, assetReleaseId, assetReleaseVersionId]"
    );
    expect(schema).toContain(
      "references: [id, projectId, technicalAssetId, assetReleaseId, assetReleaseVersionId]"
    );
    expect(schema).toContain("@@unique([projectId, usageKey])");
    expect(schema).not.toContain("usageKey              String                     @unique");
    expect(schema).toContain(
      'targetType                        ProjectAssetDerivationTargetType @map("target_type")'
    );
    expect(schema).toContain(
      'targetDocumentVersion             Int                 @map("target_document_version")'
    );
    expect(schema).toContain(
      'targetDocumentVersionStatus       ControlledDocumentVersionStatus @map("target_document_version_status")'
    );
    expect(schema).toContain(
      'targetFileStatus                  FileObjectStatus    @map("target_file_status")'
    );
    expect(schema).toContain("@@unique([projectId, targetBindingKey])");
    expect(migration).toContain('CREATE UNIQUE INDEX "project_asset_usages_active_scope_key"');
    expect(migration).toContain("WHERE \"status\" = 'ACTIVE'");
    expect(migration).toContain('"release_code" TEXT NOT NULL');
    expect(migration).toContain('"asset_release_id" TEXT NOT NULL');
    expect(migration).toContain('"project_id", "usage_key"');
    expect(migration).toContain('"target_type" "ProjectAssetDerivationTargetType" NOT NULL');
    expect(migration).toContain(
      '"target_document_version_status" "ControlledDocumentVersionStatus" NOT NULL'
    );
    expect(migration).toContain('"target_file_status" "FileObjectStatus" NOT NULL');
    expect(migration).toContain('"project_id", "target_binding_key"');
    expect(migration).toContain("document_status <> 'ACTIVE'");
    expect(migration).toContain("NEW.retired_at := CURRENT_TIMESTAMP");
    expect(migration).toMatch(/validate_project_asset_usage_reference_state[\s\S]*FOR UPDATE/);
    expect(migration).toContain("NEW.updated_at IS DISTINCT FROM OLD.updated_at");
    expect(migration).toContain("project asset derivations are append-only");
    expect(migration).toContain("project asset derivations cannot be truncated");
    expect(schema).toContain("@@unique([id, projectId, deliveryUnitId])");
    expect(schema).toContain("fields: [deliveryUnitId, projectId]");
    expect(schema).toContain("references: [id, projectId]");
    expect(schema).toContain("fields: [moduleId, projectId, deliveryUnitId]");
    expect(schema).toContain("references: [id, projectId, deliveryUnitId]");
  });
});
