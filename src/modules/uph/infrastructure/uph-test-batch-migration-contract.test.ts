import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const migrationPath = resolve(
  repoRoot,
  "prisma/migrations/20260825010000_apm_081_uph_test_batches/migration.sql"
);
const apm080MigrationPath = resolve(
  repoRoot,
  "prisma/migrations/20260823010000_apm_080_uph_topology_ct_formula/migration.sql"
);
const schemaPath = resolve(repoRoot, "prisma/schema.prisma");
const permissionsPath = resolve(repoRoot, "src/lib/auth/permissions.ts");
const authorizationPath = resolve(repoRoot, "src/lib/auth/authorize.ts");

const tableNames = {
  root: "project_uph_test_batches",
  revision: "project_uph_test_batch_revisions",
  binding: "project_uph_test_batch_revision_module_bindings",
  production: "project_uph_test_batch_revision_production_counts",
  sample: "project_uph_module_cycle_samples",
  evidence: "project_uph_test_batch_revision_evidence"
} as const;

function requireMigration(): string | null {
  expect(
    existsSync(migrationPath),
    "APM-081 must add migration 59 at 20260825010000_apm_081_uph_test_batches"
  ).toBe(true);
  return existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : null;
}

function requireApm080Migration() {
  expect(existsSync(apm080MigrationPath), "APM-080 topology migration must remain available").toBe(
    true
  );
  return readFileSync(apm080MigrationPath, "utf8");
}

function expectTable(migration: string, table: string) {
  expect(migration).toContain(`CREATE TABLE "${table}"`);
}

function expectCompositeForeignKey(
  migration: string,
  childTable: string,
  columns: string[],
  parentTable: string,
  parentColumns: string[]
) {
  const quoted = (items: string[]) => items.map((item) => `"${item}"`).join("\\s*,\\s*");
  const expression = new RegExp(
    `ALTER TABLE "${childTable}"(?:(?!;)[\\s\\S])*?FOREIGN KEY\\s*\\(${quoted(columns)}\\)\\s*` +
      `REFERENCES\\s+"${parentTable}"\\s*\\(${quoted(parentColumns)}\\)`,
    "u"
  );
  expect(
    migration,
    `${childTable} must carry project-scoped composite FK ${columns.join(",")} -> ${parentTable}`
  ).toMatch(expression);
}

function expectUnique(migration: string, table: string, columns: string[]) {
  const quoted = columns.map((column) => `"${column}"`).join("\\s*,\\s*");
  expect(migration, `${table} must uniquely identify ${columns.join(",")}`).toMatch(
    new RegExp(
      `(?:ALTER TABLE "${table}"(?:(?!;)[\\s\\S])*?UNIQUE\\s*\\(${quoted}\\)|` +
        `CREATE UNIQUE INDEX[^;]*ON "${table}"\\s*\\(${quoted}\\))`,
      "u"
    )
  );
}

function expectPartialUnique(
  migration: string,
  table: string,
  columns: string[],
  predicate: string
) {
  const quoted = columns.map((column) => `"${column}"`).join("\\s*,\\s*");
  expect(
    migration,
    `${table} must use a table-scoped partial unique index for ${columns.join(",")}`
  ).toMatch(
    new RegExp(
      `CREATE UNIQUE INDEX[^;]*ON "${table}"\\s*\\(${quoted}\\)\\s+WHERE\\s+${predicate}`,
      "iu"
    )
  );
}

function expectPrismaModelContains(schema: string, model: string, fragment: string) {
  const start = schema.indexOf(`model ${model} {`);
  expect(start, `Prisma must declare ${model}`).toBeGreaterThanOrEqual(0);
  const end = schema.indexOf("\n}", start);
  expect(end, `Prisma model ${model} must close`).toBeGreaterThan(start);
  expect(schema.slice(start, end), `${model} must include ${fragment}`).toContain(fragment);
}

