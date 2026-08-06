import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260807010000_apm_090a_procurement_foundation/migration.sql"
);

describe("APM-090A procurement persistence", () => {
  it("declares the foundation models and protects immutable requirement revisions", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

    for (const model of [
      "ProjectProcurementSettings",
      "MaterialReference",
      "SupplierReference",
      "ProjectMaterialRequirement",
      "ProjectMaterialRequirementRevision"
    ]) {
      expect(schema).toContain(`model ${model}`);
    }

    for (const table of [
      "project_procurement_settings",
      "material_references",
      "supplier_references",
      "project_material_requirements",
      "project_material_requirement_revisions"
    ]) {
      expect(migration).toContain(`\"${table}\"`);
    }

    expect(migration).toContain('CHECK ("quantity" > 0)');
    expect(migration).toContain('CHECK ("revision" > 0)');
    expect(migration).toContain('UNIQUE ("requirement_id", "revision")');
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
    expect(migration).toContain("BEFORE TRUNCATE");
    expect(migration).toContain("ON DELETE RESTRICT");
    for (const model of ["MaterialReference", "SupplierReference"]) {
      const modelStart = schema.indexOf(`model ${model}`);
      const nextModelStart = schema.indexOf("\nmodel ", modelStart + 1);
      const modelDefinition = schema.slice(
        modelStart,
        nextModelStart === -1 ? undefined : nextModelStart
      );

      expect(modelDefinition).toContain("@@unique([source, externalId])");
    }
    expect(migration).toContain('"material_references"("source", "external_id")');
    expect(migration).toContain('"supplier_references"("source", "external_id")');
    expect(migration.indexOf("IF TG_OP = 'DELETE' THEN")).toBeLessThan(
      migration.indexOf("IF NEW.\"business_type\" = 'DRAWING_CUSTOM' THEN")
    );
  });
});
