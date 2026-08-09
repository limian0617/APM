import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260807010000_apm_090a_procurement_foundation/migration.sql"
);
const capabilitySeedMigrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260807010100_apm_090a_capability_seed/migration.sql"
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
const readinessMigrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260807040000_apm_091b_procurement_readiness/migration.sql"
);
const changeImpactMigrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260807040200_apm_091b_procurement_change_impacts/migration.sql"
);

describe("APM-090A procurement persistence", () => {
  it("commits the new capability enum before inserting its seed row", () => {
    const foundationMigration = readFileSync(migrationPath, "utf8");
    const capabilitySeedMigration = existsSync(capabilitySeedMigrationPath)
      ? readFileSync(capabilitySeedMigrationPath, "utf8")
      : "";

    expect(foundationMigration).not.toMatch(
      /INSERT INTO "company_capabilities"[\s\S]*PROCUREMENT_COLLABORATION/u
    );
    expect(capabilitySeedMigration).toContain('INSERT INTO "company_capabilities"');
    expect(capabilitySeedMigration).toContain("'PROCUREMENT_COLLABORATION'");
  });

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

  it("persists immutable project-scoped readiness policies and results", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = existsSync(readinessMigrationPath)
      ? readFileSync(readinessMigrationPath, "utf8")
      : "";
    const readinessPolicyStart = schema.indexOf("model ProcurementReadinessPolicyVersion");
    const readinessResultStart = schema.indexOf("model ProcurementReadinessResult");
    const settingsStart = schema.indexOf("model ProjectProcurementSettings");
    const policyDefinition = schema.slice(
      readinessPolicyStart,
      schema.indexOf("\nmodel ", readinessPolicyStart + 1)
    );
    const resultDefinition = schema.slice(
      readinessResultStart,
      schema.indexOf("\nmodel ", readinessResultStart + 1)
    );
    const settingsDefinition = schema.slice(
      settingsStart,
      schema.indexOf("\nmodel ", settingsStart + 1)
    );

    expect(schema).toContain("enum ProcurementReadinessScopeType");
    expect(schema).toContain("enum ProcurementReadinessStatus");
    expect(schema).toContain("model ProcurementReadinessPolicyVersion");
    expect(schema).toContain("model ProcurementReadinessResult");

    for (const field of [
      "projectId",
      "version",
      "inspectionRequired",
      "arrivalAutoUsable",
      "criticalRuleJson",
      "dueGraceDays",
      "gateThresholdJson",
      "formulaVersion",
      "createdById",
      "reason",
      "createdAt"
    ]) {
      expect(policyDefinition).toContain(field);
    }
    expect(policyDefinition).toContain("@@unique([projectId, version])");
    expect(policyDefinition).toContain("@@unique([id, projectId])");

    for (const field of [
      "projectId",
      "scopeType",
      "scopeId",
      "policyVersionId",
      "formulaVersion",
      "inputWatermark",
      "status",
      "totalLines",
      "readyLines",
      "readinessRate",
      "criticalTotalLines",
      "criticalReadyLines",
      "criticalReadinessRate",
      "gapLines",
      "overdueLines",
      "pendingAcceptanceLines",
      "blockingCriticalLines",
      "sourceMode",
      "sourceSyncedAt",
      "calculatedAt"
    ]) {
      expect(resultDefinition).toContain(field);
    }
    expect(resultDefinition).toContain(
      "@@unique([projectId, scopeType, scopeId, inputWatermark, formulaVersion])"
    );

    expect(settingsDefinition).toContain("currentReadinessPolicyVersionId");
    expect(settingsDefinition).toContain("@@unique([currentReadinessPolicyVersionId, projectId])");

    const readinessStatusDefinition = schema.slice(
      schema.indexOf("enum ProcurementReadinessStatus"),
      schema.indexOf("\n}\n", schema.indexOf("enum ProcurementReadinessStatus"))
    );
    for (const status of ["READY", "BLOCKED", "EMPTY", "INVALID_INPUT", "STALE", "FAILED"]) {
      expect(readinessStatusDefinition).toContain(status);
    }
    const readinessScopeDefinition = schema.slice(
      schema.indexOf("enum ProcurementReadinessScopeType"),
      schema.indexOf("\n}\n", schema.indexOf("enum ProcurementReadinessScopeType"))
    );
    for (const scopeType of ["PROJECT", "DELIVERY_UNIT", "MACHINE", "MODULE", "REQUIREMENT"]) {
      expect(readinessScopeDefinition).toContain(scopeType);
    }

    const alertSourceDefinition = schema.slice(
      schema.indexOf("enum AlertSourceType"),
      schema.indexOf("\n}\n", schema.indexOf("enum AlertSourceType"))
    );
    const procurementAlertSources =
      alertSourceDefinition.match(/^\s+(PROCUREMENT_[A-Z_]+)$/gmu)?.map((value) => value.trim()) ??
      [];
    expect(procurementAlertSources).toEqual([
      "PROCUREMENT_NOT_ORDERED",
      "PROCUREMENT_LATE",
      "PROCUREMENT_PENDING_ACCEPTANCE",
      "PROCUREMENT_CRITICAL_SHORTAGE",
      "PROCUREMENT_CHANGE_BLOCKED",
      "PROCUREMENT_DATA_STALE"
    ]);

    for (const table of [
      "procurement_readiness_policy_versions",
      "procurement_readiness_results"
    ]) {
      expect(migration).toContain(`\"${table}\"`);
    }
    expect(migration).toContain('UNIQUE ("project_id", "version")');
    expect(migration).toContain(
      'UNIQUE ("project_id", "scope_type", "scope_id", "input_watermark", "formula_version")'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("current_readiness_policy_version_id", "project_id") REFERENCES "procurement_readiness_policy_versions"("id", "project_id")'
    );
    expect(migration).toContain(
      'FOREIGN KEY ("policy_version_id", "project_id") REFERENCES "procurement_readiness_policy_versions"("id", "project_id")'
    );
    expect(migration).toContain('CHECK (NOT "inspection_required" OR NOT "arrival_auto_usable")');
    expect(migration).toContain("procurement_readiness_results_line_counts_check");
    for (const constraint of [
      '"critical_total_lines" <= "total_lines"',
      '"critical_ready_lines" <= "ready_lines"',
      '"gap_lines" <= "total_lines"',
      '"overdue_lines" <= "total_lines"',
      '"pending_acceptance_lines" <= "total_lines"'
    ]) {
      expect(migration).toContain(constraint);
    }
    expect(migration).toContain("procurement_readiness_results_rates_check");
    expect(migration).toMatch(
      /CASE WHEN "total_lines" = 0 THEN "readiness_rate" = 0\s+ELSE "readiness_rate" = trunc\("ready_lines"::NUMERIC \/ "total_lines", 6\) END/u
    );
    expect(migration).toMatch(
      /CASE WHEN "critical_total_lines" = 0 THEN "critical_readiness_rate" = 0\s+ELSE "critical_readiness_rate" = trunc\("critical_ready_lines"::NUMERIC \/ "critical_total_lines", 6\) END/u
    );
    expect(migration).toContain("procurement_readiness_results_empty_status_check");
    for (const zeroFact of [
      '"total_lines" = 0',
      '"ready_lines" = 0',
      '"readiness_rate" = 0',
      '"critical_total_lines" = 0',
      '"critical_ready_lines" = 0',
      '"critical_readiness_rate" = 0',
      '"gap_lines" = 0',
      '"overdue_lines" = 0',
      '"pending_acceptance_lines" = 0',
      '"blocking_critical_lines" = 0'
    ]) {
      expect(migration).toContain(zeroFact);
    }
    expect(migration).toContain("procurement_readiness_results_ready_status_check");
    for (const readyFact of [
      '"total_lines" > 0',
      '"ready_lines" = "total_lines"',
      '"critical_ready_lines" = "critical_total_lines"',
      '"gap_lines" = 0',
      '"blocking_critical_lines" = 0'
    ]) {
      expect(migration).toContain(readyFact);
    }
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
    expect(migration).toContain("BEFORE TRUNCATE");
    expect(migration).toContain("ON DELETE RESTRICT");
  });

  it("persists server-detected procurement change impacts and append-only disposition evidence", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = existsSync(changeImpactMigrationPath)
      ? readFileSync(changeImpactMigrationPath, "utf8")
      : "";

    for (const model of [
      "ProcurementChangeImpact",
      "ProcurementChangeImpactObligation",
      "ProcurementChangeImpactResolution"
    ]) {
      expect(schema).toContain(`model ${model}`);
    }
    for (const enumName of [
      "ProcurementChangeImpactType",
      "ProcurementChangeImpactStatus",
      "ProcurementChangeImpactObligationType",
      "ProcurementChangeImpactDisposition"
    ]) {
      expect(schema).toContain(`enum ${enumName}`);
    }
    for (const table of [
      "procurement_change_impacts",
      "procurement_change_impact_obligations",
      "procurement_change_impact_resolutions"
    ]) {
      expect(migration).toContain(`\"${table}\"`);
    }
    expect(migration).toContain('UNIQUE ("project_id", "previous_revision_id")');
    expect(migration).toContain('UNIQUE ("obligation_id")');
    expect(migration).toContain("prevent_procurement_change_impact_mutation");
    expect(migration).toContain("procurement_change_impact_obligations_immutable");
    expect(migration).toContain("procurement_change_impact_resolutions_immutable");
    expect(migration).toContain("BEFORE TRUNCATE");
    expect(migration).toContain("ON DELETE RESTRICT");
  });
});
