import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_VALUES,
  AUDIT_OBJECT_TYPES,
  AUDIT_OBJECT_TYPE_VALUES,
  DELIVERY_UNIT_STAGE_AUDIT_FIELDS,
  GATE_APPROVAL_AUDIT_FIELDS,
  GATE_SUBMISSION_AUDIT_FIELDS,
  PROCUREMENT_AUDIT_FIELDS,
  ACCEPTANCE_AUDIT_FIELDS,
  PROJECT_STAGE_AUDIT_FIELDS,
  STAGE_RELEASE_AUTHORIZATION_AUDIT_FIELDS
} from "./vocabulary";

describe("stage audit vocabulary", () => {
  it("keeps stage audit declarations aligned across Prisma, the append migration, and field allowlists", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migrationPath = resolve(
      process.cwd(),
      "prisma/migrations/20260804020000_apm_030_stage_invariants/migration.sql"
    );
    const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

    expect(AUDIT_ACTIONS).toMatchObject({
      PROJECT_STAGE_CREATED: "PROJECT_STAGE_CREATED",
      PROJECT_STAGE_UPDATED: "PROJECT_STAGE_UPDATED",
      DELIVERY_UNIT_STAGE_UPDATED: "DELIVERY_UNIT_STAGE_UPDATED",
      STAGE_RELEASE_AUTHORIZED: "STAGE_RELEASE_AUTHORIZED",
      STAGE_RELEASE_REVOKED: "STAGE_RELEASE_REVOKED"
    });
    expect(AUDIT_OBJECT_TYPES).toMatchObject({
      PROJECT_STAGE: "PROJECT_STAGE",
      DELIVERY_UNIT_STAGE: "DELIVERY_UNIT_STAGE",
      STAGE_RELEASE_AUTHORIZATION: "STAGE_RELEASE_AUTHORIZATION"
    });
    expect(PROJECT_STAGE_AUDIT_FIELDS).toEqual([
      "projectId",
      "projectStageId",
      "sourceSnapshotComponentId",
      "code",
      "name",
      "description",
      "sequence",
      "status",
      "exceptionalReason",
      "statusChangedAt",
      "version"
    ]);
    expect(DELIVERY_UNIT_STAGE_AUDIT_FIELDS).toEqual([
      "projectId",
      "deliveryUnitStageId",
      "deliveryUnitId",
      "projectStageId",
      "status",
      "exceptionalReason",
      "statusChangedAt",
      "version"
    ]);
    expect(STAGE_RELEASE_AUTHORIZATION_AUDIT_FIELDS).toEqual([
      "projectId",
      "stageReleaseAuthorizationId",
      "scope",
      "status",
      "fromProjectStageId",
      "toProjectStageId",
      "deliveryUnitId",
      "reason",
      "authorizedById",
      "authorizedAt",
      "revokedById",
      "revokedAt",
      "revocationReason",
      "version"
    ]);

    for (const value of [
      "PROJECT_STAGE_CREATED",
      "PROJECT_STAGE_UPDATED",
      "DELIVERY_UNIT_STAGE_UPDATED",
      "STAGE_RELEASE_AUTHORIZED",
      "STAGE_RELEASE_REVOKED",
      "PROJECT_STAGE",
      "DELIVERY_UNIT_STAGE",
      "STAGE_RELEASE_AUTHORIZATION"
    ]) {
      expect(schema).toContain(value);
      expect(migration).toContain(`ADD VALUE '${value}'`);
    }
  });
});

describe("procurement change impact audit vocabulary", () => {
  it("keeps detected impacts, disposition evidence, and resolved impacts auditable", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260807040200_apm_091b_procurement_change_impacts/migration.sql"
      ),
      "utf8"
    );

    expect(AUDIT_ACTIONS).toMatchObject({
      PROCUREMENT_CHANGE_IMPACT_DETECTED: "PROCUREMENT_CHANGE_IMPACT_DETECTED",
      PROCUREMENT_CHANGE_IMPACT_EVIDENCE_RECORDED: "PROCUREMENT_CHANGE_IMPACT_EVIDENCE_RECORDED",
      PROCUREMENT_CHANGE_IMPACT_RESOLVED: "PROCUREMENT_CHANGE_IMPACT_RESOLVED"
    });
    expect(AUDIT_OBJECT_TYPES).toMatchObject({
      PROCUREMENT_CHANGE_IMPACT: "PROCUREMENT_CHANGE_IMPACT",
      PROCUREMENT_CHANGE_IMPACT_RESOLUTION: "PROCUREMENT_CHANGE_IMPACT_RESOLUTION"
    });
    expect(PROCUREMENT_AUDIT_FIELDS).toEqual(
      expect.arrayContaining([
        "procurementChangeImpactId",
        "previousRevisionId",
        "nextRevisionId",
        "changedFields",
        "obligationId",
        "disposition",
        "evidenceReference"
      ])
    );
    for (const value of [
      "PROCUREMENT_CHANGE_IMPACT_DETECTED",
      "PROCUREMENT_CHANGE_IMPACT_EVIDENCE_RECORDED",
      "PROCUREMENT_CHANGE_IMPACT_RESOLVED",
      "PROCUREMENT_CHANGE_IMPACT",
      "PROCUREMENT_CHANGE_IMPACT_RESOLUTION"
    ]) {
      expect(schema).toContain(value);
      expect(migration).toContain("ADD VALUE IF NOT EXISTS '" + value + "'");
    }
  });
});

