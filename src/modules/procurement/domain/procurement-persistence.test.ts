import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260807010000_apm_090a_procurement_foundation/migration.sql"
);
const trackingMigrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260807020000_apm_090b_procurement_tracking/migration.sql"
);
const eventsMigrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260807030000_apm_091a_procurement_events/migration.sql"
);
const fulfillmentIntegrityMigrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260807030100_apm_091a_fulfillment_integrity/migration.sql"
);
const fulfillmentDerivationMigrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260807030200_apm_091a_fulfillment_derivations/migration.sql"
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

  it("declares tracking projections, external mappings and sync watermarks", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = existsSync(trackingMigrationPath)
      ? readFileSync(trackingMigrationPath, "utf8")
      : "";
    for (const model of ["ProcurementTrackingLine", "ExternalMapping", "ProcurementSyncState"]) {
      expect(schema).toContain(`model ${model}`);
    }
    for (const table of [
      "procurement_tracking_lines",
      "procurement_external_mappings",
      "procurement_sync_states"
    ]) {
      expect(migration).toContain(`\"${table}\"`);
    }
    expect(migration).toContain(
      'UNIQUE ("source_system", "object_type", "external_id", "external_line_id")'
    );
    expect(migration).toContain('UNIQUE ("source_system", "object_type")');
    expect(migration).toContain('CHECK ("ordered_quantity" > 0)');
    expect(migration).toContain("ON DELETE RESTRICT");
  });

  it("declares immutable fulfillment events and their source identity", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = existsSync(eventsMigrationPath)
      ? readFileSync(eventsMigrationPath, "utf8")
      : "";
    expect(schema).toContain("enum ProcurementFulfillmentEventType");
    expect(schema).toContain("model ProcurementFulfillmentEvent");
    for (const field of [
      "eventType",
      "quantity",
      "businessOccurredAt",
      "recordedAt",
      "externalEventKey",
      "evidenceFileId",
      "reversesEventId",
      "createdById"
    ]) {
      expect(schema).toContain(field);
    }
    expect(migration).toContain('"procurement_fulfillment_events"');
    expect(migration).toContain('UNIQUE ("source", "external_event_key")');
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
    expect(migration).toContain("BEFORE TRUNCATE");
    expect(migration).toContain('CHECK ("quantity" > 0)');
    expect(migration).toContain("ON DELETE RESTRICT");
  });

  it("enforces fulfillment event project relations and business types in PostgreSQL", () => {
    const migration = existsSync(fulfillmentIntegrityMigrationPath)
      ? readFileSync(fulfillmentIntegrityMigrationPath, "utf8")
      : "";
    expect(migration).toContain("validate_procurement_fulfillment_event_integrity");
    expect(migration).toContain("BEFORE INSERT");
    expect(migration).toContain('NEW."tracking_unit" <> revision."tracking_unit"');
    expect(migration).toContain('NEW."requirement_id"');
    expect(migration).toContain('NEW."evidence_file_id"');
    expect(migration).toContain('NEW."reverses_event_id"');
    expect(migration).toContain("OUTSOURCED_PROCESS");
  });

  it("persists an automatic usable event's immutable source arrival relation", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = existsSync(fulfillmentDerivationMigrationPath)
      ? readFileSync(fulfillmentDerivationMigrationPath, "utf8")
      : "";

    expect(schema).toContain("derivedFromEventId");
    expect(schema).toContain("ProcurementFulfillmentEventDerivation");
    expect(migration).toContain('"derived_from_event_id"');
    expect(migration).toContain("procurement_fulfillment_events_derived_from_event_fkey");
    expect(migration).toContain("MARKED_USABLE");
  });
});
