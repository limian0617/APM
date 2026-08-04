import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("APM-031 Gate persistence contract", () => {
  it("defines project-owned Gate facts with append-only check evidence", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migrationPath = resolve(
      process.cwd(),
      "prisma/migrations/20260804030000_apm_031_gate_foundation/migration.sql"
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

    for (const declaration of [
      "enum GateScope",
      "enum GateCheckStatus",
      "model ProjectGateDefinition",
      "model ProjectGateInstance",
      "model GateCheckSnapshot",
      "model GateCheckResult",
      "GATE_DEFINITION_MATERIALIZED",
      "GATE_INSTANCE_CREATED",
      "GATE_CHECK_RUN_COMPLETED",
      "PROJECT_GATE_DEFINITION",
      "PROJECT_GATE_INSTANCE",
      "GATE_CHECK_SNAPSHOT"
    ]) {
      expect(schema).toContain(declaration);
    }

    for (const declaration of [
      'CREATE TABLE "project_gate_definitions"',
      'CREATE TABLE "project_gate_instances"',
      'CREATE TABLE "gate_check_snapshots"',
      'CREATE TABLE "gate_check_results"',
      "CREATE FUNCTION enforce_project_gate_definition_source()",
      "CREATE FUNCTION enforce_project_gate_instance_scope()",
      "CREATE FUNCTION reject_project_gate_immutable_mutation()",
      "gate_check_snapshots_reject_mutation",
      "gate_check_results_reject_mutation",
      "ADD VALUE 'GATE_DEFINITION_MATERIALIZED'",
      "ADD VALUE 'GATE_INSTANCE_CREATED'",
      "ADD VALUE 'GATE_CHECK_RUN_COMPLETED'"
    ]) {
      expect(migration).toContain(declaration);
    }

    expect(migration).toContain(
      'CHECK (("scope" = \'PROJECT\' AND "delivery_unit_id" IS NULL AND "module_id" IS NULL)'
    );
    expect(migration).toContain('FOREIGN KEY ("project_stage_id", "project_id")');
    expect(migration).toContain('FOREIGN KEY ("delivery_unit_id", "project_id")');
    expect(migration).toContain('FOREIGN KEY ("module_id", "project_id")');
  });
});