describe("acceptance audit vocabulary", () => {
  it("keeps APM-100 immutable template, batch, result and evidence facts aligned", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260809020000_apm_100_acceptance_foundation/migration.sql"
      ),
      "utf8"
    );

    expect(AUDIT_ACTIONS).toMatchObject({
      ACCEPTANCE_TEMPLATE_PUBLISHED: "ACCEPTANCE_TEMPLATE_PUBLISHED",
      ACCEPTANCE_BATCH_CREATED: "ACCEPTANCE_BATCH_CREATED",
      ACCEPTANCE_BATCH_STARTED: "ACCEPTANCE_BATCH_STARTED",
      ACCEPTANCE_BATCH_LOCKED: "ACCEPTANCE_BATCH_LOCKED",
      ACCEPTANCE_RESULT_RECORDED: "ACCEPTANCE_RESULT_RECORDED",
      ACCEPTANCE_RESULT_CORRECTED: "ACCEPTANCE_RESULT_CORRECTED",
      ACCEPTANCE_EVIDENCE_REFERENCED: "ACCEPTANCE_EVIDENCE_REFERENCED"
    });
    expect(AUDIT_OBJECT_TYPES).toMatchObject({
      ACCEPTANCE_TEMPLATE_VERSION: "ACCEPTANCE_TEMPLATE_VERSION",
      ACCEPTANCE_BATCH: "ACCEPTANCE_BATCH",
      ACCEPTANCE_TEST_RESULT_REVISION: "ACCEPTANCE_TEST_RESULT_REVISION"
    });
    expect(ACCEPTANCE_AUDIT_FIELDS).toEqual(
      expect.arrayContaining([
        "projectId",
        "templateVersionId",
        "batchId",
        "resultRevisionId",
        "evidenceFileId",
        "version"
      ])
    );
    for (const value of [
      "ACCEPTANCE_TEMPLATE_PUBLISHED",
      "ACCEPTANCE_BATCH_CREATED",
      "ACCEPTANCE_BATCH_STARTED",
      "ACCEPTANCE_BATCH_LOCKED",
      "ACCEPTANCE_RESULT_RECORDED",
      "ACCEPTANCE_RESULT_CORRECTED",
      "ACCEPTANCE_EVIDENCE_REFERENCED",
      "ACCEPTANCE_TEMPLATE_VERSION",
      "ACCEPTANCE_BATCH",
      "ACCEPTANCE_TEST_RESULT_REVISION"
    ]) {
      expect(schema).toContain(value);
      expect(migration).toContain(`ADD VALUE IF NOT EXISTS '${value}'`);
    }
  });
});

