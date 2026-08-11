import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationPath =
  "prisma/migrations/20260811010000_apm_053_manufacturing_classification/migration.sql";

async function readMigration() {
  return readFile(migrationPath, "utf8").catch(() => "");
}

function modelBody(schema: string, modelName: string) {
  return schema.match(new RegExp(`model ${modelName} \\{[\\s\\S]*?^\\}`, "mu"))?.[0];
}

describe("APM-053 manufacturing classification persistence", () => {
  it("models versioned global manufacturing categories and process tags", async () => {
    const schema = await readFile("prisma/schema.prisma", "utf8");
    const category = modelBody(schema, "ManufacturingCategory");
    const processTag = modelBody(schema, "ProcessTag");

    expect(category).toBeDefined();
    expect(processTag).toBeDefined();
    expect(category).toMatch(/code\s+String\s+@unique/u);
    expect(processTag).toMatch(/code\s+String\s+@unique/u);
    for (const model of [category, processTag]) {
      expect(model).toMatch(/name\s+String/u);
      expect(model).toMatch(/sortOrder\s+Int\s+@default\(0\)/u);
      expect(model).toMatch(/isActive\s+Boolean\s+@default\(true\)/u);
      expect(model).toMatch(/version\s+Int\s+@default\(1\)/u);
      expect(model).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)/u);
      expect(model).toMatch(/updatedAt\s+DateTime\s+@updatedAt/u);
    }
  });

  it("keeps drawing master data separate from classified selection items", async () => {
    const schema = await readFile("prisma/schema.prisma", "utf8");
    const drawing = modelBody(schema, "MechanicalDrawing");
    const selectionSet = modelBody(schema, "DrawingSelectionSet");
    const selectionItem = modelBody(schema, "DrawingSelectionItem");

    expect(drawing).toMatch(/manufacturingCategoryId\s+String\?/u);
    expect(drawing).toMatch(/\w+\s+MechanicalDrawingProcessTag\[\]/u);
    expect(drawing).not.toMatch(
      /\b(quantity|spareQuantity|requiredOn|supplierReferenceId|purpose)\b/u
    );
    expect(selectionSet).toMatch(/status\s+DrawingSelectionSetStatus\s+@default\(DRAFT\)/u);
    expect(selectionSet).toContain("@@unique([projectId, code])");
    expect(selectionItem).toMatch(/documentVersionId\s+String/u);
    expect(selectionItem).toMatch(/version\s+Int\s+@default\(1\)/u);
    expect(selectionItem).toMatch(/quantity\s+Decimal\s+@db.Decimal\(18, 6\)/u);
    expect(selectionItem).toMatch(
      /spareQuantity\s+Decimal\s+@default\(0\)(?:\s+@map\([^\n]+\))?\s+@db.Decimal\(18, 6\)/u
    );
    expect(selectionItem).toMatch(/supplierReferenceId\s+String\?/u);
    expect(selectionItem).toMatch(/purpose\s+DrawingSelectionItemPurpose/u);
    expect(selectionItem).toMatch(/supplierMatchState\s+DrawingSelectionItemMatchState/u);
    expect(selectionItem).toContain("@@unique([selectionSetId, documentVersionId])");
  });

  it("normalizes supplier capabilities without replacing the legacy capability tag JSON", async () => {
    const schema = await readFile("prisma/schema.prisma", "utf8");
    const supplier = modelBody(schema, "SupplierReference");
    const capability = modelBody(schema, "SupplierReferenceManufacturingCapability");
    const processCapability = modelBody(schema, "SupplierReferenceProcessCapability");

    expect(supplier).toMatch(/capabilityTagsJson\s+Json\s+@default\("\[\]"\)/u);
    expect(supplier).toMatch(
      /manufacturingCapabilities\s+SupplierReferenceManufacturingCapability\[\]/u
    );
    expect(capability).toContain("@@unique([supplierReferenceId, manufacturingCategoryId])");
    expect(processCapability).toContain("@@unique([supplierCapabilityId, processTagId])");
  });

  it("seeds the exact manufacturing vocabulary and preserves disabled configuration history", async () => {
    const migration = await readMigration();

    for (const code of [
      "MACHINING",
      "SHEET_METAL",
      "WELDED_STRUCTURE",
      "SURFACE_TREATMENT",
      "ADDITIVE_MANUFACTURING",
      "OTHER_OUTSOURCING",
      "NOT_EXTERNALLY_MANUFACTURED"
    ]) {
      expect(migration).toContain(`'${code}'`);
    }
    for (const code of [
      "TURNING",
      "MILLING",
      "GRINDING",
      "WIRE_EDM",
      "LASER_CUTTING",
      "BENDING",
      "WELDING",
      "HEAT_TREATMENT",
      "ANODIZING",
      "COATING"
    ]) {
      expect(migration).toContain(`'${code}'`);
    }
    expect(migration).toContain(
      "manufacturing configuration facts must be disabled instead of removed"
    );
  });

  it("uses the shared stable-code grammar for category, tag, and snapshot codes", async () => {
    const migration = await readMigration();
    const stableCodeGrammar = "'^[A-Z][A-Z0-9._-]{0,63}$'";

    expect(migration.split(stableCodeGrammar)).toHaveLength(5);
  });

  it("requires a classified exact published drawing version with verified controlled files", async () => {
    const migration = await readMigration();

    expect(migration).toContain(
      "drawing selection item must reference an exact published drawing version"
    );
    expect(migration).toContain("drawing selection item requires a classified drawing");
    expect(migration).toContain("drawing selection item requires scanned controlled drawing files");
    expect(migration).toContain("drawing selection item requires exactly one CAD source file");
    expect(migration).toContain('"status" IS DISTINCT FROM \'AVAILABLE\'::"FileObjectStatus"');
    expect(migration).toContain(
      '"storage_area" IS DISTINCT FROM \'CONTROLLED\'::"FileStorageArea"'
    );
    expect(migration).toContain('"scanned_at" IS NULL');
    expect(migration).toContain('"verified_mime_type" IS NULL');
    expect(migration).toContain('"verified_size" IS NULL');
    expect(migration).toContain('"role" = \'CAD_SOURCE\'::"DrawingFileRole"');
  });

  it("rejects new or cleared null drawing categories while preserving uncategorized legacy rows", async () => {
    const migration = await readMigration();

    expect(migration).toContain('IF NEW."manufacturing_category_id" IS NULL THEN');
    expect(migration).toContain(
      "IF TG_OP = 'INSERT' OR OLD.\"manufacturing_category_id\" IS NOT NULL THEN"
    );
    expect(migration).toContain("'mechanical drawings require a manufacturing category'");
    expect(migration).toContain('BEFORE INSERT OR UPDATE ON "mechanical_drawings"');
  });

  it("enforces project-scoped foreign keys, snapshot shape, and locked selection immutability", async () => {
    const migration = await readMigration();

    expect(migration).toContain("drawing_selection_items_selection_set_project_fkey");
    expect(migration).toContain("drawing_selection_items_drawing_project_fkey");
    expect(migration).toContain("drawing_selection_items_document_version_project_fkey");
    expect(migration).toContain("drawing_selection_items_supplier_reference_project_fkey");
    expect(migration).toContain("drawing_selection_items_quantity_check");
    expect(migration).toContain("drawing_selection_items_spare_quantity_check");
    expect(migration).toContain("drawing_selection_items_process_tag_snapshot_array_check");
    expect(migration).toContain("drawing_selection_items_version_check");
    expect(migration).toContain(
      "drawing selection item process tag snapshot must be sorted and unique"
    );
    expect(migration).toContain(
      "drawing selection item snapshots are immutable and commands advance version once"
    );
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("locked drawing selection sets are immutable");
    expect(migration).toContain("locked drawing selection items are immutable");
    expect(migration).toContain("drawing_selection_sets_reject_truncate");
    expect(migration).toContain("drawing_selection_items_reject_truncate");
    expect(migration).toContain("supplier_reference_manufacturing_capabilities_reject_truncate");
    expect(migration).toContain("supplier_reference_process_capabilities_reject_truncate");
    expect(migration).toContain(
      'BEFORE TRUNCATE ON "supplier_reference_manufacturing_capabilities"'
    );
    expect(migration).toContain('BEFORE TRUNCATE ON "supplier_reference_process_capabilities"');
  });

  it("requires CI to replay the APM-103 database through the APM-053 migration", async () => {
    const ci = await readFile(".github/workflows/ci.yml", "utf8");

    expect(ci).toContain("Validate APM-103 to APM-053 upgrade migration");
    expect(ci).toContain('"20260811010000_apm_053_manufacturing_classification"');
    expect(ci).toContain("apm_upgrade_apm103");
  });
});
