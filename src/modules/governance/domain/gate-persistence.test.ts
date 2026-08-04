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
  });
});

describe("APM-032 Gate submission persistence contract", () => {
  it("adds immutable submissions, reviewer snapshots, decisions, and lifecycle events", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260804040000_apm_032_gate_submissions/migration.sql"
      ),
      "utf8"
    );

    for (const declaration of [
      "enum GateApprovalMode",
      "enum GateSubmissionStatus",
      "enum GateApprovalDecision",
      "enum GateSubmissionEventType",
      "model GateSubmission",
      "model GateSubmissionApprover",
      "model GateApproval",
      "model GateSubmissionEvent",
      "GATE_SUBMISSION_SUBMITTED",
      "GATE_APPROVAL_RECORDED",
      "GATE_SUBMISSION_WITHDRAWN",
      "GATE_SUBMISSION_APPROVED",
      "GATE_SUBMISSION_REJECTED",
      "GATE_SUBMISSION",
      "GATE_APPROVAL"
    ]) {
      expect(schema).toContain(declaration);
    }

    for (const declaration of [
      'CREATE TABLE "gate_submissions"',
      'CREATE TABLE "gate_submission_approvers"',
      'CREATE TABLE "gate_approvals"',
      'CREATE TABLE "gate_submission_events"',
      "gate_submissions_one_pending_instance_key",
      "CREATE FUNCTION enforce_gate_submission_relation()",
      "CREATE FUNCTION enforce_gate_submission_approver_relation()",
      "CREATE FUNCTION enforce_gate_approval_relation()",
      "CREATE FUNCTION enforce_gate_submission_stability()",
      "CREATE FUNCTION enforce_gate_submission_decision()",
      "CREATE FUNCTION require_gate_submission_approvers()",
      "gate_submission_approvers_reject_mutation",
      "gate_approvals_reject_mutation",
      "gate_submission_events_reject_mutation",
      "gate_submissions_decision_check",
      "gate_submissions_require_approvers",
      "ADD VALUE 'GATE_SUBMISSION_SUBMITTED'",
      "ADD VALUE 'GATE_APPROVAL_RECORDED'",
      "ADD VALUE 'GATE_SUBMISSION_WITHDRAWN'",
      "ADD VALUE 'GATE_SUBMISSION_APPROVED'",
      "ADD VALUE 'GATE_SUBMISSION_REJECTED'"
    ]) {
      expect(migration).toContain(declaration);
    }
  });
});

describe("APM-033 Gate conditional release persistence contract", () => {
  it("adds immutable conditional releases and append-only residual item history", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260804050000_apm_033_gate_conditional_releases/migration.sql"
      ),
      "utf8"
    );

    for (const declaration of [
      "enum ResidualItemStatus",
      "enum ResidualItemEventType",
      "model GateConditionalRelease",
      "model ResidualItem",
      "model ResidualItemEvent",
      "GATE_CONDITIONALLY_RELEASED",
      "RESIDUAL_ITEM_CREATED",
      "RESIDUAL_ITEM_STARTED",
      "RESIDUAL_ITEM_VERIFICATION_SUBMITTED",
      "RESIDUAL_ITEM_VERIFIED",
      "RESIDUAL_ITEM_RETURNED",
      "GATE_CONDITIONAL_RELEASE",
      "RESIDUAL_ITEM"
    ]) {
      expect(schema).toContain(declaration);
    }

    for (const declaration of [
      'CREATE TABLE "gate_conditional_releases"',
      'CREATE TABLE "residual_items"',
      'CREATE TABLE "residual_item_events"',
      "gate_conditional_releases_submission_key",
      "residual_items_release_sequence_key",
      "residual_item_events_item_sequence_key",
      "CREATE FUNCTION enforce_gate_conditional_release_relation()",
      "CREATE FUNCTION enforce_residual_item_relation()",
      "CREATE FUNCTION enforce_residual_item_transition()",
      "CREATE FUNCTION require_conditional_release_residual_items()",
      "conditional_release_requires_approved_submission",
      "conditional_release_requires_residual_items",
      "residual_items_reject_mutation",
      "residual_item_events_reject_mutation",
      "ADD VALUE 'GATE_CONDITIONALLY_RELEASED'",
      "ADD VALUE 'RESIDUAL_ITEM_VERIFIED'"
    ]) {
      expect(migration).toContain(declaration);
    }
  });

  it("keeps the APM-023 baseline and APM-034 prerequisite in CI upgrade coverage", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

    expect(workflow).toContain("Validate APM-023 to APM-070 upgrade migration");
    expect(workflow).toContain("cp -R prisma/migrations/20260804060000_apm_034_alert_governance");
  });
});