describe("Gate audit vocabulary", () => {
  it("keeps APM-031 Gate facts aligned across Prisma and the foundation migration", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260804030000_apm_031_gate_foundation/migration.sql"
      ),
      "utf8"
    );

    for (const value of [
      "GATE_DEFINITION_MATERIALIZED",
      "GATE_INSTANCE_CREATED",
      "GATE_CHECK_RUN_COMPLETED",
      "PROJECT_GATE_DEFINITION",
      "PROJECT_GATE_INSTANCE",
      "GATE_CHECK_SNAPSHOT"
    ]) {
      expect(schema).toContain(value);
      expect(migration).toContain(`ADD VALUE '${value}'`);
    }
  });

  it("keeps APM-032 submission and approval facts aligned across Prisma, migration, and allowlists", () => {
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260804040000_apm_032_gate_submissions/migration.sql"
      ),
      "utf8"
    );

    expect(AUDIT_ACTIONS).toMatchObject({
      GATE_SUBMISSION_SUBMITTED: "GATE_SUBMISSION_SUBMITTED",
      GATE_APPROVAL_RECORDED: "GATE_APPROVAL_RECORDED",
      GATE_SUBMISSION_WITHDRAWN: "GATE_SUBMISSION_WITHDRAWN",
      GATE_SUBMISSION_APPROVED: "GATE_SUBMISSION_APPROVED",
      GATE_SUBMISSION_REJECTED: "GATE_SUBMISSION_REJECTED"
    });
    expect(AUDIT_OBJECT_TYPES).toMatchObject({
      GATE_SUBMISSION: "GATE_SUBMISSION",
      GATE_APPROVAL: "GATE_APPROVAL"
    });
    expect(GATE_SUBMISSION_AUDIT_FIELDS).toContain("approverUserIds");
    expect(GATE_SUBMISSION_AUDIT_FIELDS).toContain("gateCheckSnapshotId");
    expect(GATE_APPROVAL_AUDIT_FIELDS).toEqual([
      "projectId",
      "gateSubmissionId",
      "gateApprovalId",
      "gateSubmissionApproverId",
      "decision",
      "decidedById",
      "decidedAt",
      "status",
      "version"
    ]);

    for (const value of [
      "GATE_SUBMISSION_SUBMITTED",
      "GATE_APPROVAL_RECORDED",
      "GATE_SUBMISSION_WITHDRAWN",
      "GATE_SUBMISSION_APPROVED",
      "GATE_SUBMISSION_REJECTED",
      "GATE_SUBMISSION",
      "GATE_APPROVAL"
    ]) {
      expect(schema).toContain(value);
      expect(migration).toContain(`ADD VALUE '${value}'`);
    }
  });
});

describe("APM-104 retrospective and knowledge audit vocabulary", () => {
  it("declares append-only retrospective, closure and knowledge facts", () => {
    expect(AUDIT_ACTIONS).toMatchObject({
      PROJECT_RETROSPECTIVE_DRAFT_CREATED: "PROJECT_RETROSPECTIVE_DRAFT_CREATED",
      PROJECT_RETROSPECTIVE_SUBMITTED: "PROJECT_RETROSPECTIVE_SUBMITTED",
      PROJECT_RETROSPECTIVE_REVIEWED: "PROJECT_RETROSPECTIVE_REVIEWED",
      PROJECT_CLOSURE_POLICY_UPGRADED: "PROJECT_CLOSURE_POLICY_UPGRADED",
      PROJECT_CLOSURE_RECORD_CREATED: "PROJECT_CLOSURE_RECORD_CREATED",
      KNOWLEDGE_ENTRY_VERSION_CREATED: "KNOWLEDGE_ENTRY_VERSION_CREATED",
      KNOWLEDGE_ENTRY_REVIEWED: "KNOWLEDGE_ENTRY_REVIEWED",
      KNOWLEDGE_ENTRY_PUBLISHED: "KNOWLEDGE_ENTRY_PUBLISHED",
      KNOWLEDGE_REUSE_CONFIRMED: "KNOWLEDGE_REUSE_CONFIRMED",
      KNOWLEDGE_REUSE_CORRECTED: "KNOWLEDGE_REUSE_CORRECTED"
    });
    expect(AUDIT_OBJECT_TYPES).toMatchObject({
      PROJECT_RETROSPECTIVE: "PROJECT_RETROSPECTIVE",
      PROJECT_RETROSPECTIVE_VERSION: "PROJECT_RETROSPECTIVE_VERSION",
      PROJECT_CLOSURE_POLICY_VERSION: "PROJECT_CLOSURE_POLICY_VERSION",
      PROJECT_CLOSURE_RECORD: "PROJECT_CLOSURE_RECORD",
      KNOWLEDGE_ENTRY: "KNOWLEDGE_ENTRY",
      KNOWLEDGE_ENTRY_VERSION: "KNOWLEDGE_ENTRY_VERSION",
      KNOWLEDGE_REUSE_RECORD: "KNOWLEDGE_REUSE_RECORD"
    });
    const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260812010000_apm_104_retrospectives_knowledge_closure_policy/migration.sql"
      ),
      "utf8"
    );
    for (const value of [
      "PROJECT_RETROSPECTIVE_DRAFT_CREATED",
      "PROJECT_RETROSPECTIVE_SUBMITTED",
      "PROJECT_RETROSPECTIVE_REVIEWED",
      "PROJECT_CLOSURE_POLICY_UPGRADED",
      "PROJECT_CLOSURE_RECORD_CREATED",
      "KNOWLEDGE_ENTRY_VERSION_CREATED",
      "KNOWLEDGE_ENTRY_REVIEWED",
      "KNOWLEDGE_ENTRY_PUBLISHED",
      "KNOWLEDGE_REUSE_CONFIRMED",
      "KNOWLEDGE_REUSE_CORRECTED",
      "PROJECT_RETROSPECTIVE",
      "PROJECT_RETROSPECTIVE_VERSION",
      "PROJECT_CLOSURE_POLICY_VERSION",
      "PROJECT_CLOSURE_RECORD",
      "KNOWLEDGE_ENTRY",
      "KNOWLEDGE_ENTRY_VERSION",
      "KNOWLEDGE_REUSE_RECORD"
    ]) {
      expect(schema).toContain(value);
      expect(migration).toContain(`ADD VALUE IF NOT EXISTS '${value}'`);
    }
  });
});