function sqlWithoutComments(migration: string) {
  return migration.replace(/--[^\n]*/gu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
}

function expectFunctionBody(migration: string, name: string) {
  const match = new RegExp(
    `CREATE OR REPLACE FUNCTION "${name}"\\([^)]*\\)[\\s\\S]*?AS \\\$\\$([\\s\\S]*?)\\$\\$ LANGUAGE`,
    "u"
  ).exec(sqlWithoutComments(migration));
  expect(match?.[1], `migration must define executable ${name}()`).toBeTruthy();
  return match?.[1] ?? "";
}

describe("APM-081 PostgreSQL migration contract", () => {
  it("adds migration 59 with only the six frozen test-batch fact relationships", () => {
    const migration = requireMigration();
    if (!migration) return;

    expect(migration).toMatch(/^BEGIN;/u);
    expect(migration).toMatch(/COMMIT;\s*$/u);
    for (const table of Object.values(tableNames)) expectTable(migration, table);
    expect(migration).not.toContain('CREATE TABLE "project_uph_test_batch_module_quality_counts"');
    expect(migration).not.toContain('CREATE TABLE "project_uph_test_batch_cycle_samples"');
    expect(migration).toContain("UphTestBatchRevisionStatus");
    expect(migration).toContain("current_work_revision_id");
    expect(migration).toContain("current_locked_revision_id");
    expect(migration).toContain("supersedes_revision_id");
  });

  it("uses project-scoped composite FKs and uniques for each named relationship", () => {
    const migration = requireMigration();
    if (!migration) return;
    const apm080Migration = requireApm080Migration();

    expectCompositeForeignKey(
      migration,
      tableNames.root,
      ["current_work_revision_id", "project_id"],
      tableNames.revision,
      ["id", "project_id"]
    );
    expectCompositeForeignKey(
      migration,
      tableNames.root,
      ["current_locked_revision_id", "project_id"],
      tableNames.revision,
      ["id", "project_id"]
    );
    expectCompositeForeignKey(
      migration,
      tableNames.revision,
      ["batch_id", "project_id"],
      tableNames.root,
      ["id", "project_id"]
    );
    expectCompositeForeignKey(
      migration,
      tableNames.revision,
      ["supersedes_revision_id", "project_id"],
      tableNames.revision,
      ["id", "project_id"]
    );
    expectCompositeForeignKey(
      migration,
      tableNames.revision,
      ["topology_version_id", "project_id"],
      "project_uph_topology_versions",
      ["id", "project_id"]
    );
    expectCompositeForeignKey(
      migration,
      tableNames.revision,
      ["topology_root_node_id", "topology_version_id"],
      "project_uph_topology_nodes",
      ["id", "topology_version_id"]
    );
    expectCompositeForeignKey(
      migration,
      tableNames.revision,
      ["formula_version_id", "project_id"],
      "project_uph_formula_versions",
      ["id", "project_id"]
    );
    expectCompositeForeignKey(
      migration,
      tableNames.binding,
      ["revision_id", "project_id"],
      tableNames.revision,
      ["id", "project_id"]
    );
    expectCompositeForeignKey(
      migration,
      tableNames.binding,
      ["project_module_id", "project_id"],
      "project_modules",
      ["id", "project_id"]
    );
    expectCompositeForeignKey(
      migration,
      tableNames.binding,
      ["ct_version_id", "ct_definition_id", "project_id"],
      "project_uph_ct_definition_versions",
      ["id", "ct_definition_id", "project_id"]
    );
    expectCompositeForeignKey(
      migration,
      tableNames.production,
      ["revision_id", "project_id"],
      tableNames.revision,
      ["id", "project_id"]
    );
    expectCompositeForeignKey(
      migration,
      tableNames.evidence,
      ["sample_id", "revision_id", "project_id"],
      tableNames.sample,
      ["id", "revision_id", "project_id"]
    );
    expectCompositeForeignKey(
      migration,
      tableNames.sample,
      ["module_binding_id", "revision_id", "project_id"],
      tableNames.binding,
      ["id", "revision_id", "project_id"]
    );
    expectCompositeForeignKey(
      migration,
      tableNames.sample,
      ["correction_of_sample_id", "revision_id", "project_id"],
      tableNames.sample,
      ["id", "revision_id", "project_id"]
    );
    expectCompositeForeignKey(
      migration,
      tableNames.evidence,
      ["revision_id", "project_id"],
      tableNames.revision,
      ["id", "project_id"]
    );
    expectUnique(apm080Migration, "project_uph_topology_nodes", ["id", "topology_version_id"]);
    expectUnique(migration, "project_uph_ct_definition_versions", [
      "id",
      "ct_definition_id",
      "project_id"
    ]);
    expectCompositeForeignKey(
      migration,
      tableNames.evidence,
      ["file_object_id", "project_id"],
      "file_objects",
      ["id", "project_id"]
    );
    expectUnique(migration, tableNames.root, ["id", "project_id"]);
    expectUnique(migration, tableNames.revision, ["id", "project_id"]);
    expectUnique(migration, tableNames.binding, ["id", "revision_id", "project_id"]);
    expectUnique(migration, tableNames.sample, ["id", "revision_id", "project_id"]);
    expectUnique(migration, tableNames.root, ["project_id", "batch_number"]);
    expectUnique(migration, tableNames.revision, ["batch_id", "revision_number", "project_id"]);
    expectUnique(migration, tableNames.binding, ["revision_id", "project_module_id", "project_id"]);
    expectUnique(migration, tableNames.sample, ["module_binding_id", "ordinal", "project_id"]);
    expectUnique(migration, tableNames.revision, ["supersedes_revision_id"]);
    expectUnique(migration, tableNames.production, ["revision_id", "project_id"]);
    expectPartialUnique(
      migration,
      tableNames.sample,
      ["module_binding_id", "source_event_id", "project_id"],
      '"source_event_id" IS NOT NULL'
    );
    expectPartialUnique(
      migration,
      tableNames.sample,
      ["correction_of_sample_id"],
      '"correction_of_sample_id" IS NOT NULL'
    );
  });

  it("uses deferred pointer and successor guards instead of a second state machine", () => {
    const migration = requireMigration();
    if (!migration) return;

    expect(migration).toMatch(
      /current_work_revision_id\s+IS\s+NULL\s+OR\s+current_work_revision_id\s*<>\s*current_locked_revision_id/iu
    );
    expectPartialUnique(
      migration,
      tableNames.revision,
      ["project_id", "batch_id"],
      "status IN \\('DRAFT', 'PM_CONFIRMED'\\)"
    );
    expectPartialUnique(
      migration,
      tableNames.revision,
      ["project_id", "batch_id"],
      "status = 'LOCKED'"
    );
    expectPartialUnique(
      migration,
      tableNames.revision,
      ["project_id", "batch_id"],
      '"supersedes_revision_id" IS NULL'
    );
    for (const guard of [
      "project_uph_test_batch_pointer_commit_guard",
      "project_uph_test_batch_revision_successor_guard"
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE CONSTRAINT TRIGGER "${guard}"[\\s\\S]*?DEFERRABLE INITIALLY DEFERRED`,
          "u"
        )
      );
    }
    expect(migration).toContain("current work revision must be DRAFT or PM_CONFIRMED");
    expect(migration).toContain("current locked revision must be LOCKED");
    expect(migration).toContain("SUPERSEDED revision must have exactly one successor");
  });

  it("requires binding integrity, checksum reconstruction, immutable facts, and delete/truncate rejection", () => {
    const migration = requireMigration();
    if (!migration) return;

    for (const fragment of [
      "topology_version_id",
      "formula_version_id",
      "ct_version_id",
      "confirmed_input_snapshot_json",
      "confirmed_input_checksum",
      "statistics_snapshot_json",
      "statistics_checksum",
      "locked_snapshot_json",
      "locked_checksum",
      "project_uph_test_batch_binding_guard",
      "project_uph_test_batch_revision_checksum_guard",
      "project_uph_test_batch_revision_immutable_guard",
      "project_uph_test_batch_reject_delete",
      "project_uph_test_batch_reject_truncate",
      "project_uph_test_batch_validate_evidence_file"
    ]) {
      expect(migration, `migration must include ${fragment}`).toContain(fragment);
    }
    expect(migration).toMatch(/rebuild.*confirmed.*snapshot|confirmed.*snapshot.*rebuild/iu);
    expect(migration).toMatch(/rebuild.*statistics.*snapshot|statistics.*snapshot.*rebuild/iu);
    expect(migration).toMatch(/TRUNCATE[\s\S]*55000/iu);
  });

  it("declares six Prisma relations and the three dedicated project permission codes", () => {
    const schema = readFileSync(schemaPath, "utf8");
    const permissions = readFileSync(permissionsPath, "utf8");
    const authorization = readFileSync(authorizationPath, "utf8");

    for (const model of [
      "ProjectUphTestBatch",
      "ProjectUphTestBatchRevision",
      "ProjectUphTestBatchRevisionModuleBinding",
      "ProjectUphTestBatchRevisionProductionCount",
      "ProjectUphModuleCycleSample",
      "ProjectUphTestBatchRevisionEvidence"
    ]) {
      expect(schema.includes(`model ${model}`), `Prisma must declare ${model}`).toBe(true);
    }
    expectPrismaModelContains(
      schema,
      "ProjectUphCtDefinitionVersion",
      "@@unique([id, ctDefinitionId, projectId])"
    );
    expectPrismaModelContains(
      schema,
      "ProjectUphTestBatchRevision",
      "fields: [topologyRootNodeId, topologyVersionId], references: [id, topologyVersionId]"
    );
    expectPrismaModelContains(
      schema,
      "ProjectUphTestBatchRevision",
      "fields: [supersedesRevisionId, projectId], references: [id, projectId]"
    );
    expectPrismaModelContains(
      schema,
      "ProjectUphTestBatchRevisionModuleBinding",
      "fields: [ctVersionId, ctDefinitionId, projectId], references: [id, ctDefinitionId, projectId]"
    );
    expectPrismaModelContains(
      schema,
      "ProjectUphTestBatchRevisionProductionCount",
      "fields: [revisionId, projectId], references: [id, projectId]"
    );
    for (const permission of [
      "PROJECT_UPH_BATCH_MANAGE",
      "PROJECT_UPH_BATCH_CONFIRM",
      "PROJECT_UPH_BATCH_LOCK"
    ]) {
      expect(permissions.includes(permission), `permissions must declare ${permission}`).toBe(true);
      expect(authorization.includes(permission), `authorization must map ${permission}`).toBe(true);
    }
  });

  it("routes deferred guards by table and preserves both replacement and locked-correction lineage", () => {
    const migration = requireMigration();
    if (!migration) return;

    const bindingGuard = expectFunctionBody(migration, "project_uph_test_batch_binding_guard");
    const pointerGuard = expectFunctionBody(
      migration,
      "project_uph_test_batch_pointer_commit_guard"
    );
    const successorGuard = expectFunctionBody(
      migration,
      "project_uph_test_batch_revision_successor_guard"
    );
    const revisionGuard = expectFunctionBody(
      migration,
      "project_uph_test_batch_revision_immutable_guard"
    );

    expect(bindingGuard).toContain("TG_TABLE_NAME");
    expect(bindingGuard).toContain("project_uph_test_batch_revisions");
    expect(bindingGuard).toContain("project_uph_test_batch_revision_module_bindings");
    expect(bindingGuard).toContain('IF revision_row."supersedes_revision_id" IS NULL THEN');
    expect(bindingGuard).toContain("IF TG_OP = 'INSERT' AND NOT EXISTS");
    expect(bindingGuard).toContain("ELSE\n    SELECT * INTO predecessor_row");
    expect(bindingGuard).toContain(`revision_row."status" IN ('DRAFT', 'PM_CONFIRMED')`);
    expect(bindingGuard).toContain("UPH binding statistics must be null before LOCKED facts exist");
    expect(pointerGuard).toContain("TG_TABLE_NAME");
    expect(pointerGuard).toContain("revision_id_value");
    expect(pointerGuard).toContain('WHERE "id" = revision_id_value');
    expect(revisionGuard).toContain("NEW.\"status\" = 'SUPERSEDED'");
    expect(revisionGuard).toContain("PM_CONFIRMED replacement must retain PM facts only");
    expect(successorGuard).toContain("WITH RECURSIVE lineage");
    expect(successorGuard).toContain(
      "locked predecessor lineage must end at the current LOCKED revision"
    );
  });

  it("persists and rebuilds the complete frozen source, plan, protocol, responsibility, sample, and statistics facts", () => {
    const migration = requireMigration();
    if (!migration) return;
    const schema = readFileSync(schemaPath, "utf8");
    const checksumGuard = expectFunctionBody(
      migration,
      "project_uph_test_batch_revision_checksum_guard"
    );
    const sourceSnapshot = expectFunctionBody(migration, "uph_test_batch_source_binding_snapshot");
    const statisticsSnapshot = expectFunctionBody(migration, "uph_test_batch_statistics_snapshot");
    const rebuiltStatistics = expectFunctionBody(
      migration,
      "uph_test_batch_rebuilt_module_statistics"
    );
    const responsibilityGuard = expectFunctionBody(
      migration,
      "project_uph_test_batch_responsibility_guard"
    );

    for (const fragment of [
      '"plan_snapshot_json" JSONB NOT NULL',
      '"plan_checksum" TEXT NOT NULL',
      '"plan_declared_at" TIMESTAMPTZ(3) NOT NULL',
      '"ct_source_snapshot_json" JSONB NOT NULL',
      '"ct_source_checksum" TEXT NOT NULL',
      '"ct_source_watermark" TEXT NOT NULL',
      '"recorded_at" TIMESTAMPTZ(3) NOT NULL',
      '"captured_by_membership_id" TEXT NOT NULL',
      '"captured_by_snapshot_json" JSONB NOT NULL',
      '"captured_by_checksum" TEXT NOT NULL',
      '"observation_started_at" TIMESTAMPTZ(3) NOT NULL',
      '"observation_ended_at" TIMESTAMPTZ(3)'
    ]) {
      expect(sqlWithoutComments(migration), `migration must persist ${fragment}`).toContain(
        fragment
      );
    }
    for (const protocolField of [
      "secondsPerCycle",
      "decimalScale",
      "HALF_UP",
      "MANUAL_ENTRY",
      "DEVICE_EVENT",
      "arithmeticMean",
      "maximum",
      "R-7",
      "P90_MINUS_P50"
    ]) {
      expect(
        checksumGuard,
        `UPH_TEST_PROTOCOL@1 must canonically include ${protocolField}`
      ).toContain(protocolField);
    }
    for (const sourceField of [
      "topologySnapshot",
      "topologyChecksum",
      "topologyWatermark",
      "formulaSnapshot",
      "formulaChecksum",
      "formulaWatermark",
      "ctSnapshot",
      "ctChecksum",
      "ctWatermark"
    ]) {
      expect(sourceSnapshot, `source rebuild must include ${sourceField}`).toContain(sourceField);
    }
    expect(statisticsSnapshot).toContain("uph_test_batch_rebuilt_module_statistics");
    expect(rebuiltStatistics).toContain("WITH ordered_samples");
    expect(rebuiltStatistics).toContain("percentile_rank");
    expect(rebuiltStatistics).toContain("spread_raw");
    expect(responsibilityGuard).toContain('member."user_id"');
    expect(responsibilityGuard).toContain('member."project_role"');
    expect(responsibilityGuard).toContain('member."left_at" IS NULL');
    expectPrismaModelContains(schema, "ProjectUphTestBatchRevision", "processOwnerMembership");
    expectPrismaModelContains(schema, "ProjectUphTestBatchRevision", "pmConfirmerMembership");
    expectPrismaModelContains(schema, "ProjectUphTestBatchRevision", "qualityLockerMembership");
    expectPrismaModelContains(schema, "ProjectUphModuleCycleSample", "capturedByMembership");
    expectPrismaModelContains(schema, "ProjectUphTestBatchRevision", "createdBy");
  });

  it("uses database guards for root versions, draft-only creation, successor clearing, and append-only correction", () => {
    const migration = requireMigration();
    if (!migration) return;

    const rootGuard = expectFunctionBody(migration, "project_uph_test_batch_root_immutable_guard");
    const revisionInsertGuard = expectFunctionBody(
      migration,
      "project_uph_test_batch_revision_insert_guard"
    );
    const sampleGuard = expectFunctionBody(migration, "project_uph_test_batch_sample_append_guard");
    const successorGuard = expectFunctionBody(
      migration,
      "project_uph_test_batch_revision_successor_guard"
    );

    expect(rootGuard).toContain('NEW."resource_version" <> OLD."resource_version" + 1');
    expect(rootGuard).toContain("TG_OP = 'INSERT' AND NEW.\"resource_version\" <> 1");
    expect(rootGuard).toContain('NEW."batch_number" IS DISTINCT FROM OLD."batch_number"');
    expect(revisionInsertGuard).toContain("NEW.\"status\" <> 'DRAFT'");
    expect(sampleGuard).toContain("MANUAL_ENTRY_CORRECTION");
    expect(sampleGuard).toContain(
      "UPH sample capture responsibility snapshot/checksum must be immutable"
    );
    expect(sampleGuard).toContain('successor."supersedes_revision_id"');
    expect(sampleGuard).toContain('predecessor."batch_id" = successor."batch_id"');
    expect(sampleGuard).toContain(
      'successor."revision_number" = predecessor."revision_number" + 1'
    );
    expect(sampleGuard).toContain(
      'predecessor_binding."project_module_id" = successor_binding."project_module_id"'
    );
    for (const frozenCaptureFact of [
      'predecessor_sample."recorded_at" IS NOT DISTINCT FROM NEW."recorded_at"',
      'predecessor_sample."captured_by_membership_id" IS NOT DISTINCT FROM NEW."captured_by_membership_id"',
      'predecessor_sample."captured_by_user_id" IS NOT DISTINCT FROM NEW."captured_by_user_id"',
      'predecessor_sample."captured_by_role" IS NOT DISTINCT FROM NEW."captured_by_role"',
      'predecessor_sample."captured_by_snapshot_json" IS NOT DISTINCT FROM NEW."captured_by_snapshot_json"',
      'predecessor_sample."captured_by_checksum" IS NOT DISTINCT FROM NEW."captured_by_checksum"',
      'predecessor_sample."cycle_duration_seconds" IS NOT DISTINCT FROM NEW."cycle_duration_seconds"',
      'predecessor_sample."observed_at" IS NOT DISTINCT FROM NEW."observed_at"',
      'predecessor_sample."source_event_id" IS NOT DISTINCT FROM NEW."source_event_id"'
    ]) {
      expect(sampleGuard).toContain(frozenCaptureFact);
    }
    expect(sampleGuard).toContain('member."left_at" IS NULL');
    expect(sampleGuard).toContain("actor.\"status\" = 'ACTIVE'");
    expect(sampleGuard).toContain('NEW."correction_of_sample_id" IS NOT NULL');
    expect(sampleGuard).toContain("manual correction must append next ordinal");
    expect(sampleGuard).toContain(
      "cycle duration, observation, capture, and source event are immutable"
    );
    expect(revisionInsertGuard).toContain(
      "successor must clear PM, QUALITY, checksum, and binding statistics facts"
    );
    expect(sqlWithoutComments(migration)).toMatch(
      /BEFORE INSERT OR UPDATE OR DELETE ON "project_uph_test_batches"[\s\S]*?project_uph_test_batch_root_immutable_guard/iu
    );
  });

  it("keeps plan declaration, historical responsibilities, correction order, lineage, and native timestamps exact", () => {
    const migration = requireMigration();
    if (!migration) return;
    const sql = sqlWithoutComments(migration);
    const schema = readFileSync(schemaPath, "utf8");
    const planSnapshot = expectFunctionBody(migration, "uph_test_batch_plan_snapshot");
    const confirmedInput = expectFunctionBody(migration, "uph_test_batch_confirmed_input_snapshot");
    const responsibilityGuard = expectFunctionBody(
      migration,
      "project_uph_test_batch_responsibility_guard"
    );
    const sampleGuard = expectFunctionBody(migration, "project_uph_test_batch_sample_append_guard");
    const revisionInsertGuard = expectFunctionBody(
      migration,
      "project_uph_test_batch_revision_insert_guard"
    );
    const successorGuard = expectFunctionBody(
      migration,
      "project_uph_test_batch_revision_successor_guard"
    );
    const checksumGuard = expectFunctionBody(
      migration,
      "project_uph_test_batch_revision_checksum_guard"
    );

    for (const planField of [
      "planDeclarationReason",
      "plannedProductionSeconds",
      "planDeclaredAt",
      "processOwnerMembershipId",
      "processOwnerUserId",
      "processOwnerRole"
    ]) {
      expect(planSnapshot).toContain(planField);
    }
    expect(planSnapshot).not.toContain("observationStartedAt");
    expect(confirmedInput).toContain("planSnapshotJson");
    expect(confirmedInput).toContain("planChecksum");
    expect(confirmedInput).toContain("observationWindow");
    expect(confirmedInput).toContain("observationStartedAt");

    expect(responsibilityGuard).toContain("IF TG_OP = 'INSERT' THEN");
    expect(responsibilityGuard).toContain('NEW."created_by_id"');
    expect(responsibilityGuard).toContain('NEW."created_at"');
    expect(responsibilityGuard).not.toContain('NEW."plan_declared_at"');
    for (const factBranch of [
      'OLD."pm_confirmer_membership_id" IS NULL',
      'NEW."pm_confirmer_membership_id" IS NOT NULL',
      'OLD."quality_locker_membership_id" IS NULL',
      'NEW."quality_locker_membership_id" IS NOT NULL'
    ]) {
      expect(responsibilityGuard).toContain(factBranch);
    }
    expect(responsibilityGuard).toContain('member."left_at" IS NULL');
    expect(responsibilityGuard).toContain("actor.\"status\" = 'ACTIVE'");
    expect(responsibilityGuard).toContain('NEW."process_owner_snapshot_json"');
    expect(responsibilityGuard).not.toContain('revision_row."process_owner');

    expect(sampleGuard).toContain("NEW.\"capture_method\" <> 'MANUAL_ENTRY'");
    expect(sampleGuard).toContain("NEW.\"disposition\" <> 'INCLUDED'");
    expect(sampleGuard).toContain('NEW."exclusion_reason_code" IS NOT NULL');
    expect(sampleGuard).toContain('NEW."source_event_id" IS NOT NULL');
    expect(sampleGuard).toContain('min(existing."ordinal")');
    expect(sampleGuard).toContain("count(*)");
    expect(sampleGuard).toContain("continuous sequence starting at one");

    expect(revisionInsertGuard).toContain('NEW."supersedes_revision_id" IS NULL');
    expect(revisionInsertGuard).toContain('NEW."revision_number" <> 1');
    expect(revisionInsertGuard).toContain('predecessor."batch_id" <> NEW."batch_id"');
    expect(revisionInsertGuard).toContain('predecessor."revision_number" + 1');
    expect(successorGuard).toContain('predecessor_row."quality_locker_membership_id" IS NULL');
    expect(successorGuard).toContain("predecessor with no QUALITY fact must be SUPERSEDED");
    expect(successorGuard).toContain("terminal_row.\"status\" IN ('DRAFT', 'PM_CONFIRMED')");
    expect(successorGuard).toContain("predecessor_row.\"status\" <> 'LOCKED'");
    expect(successorGuard).toContain(
      'batch_row."current_locked_revision_id" IS DISTINCT FROM predecessor_row."id"'
    );
    expect(successorGuard).toContain("terminal_row.\"status\" = 'LOCKED'");
    expect(successorGuard).toContain("predecessor_row.\"status\" <> 'SUPERSEDED'");
    expect(successorGuard).toContain(
      'batch_row."current_locked_revision_id" IS DISTINCT FROM terminal_row."id"'
    );
    expect(successorGuard).toContain(
      'batch_row."current_work_revision_id" IS DISTINCT FROM terminal_row."id"'
    );
    expect(checksumGuard).toContain("eligibleForStatistics");
    expect(checksumGuard).toContain("disposition=INCLUDED");

    for (const timestamp of [
      '"created_at" TIMESTAMPTZ(3)',
      '"updated_at" TIMESTAMPTZ(3)',
      '"plan_declared_at" TIMESTAMPTZ(3)',
      '"observation_started_at" TIMESTAMPTZ(3)',
      '"observation_ended_at" TIMESTAMPTZ(3)',
      '"pm_confirmed_at" TIMESTAMPTZ(3)',
      '"locked_at" TIMESTAMPTZ(3)',
      '"observed_at" TIMESTAMPTZ(3)',
      '"recorded_at" TIMESTAMPTZ(3)'
    ]) {
      expect(sql).toContain(timestamp);
    }
    expectPrismaModelContains(schema, "ProjectUphTestBatch", "@db.Timestamptz(3)");
    expectPrismaModelContains(schema, "ProjectUphTestBatchRevisionEvidence", "@db.Timestamptz(3)");
    expect(sql).toContain('"purpose" "UphTestBatchEvidencePurpose",');
    expect(sql).not.toContain('"purpose" "UphTestBatchEvidencePurpose" NOT NULL');
    expectPrismaModelContains(
      schema,
      "ProjectUphTestBatchRevisionEvidence",
      "purpose      UphTestBatchEvidencePurpose?"
    );
    expectPrismaModelContains(
      schema,
      "ProjectUphTestBatchRevision",
      '@relation("UphTestBatchRevisionCreatedBy", fields: [createdById], references: [id], onDelete: Restrict)'
    );
    expectPrismaModelContains(schema, "User", "uphTestBatchCreatedRevisions");
  });
});
