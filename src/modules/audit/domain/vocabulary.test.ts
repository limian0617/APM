import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUDIT_ACTIONS,
  AUDIT_OBJECT_TYPES,
  DELIVERY_UNIT_STAGE_AUDIT_FIELDS,
  GATE_APPROVAL_AUDIT_FIELDS,
  GATE_SUBMISSION_AUDIT_FIELDS,
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