describe("procurement audit vocabulary", () => {
  it("exposes the APM-090A procurement facts without sensitive ERP finance fields", () => {
    expect(AUDIT_ACTIONS).toMatchObject({
      PROCUREMENT_SETTINGS_CONFIGURED: "PROCUREMENT_SETTINGS_CONFIGURED",
      MATERIAL_REFERENCE_CREATED: "MATERIAL_REFERENCE_CREATED",
      SUPPLIER_REFERENCE_CREATED: "SUPPLIER_REFERENCE_CREATED",
      MATERIAL_REQUIREMENT_DRAFTED: "MATERIAL_REQUIREMENT_DRAFTED",
      MATERIAL_REQUIREMENT_CONFIRMED: "MATERIAL_REQUIREMENT_CONFIRMED",
      MATERIAL_REQUIREMENT_REVISED: "MATERIAL_REQUIREMENT_REVISED",
      MATERIAL_REQUIREMENT_CANCELED: "MATERIAL_REQUIREMENT_CANCELED",
      PROCUREMENT_FULFILLMENT_RECORDED: "PROCUREMENT_FULFILLMENT_RECORDED",
      PROCUREMENT_FULFILLMENT_REVERSED: "PROCUREMENT_FULFILLMENT_REVERSED"
    });
    expect(AUDIT_OBJECT_TYPES).toMatchObject({
      PROJECT_PROCUREMENT_SETTINGS: "PROJECT_PROCUREMENT_SETTINGS",
      MATERIAL_REFERENCE: "MATERIAL_REFERENCE",
      SUPPLIER_REFERENCE: "SUPPLIER_REFERENCE",
      PROJECT_MATERIAL_REQUIREMENT: "PROJECT_MATERIAL_REQUIREMENT",
      PROJECT_MATERIAL_REQUIREMENT_REVISION: "PROJECT_MATERIAL_REQUIREMENT_REVISION",
      PROCUREMENT_FULFILLMENT_EVENT: "PROCUREMENT_FULFILLMENT_EVENT"
    });
    expect(AUDIT_ACTION_VALUES).toEqual(
      expect.arrayContaining([
        "PROCUREMENT_SETTINGS_CONFIGURED",
        "MATERIAL_REFERENCE_CREATED",
        "SUPPLIER_REFERENCE_CREATED",
        "MATERIAL_REQUIREMENT_DRAFTED",
        "MATERIAL_REQUIREMENT_CONFIRMED",
        "MATERIAL_REQUIREMENT_REVISED",
        "MATERIAL_REQUIREMENT_CANCELED",
        "PROCUREMENT_FULFILLMENT_RECORDED",
        "PROCUREMENT_FULFILLMENT_REVERSED"
      ])
    );
    expect(AUDIT_OBJECT_TYPE_VALUES).toEqual(
      expect.arrayContaining([
        "PROJECT_PROCUREMENT_SETTINGS",
        "MATERIAL_REFERENCE",
        "SUPPLIER_REFERENCE",
        "PROJECT_MATERIAL_REQUIREMENT",
        "PROJECT_MATERIAL_REQUIREMENT_REVISION",
        "PROCUREMENT_FULFILLMENT_EVENT"
      ])
    );
    expect(PROCUREMENT_AUDIT_FIELDS).toEqual(
      expect.arrayContaining([
        "projectId",
        "materialReferenceId",
        "supplierReferenceId",
        "requirementId",
        "revisionId",
        "quantity",
        "trackingUnit",
        "fulfillmentEventId",
        "eventType",
        "businessOccurredAt",
        "recordedAt",
        "evidenceFileId",
        "reversesEventId",
        "requiredOn",
        "businessType",
        "status",
        "source",
        "version",
        "reason"
      ])
    );
    expect(PROCUREMENT_AUDIT_FIELDS).not.toEqual(
      expect.arrayContaining(["price", "bankAccount", "taxNumber", "payment"])
    );
  });
});
