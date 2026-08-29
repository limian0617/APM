BEGIN;

ALTER TYPE "TechnicalAssetStatus" ADD VALUE IF NOT EXISTS 'DISABLED';
ALTER TYPE "AlertSourceType" ADD VALUE IF NOT EXISTS 'ASSET_IMPACT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TECHNICAL_ASSET_DISABLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_RELEASE_RECALL_ISSUED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_RELEASE_RECALL_REVISED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_RELEASE_RECALL_READ';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_PROJECT_IMPACT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_PROJECT_IMPACT_REFRESHED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_PROJECT_IMPACT_READ';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_PROJECT_IMPACT_DISPOSITION_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_IMPACT_RISK_ACCEPTANCE_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_IMPACT_RISK_ACCEPTANCE_DECIDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_UPGRADE_CANDIDATE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_UPGRADE_CANDIDATE_READ';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_UPGRADE_ADOPTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_IMPACT_ALERT_PROJECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_IMPACT_ALERT_PROJECTION_BLOCKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ASSET_IMPACT_ALERT_PROJECTION_REPLAYED';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ASSET_RELEASE_RECALL';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ASSET_RELEASE_RECALL_REVISION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ASSET_RELEASE_RECALL_AFFECTED_VERSION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ASSET_PROJECT_IMPACT';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ASSET_IMPACT_ASSESSMENT_REVISION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ASSET_IMPACT_DISPOSITION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ASSET_IMPACT_RISK_ACCEPTANCE_REQUEST';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ASSET_IMPACT_RISK_ACCEPTANCE_DECISION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ASSET_UPGRADE_CANDIDATE';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ASSET_UPGRADE_ADOPTION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ASSET_UPGRADE_USAGE_MAPPING';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ASSET_IMPACT_ALERT_PROJECTION_ATTEMPT';

-- Independent risk decisions reuse the APM-063 permissions and are limited
-- to the project roles accepted by the database decision trigger.
INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
  ('role-quality', 'permission-project-asset-usage-manage', 'PROJECT'),
  ('role-department-lead', 'permission-project-asset-usage-read', 'PROJECT'),
  ('role-department-lead', 'permission-project-asset-usage-manage', 'PROJECT')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

CREATE TYPE "AssetReleaseRecallScope" AS ENUM ('RELEASE', 'RELEASE_VERSION');
CREATE TYPE "AssetReleaseRecallState" AS ENUM ('ACTIVE', 'WITHDRAWN');
CREATE TYPE "AssetReleaseRecallRevisionKind" AS ENUM ('ISSUED', 'CORRECTED', 'WITHDRAWN', 'REISSUED');
CREATE TYPE "AssetProjectImpactSourceType" AS ENUM ('RECALL', 'ASSET_DEACTIVATION');
CREATE TYPE "AssetProjectImpactStatus" AS ENUM (
  'OPEN', 'ACKNOWLEDGED', 'ASSESSING', 'UPGRADE_PLANNED', 'RISK_ACCEPTANCE_PENDING',
  'MITIGATED', 'ACCEPTED_RISK', 'CLOSED'
);
CREATE TYPE "AssetImpactAssessmentKind" AS ENUM ('INITIAL', 'REFRESH');
CREATE TYPE "AssetImpactDispositionType" AS ENUM (
  'ACKNOWLEDGED', 'ASSESSING', 'UPGRADE_PLANNED', 'MITIGATED',
  'RISK_ACCEPTANCE_REQUESTED', 'RISK_ACCEPTANCE_APPROVED',
  'RISK_ACCEPTANCE_REJECTED', 'CLOSED', 'REFRESHED'
);
CREATE TYPE "AssetImpactRiskAcceptanceStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "AssetImpactRiskDecision" AS ENUM ('APPROVED', 'REJECTED');
CREATE TYPE "AssetUpgradeUsageMigrationMode" AS ENUM ('COPY', 'OVERRIDE');
CREATE TYPE "AssetImpactAlertProjectionDesiredState" AS ENUM ('ACTIVE', 'RESOLVED');
CREATE TYPE "AssetImpactAlertProjectionResult" AS ENUM ('DELIVERED', 'BLOCKED_CONFIGURATION', 'FAILED_TRANSIENT');

CREATE UNIQUE INDEX "technical_asset_events_id_technical_asset_id_key"
  ON "technical_asset_events"("id", "technical_asset_id");
CREATE UNIQUE INDEX "project_asset_references_id_project_technical_asset_key"
  ON "project_asset_references"("id", "project_id", "technical_asset_id");
CREATE UNIQUE INDEX "project_asset_usages_id_project_technical_asset_key"
  ON "project_asset_usages"("id", "project_id", "technical_asset_id");
CREATE UNIQUE INDEX "project_asset_usages_exact_upgrade_mapping_key"
  ON "project_asset_usages"("id", "project_id", "technical_asset_id", "reference_id", "asset_release_id", "asset_release_version_id", "component_snapshot_id");
CREATE TABLE "asset_release_recalls" (
  "id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "release_id" TEXT NOT NULL,
  "target_release_version_id" TEXT,
  "target_key" TEXT NOT NULL,
  "scope" "AssetReleaseRecallScope" NOT NULL,
  "current_revision_id" TEXT,
  "current_state" "AssetReleaseRecallState" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "affected_version_set_checksum" TEXT,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "asset_release_recalls_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_release_recalls_target_key_check" CHECK (
    ("scope" = 'RELEASE' AND "target_release_version_id" IS NULL AND "target_key" = 'RELEASE:' || "release_id")
    OR ("scope" = 'RELEASE_VERSION' AND "target_release_version_id" IS NOT NULL AND "target_key" = 'RELEASE_VERSION:' || "target_release_version_id")
  ),
  CONSTRAINT "asset_release_recalls_version_check" CHECK ("version" > 0)
);

CREATE TABLE "asset_release_recall_revisions" (
  "id" TEXT NOT NULL,
  "recall_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "kind" "AssetReleaseRecallRevisionKind" NOT NULL,
  "state" "AssetReleaseRecallState" NOT NULL,
  "severity" "AlertRiskLevel" NOT NULL,
  "reason" TEXT NOT NULL,
  "affected_version_set_checksum" TEXT NOT NULL,
  "affected_version_count" INTEGER NOT NULL,
  "source_asset_release_id" TEXT NOT NULL,
  "source_asset_release_version_id" TEXT NOT NULL,
  "source_revision" INTEGER NOT NULL,
  "source_snapshot_checksum" TEXT NOT NULL,
  "source_watermark" TEXT NOT NULL,
  "evidence_json" JSONB NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "snapshot_checksum" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "effective_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "asset_release_recall_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_release_recall_revisions_check" CHECK (
    "revision" > 0
    AND length(btrim("reason")) BETWEEN 1 AND 1024
    AND "affected_version_set_checksum" ~ '^[0-9a-f]{64}$'
    AND "affected_version_count" > 0
    AND "source_revision" > 0
    AND "source_snapshot_checksum" ~ '^[0-9a-f]{64}$'
    AND "snapshot_checksum" ~ '^[0-9a-f]{64}$'
    AND length(btrim("source_watermark")) > 0
    AND jsonb_typeof("evidence_json") = 'object'
    AND jsonb_typeof("snapshot_json") = 'object'
    AND (("kind" = 'WITHDRAWN' AND "state" = 'WITHDRAWN') OR ("kind" <> 'WITHDRAWN' AND "state" = 'ACTIVE'))
  )
);

CREATE TABLE "asset_release_recall_affected_versions" (
  "id" TEXT NOT NULL,
  "recall_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "release_id" TEXT NOT NULL,
  "asset_release_version_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "snapshot_checksum" TEXT NOT NULL,
  "source_watermark" TEXT NOT NULL,
  "status" "AssetReleaseVersionStatus" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "asset_release_recall_affected_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_release_recall_affected_versions_check" CHECK (
    "revision" > 0
    AND "snapshot_checksum" ~ '^[0-9a-f]{64}$'
    AND length(btrim("source_watermark")) > 0
    AND "status" IN ('PUBLISHED', 'SUPERSEDED')
  )
);

CREATE TABLE "asset_project_impacts" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "source_type" "AssetProjectImpactSourceType" NOT NULL,
  "source_key" TEXT NOT NULL,
  "recall_id" TEXT,
  "technical_asset_event_id" TEXT,
  "current_assessment_revision_id" TEXT,
  "status" "AssetProjectImpactStatus" NOT NULL DEFAULT 'OPEN',
  "owner_membership_id" TEXT,
  "due_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "asset_project_impacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_project_impacts_cause_check" CHECK (
    ("source_type" = 'RECALL' AND "recall_id" IS NOT NULL AND "technical_asset_event_id" IS NULL AND "source_key" = 'RECALL:' || "recall_id")
    OR ("source_type" = 'ASSET_DEACTIVATION' AND "recall_id" IS NULL AND "technical_asset_event_id" IS NOT NULL AND "source_key" = 'ASSET_DEACTIVATION:' || "technical_asset_event_id")
  ),
  CONSTRAINT "asset_project_impacts_source_key_check" CHECK (length(btrim("source_key")) BETWEEN 1 AND 191),
  CONSTRAINT "asset_project_impacts_version_check" CHECK ("version" > 0)
);

CREATE TABLE "asset_impact_assessment_revisions" (
  "id" TEXT NOT NULL,
  "impact_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "kind" "AssetImpactAssessmentKind" NOT NULL,
  "recall_id" TEXT,
  "recall_revision_id" TEXT,
  "source_watermark" TEXT NOT NULL,
  "snapshot_checksum" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "frozen_at" TIMESTAMP(3) NOT NULL,
  "actor_id" TEXT,
  "actor_membership_id" TEXT,
  "actor_membership_snapshot_json" JSONB,
  "owner_membership_id" TEXT,
  "owner_membership_snapshot_json" JSONB,
  "due_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "asset_impact_assessment_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_impact_assessment_revisions_check" CHECK (
    "sequence" > 0 AND length(btrim("source_watermark")) > 0
    AND "snapshot_checksum" ~ '^[0-9a-f]{64}$' AND jsonb_typeof("snapshot_json") = 'object'
    AND (
      ("actor_id" IS NULL AND "actor_membership_id" IS NULL AND "actor_membership_snapshot_json" IS NULL)
      OR ("actor_id" IS NOT NULL AND "actor_membership_id" IS NOT NULL AND jsonb_typeof("actor_membership_snapshot_json") = 'object')
    )
    AND ("kind" <> 'REFRESH' OR "actor_id" IS NOT NULL)
    AND (
      ("owner_membership_id" IS NULL AND "owner_membership_snapshot_json" IS NULL AND "due_at" IS NULL)
      OR ("owner_membership_id" IS NOT NULL AND jsonb_typeof("owner_membership_snapshot_json") = 'object' AND "due_at" IS NOT NULL)
    )
    AND (("recall_id" IS NULL AND "recall_revision_id" IS NULL)
      OR ("recall_id" IS NOT NULL AND "recall_revision_id" IS NOT NULL))
  )
);

CREATE TABLE "asset_impact_dispositions" (
  "id" TEXT NOT NULL,
  "impact_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "assessment_revision_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" "AssetImpactDispositionType" NOT NULL,
  "from_status" "AssetProjectImpactStatus" NOT NULL,
  "to_status" "AssetProjectImpactStatus" NOT NULL,
  "reason" TEXT NOT NULL,
  "evidence_json" JSONB NOT NULL,
  "actor_id" TEXT NOT NULL,
  "actor_membership_id" TEXT NOT NULL,
  "actor_membership_snapshot_json" JSONB NOT NULL,
  "owner_membership_id" TEXT NOT NULL,
  "owner_membership_snapshot_json" JSONB NOT NULL,
  "due_at" TIMESTAMP(3) NOT NULL,
  "mitigation_adoption_id" TEXT,
  "risk_acceptance_request_id" TEXT,
  "risk_acceptance_decision_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "asset_impact_dispositions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_impact_dispositions_check" CHECK (
    "sequence" > 0 AND length(btrim("reason")) BETWEEN 1 AND 1024
    AND jsonb_typeof("evidence_json") = 'object' AND "evidence_json" <> '{}'::jsonb
    AND jsonb_typeof("actor_membership_snapshot_json") = 'object'
    AND jsonb_typeof("owner_membership_snapshot_json") = 'object'
    AND (("type" = 'MITIGATED' AND "mitigation_adoption_id" IS NOT NULL)
      OR ("type" <> 'MITIGATED' AND "mitigation_adoption_id" IS NULL))
    AND (
      ("type" = 'RISK_ACCEPTANCE_REQUESTED' AND "risk_acceptance_request_id" IS NOT NULL AND "risk_acceptance_decision_id" IS NULL)
      OR ("type" IN ('RISK_ACCEPTANCE_APPROVED', 'RISK_ACCEPTANCE_REJECTED') AND "risk_acceptance_request_id" IS NOT NULL AND "risk_acceptance_decision_id" IS NOT NULL)
      OR ("type" NOT IN ('RISK_ACCEPTANCE_REQUESTED', 'RISK_ACCEPTANCE_APPROVED', 'RISK_ACCEPTANCE_REJECTED') AND "risk_acceptance_request_id" IS NULL AND "risk_acceptance_decision_id" IS NULL)
    )
  )
);

CREATE TABLE "asset_impact_risk_acceptance_requests" (
  "id" TEXT NOT NULL,
  "impact_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "status" "AssetImpactRiskAcceptanceStatus" NOT NULL DEFAULT 'PENDING',
  "version" INTEGER NOT NULL DEFAULT 1,
  "requested_by_id" TEXT NOT NULL,
  "requested_membership_id" TEXT NOT NULL,
  "requested_membership_snapshot_json" JSONB NOT NULL,
  "source_actor_id" TEXT NOT NULL,
  "source_actor_snapshot_json" JSONB NOT NULL,
  "evidence_json" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "requested_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "asset_impact_risk_acceptance_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_impact_risk_acceptance_requests_check" CHECK (
    "version" > 0 AND length(btrim("reason")) BETWEEN 1 AND 1024
    AND jsonb_typeof("evidence_json") = 'object' AND "evidence_json" <> '{}'::jsonb
    AND jsonb_typeof("requested_membership_snapshot_json") = 'object'
    AND jsonb_typeof("source_actor_snapshot_json") = 'object'
  )
);

CREATE TABLE "asset_impact_risk_acceptance_decisions" (
  "id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "impact_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "decision" "AssetImpactRiskDecision" NOT NULL,
  "actor_id" TEXT NOT NULL,
  "actor_membership_id" TEXT NOT NULL,
  "actor_membership_snapshot_json" JSONB NOT NULL,
  "evidence_json" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "decided_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "asset_impact_risk_acceptance_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_impact_risk_acceptance_decisions_check" CHECK (
    length(btrim("reason")) BETWEEN 1 AND 1024
    AND jsonb_typeof("evidence_json") = 'object' AND "evidence_json" <> '{}'::jsonb
    AND jsonb_typeof("actor_membership_snapshot_json") = 'object'
  )
);

CREATE TABLE "asset_upgrade_candidates" (
  "id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "source_asset_release_id" TEXT NOT NULL,
  "source_asset_release_version_id" TEXT NOT NULL,
  "source_revision" INTEGER NOT NULL,
  "source_snapshot_checksum" TEXT NOT NULL,
  "source_watermark" TEXT NOT NULL,
  "target_asset_release_id" TEXT NOT NULL,
  "target_asset_release_version_id" TEXT NOT NULL,
  "target_revision" INTEGER NOT NULL,
  "target_snapshot_checksum" TEXT NOT NULL,
  "target_watermark" TEXT NOT NULL,
  "compatibility_snapshot_json" JSONB NOT NULL,
  "compatibility_snapshot_checksum" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "asset_upgrade_candidates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_upgrade_candidates_frozen_check" CHECK (
    "source_revision" > 0 AND "target_revision" > 0
    AND "source_snapshot_checksum" ~ '^[0-9a-f]{64}$'
    AND "target_snapshot_checksum" ~ '^[0-9a-f]{64}$'
    AND "compatibility_snapshot_checksum" ~ '^[0-9a-f]{64}$'
    AND length(btrim("source_watermark")) > 0 AND length(btrim("target_watermark")) > 0
    AND jsonb_typeof("compatibility_snapshot_json") = 'object'
    AND "source_asset_release_version_id" <> "target_asset_release_version_id"
  )
);

CREATE TABLE "asset_upgrade_adoptions" (
  "id" TEXT NOT NULL,
  "candidate_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "impact_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "source_reference_id" TEXT NOT NULL,
  "source_reference_version" INTEGER NOT NULL,
  "target_reference_id" TEXT NOT NULL,
  "target_reference_version" INTEGER NOT NULL,
  "source_asset_release_id" TEXT NOT NULL,
  "source_asset_release_version_id" TEXT NOT NULL,
  "source_revision" INTEGER NOT NULL,
  "source_snapshot_checksum" TEXT NOT NULL,
  "source_watermark" TEXT NOT NULL,
  "target_asset_release_id" TEXT NOT NULL,
  "target_asset_release_version_id" TEXT NOT NULL,
  "target_revision" INTEGER NOT NULL,
  "target_snapshot_checksum" TEXT NOT NULL,
  "target_watermark" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "adopted_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "asset_upgrade_adoptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_upgrade_adoptions_frozen_check" CHECK (
    length(btrim("reason")) BETWEEN 1 AND 1024
    AND "source_reference_version" > 0 AND "target_reference_version" > 0
    AND "source_revision" > 0 AND "target_revision" > 0
    AND "source_snapshot_checksum" ~ '^[0-9a-f]{64}$'
    AND "target_snapshot_checksum" ~ '^[0-9a-f]{64}$'
    AND length(btrim("source_watermark")) > 0 AND length(btrim("target_watermark")) > 0
  )
);

CREATE TABLE "asset_upgrade_usage_mappings" (
  "id" TEXT NOT NULL,
  "adoption_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "source_usage_id" TEXT NOT NULL,
  "source_usage_version" INTEGER NOT NULL,
  "source_reference_id" TEXT NOT NULL,
  "source_asset_release_id" TEXT NOT NULL,
  "source_asset_release_version_id" TEXT NOT NULL,
  "source_component_snapshot_id" TEXT NOT NULL,
  "target_usage_id" TEXT NOT NULL,
  "target_usage_key" TEXT NOT NULL,
  "target_usage_version" INTEGER NOT NULL,
  "target_reference_id" TEXT NOT NULL,
  "target_asset_release_id" TEXT NOT NULL,
  "target_asset_release_version_id" TEXT NOT NULL,
  "target_component_snapshot_id" TEXT NOT NULL,
  "migration_mode" "AssetUpgradeUsageMigrationMode" NOT NULL,
  "mapping_snapshot_json" JSONB NOT NULL,
  "mapping_snapshot_checksum" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "asset_upgrade_usage_mappings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_upgrade_usage_mappings_frozen_check" CHECK (
    "source_usage_id" <> "target_usage_id" AND "source_usage_version" > 0 AND "target_usage_version" > 0
    AND length(btrim("target_usage_key")) BETWEEN 1 AND 191
    AND "mapping_snapshot_checksum" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("mapping_snapshot_json") = 'object'
  )
);

-- source_job_id intentionally freezes the trusted PersistentJob identity without an FK:
-- projection attempts are immutable business/audit facts and must not extend operational job retention.
CREATE TABLE "asset_impact_alert_projection_attempts" (
  "id" TEXT NOT NULL,
  "impact_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "assessment_revision_id" TEXT NOT NULL,
  "assessment_sequence" INTEGER NOT NULL,
  "assessment_snapshot_checksum" TEXT NOT NULL,
  "assessment_source_watermark" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "desired_state" "AssetImpactAlertProjectionDesiredState" NOT NULL,
  "source_job_id" TEXT NOT NULL,
  "source_event_type" TEXT NOT NULL,
  "rule_id" TEXT,
  "rule_version" INTEGER,
  "result" "AssetImpactAlertProjectionResult" NOT NULL,
  "blocked_reason" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "asset_impact_alert_projection_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_impact_alert_projection_attempts_check" CHECK (
    "source_key" = 'ASSET_IMPACT:' || "impact_id"
    AND "assessment_sequence" > 0
    AND "assessment_snapshot_checksum" ~ '^[0-9a-f]{64}$'
    AND "assessment_source_watermark" ~ '^[0-9a-f]{64}$'
    AND length(btrim("idempotency_key")) BETWEEN 1 AND 191
    AND length(btrim("source_job_id")) BETWEEN 1 AND 191
    AND "source_event_type" IN (
      'asset.impact.assessed',
      'asset.impact.disposition-recorded',
      'asset.impact.risk-acceptance.decided',
      'project.asset-upgrade.adopted',
      'asset.impact.closed'
    )
    AND (("rule_id" IS NULL AND "rule_version" IS NULL) OR ("rule_id" IS NOT NULL AND "rule_version" > 0))
    AND (("result" = 'BLOCKED_CONFIGURATION' AND length(btrim("blocked_reason")) > 0)
      OR ("result" <> 'BLOCKED_CONFIGURATION' AND "blocked_reason" IS NULL))
    AND ("result" = 'BLOCKED_CONFIGURATION'
      OR ("result" IN ('DELIVERED', 'FAILED_TRANSIENT') AND "rule_id" IS NOT NULL))
  )
);

CREATE UNIQUE INDEX "asset_release_recalls_technical_asset_id_target_key_key"
  ON "asset_release_recalls"("technical_asset_id", "target_key");
CREATE UNIQUE INDEX "asset_release_recalls_id_technical_asset_id_key"
  ON "asset_release_recalls"("id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_release_recalls_current_revision_asset_key"
  ON "asset_release_recalls"("current_revision_id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_release_recall_revisions_recall_id_revision_key"
  ON "asset_release_recall_revisions"("recall_id", "revision");
CREATE UNIQUE INDEX "asset_release_recall_revisions_id_asset_key"
  ON "asset_release_recall_revisions"("id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_release_recall_revisions_exact_source_key"
  ON "asset_release_recall_revisions"("id", "recall_id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_release_recall_affected_versions_recall_version_key"
  ON "asset_release_recall_affected_versions"("recall_id", "asset_release_version_id");
CREATE UNIQUE INDEX "asset_release_recall_affected_versions_id_recall_asset_key"
  ON "asset_release_recall_affected_versions"("id", "recall_id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_project_impacts_project_source_key"
  ON "asset_project_impacts"("project_id", "source_key");
CREATE UNIQUE INDEX "asset_project_impacts_id_project_asset_key"
  ON "asset_project_impacts"("id", "project_id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_project_impacts_current_assessment_project_asset_key"
  ON "asset_project_impacts"("current_assessment_revision_id", "project_id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_impact_assessment_revisions_impact_sequence_key"
  ON "asset_impact_assessment_revisions"("impact_id", "sequence");
CREATE UNIQUE INDEX "asset_impact_assessment_revisions_id_project_asset_key"
  ON "asset_impact_assessment_revisions"("id", "project_id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_impact_assessment_revisions_exact_key"
  ON "asset_impact_assessment_revisions"("id", "impact_id", "project_id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_impact_assessment_revisions_projection_exact_key"
  ON "asset_impact_assessment_revisions"("id", "impact_id", "project_id", "technical_asset_id", "sequence", "snapshot_checksum", "source_watermark");
CREATE UNIQUE INDEX "asset_impact_dispositions_impact_sequence_key"
  ON "asset_impact_dispositions"("impact_id", "sequence");
CREATE UNIQUE INDEX "asset_impact_risk_acceptance_requests_exact_key"
  ON "asset_impact_risk_acceptance_requests"("id", "impact_id", "project_id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_impact_risk_acceptance_decisions_request_key"
  ON "asset_impact_risk_acceptance_decisions"("request_id");
CREATE UNIQUE INDEX "asset_impact_risk_acceptance_decisions_exact_key"
  ON "asset_impact_risk_acceptance_decisions"("id", "request_id", "impact_id", "project_id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_upgrade_candidates_technical_asset_source_target_key"
  ON "asset_upgrade_candidates"("technical_asset_id", "source_asset_release_version_id", "target_asset_release_version_id");
CREATE UNIQUE INDEX "asset_upgrade_candidates_id_technical_asset_key"
  ON "asset_upgrade_candidates"("id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_upgrade_adoptions_id_project_asset_key"
  ON "asset_upgrade_adoptions"("id", "project_id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_upgrade_adoptions_exact_impact_key"
  ON "asset_upgrade_adoptions"("id", "impact_id", "project_id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_upgrade_adoptions_project_source_reference_key"
  ON "asset_upgrade_adoptions"("project_id", "source_reference_id");
CREATE UNIQUE INDEX "asset_upgrade_usage_mappings_adoption_source_usage_key"
  ON "asset_upgrade_usage_mappings"("adoption_id", "source_usage_id");
CREATE UNIQUE INDEX "asset_upgrade_usage_mappings_adoption_target_usage_key"
  ON "asset_upgrade_usage_mappings"("adoption_id", "target_usage_id");
CREATE UNIQUE INDEX "asset_upgrade_usage_mappings_id_project_asset_key"
  ON "asset_upgrade_usage_mappings"("id", "project_id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_impact_alert_projection_attempts_idempotency_key"
  ON "asset_impact_alert_projection_attempts"("idempotency_key");

ALTER TABLE "asset_release_recalls"
  ADD CONSTRAINT "asset_release_recalls_asset_fkey" FOREIGN KEY ("technical_asset_id") REFERENCES "technical_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_release_recalls_release_fkey" FOREIGN KEY ("release_id", "technical_asset_id") REFERENCES "asset_releases"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_release_recalls_target_version_fkey" FOREIGN KEY ("target_release_version_id", "release_id", "technical_asset_id") REFERENCES "asset_release_versions"("id", "release_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_release_recalls_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_release_recall_revisions"
  ADD CONSTRAINT "asset_release_recall_revisions_recall_fkey" FOREIGN KEY ("recall_id", "technical_asset_id") REFERENCES "asset_release_recalls"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_release_recall_revisions_source_version_fkey" FOREIGN KEY ("source_asset_release_version_id", "source_asset_release_id", "technical_asset_id") REFERENCES "asset_release_versions"("id", "release_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_release_recall_revisions_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_release_recalls"
  ADD CONSTRAINT "asset_release_recalls_current_revision_fkey" FOREIGN KEY ("current_revision_id", "technical_asset_id") REFERENCES "asset_release_recall_revisions"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "asset_release_recall_affected_versions"
  ADD CONSTRAINT "asset_release_recall_affected_versions_recall_fkey" FOREIGN KEY ("recall_id", "technical_asset_id") REFERENCES "asset_release_recalls"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_release_recall_affected_versions_release_fkey" FOREIGN KEY ("release_id", "technical_asset_id") REFERENCES "asset_releases"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_release_recall_affected_versions_version_fkey" FOREIGN KEY ("asset_release_version_id", "release_id", "technical_asset_id") REFERENCES "asset_release_versions"("id", "release_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_project_impacts"
  ADD CONSTRAINT "asset_project_impacts_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_project_impacts_asset_fkey" FOREIGN KEY ("technical_asset_id") REFERENCES "technical_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_project_impacts_recall_fkey" FOREIGN KEY ("recall_id", "technical_asset_id") REFERENCES "asset_release_recalls"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_project_impacts_deactivation_event_fkey" FOREIGN KEY ("technical_asset_event_id", "technical_asset_id") REFERENCES "technical_asset_events"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_project_impacts_owner_membership_fkey" FOREIGN KEY ("owner_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_impact_assessment_revisions"
  ADD CONSTRAINT "asset_impact_assessment_revisions_impact_fkey" FOREIGN KEY ("impact_id", "project_id", "technical_asset_id") REFERENCES "asset_project_impacts"("id", "project_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_assessment_revisions_recall_revision_fkey" FOREIGN KEY ("recall_revision_id", "recall_id", "technical_asset_id") REFERENCES "asset_release_recall_revisions"("id", "recall_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_assessment_revisions_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_assessment_revisions_actor_membership_fkey" FOREIGN KEY ("actor_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_assessment_revisions_owner_membership_fkey" FOREIGN KEY ("owner_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_project_impacts"
  ADD CONSTRAINT "asset_project_impacts_current_assessment_fkey" FOREIGN KEY ("current_assessment_revision_id", "project_id", "technical_asset_id") REFERENCES "asset_impact_assessment_revisions"("id", "project_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "asset_impact_dispositions"
  ADD CONSTRAINT "asset_impact_dispositions_impact_fkey" FOREIGN KEY ("impact_id", "project_id", "technical_asset_id") REFERENCES "asset_project_impacts"("id", "project_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_dispositions_assessment_fkey" FOREIGN KEY ("assessment_revision_id", "impact_id", "project_id", "technical_asset_id") REFERENCES "asset_impact_assessment_revisions"("id", "impact_id", "project_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_dispositions_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_dispositions_membership_fkey" FOREIGN KEY ("actor_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_dispositions_owner_fkey" FOREIGN KEY ("owner_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_dispositions_mitigation_adoption_fkey" FOREIGN KEY ("mitigation_adoption_id", "impact_id", "project_id", "technical_asset_id") REFERENCES "asset_upgrade_adoptions"("id", "impact_id", "project_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_dispositions_risk_request_fkey" FOREIGN KEY ("risk_acceptance_request_id", "impact_id", "project_id", "technical_asset_id") REFERENCES "asset_impact_risk_acceptance_requests"("id", "impact_id", "project_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_dispositions_risk_decision_fkey" FOREIGN KEY ("risk_acceptance_decision_id", "risk_acceptance_request_id", "impact_id", "project_id", "technical_asset_id") REFERENCES "asset_impact_risk_acceptance_decisions"("id", "request_id", "impact_id", "project_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_impact_risk_acceptance_requests"
  ADD CONSTRAINT "asset_impact_risk_requests_impact_fkey" FOREIGN KEY ("impact_id", "project_id", "technical_asset_id") REFERENCES "asset_project_impacts"("id", "project_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_risk_requests_requestor_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_risk_requests_membership_fkey" FOREIGN KEY ("requested_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_risk_requests_source_actor_fkey" FOREIGN KEY ("source_actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_impact_risk_acceptance_decisions"
  ADD CONSTRAINT "asset_impact_risk_decisions_request_fkey" FOREIGN KEY ("request_id", "impact_id", "project_id", "technical_asset_id") REFERENCES "asset_impact_risk_acceptance_requests"("id", "impact_id", "project_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_risk_decisions_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_risk_decisions_membership_fkey" FOREIGN KEY ("actor_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_upgrade_candidates"
  ADD CONSTRAINT "asset_upgrade_candidates_asset_fkey" FOREIGN KEY ("technical_asset_id") REFERENCES "technical_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_upgrade_candidates_source_release_fkey" FOREIGN KEY ("source_asset_release_id", "technical_asset_id") REFERENCES "asset_releases"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_upgrade_candidates_source_version_fkey" FOREIGN KEY ("source_asset_release_version_id", "source_asset_release_id", "technical_asset_id") REFERENCES "asset_release_versions"("id", "release_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_upgrade_candidates_target_release_fkey" FOREIGN KEY ("target_asset_release_id", "technical_asset_id") REFERENCES "asset_releases"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_upgrade_candidates_target_version_fkey" FOREIGN KEY ("target_asset_release_version_id", "target_asset_release_id", "technical_asset_id") REFERENCES "asset_release_versions"("id", "release_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_upgrade_candidates_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_upgrade_adoptions"
  ADD CONSTRAINT "asset_upgrade_adoptions_candidate_fkey" FOREIGN KEY ("candidate_id", "technical_asset_id") REFERENCES "asset_upgrade_candidates"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_upgrade_adoptions_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_upgrade_adoptions_asset_fkey" FOREIGN KEY ("technical_asset_id") REFERENCES "technical_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_upgrade_adoptions_impact_fkey" FOREIGN KEY ("impact_id", "project_id", "technical_asset_id") REFERENCES "asset_project_impacts"("id", "project_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_upgrade_adoptions_source_reference_fkey" FOREIGN KEY ("source_reference_id", "project_id", "technical_asset_id", "source_asset_release_id", "source_asset_release_version_id") REFERENCES "project_asset_references"("id", "project_id", "technical_asset_id", "asset_release_id", "asset_release_version_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_upgrade_adoptions_target_reference_fkey" FOREIGN KEY ("target_reference_id", "project_id", "technical_asset_id", "target_asset_release_id", "target_asset_release_version_id") REFERENCES "project_asset_references"("id", "project_id", "technical_asset_id", "asset_release_id", "asset_release_version_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_upgrade_adoptions_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_upgrade_usage_mappings"
  ADD CONSTRAINT "asset_upgrade_usage_mappings_adoption_fkey" FOREIGN KEY ("adoption_id", "project_id", "technical_asset_id") REFERENCES "asset_upgrade_adoptions"("id", "project_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_upgrade_usage_mappings_source_usage_fkey" FOREIGN KEY ("source_usage_id", "project_id", "technical_asset_id", "source_reference_id", "source_asset_release_id", "source_asset_release_version_id", "source_component_snapshot_id") REFERENCES "project_asset_usages"("id", "project_id", "technical_asset_id", "reference_id", "asset_release_id", "asset_release_version_id", "component_snapshot_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_upgrade_usage_mappings_target_usage_fkey" FOREIGN KEY ("target_usage_id", "project_id", "technical_asset_id", "target_reference_id", "target_asset_release_id", "target_asset_release_version_id", "target_component_snapshot_id") REFERENCES "project_asset_usages"("id", "project_id", "technical_asset_id", "reference_id", "asset_release_id", "asset_release_version_id", "component_snapshot_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "asset_impact_alert_projection_attempts"
  ADD CONSTRAINT "asset_impact_alert_projection_attempts_impact_fkey" FOREIGN KEY ("impact_id", "project_id", "technical_asset_id") REFERENCES "asset_project_impacts"("id", "project_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_alert_projection_attempts_assessment_fkey" FOREIGN KEY ("assessment_revision_id", "impact_id", "project_id", "technical_asset_id", "assessment_sequence", "assessment_snapshot_checksum", "assessment_source_watermark") REFERENCES "asset_impact_assessment_revisions"("id", "impact_id", "project_id", "technical_asset_id", "sequence", "snapshot_checksum", "source_watermark") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_impact_alert_projection_attempts_rule_fkey" FOREIGN KEY ("rule_id", "project_id") REFERENCES "project_alert_rules"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION validate_technical_asset_mutation() RETURNS trigger AS $$
DECLARE rnd_status "RndProjectStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'technical assets cannot be deleted; cancel or disable them instead' USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."rnd_project_id" IS DISTINCT FROM OLD."rnd_project_id"
    OR NEW."asset_number" IS DISTINCT FROM OLD."asset_number" OR NEW."asset_type" IS DISTINCT FROM OLD."asset_type"
    OR NEW."owner_id" IS DISTINCT FROM OLD."owner_id" OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'technical asset stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status"::text IN ('CANCELED', 'DISABLED') THEN
    RAISE EXCEPTION 'canceled or disabled technical assets are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'technical asset commands must advance resource version exactly once' USING ERRCODE = '23514';
  END IF;
  IF NEW."status"::text = 'VALIDATION_PENDING' THEN
    SELECT "status" INTO rnd_status FROM "rnd_projects" WHERE "id" = NEW."rnd_project_id" FOR UPDATE;
    IF rnd_status IS DISTINCT FROM 'VALIDATION' THEN
      RAISE EXCEPTION 'technical asset validation requires its R&D project to be in VALIDATION' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF (OLD."status"::text = 'DRAFT' AND NEW."status"::text IN ('VALIDATION_PENDING', 'CANCELED'))
    OR (OLD."status"::text = 'VALIDATION_PENDING' AND NEW."status"::text IN ('DRAFT', 'VALIDATED', 'CANCELED'))
    OR (OLD."status"::text = 'VALIDATED' AND NEW."status"::text = 'DISABLED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid technical asset transition: % -> %', OLD."status", NEW."status" USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_technical_asset_deactivation_event() RETURNS trigger AS $$
BEGIN
  IF OLD."status"::text = 'VALIDATED' AND NEW."status"::text = 'DISABLED' AND NOT EXISTS (
    SELECT 1 FROM "technical_asset_events" event
     WHERE event."technical_asset_id" = NEW."id" AND event."rnd_project_id" = NEW."rnd_project_id"
       AND event."event_type"::text = 'STATUS_CHANGED'
       AND event."from_status"::text = 'VALIDATED' AND event."to_status"::text = 'DISABLED'
       AND event."snapshot_json"->>'technicalAssetId' = NEW."id"
       AND event."snapshot_json"->>'rndProjectId' = NEW."rnd_project_id"
       AND event."snapshot_json"->>'status' = 'DISABLED'
       AND event."snapshot_json"->>'version' = NEW."version"::text
  ) THEN
    RAISE EXCEPTION 'technical asset deactivation requires its exact status event before commit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_apm_064_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_release_insert_availability() RETURNS trigger AS $$
DECLARE
  v_rnd_project_id TEXT;
  v_rnd_status TEXT;
  v_asset_status TEXT;
BEGIN
  SELECT "rnd_project_id" INTO v_rnd_project_id FROM "technical_assets" WHERE "id" = NEW."technical_asset_id";
  SELECT "status"::text INTO v_rnd_status FROM "rnd_projects" WHERE "id" = v_rnd_project_id FOR UPDATE;
  SELECT "status"::text INTO v_asset_status FROM "technical_assets" WHERE "id" = NEW."technical_asset_id" FOR UPDATE;
  IF v_rnd_status IS NULL OR v_asset_status IS NULL OR v_rnd_status IN ('COMPLETED', 'CANCELED')
    OR v_asset_status IN ('CANCELED', 'DISABLED') THEN
    RAISE EXCEPTION 'technical asset or R&D project is unavailable for a new release fact' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'asset_release_versions' THEN
    PERFORM 1 FROM "asset_releases"
     WHERE "id" = NEW."release_id" AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'asset release version requires its exact available release' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW."created_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  IF TG_TABLE_NAME = 'asset_releases' THEN NEW."updated_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_release_recall_insert() RETURNS trigger AS $$
DECLARE
  v_rnd_project_id TEXT;
  v_release RECORD;
  v_target_status TEXT;
BEGIN
  SELECT "rnd_project_id" INTO v_rnd_project_id FROM "technical_assets"
   WHERE "id" = NEW."technical_asset_id" FOR UPDATE;
  PERFORM 1 FROM "rnd_projects" WHERE "id" = v_rnd_project_id FOR UPDATE;
  SELECT * INTO v_release FROM "asset_releases"
   WHERE "id" = NEW."release_id" AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recall source asset and release must be exact historical facts' USING ERRCODE = '23514';
  END IF;
  NEW."created_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  NEW."updated_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  PERFORM 1 FROM "asset_release_versions"
   WHERE "release_id" = NEW."release_id" AND "technical_asset_id" = NEW."technical_asset_id"
     AND "status"::text IN ('PUBLISHED', 'SUPERSEDED') AND "published_at" <= NEW."created_at"
   ORDER BY "id" FOR UPDATE;
  IF NEW."scope"::text = 'RELEASE_VERSION' THEN
    SELECT "status"::text INTO v_target_status FROM "asset_release_versions"
     WHERE "id" = NEW."target_release_version_id" AND "release_id" = NEW."release_id"
       AND "technical_asset_id" = NEW."technical_asset_id" AND "published_at" <= NEW."created_at";
    IF NOT FOUND OR v_target_status NOT IN ('PUBLISHED', 'SUPERSEDED') THEN
      RAISE EXCEPTION 'RELEASE_VERSION recall requires an exact published historical target' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_release_recall_affected_version() RETURNS trigger AS $$
DECLARE root_row RECORD; version_row RECORD;
BEGIN
  SELECT * INTO root_row FROM "asset_release_recalls" WHERE "id" = NEW."recall_id" AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM "asset_release_recall_revisions" WHERE "recall_id" = NEW."recall_id") THEN
    RAISE EXCEPTION 'affected-version set may only be frozen once before ISSUED' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO version_row FROM "asset_release_versions"
   WHERE "id" = NEW."asset_release_version_id" AND "release_id" = root_row."release_id" AND "technical_asset_id" = NEW."technical_asset_id";
  IF NOT FOUND OR NEW."release_id" IS DISTINCT FROM version_row."release_id"
    OR NEW."revision" IS DISTINCT FROM version_row."revision"
    OR NEW."snapshot_checksum" IS DISTINCT FROM version_row."snapshot_checksum"
    OR NEW."source_watermark" IS DISTINCT FROM version_row."source_watermark"
    OR NEW."status" IS DISTINCT FROM version_row."status"
    OR version_row."status"::text NOT IN ('PUBLISHED', 'SUPERSEDED')
    OR version_row."published_at" > root_row."created_at" THEN
    RAISE EXCEPTION 'affected version must equal an exact published historical release version' USING ERRCODE = '23514';
  END IF;
  IF root_row."scope"::text = 'RELEASE_VERSION' AND NEW."asset_release_version_id" IS DISTINCT FROM root_row."target_release_version_id" THEN
    RAISE EXCEPTION 'RELEASE_VERSION recall may freeze only its exact target version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_release_recall_revision() RETURNS trigger AS $$
DECLARE
  root_row RECORD;
  previous_row RECORD;
  first_checksum TEXT;
  max_revision INTEGER;
  affected_count INTEGER;
  eligible_count INTEGER;
  anchor_row RECORD;
BEGIN
  SELECT * INTO root_row FROM "asset_release_recalls" WHERE "id" = NEW."recall_id" AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'recall root not found' USING ERRCODE = '23514'; END IF;
  SELECT coalesce(max("revision"), 0) INTO max_revision FROM "asset_release_recall_revisions" WHERE "recall_id" = NEW."recall_id";
  IF NEW."revision" <> max_revision + 1 THEN RAISE EXCEPTION 'recall revision must advance exactly once' USING ERRCODE = '23514'; END IF;
  IF max_revision = 0 THEN
    IF root_row."current_revision_id" IS NOT NULL THEN
      RAISE EXCEPTION 'first recall revision requires an empty current pointer' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO previous_row FROM "asset_release_recall_revisions"
     WHERE "recall_id" = NEW."recall_id" AND "revision" = max_revision;
    IF root_row."current_revision_id" IS DISTINCT FROM previous_row."id" THEN
      RAISE EXCEPTION 'recall revision requires the previous exact current revision' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT "affected_version_set_checksum" INTO first_checksum FROM "asset_release_recall_revisions" WHERE "recall_id" = NEW."recall_id" ORDER BY "revision" ASC LIMIT 1;
  SELECT count(*) INTO affected_count FROM "asset_release_recall_affected_versions" WHERE "recall_id" = NEW."recall_id";
  SELECT * INTO anchor_row FROM "asset_release_recall_affected_versions"
   WHERE "recall_id" = NEW."recall_id" AND "asset_release_version_id" = NEW."source_asset_release_version_id";
  IF affected_count <> NEW."affected_version_count" OR NOT FOUND
    OR NEW."source_asset_release_id" IS DISTINCT FROM anchor_row."release_id"
    OR NEW."source_revision" IS DISTINCT FROM anchor_row."revision"
    OR NEW."source_snapshot_checksum" IS DISTINCT FROM anchor_row."snapshot_checksum"
    OR NEW."source_watermark" IS DISTINCT FROM anchor_row."source_watermark"
    OR NEW."snapshot_json"->>'affectedVersionSetChecksum' IS DISTINCT FROM NEW."affected_version_set_checksum"
    OR NEW."snapshot_json"->>'sourceWatermark' IS DISTINCT FROM NEW."source_watermark" THEN
    RAISE EXCEPTION 'recall revision anchor, count, and snapshot must equal its frozen affected-version set' USING ERRCODE = '23514';
  END IF;
  IF max_revision = 0 THEN
    SELECT count(*) INTO eligible_count FROM "asset_release_versions"
     WHERE "release_id" = root_row."release_id" AND "technical_asset_id" = root_row."technical_asset_id"
       AND "status"::text IN ('PUBLISHED', 'SUPERSEDED') AND "published_at" <= root_row."created_at";
    IF NEW."kind"::text <> 'ISSUED' OR NEW."state"::text <> 'ACTIVE' OR affected_count = 0
      OR root_row."affected_version_set_checksum" IS DISTINCT FROM NEW."affected_version_set_checksum"
      OR (root_row."scope"::text = 'RELEASE' AND (
        affected_count <> eligible_count OR EXISTS (
          SELECT 1 FROM "asset_release_versions" version_row
           WHERE version_row."release_id" = root_row."release_id"
             AND version_row."technical_asset_id" = root_row."technical_asset_id"
             AND version_row."status"::text IN ('PUBLISHED', 'SUPERSEDED')
             AND version_row."published_at" <= root_row."created_at"
             AND NOT EXISTS (
               SELECT 1 FROM "asset_release_recall_affected_versions" frozen
                WHERE frozen."recall_id" = root_row."id" AND frozen."asset_release_version_id" = version_row."id"
             )
        )
      ))
      OR (root_row."scope"::text = 'RELEASE_VERSION' AND (
        affected_count <> 1 OR NOT EXISTS (
          SELECT 1 FROM "asset_release_recall_affected_versions"
           WHERE "recall_id" = root_row."id" AND "asset_release_version_id" = root_row."target_release_version_id"
        )
      )) THEN
      RAISE EXCEPTION 'first recall revision must ISSUE a complete frozen affected-version set' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."kind"::text = 'ISSUED' OR NEW."affected_version_set_checksum" IS DISTINCT FROM first_checksum
      OR NEW."affected_version_set_checksum" IS DISTINCT FROM root_row."affected_version_set_checksum" THEN
      RAISE EXCEPTION 'recall revisions cannot change the frozen affected-version set' USING ERRCODE = '23514';
    END IF;
    IF root_row."current_state"::text = 'ACTIVE' AND NEW."kind"::text NOT IN ('CORRECTED', 'WITHDRAWN') THEN
      RAISE EXCEPTION 'active recall may only be CORRECTED or WITHDRAWN' USING ERRCODE = '23514';
    END IF;
    IF root_row."current_state"::text = 'WITHDRAWN' AND NEW."kind"::text <> 'REISSUED' THEN
      RAISE EXCEPTION 'withdrawn recall may only be REISSUED' USING ERRCODE = '23514';
    END IF;
    IF NEW."kind"::text = 'REISSUED' AND root_row."current_state"::text <> 'WITHDRAWN' THEN
      RAISE EXCEPTION 'only a withdrawn recall may be reissued' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW."effective_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_release_recall_mutation() RETURNS trigger AS $$
DECLARE revision_row RECORD; old_revision_row RECORD; revision_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'asset release recalls cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."technical_asset_id" IS DISTINCT FROM OLD."technical_asset_id"
    OR NEW."release_id" IS DISTINCT FROM OLD."release_id" OR NEW."target_release_version_id" IS DISTINCT FROM OLD."target_release_version_id"
    OR NEW."target_key" IS DISTINCT FROM OLD."target_key" OR NEW."scope" IS DISTINCT FROM OLD."scope"
    OR NEW."affected_version_set_checksum" IS DISTINCT FROM OLD."affected_version_set_checksum"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'asset release recall identity and frozen target are immutable' USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO revision_count FROM "asset_release_recall_revisions" WHERE "recall_id" = OLD."id";
  SELECT * INTO revision_row FROM "asset_release_recall_revisions" WHERE "id" = NEW."current_revision_id" AND "recall_id" = OLD."id" AND "technical_asset_id" = OLD."technical_asset_id";
  IF NOT FOUND OR revision_row."revision" <> revision_count
    OR (OLD."current_revision_id" IS NOT NULL AND NEW."current_revision_id" = OLD."current_revision_id")
    OR NEW."current_state" IS DISTINCT FROM revision_row."state" THEN
    RAISE EXCEPTION 'recall current pointer must reference its exact revision and state' USING ERRCODE = '23514';
  END IF;
  IF OLD."current_revision_id" IS NULL AND revision_count = 1 AND NEW."version" = OLD."version" THEN RETURN NEW; END IF;
  SELECT * INTO old_revision_row FROM "asset_release_recall_revisions"
   WHERE "id" = OLD."current_revision_id" AND "recall_id" = OLD."id" AND "technical_asset_id" = OLD."technical_asset_id";
  IF NOT FOUND OR revision_row."revision" <> old_revision_row."revision" + 1 THEN
    RAISE EXCEPTION 'recall current pointer must advance by exactly one revision' USING ERRCODE = '23514';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN RAISE EXCEPTION 'recall commands must advance version exactly once' USING ERRCODE = '23514'; END IF;
  NEW."updated_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_asset_release_recall_revision_applied() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "asset_release_recalls"
     WHERE "id" = NEW."recall_id" AND "technical_asset_id" = NEW."technical_asset_id"
       AND "current_revision_id" = NEW."id" AND "current_state" = NEW."state"
  ) THEN
    RAISE EXCEPTION 'recall revision must become the exact current pointer before commit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_asset_release_recall_complete() RETURNS trigger AS $$
DECLARE root_current_revision_id TEXT; root_row RECORD; frozen_count INTEGER;
BEGIN
  SELECT recall.* INTO root_row
    FROM "asset_release_recalls" AS recall
   WHERE recall."id" = NEW."id" AND recall."technical_asset_id" = NEW."technical_asset_id";
  root_current_revision_id := root_row."current_revision_id";
  IF root_current_revision_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM "asset_release_recall_affected_versions" WHERE "recall_id" = NEW."id") THEN
    RAISE EXCEPTION 'recall root requires a current revision and frozen affected-version set before commit' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO frozen_count FROM "asset_release_recall_affected_versions" WHERE "recall_id" = NEW."id";
  IF root_row."scope"::text = 'RELEASE' THEN
    IF frozen_count = 0 THEN RAISE EXCEPTION 'RELEASE recall requires a frozen issuance set' USING ERRCODE = '23514'; END IF;
  ELSIF frozen_count <> 1 OR NOT EXISTS (
    SELECT 1 FROM "asset_release_recall_affected_versions"
     WHERE "recall_id" = root_row."id" AND "asset_release_version_id" = root_row."target_release_version_id"
  ) THEN
    RAISE EXCEPTION 'RELEASE_VERSION recall must freeze exactly its target version' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_impact_disposition_insert() RETURNS trigger AS $$
DECLARE
  v_impact RECORD;
  v_membership RECORD;
  v_owner_membership RECORD;
  v_assessment RECORD;
  v_previous RECORD;
  v_risk_request RECORD;
  v_risk_decision RECORD;
  v_mitigation_adoption RECORD;
  v_max_sequence INTEGER;
  v_valid_transition BOOLEAN;
BEGIN
  SELECT * INTO v_impact FROM "asset_project_impacts"
   WHERE "id" = NEW."impact_id" AND "project_id" = NEW."project_id"
     AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'asset impact disposition source not found' USING ERRCODE = '23514';
  END IF;

  SELECT coalesce(max("sequence"), 0) INTO v_max_sequence
    FROM "asset_impact_dispositions" WHERE "impact_id" = NEW."impact_id";
  IF NEW."sequence" <> v_max_sequence + 1 THEN
    RAISE EXCEPTION 'impact disposition must advance sequence exactly once' USING ERRCODE = '23514';
  END IF;
  IF v_max_sequence > 0 THEN
    SELECT * INTO v_previous FROM "asset_impact_dispositions"
     WHERE "impact_id" = NEW."impact_id" AND "sequence" = v_max_sequence;
    IF v_previous."to_status" IS DISTINCT FROM v_impact."status" THEN
      RAISE EXCEPTION 'previous impact disposition must be applied before the next fact' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."from_status" IS DISTINCT FROM v_impact."status" THEN
    RAISE EXCEPTION 'impact disposition must start from the current aggregate status' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_membership FROM "project_members"
   WHERE "id" = NEW."actor_membership_id" AND "project_id" = NEW."project_id"
     AND "user_id" = NEW."actor_id" AND "left_at" IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'impact disposition actor membership must be active and belong to the actor' USING ERRCODE = '23514';
  END IF;
  IF NEW."actor_membership_snapshot_json"->>'membershipId' IS DISTINCT FROM v_membership."id"
    OR NEW."actor_membership_snapshot_json"->>'userId' IS DISTINCT FROM v_membership."user_id"
    OR NEW."actor_membership_snapshot_json"->>'projectRole' IS DISTINCT FROM v_membership."project_role"::text THEN
    RAISE EXCEPTION 'impact disposition must freeze its exact actor membership' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_owner_membership FROM "project_members"
   WHERE "id" = NEW."owner_membership_id" AND "project_id" = NEW."project_id"
     AND "project_role"::text = 'PROJECT_MANAGER' AND "left_at" IS NULL FOR UPDATE;
  IF NOT FOUND OR NEW."owner_membership_snapshot_json"->>'membershipId' IS DISTINCT FROM v_owner_membership."id"
    OR NEW."owner_membership_snapshot_json"->>'userId' IS DISTINCT FROM v_owner_membership."user_id"
    OR NEW."owner_membership_snapshot_json"->>'projectRole' IS DISTINCT FROM v_owner_membership."project_role"::text THEN
    RAISE EXCEPTION 'impact disposition owner must freeze an active project-manager membership' USING ERRCODE = '23514';
  END IF;
  IF NEW."to_status"::text <> 'CLOSED' AND NEW."due_at" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'active impact disposition requires a future due date' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_assessment FROM "asset_impact_assessment_revisions"
   WHERE "id" = NEW."assessment_revision_id" AND "impact_id" = NEW."impact_id"
     AND "project_id" = NEW."project_id" AND "technical_asset_id" = NEW."technical_asset_id";
  IF NOT FOUND
    OR (NEW."type"::text <> 'REFRESHED' AND NEW."assessment_revision_id" IS DISTINCT FROM v_impact."current_assessment_revision_id")
    OR (NEW."type"::text = 'REFRESHED' AND v_assessment."kind"::text <> 'REFRESH')
    OR EXISTS (
      SELECT 1 FROM "asset_impact_assessment_revisions" later
       WHERE later."impact_id" = NEW."impact_id" AND later."sequence" > v_assessment."sequence"
    )
    OR NEW."owner_membership_id" IS DISTINCT FROM v_assessment."owner_membership_id"
    OR NEW."owner_membership_snapshot_json" IS DISTINCT FROM v_assessment."owner_membership_snapshot_json"
    OR NEW."due_at" IS DISTINCT FROM v_assessment."due_at" THEN
    RAISE EXCEPTION 'impact disposition must bind its exact assessment revision' USING ERRCODE = '23514';
  END IF;

  IF NEW."type"::text = 'MITIGATED' THEN
    SELECT * INTO v_mitigation_adoption FROM "asset_upgrade_adoptions"
     WHERE "id" = NEW."mitigation_adoption_id" AND "impact_id" = NEW."impact_id"
       AND "project_id" = NEW."project_id" AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MITIGATED disposition requires its exact same-impact adoption' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."mitigation_adoption_id" IS NOT NULL THEN
    RAISE EXCEPTION 'only MITIGATED disposition may bind a mitigation adoption' USING ERRCODE = '23514';
  END IF;

  IF NEW."type"::text = 'RISK_ACCEPTANCE_REQUESTED' THEN
    SELECT * INTO v_risk_request FROM "asset_impact_risk_acceptance_requests"
     WHERE "id" = NEW."risk_acceptance_request_id" AND "impact_id" = NEW."impact_id"
       AND "project_id" = NEW."project_id" AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
    IF NOT FOUND OR v_risk_request."status"::text <> 'PENDING'
      OR NEW."actor_id" IS DISTINCT FROM v_risk_request."requested_by_id"
      OR NEW."actor_membership_id" IS DISTINCT FROM v_risk_request."requested_membership_id" THEN
      RAISE EXCEPTION 'risk acceptance requested disposition requires its exact pending request fact' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."type"::text IN ('RISK_ACCEPTANCE_APPROVED', 'RISK_ACCEPTANCE_REJECTED') THEN
    SELECT request.*, decision."id" AS decision_id, decision."decision", decision."actor_id" AS decision_actor_id,
           decision."actor_membership_id" AS decision_membership_id
      INTO v_risk_decision
      FROM "asset_impact_risk_acceptance_requests" request
      JOIN "asset_impact_risk_acceptance_decisions" decision
        ON decision."request_id" = request."id" AND decision."impact_id" = request."impact_id"
       AND decision."project_id" = request."project_id" AND decision."technical_asset_id" = request."technical_asset_id"
     WHERE request."id" = NEW."risk_acceptance_request_id" AND decision."id" = NEW."risk_acceptance_decision_id"
       AND request."impact_id" = NEW."impact_id" AND request."project_id" = NEW."project_id"
       AND request."technical_asset_id" = NEW."technical_asset_id" FOR UPDATE OF request, decision;
    IF NOT FOUND OR v_risk_decision."status"::text <> v_risk_decision."decision"::text
      OR NEW."actor_id" IS DISTINCT FROM v_risk_decision."decision_actor_id"
      OR NEW."actor_membership_id" IS DISTINCT FROM v_risk_decision."decision_membership_id"
      OR (NEW."type"::text = 'RISK_ACCEPTANCE_APPROVED' AND v_risk_decision."decision"::text <> 'APPROVED')
      OR (NEW."type"::text = 'RISK_ACCEPTANCE_REJECTED' AND v_risk_decision."decision"::text <> 'REJECTED') THEN
      RAISE EXCEPTION 'risk acceptance disposition requires its exact applied decision fact' USING ERRCODE = '23514';
    END IF;
  END IF;

  v_valid_transition :=
    (NEW."type"::text = 'ACKNOWLEDGED' AND NEW."from_status"::text = 'OPEN' AND NEW."to_status"::text = 'ACKNOWLEDGED')
    OR (NEW."type"::text = 'ASSESSING' AND NEW."from_status"::text = 'ACKNOWLEDGED' AND NEW."to_status"::text = 'ASSESSING')
    OR (NEW."type"::text = 'UPGRADE_PLANNED' AND NEW."from_status"::text = 'ASSESSING' AND NEW."to_status"::text = 'UPGRADE_PLANNED')
    OR (NEW."type"::text = 'MITIGATED' AND NEW."from_status"::text = 'UPGRADE_PLANNED' AND NEW."to_status"::text = 'MITIGATED')
    OR (NEW."type"::text = 'RISK_ACCEPTANCE_REQUESTED' AND NEW."from_status"::text IN ('ASSESSING', 'UPGRADE_PLANNED') AND NEW."to_status"::text = 'RISK_ACCEPTANCE_PENDING')
    OR (NEW."type"::text = 'RISK_ACCEPTANCE_APPROVED' AND NEW."from_status"::text = 'RISK_ACCEPTANCE_PENDING' AND NEW."to_status"::text = 'ACCEPTED_RISK')
    OR (NEW."type"::text = 'RISK_ACCEPTANCE_REJECTED' AND NEW."from_status"::text = 'RISK_ACCEPTANCE_PENDING' AND NEW."to_status"::text = 'ASSESSING')
    OR (NEW."type"::text = 'CLOSED' AND NEW."from_status"::text IN ('MITIGATED', 'ACCEPTED_RISK') AND NEW."to_status"::text = 'CLOSED')
    OR (NEW."type"::text = 'REFRESHED' AND NEW."from_status"::text <> 'CLOSED' AND NEW."to_status"::text = 'OPEN');
  IF NOT v_valid_transition THEN
    RAISE EXCEPTION 'impact disposition must follow the frozen state machine' USING ERRCODE = '23514';
  END IF;

  NEW."created_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_project_impact_insert() RETURNS trigger AS $$
DECLARE
  v_recall RECORD;
  v_event RECORD;
BEGIN
  IF NEW."source_type"::text = 'RECALL' THEN
    SELECT * INTO v_recall FROM "asset_release_recalls"
     WHERE "id" = NEW."recall_id" AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
    IF NOT FOUND OR NEW."technical_asset_event_id" IS NOT NULL
      OR NEW."source_key" IS DISTINCT FROM 'RECALL:' || v_recall."id" THEN
      RAISE EXCEPTION 'recall impact must bind its exact recall source' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT event.* INTO v_event FROM "technical_asset_events" event
      JOIN "technical_assets" asset
        ON asset."id" = event."technical_asset_id" AND asset."rnd_project_id" = event."rnd_project_id"
     WHERE event."id" = NEW."technical_asset_event_id"
       AND event."technical_asset_id" = NEW."technical_asset_id"
       AND event."event_type"::text = 'STATUS_CHANGED'
       AND event."from_status"::text = 'VALIDATED' AND event."to_status"::text = 'DISABLED'
       AND asset."status"::text = 'DISABLED'
     FOR UPDATE OF event, asset;
    IF NOT FOUND OR NEW."recall_id" IS NOT NULL
      OR NEW."source_key" IS DISTINCT FROM 'ASSET_DEACTIVATION:' || v_event."id" THEN
      RAISE EXCEPTION 'deactivation impact must bind its exact VALIDATED to DISABLED event' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_impact_alert_projection_attempt_insert() RETURNS trigger AS $$
BEGIN
  NEW."created_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_impact_assessment_revision_insert() RETURNS trigger AS $$
DECLARE
  v_impact RECORD;
  v_previous RECORD;
  v_actor_membership RECORD;
  v_owner_membership RECORD;
  v_recall_revision RECORD;
  v_deactivation_event RECORD;
  v_max_sequence INTEGER;
BEGIN
  SELECT * INTO v_impact FROM "asset_project_impacts"
   WHERE "id" = NEW."impact_id" AND "project_id" = NEW."project_id"
     AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'asset impact assessment parent not found' USING ERRCODE = '23514';
  END IF;
  IF v_impact."source_type"::text = 'RECALL' THEN
    SELECT * INTO v_recall_revision FROM "asset_release_recall_revisions"
     WHERE "id" = NEW."recall_revision_id" AND "recall_id" = NEW."recall_id"
       AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
    IF NOT FOUND OR NEW."recall_id" IS DISTINCT FROM v_impact."recall_id"
      OR NEW."recall_revision_id" IS NULL
      OR NEW."snapshot_json"->>'recallId' IS DISTINCT FROM v_impact."recall_id"
      OR NEW."snapshot_json"->>'recallRevisionId' IS DISTINCT FROM v_recall_revision."id"
      OR NEW."snapshot_json"->>'recallRevisionNumber' IS DISTINCT FROM v_recall_revision."revision"::text
      OR NEW."snapshot_json"->>'recallRevisionSnapshotChecksum' IS DISTINCT FROM v_recall_revision."snapshot_checksum"
      OR NEW."snapshot_json"->>'recallRevisionKind' IS DISTINCT FROM v_recall_revision."kind"::text
      OR NEW."snapshot_json"->>'recallRevisionState' IS DISTINCT FROM v_recall_revision."state"::text
      OR NEW."snapshot_json"->>'sourceWatermark' IS DISTINCT FROM NEW."source_watermark" THEN
      RAISE EXCEPTION 'recall impact assessment must bind its exact recall revision source facts' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO v_deactivation_event FROM "technical_asset_events"
     WHERE "id" = v_impact."technical_asset_event_id"
       AND "technical_asset_id" = NEW."technical_asset_id"
       AND "event_type"::text = 'STATUS_CHANGED'
       AND "from_status"::text = 'VALIDATED' AND "to_status"::text = 'DISABLED' FOR UPDATE;
    IF NOT FOUND OR NEW."recall_id" IS NOT NULL OR NEW."recall_revision_id" IS NOT NULL
      OR NEW."snapshot_json"->>'technicalAssetEventId' IS DISTINCT FROM v_deactivation_event."id"
      OR NEW."snapshot_json"->>'technicalAssetId' IS DISTINCT FROM NEW."technical_asset_id"
      OR NEW."snapshot_json"->>'eventSequence' IS DISTINCT FROM v_deactivation_event."sequence"::text
      OR NEW."snapshot_json"->>'fromStatus' IS DISTINCT FROM 'VALIDATED'
      OR NEW."snapshot_json"->>'toStatus' IS DISTINCT FROM 'DISABLED'
      OR NEW."snapshot_json"->'eventSnapshot' IS DISTINCT FROM v_deactivation_event."snapshot_json"
      OR NEW."snapshot_json"->>'sourceWatermark' IS DISTINCT FROM NEW."source_watermark" THEN
      RAISE EXCEPTION 'deactivation impact assessment must bind its exact disabled event source facts' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT coalesce(max("sequence"), 0) INTO v_max_sequence
    FROM "asset_impact_assessment_revisions" WHERE "impact_id" = NEW."impact_id";
  IF NEW."sequence" <> v_max_sequence + 1 THEN
    RAISE EXCEPTION 'impact assessment must advance sequence exactly once' USING ERRCODE = '23514';
  END IF;
  IF v_max_sequence = 0 THEN
    IF NEW."kind"::text <> 'INITIAL' OR v_impact."current_assessment_revision_id" IS NOT NULL THEN
      RAISE EXCEPTION 'first impact assessment must be INITIAL with an empty current pointer' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO v_previous FROM "asset_impact_assessment_revisions"
     WHERE "impact_id" = NEW."impact_id" AND "sequence" = v_max_sequence;
    IF NEW."kind"::text <> 'REFRESH' OR NEW."actor_id" IS NULL
      OR v_impact."current_assessment_revision_id" IS DISTINCT FROM v_previous."id" THEN
      RAISE EXCEPTION 'impact assessment refresh requires the previous exact current revision' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."actor_id" IS NOT NULL THEN
    SELECT * INTO v_actor_membership FROM "project_members"
     WHERE "id" = NEW."actor_membership_id" AND "project_id" = NEW."project_id"
       AND "user_id" = NEW."actor_id" AND "left_at" IS NULL FOR UPDATE;
    IF NOT FOUND OR NEW."actor_membership_snapshot_json"->>'membershipId' IS DISTINCT FROM v_actor_membership."id"
      OR NEW."actor_membership_snapshot_json"->>'userId' IS DISTINCT FROM v_actor_membership."user_id"
      OR NEW."actor_membership_snapshot_json"->>'projectRole' IS DISTINCT FROM v_actor_membership."project_role"::text THEN
      RAISE EXCEPTION 'impact assessment actor must freeze an active membership belonging to the actor' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."actor_membership_id" IS NOT NULL OR NEW."actor_membership_snapshot_json" IS NOT NULL THEN
    RAISE EXCEPTION 'system impact assessment cannot claim an actor membership' USING ERRCODE = '23514';
  END IF;
  IF NEW."owner_membership_id" IS NOT NULL THEN
    SELECT * INTO v_owner_membership FROM "project_members"
     WHERE "id" = NEW."owner_membership_id" AND "project_id" = NEW."project_id"
       AND "project_role"::text = 'PROJECT_MANAGER' AND "left_at" IS NULL FOR UPDATE;
    IF NOT FOUND OR NEW."owner_membership_snapshot_json"->>'membershipId' IS DISTINCT FROM v_owner_membership."id"
      OR NEW."owner_membership_snapshot_json"->>'userId' IS DISTINCT FROM v_owner_membership."user_id"
      OR NEW."owner_membership_snapshot_json"->>'projectRole' IS DISTINCT FROM v_owner_membership."project_role"::text
      OR NEW."due_at" IS NULL OR NEW."due_at" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') THEN
      RAISE EXCEPTION 'impact assessment owner must freeze an active project-manager membership and future due date' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."owner_membership_snapshot_json" IS NOT NULL OR NEW."due_at" IS NOT NULL THEN
    RAISE EXCEPTION 'unassigned impact assessment cannot claim owner or due-date facts' USING ERRCODE = '23514';
  END IF;
  NEW."frozen_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  NEW."created_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_asset_project_impact_complete() RETURNS trigger AS $$
DECLARE
  v_impact RECORD;
  v_initial RECORD;
BEGIN
  SELECT * INTO v_impact FROM "asset_project_impacts"
   WHERE "id" = NEW."id" AND "project_id" = NEW."project_id"
     AND "technical_asset_id" = NEW."technical_asset_id";
  SELECT * INTO v_initial FROM "asset_impact_assessment_revisions"
   WHERE "id" = v_impact."current_assessment_revision_id" AND "impact_id" = v_impact."id"
     AND "project_id" = v_impact."project_id" AND "technical_asset_id" = v_impact."technical_asset_id"
     AND "sequence" = 1 AND "kind"::text = 'INITIAL';
  IF v_impact."current_assessment_revision_id" IS NULL OR NOT FOUND
    OR v_impact."status"::text <> 'OPEN' OR v_impact."version" <> 1
    OR v_impact."owner_membership_id" IS DISTINCT FROM v_initial."owner_membership_id"
    OR v_impact."due_at" IS DISTINCT FROM v_initial."due_at" THEN
    RAISE EXCEPTION 'asset project impact requires an exact INITIAL assessment before commit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_project_impact_mutation() RETURNS trigger AS $$
DECLARE v_disposition RECORD; v_assessment RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'asset project impacts cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."technical_asset_id" IS DISTINCT FROM OLD."technical_asset_id" OR NEW."source_type" IS DISTINCT FROM OLD."source_type"
    OR NEW."source_key" IS DISTINCT FROM OLD."source_key" OR NEW."recall_id" IS DISTINCT FROM OLD."recall_id"
    OR NEW."technical_asset_event_id" IS DISTINCT FROM OLD."technical_asset_event_id" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'asset project impact source facts are immutable' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_assessment FROM "asset_impact_assessment_revisions"
   WHERE "id" = NEW."current_assessment_revision_id" AND "impact_id" = OLD."id"
     AND "project_id" = OLD."project_id" AND "technical_asset_id" = OLD."technical_asset_id";
  IF OLD."current_assessment_revision_id" IS NULL AND FOUND AND v_assessment."sequence" = 1
    AND v_assessment."kind"::text = 'INITIAL' AND NEW."status" IS NOT DISTINCT FROM OLD."status"
    AND NEW."owner_membership_id" IS NOT DISTINCT FROM v_assessment."owner_membership_id"
    AND NEW."due_at" IS NOT DISTINCT FROM v_assessment."due_at" AND NEW."version" = OLD."version" THEN
    NEW."updated_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
    RETURN NEW;
  END IF;
  SELECT * INTO v_disposition FROM "asset_impact_dispositions"
   WHERE "impact_id" = OLD."id" ORDER BY "sequence" DESC LIMIT 1;
  IF NOT FOUND OR v_disposition."from_status" IS DISTINCT FROM OLD."status"
    OR v_disposition."to_status" IS DISTINCT FROM NEW."status"
    OR v_disposition."assessment_revision_id" IS DISTINCT FROM NEW."current_assessment_revision_id"
    OR v_assessment."owner_membership_id" IS DISTINCT FROM NEW."owner_membership_id"
    OR v_assessment."due_at" IS DISTINCT FROM NEW."due_at"
    OR v_disposition."owner_membership_id" IS DISTINCT FROM v_assessment."owner_membership_id"
    OR v_disposition."due_at" IS DISTINCT FROM v_assessment."due_at"
    OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'asset project impact update requires its exact latest assessment and disposition facts' USING ERRCODE = '23514';
  END IF;
  NEW."updated_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_asset_impact_disposition_applied() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "asset_project_impacts"
     WHERE "id" = NEW."impact_id" AND "project_id" = NEW."project_id"
       AND "technical_asset_id" = NEW."technical_asset_id" AND "status" = NEW."to_status"
       AND "current_assessment_revision_id" = NEW."assessment_revision_id"
       AND "owner_membership_id" = NEW."owner_membership_id" AND "due_at" = NEW."due_at"
  ) THEN
    RAISE EXCEPTION 'impact disposition must be applied to its aggregate before commit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_asset_impact_assessment_applied() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "asset_project_impacts"
     WHERE "id" = NEW."impact_id" AND "project_id" = NEW."project_id"
       AND "technical_asset_id" = NEW."technical_asset_id" AND "current_assessment_revision_id" = NEW."id"
       AND "owner_membership_id" IS NOT DISTINCT FROM NEW."owner_membership_id"
       AND "due_at" IS NOT DISTINCT FROM NEW."due_at"
  ) THEN
    RAISE EXCEPTION 'impact assessment must become the exact current pointer before commit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_impact_risk_request_insert() RETURNS trigger AS $$
DECLARE
  v_impact RECORD;
  v_membership RECORD;
  v_source_actor_id TEXT;
BEGIN
  SELECT * INTO v_impact FROM "asset_project_impacts"
   WHERE "id" = NEW."impact_id" AND "project_id" = NEW."project_id"
     AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
  IF NOT FOUND OR v_impact."status"::text NOT IN ('ASSESSING', 'UPGRADE_PLANNED') THEN
    RAISE EXCEPTION 'risk acceptance request requires an assessing or upgrade-planned impact' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_membership FROM "project_members"
   WHERE "id" = NEW."requested_membership_id" AND "project_id" = NEW."project_id"
     AND "user_id" = NEW."requested_by_id" AND "project_role"::text = 'PROJECT_MANAGER'
     AND "left_at" IS NULL FOR UPDATE;
  IF NOT FOUND OR NEW."requested_membership_snapshot_json"->>'membershipId' IS DISTINCT FROM v_membership."id"
    OR NEW."requested_membership_snapshot_json"->>'userId' IS DISTINCT FROM v_membership."user_id"
    OR NEW."requested_membership_snapshot_json"->>'projectRole' IS DISTINCT FROM v_membership."project_role"::text THEN
    RAISE EXCEPTION 'risk acceptance requestor must freeze an active project-manager membership' USING ERRCODE = '23514';
  END IF;
  IF v_impact."source_type"::text = 'RECALL' THEN
    SELECT revision."actor_id" INTO v_source_actor_id FROM "asset_release_recalls" recall
      JOIN "asset_release_recall_revisions" revision ON revision."id" = recall."current_revision_id"
     WHERE recall."id" = v_impact."recall_id" AND recall."technical_asset_id" = NEW."technical_asset_id"
     FOR UPDATE OF recall, revision;
  ELSE
    SELECT "actor_id" INTO v_source_actor_id FROM "technical_asset_events"
     WHERE "id" = v_impact."technical_asset_event_id" AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
  END IF;
  IF v_source_actor_id IS NULL OR NEW."source_actor_id" IS DISTINCT FROM v_source_actor_id
    OR NEW."source_actor_snapshot_json"->>'actorId' IS DISTINCT FROM v_source_actor_id
    OR NEW."status"::text <> 'PENDING' OR NEW."version" <> 1 THEN
    RAISE EXCEPTION 'risk acceptance request must freeze its exact source actor and initial state' USING ERRCODE = '23514';
  END IF;
  NEW."requested_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  NEW."created_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  NEW."updated_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_impact_risk_decision_insert() RETURNS trigger AS $$
DECLARE
  v_request RECORD;
  v_impact RECORD;
  v_membership RECORD;
  v_owner_user_id TEXT;
  v_technical_asset_owner_id TEXT;
BEGIN
  SELECT * INTO v_request FROM "asset_impact_risk_acceptance_requests"
   WHERE "id" = NEW."request_id" AND "impact_id" = NEW."impact_id"
     AND "project_id" = NEW."project_id" AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
  SELECT * INTO v_impact FROM "asset_project_impacts"
   WHERE "id" = NEW."impact_id" AND "project_id" = NEW."project_id"
     AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
  IF v_request."status"::text <> 'PENDING' OR v_impact."status"::text <> 'RISK_ACCEPTANCE_PENDING' THEN
    RAISE EXCEPTION 'risk acceptance decision requires its exact pending request and impact' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_membership FROM "project_members"
   WHERE "id" = NEW."actor_membership_id" AND "project_id" = NEW."project_id"
     AND "user_id" = NEW."actor_id" AND "project_role"::text IN ('QUALITY', 'DEPARTMENT_LEAD')
     AND "left_at" IS NULL FOR UPDATE;
  IF NOT FOUND OR NEW."actor_membership_snapshot_json"->>'membershipId' IS DISTINCT FROM v_membership."id"
    OR NEW."actor_membership_snapshot_json"->>'userId' IS DISTINCT FROM v_membership."user_id"
    OR NEW."actor_membership_snapshot_json"->>'projectRole' IS DISTINCT FROM v_membership."project_role"::text THEN
    RAISE EXCEPTION 'risk acceptance approver must freeze an active quality or department-lead membership' USING ERRCODE = '23514';
  END IF;
  IF v_impact."owner_membership_id" IS NOT NULL THEN
    SELECT "user_id" INTO v_owner_user_id FROM "project_members"
     WHERE "id" = v_impact."owner_membership_id" AND "project_id" = NEW."project_id" FOR UPDATE;
  END IF;
  SELECT "owner_id" INTO v_technical_asset_owner_id FROM "technical_assets"
   WHERE "id" = NEW."technical_asset_id" FOR UPDATE;
  IF NEW."actor_id" = v_request."requested_by_id" OR NEW."actor_id" = v_request."source_actor_id"
    OR NEW."actor_id" = v_owner_user_id OR NEW."actor_id" = v_technical_asset_owner_id THEN
    RAISE EXCEPTION 'risk acceptance approver must be independent' USING ERRCODE = '23514';
  END IF;
  NEW."decided_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  NEW."created_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_impact_risk_request_mutation() RETURNS trigger AS $$
DECLARE v_decision RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'risk acceptance requests cannot be deleted' USING ERRCODE = '55000'; END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."impact_id" IS DISTINCT FROM OLD."impact_id" OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."technical_asset_id" IS DISTINCT FROM OLD."technical_asset_id" OR NEW."requested_by_id" IS DISTINCT FROM OLD."requested_by_id"
    OR NEW."requested_membership_id" IS DISTINCT FROM OLD."requested_membership_id"
    OR NEW."requested_membership_snapshot_json" IS DISTINCT FROM OLD."requested_membership_snapshot_json"
    OR NEW."source_actor_id" IS DISTINCT FROM OLD."source_actor_id"
    OR NEW."source_actor_snapshot_json" IS DISTINCT FROM OLD."source_actor_snapshot_json"
    OR NEW."evidence_json" IS DISTINCT FROM OLD."evidence_json" OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR OLD."status"::text <> 'PENDING' OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'risk acceptance request only supports PENDING to APPROVED or REJECTED' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_decision FROM "asset_impact_risk_acceptance_decisions"
   WHERE "request_id" = OLD."id" AND "impact_id" = OLD."impact_id" AND "project_id" = OLD."project_id"
     AND "technical_asset_id" = OLD."technical_asset_id";
  IF NOT FOUND OR NEW."status"::text IS DISTINCT FROM v_decision."decision"::text THEN
    RAISE EXCEPTION 'risk acceptance request update must bind its exact decision fact' USING ERRCODE = '23514';
  END IF;
  NEW."updated_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_asset_impact_risk_request_applied() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM "asset_impact_risk_acceptance_requests" request
      JOIN "asset_impact_dispositions" disposition
        ON disposition."risk_acceptance_request_id" = request."id"
       AND disposition."impact_id" = request."impact_id"
       AND disposition."project_id" = request."project_id"
       AND disposition."technical_asset_id" = request."technical_asset_id"
      JOIN "asset_project_impacts" impact
        ON impact."id" = request."impact_id" AND impact."project_id" = request."project_id"
       AND impact."technical_asset_id" = request."technical_asset_id"
     WHERE request."id" = NEW."id" AND request."impact_id" = NEW."impact_id"
       AND request."project_id" = NEW."project_id" AND request."technical_asset_id" = NEW."technical_asset_id"
       AND request."status"::text = 'PENDING'
       AND disposition."type"::text = 'RISK_ACCEPTANCE_REQUESTED'
       AND disposition."risk_acceptance_decision_id" IS NULL
       AND disposition."from_status"::text IN ('ASSESSING', 'UPGRADE_PLANNED')
       AND disposition."to_status"::text = 'RISK_ACCEPTANCE_PENDING'
       AND impact."status"::text = 'RISK_ACCEPTANCE_PENDING'
       AND impact."current_assessment_revision_id" = disposition."assessment_revision_id"
  ) THEN
    RAISE EXCEPTION 'risk acceptance request requires its exact pending disposition and impact before commit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_asset_impact_risk_decision_applied() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM "asset_impact_risk_acceptance_requests" request
      JOIN "asset_impact_dispositions" disposition
        ON disposition."risk_acceptance_decision_id" = NEW."id"
       AND disposition."risk_acceptance_request_id" = request."id"
       AND disposition."impact_id" = request."impact_id"
       AND disposition."project_id" = request."project_id"
       AND disposition."technical_asset_id" = request."technical_asset_id"
      JOIN "asset_project_impacts" impact
        ON impact."id" = request."impact_id" AND impact."project_id" = request."project_id"
       AND impact."technical_asset_id" = request."technical_asset_id"
     WHERE request."id" = NEW."request_id" AND request."impact_id" = NEW."impact_id"
       AND request."project_id" = NEW."project_id" AND request."technical_asset_id" = NEW."technical_asset_id"
       AND request."status"::text = NEW."decision"::text
       AND disposition."from_status"::text = 'RISK_ACCEPTANCE_PENDING'
       AND (
         (NEW."decision"::text = 'APPROVED'
           AND disposition."type"::text = 'RISK_ACCEPTANCE_APPROVED'
           AND disposition."to_status"::text = 'ACCEPTED_RISK'
           AND impact."status"::text = 'ACCEPTED_RISK')
         OR (NEW."decision"::text = 'REJECTED'
           AND disposition."type"::text = 'RISK_ACCEPTANCE_REJECTED'
           AND disposition."to_status"::text = 'ASSESSING'
           AND impact."status"::text = 'ASSESSING')
       )
       AND impact."current_assessment_revision_id" = disposition."assessment_revision_id"
  ) THEN
    RAISE EXCEPTION 'risk acceptance decision requires its exact request update, disposition, and impact before commit' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_upgrade_candidate_insert() RETURNS trigger AS $$
DECLARE
  v_rnd_project_id TEXT;
  v_rnd_status TEXT;
  v_asset_status TEXT;
  source_version RECORD;
  target_version RECORD;
BEGIN
  SELECT "rnd_project_id" INTO v_rnd_project_id FROM "technical_assets" WHERE "id" = NEW."technical_asset_id";
  SELECT "status"::text INTO v_rnd_status FROM "rnd_projects" WHERE "id" = v_rnd_project_id FOR UPDATE;
  SELECT "status"::text INTO v_asset_status FROM "technical_assets" WHERE "id" = NEW."technical_asset_id" FOR UPDATE;
  PERFORM 1 FROM "asset_releases"
   WHERE "id" IN (NEW."source_asset_release_id", NEW."target_asset_release_id")
     AND "technical_asset_id" = NEW."technical_asset_id" ORDER BY "id" FOR UPDATE;
  PERFORM 1 FROM "asset_release_versions"
   WHERE "id" IN (NEW."source_asset_release_version_id", NEW."target_asset_release_version_id")
     AND "technical_asset_id" = NEW."technical_asset_id" ORDER BY "id" FOR UPDATE;
  SELECT * INTO source_version FROM "asset_release_versions"
   WHERE "id" = NEW."source_asset_release_version_id" AND "release_id" = NEW."source_asset_release_id"
     AND "technical_asset_id" = NEW."technical_asset_id";
  SELECT * INTO target_version FROM "asset_release_versions"
   WHERE "id" = NEW."target_asset_release_version_id" AND "release_id" = NEW."target_asset_release_id"
     AND "technical_asset_id" = NEW."technical_asset_id";
  IF source_version."id" IS NULL OR target_version."id" IS NULL
    OR v_rnd_status IN ('COMPLETED', 'CANCELED') OR v_asset_status IN ('CANCELED', 'DISABLED')
    OR source_version."status"::text NOT IN ('PUBLISHED', 'SUPERSEDED')
    OR target_version."status"::text <> 'PUBLISHED'
    OR NEW."source_revision" IS DISTINCT FROM source_version."revision"
    OR NEW."source_snapshot_checksum" IS DISTINCT FROM source_version."snapshot_checksum"
    OR NEW."source_watermark" IS DISTINCT FROM source_version."source_watermark"
    OR NEW."target_revision" IS DISTINCT FROM target_version."revision"
    OR NEW."target_snapshot_checksum" IS DISTINCT FROM target_version."snapshot_checksum"
    OR NEW."target_watermark" IS DISTINCT FROM target_version."source_watermark" THEN
    RAISE EXCEPTION 'upgrade candidate must freeze exact allowed source and target ReleaseVersion facts' USING ERRCODE = '23514';
  END IF;
  NEW."created_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_upgrade_adoption_insert() RETURNS trigger AS $$
DECLARE
  v_rnd_project_id TEXT;
  v_rnd_status TEXT;
  v_asset_status TEXT;
  v_target_release_status TEXT;
  v_candidate RECORD;
  v_project_status TEXT;
  v_impact RECORD;
  v_source_reference RECORD;
  v_target_reference RECORD;
BEGIN
  SELECT "status"::text INTO v_project_status FROM "projects" WHERE "id" = NEW."project_id" FOR UPDATE;
  PERFORM 1 FROM "project_asset_references"
   WHERE "id" IN (NEW."source_reference_id", NEW."target_reference_id")
     AND "project_id" = NEW."project_id" AND "technical_asset_id" = NEW."technical_asset_id"
   ORDER BY "id" FOR UPDATE;
  SELECT * INTO v_source_reference FROM "project_asset_references"
   WHERE "id" = NEW."source_reference_id" AND "project_id" = NEW."project_id"
     AND "technical_asset_id" = NEW."technical_asset_id";
  SELECT * INTO v_target_reference FROM "project_asset_references"
   WHERE "id" = NEW."target_reference_id" AND "project_id" = NEW."project_id"
     AND "technical_asset_id" = NEW."technical_asset_id";
  PERFORM 1 FROM "project_asset_usages"
   WHERE "reference_id" = NEW."source_reference_id" AND "project_id" = NEW."project_id"
     AND "status"::text = 'ACTIVE' ORDER BY "id" FOR UPDATE;
  SELECT "rnd_project_id" INTO v_rnd_project_id FROM "technical_assets" WHERE "id" = NEW."technical_asset_id";
  SELECT "status"::text INTO v_rnd_status FROM "rnd_projects" WHERE "id" = v_rnd_project_id FOR UPDATE;
  SELECT "status"::text INTO v_asset_status FROM "technical_assets" WHERE "id" = NEW."technical_asset_id" FOR UPDATE;
  PERFORM 1 FROM "asset_releases"
   WHERE "id" IN (NEW."source_asset_release_id", NEW."target_asset_release_id")
     AND "technical_asset_id" = NEW."technical_asset_id" ORDER BY "id" FOR UPDATE;
  PERFORM 1 FROM "asset_release_versions"
   WHERE "id" IN (NEW."source_asset_release_version_id", NEW."target_asset_release_version_id")
     AND "technical_asset_id" = NEW."technical_asset_id" ORDER BY "id" FOR UPDATE;
  SELECT "status"::text INTO v_target_release_status FROM "asset_release_versions"
   WHERE "id" = NEW."target_asset_release_version_id" AND "release_id" = NEW."target_asset_release_id"
     AND "technical_asset_id" = NEW."technical_asset_id";
  PERFORM 1 FROM "asset_release_recalls" recall
    JOIN "asset_release_recall_revisions" revision ON revision."id" = recall."current_revision_id"
    JOIN "asset_release_recall_affected_versions" affected ON affected."recall_id" = recall."id"
   WHERE recall."technical_asset_id" = NEW."technical_asset_id" AND recall."current_state"::text = 'ACTIVE'
     AND revision."state"::text = 'ACTIVE' AND affected."asset_release_version_id" = NEW."target_asset_release_version_id"
   ORDER BY recall."id" FOR UPDATE OF recall, revision;
  IF FOUND THEN
    RAISE EXCEPTION 'upgrade adoption target release version is actively recalled' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_candidate FROM "asset_upgrade_candidates"
   WHERE "id" = NEW."candidate_id" AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
  SELECT * INTO v_impact FROM "asset_project_impacts"
   WHERE "id" = NEW."impact_id" AND "project_id" = NEW."project_id"
     AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
  IF v_candidate."id" IS NULL OR v_impact."id" IS NULL OR v_source_reference."id" IS NULL OR v_target_reference."id" IS NULL
    OR v_project_status IN ('CLOSED', 'CANCELED') OR v_impact."status"::text <> 'UPGRADE_PLANNED'
    OR v_rnd_status IN ('COMPLETED', 'CANCELED') OR v_asset_status IN ('CANCELED', 'DISABLED') OR v_target_release_status <> 'PUBLISHED'
    OR v_source_reference."status"::text <> 'ACTIVE' OR v_target_reference."status"::text <> 'ACTIVE'
    OR NEW."source_reference_id" = NEW."target_reference_id"
    OR NEW."source_reference_version" IS DISTINCT FROM v_source_reference."version"
    OR NEW."target_reference_version" IS DISTINCT FROM v_target_reference."version"
    OR NEW."source_asset_release_id" IS DISTINCT FROM v_candidate."source_asset_release_id"
    OR NEW."source_asset_release_version_id" IS DISTINCT FROM v_candidate."source_asset_release_version_id"
    OR NEW."source_revision" IS DISTINCT FROM v_candidate."source_revision"
    OR NEW."source_snapshot_checksum" IS DISTINCT FROM v_candidate."source_snapshot_checksum"
    OR NEW."source_watermark" IS DISTINCT FROM v_candidate."source_watermark"
    OR NEW."target_asset_release_id" IS DISTINCT FROM v_candidate."target_asset_release_id"
    OR NEW."target_asset_release_version_id" IS DISTINCT FROM v_candidate."target_asset_release_version_id"
    OR NEW."target_revision" IS DISTINCT FROM v_candidate."target_revision"
    OR NEW."target_snapshot_checksum" IS DISTINCT FROM v_candidate."target_snapshot_checksum"
    OR NEW."target_watermark" IS DISTINCT FROM v_candidate."target_watermark"
    OR v_source_reference."asset_release_id" IS DISTINCT FROM v_candidate."source_asset_release_id"
    OR v_source_reference."asset_release_version_id" IS DISTINCT FROM v_candidate."source_asset_release_version_id"
    OR v_source_reference."release_revision" IS DISTINCT FROM v_candidate."source_revision"
    OR v_source_reference."snapshot_checksum" IS DISTINCT FROM v_candidate."source_snapshot_checksum"
    OR v_source_reference."source_watermark" IS DISTINCT FROM v_candidate."source_watermark"
    OR v_target_reference."asset_release_id" IS DISTINCT FROM v_candidate."target_asset_release_id"
    OR v_target_reference."asset_release_version_id" IS DISTINCT FROM v_candidate."target_asset_release_version_id"
    OR v_target_reference."release_revision" IS DISTINCT FROM v_candidate."target_revision"
    OR v_target_reference."snapshot_checksum" IS DISTINCT FROM v_candidate."target_snapshot_checksum"
    OR v_target_reference."source_watermark" IS DISTINCT FROM v_candidate."target_watermark" THEN
    RAISE EXCEPTION 'upgrade adoption must bind exact candidate, impact, and source/target reference facts' USING ERRCODE = '23514';
  END IF;
  NEW."adopted_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  NEW."created_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_upgrade_usage_mapping_insert() RETURNS trigger AS $$
DECLARE adoption_row RECORD; source_usage RECORD; target_usage RECORD;
BEGIN
  SELECT * INTO adoption_row FROM "asset_upgrade_adoptions"
   WHERE "id" = NEW."adoption_id" AND "project_id" = NEW."project_id"
     AND "technical_asset_id" = NEW."technical_asset_id" FOR UPDATE;
  PERFORM 1 FROM "project_asset_usages"
   WHERE "id" IN (NEW."source_usage_id", NEW."target_usage_id")
     AND "project_id" = NEW."project_id" AND "technical_asset_id" = NEW."technical_asset_id"
   ORDER BY "id" FOR UPDATE;
  SELECT * INTO source_usage FROM "project_asset_usages"
   WHERE "id" = NEW."source_usage_id" AND "project_id" = NEW."project_id" AND "technical_asset_id" = NEW."technical_asset_id";
  SELECT * INTO target_usage FROM "project_asset_usages"
   WHERE "id" = NEW."target_usage_id" AND "project_id" = NEW."project_id" AND "technical_asset_id" = NEW."technical_asset_id";
  IF adoption_row."id" IS NULL OR source_usage."id" IS NULL OR target_usage."id" IS NULL
    OR NEW."source_reference_id" IS DISTINCT FROM adoption_row."source_reference_id"
    OR NEW."target_reference_id" IS DISTINCT FROM adoption_row."target_reference_id"
    OR NEW."source_asset_release_id" IS DISTINCT FROM adoption_row."source_asset_release_id"
    OR NEW."source_asset_release_version_id" IS DISTINCT FROM adoption_row."source_asset_release_version_id"
    OR NEW."target_asset_release_id" IS DISTINCT FROM adoption_row."target_asset_release_id"
    OR NEW."target_asset_release_version_id" IS DISTINCT FROM adoption_row."target_asset_release_version_id"
    OR source_usage."status"::text <> 'ACTIVE' OR target_usage."status"::text <> 'ACTIVE'
    OR NEW."source_usage_version" IS DISTINCT FROM source_usage."version"
    OR NEW."source_reference_id" IS DISTINCT FROM source_usage."reference_id"
    OR NEW."source_asset_release_id" IS DISTINCT FROM source_usage."asset_release_id"
    OR NEW."source_asset_release_version_id" IS DISTINCT FROM source_usage."asset_release_version_id"
    OR NEW."source_component_snapshot_id" IS DISTINCT FROM source_usage."component_snapshot_id"
    OR NEW."target_usage_version" IS DISTINCT FROM target_usage."version"
    OR NEW."target_usage_key" IS DISTINCT FROM target_usage."usage_key"
    OR NEW."target_reference_id" IS DISTINCT FROM target_usage."reference_id"
    OR NEW."target_asset_release_id" IS DISTINCT FROM target_usage."asset_release_id"
    OR NEW."target_asset_release_version_id" IS DISTINCT FROM target_usage."asset_release_version_id"
    OR NEW."target_component_snapshot_id" IS DISTINCT FROM target_usage."component_snapshot_id"
    OR (NEW."migration_mode"::text = 'COPY' AND (
      target_usage."quantity" IS DISTINCT FROM source_usage."quantity"
      OR target_usage."configuration_json" IS DISTINCT FROM source_usage."configuration_json"
      OR target_usage."scope_type" IS DISTINCT FROM source_usage."scope_type"
      OR target_usage."scope_id" IS DISTINCT FROM source_usage."scope_id"
      OR target_usage."delivery_unit_id" IS DISTINCT FROM source_usage."delivery_unit_id"
      OR target_usage."module_id" IS DISTINCT FROM source_usage."module_id"
    ))
    OR jsonb_typeof(NEW."mapping_snapshot_json"->'source') IS DISTINCT FROM 'object'
    OR jsonb_typeof(NEW."mapping_snapshot_json"->'target') IS DISTINCT FROM 'object'
    OR NEW."mapping_snapshot_json"->'source'->>'usageId' IS DISTINCT FROM source_usage."id"
    OR (NEW."mapping_snapshot_json"->'source'->>'usageVersion')::integer IS DISTINCT FROM source_usage."version"
    OR NEW."mapping_snapshot_json"->'source'->>'usageKey' IS DISTINCT FROM source_usage."usage_key"
    OR NEW."mapping_snapshot_json"->'source'->>'referenceId' IS DISTINCT FROM source_usage."reference_id"
    OR (NEW."mapping_snapshot_json"->'source'->>'referenceVersion')::integer IS DISTINCT FROM adoption_row."source_reference_version"
    OR NEW."mapping_snapshot_json"->'source'->>'releaseId' IS DISTINCT FROM source_usage."asset_release_id"
    OR NEW."mapping_snapshot_json"->'source'->>'releaseVersionId' IS DISTINCT FROM source_usage."asset_release_version_id"
    OR (NEW."mapping_snapshot_json"->'source'->>'revision')::integer IS DISTINCT FROM adoption_row."source_revision"
    OR NEW."mapping_snapshot_json"->'source'->>'snapshotChecksum' IS DISTINCT FROM adoption_row."source_snapshot_checksum"
    OR NEW."mapping_snapshot_json"->'source'->>'sourceWatermark' IS DISTINCT FROM adoption_row."source_watermark"
    OR NEW."mapping_snapshot_json"->'source'->>'componentSnapshotId' IS DISTINCT FROM source_usage."component_snapshot_id"
    OR (NEW."mapping_snapshot_json"->'source'->>'quantity')::numeric IS DISTINCT FROM source_usage."quantity"
    OR NEW."mapping_snapshot_json"->'source'->'configuration' IS DISTINCT FROM source_usage."configuration_json"
    OR NEW."mapping_snapshot_json"->'source'->>'scopeType' IS DISTINCT FROM source_usage."scope_type"::text
    OR NEW."mapping_snapshot_json"->'source'->>'scopeId' IS DISTINCT FROM source_usage."scope_id"
    OR NEW."mapping_snapshot_json"->'source'->>'deliveryUnitId' IS DISTINCT FROM source_usage."delivery_unit_id"
    OR NEW."mapping_snapshot_json"->'source'->>'moduleId' IS DISTINCT FROM source_usage."module_id"
    OR NEW."mapping_snapshot_json"->'target'->>'usageId' IS DISTINCT FROM target_usage."id"
    OR (NEW."mapping_snapshot_json"->'target'->>'usageVersion')::integer IS DISTINCT FROM target_usage."version"
    OR NEW."mapping_snapshot_json"->'target'->>'usageKey' IS DISTINCT FROM target_usage."usage_key"
    OR NEW."mapping_snapshot_json"->'target'->>'referenceId' IS DISTINCT FROM target_usage."reference_id"
    OR (NEW."mapping_snapshot_json"->'target'->>'referenceVersion')::integer IS DISTINCT FROM adoption_row."target_reference_version"
    OR NEW."mapping_snapshot_json"->'target'->>'releaseId' IS DISTINCT FROM target_usage."asset_release_id"
    OR NEW."mapping_snapshot_json"->'target'->>'releaseVersionId' IS DISTINCT FROM target_usage."asset_release_version_id"
    OR (NEW."mapping_snapshot_json"->'target'->>'revision')::integer IS DISTINCT FROM adoption_row."target_revision"
    OR NEW."mapping_snapshot_json"->'target'->>'snapshotChecksum' IS DISTINCT FROM adoption_row."target_snapshot_checksum"
    OR NEW."mapping_snapshot_json"->'target'->>'sourceWatermark' IS DISTINCT FROM adoption_row."target_watermark"
    OR NEW."mapping_snapshot_json"->'target'->>'componentSnapshotId' IS DISTINCT FROM target_usage."component_snapshot_id"
    OR (NEW."mapping_snapshot_json"->'target'->>'quantity')::numeric IS DISTINCT FROM target_usage."quantity"
    OR NEW."mapping_snapshot_json"->'target'->'configuration' IS DISTINCT FROM target_usage."configuration_json"
    OR NEW."mapping_snapshot_json"->'target'->>'scopeType' IS DISTINCT FROM target_usage."scope_type"::text
    OR NEW."mapping_snapshot_json"->'target'->>'scopeId' IS DISTINCT FROM target_usage."scope_id"
    OR NEW."mapping_snapshot_json"->'target'->>'deliveryUnitId' IS DISTINCT FROM target_usage."delivery_unit_id"
    OR NEW."mapping_snapshot_json"->'target'->>'moduleId' IS DISTINCT FROM target_usage."module_id"
    OR NEW."mapping_snapshot_json"->>'adoptionId' IS DISTINCT FROM NEW."adoption_id"
    OR NEW."mapping_snapshot_json"->>'sourceUsageId' IS DISTINCT FROM NEW."source_usage_id"
    OR NEW."mapping_snapshot_json"->>'targetUsageId' IS DISTINCT FROM NEW."target_usage_id"
    OR NEW."mapping_snapshot_json"->>'migrationMode' IS DISTINCT FROM NEW."migration_mode"::text THEN
    RAISE EXCEPTION 'upgrade usage mapping must freeze exact project/reference/release/version/component facts' USING ERRCODE = '23514';
  END IF;
  NEW."created_at" := (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION assert_asset_upgrade_adoption_complete() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "project_asset_references"
     WHERE "id" = NEW."source_reference_id" AND "project_id" = NEW."project_id" AND "status"::text = 'RETIRED'
  ) OR NOT EXISTS (
    SELECT 1 FROM "project_asset_references"
     WHERE "id" = NEW."target_reference_id" AND "project_id" = NEW."project_id" AND "status"::text = 'ACTIVE'
  ) OR EXISTS (
    SELECT 1 FROM "project_asset_usages" source_usage
     WHERE source_usage."reference_id" = NEW."source_reference_id" AND source_usage."project_id" = NEW."project_id"
       AND source_usage."created_at" <= NEW."adopted_at"
       AND (source_usage."retired_at" IS NULL OR source_usage."retired_at" >= NEW."adopted_at")
       AND (source_usage."status"::text <> 'RETIRED' OR NOT EXISTS (
         SELECT 1 FROM "asset_upgrade_usage_mappings" mapping
          WHERE mapping."adoption_id" = NEW."id" AND mapping."source_usage_id" = source_usage."id"
       ))
  ) OR EXISTS (
    SELECT 1 FROM "asset_upgrade_usage_mappings" mapping
      JOIN "project_asset_usages" target_usage ON target_usage."id" = mapping."target_usage_id"
     WHERE mapping."adoption_id" = NEW."id" AND (
       target_usage."reference_id" IS DISTINCT FROM NEW."target_reference_id"
       OR target_usage."project_id" IS DISTINCT FROM NEW."project_id"
       OR target_usage."status"::text <> 'ACTIVE'
     )
  ) THEN
    RAISE EXCEPTION 'upgrade adoption requires complete source usage mapping and atomic source retirement' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_project_asset_write_availability() RETURNS trigger AS $$
DECLARE
  v_project_id TEXT; v_technical_asset_id TEXT; v_asset_release_id TEXT; v_asset_release_version_id TEXT;
  v_component_snapshot_id TEXT; v_source_reference_id TEXT; v_source_usage_id TEXT; v_rnd_project_id TEXT;
  v_project_status TEXT; v_asset_status TEXT; v_rnd_status TEXT; v_release_version_status TEXT;
  v_reference RECORD; v_usage RECORD; v_release_version RECORD;
BEGIN
  v_project_id := NEW."project_id";
  IF TG_TABLE_NAME = 'project_asset_derivations' THEN
    v_technical_asset_id := NEW."source_technical_asset_id";
    v_asset_release_id := NEW."source_asset_release_id";
    v_asset_release_version_id := NEW."source_asset_release_version_id";
    v_component_snapshot_id := NEW."source_component_snapshot_id";
    v_source_reference_id := NEW."source_reference_id";
    v_source_usage_id := NEW."source_usage_id";
  ELSE
    v_technical_asset_id := NEW."technical_asset_id";
    v_asset_release_id := NEW."asset_release_id";
    v_asset_release_version_id := NEW."asset_release_version_id";
    IF TG_TABLE_NAME = 'project_asset_usages' THEN
      v_component_snapshot_id := NEW."component_snapshot_id";
      v_source_reference_id := NEW."reference_id";
    END IF;
  END IF;

  SELECT "status"::text INTO v_project_status FROM "projects" WHERE "id" = v_project_id FOR UPDATE;
  IF NOT FOUND OR v_project_status IN ('CLOSED', 'CANCELED') THEN
    RAISE EXCEPTION 'project is unavailable for new project asset facts' USING ERRCODE = '23514';
  END IF;
  IF v_source_reference_id IS NOT NULL THEN
    SELECT * INTO v_reference FROM "project_asset_references"
     WHERE "id" = v_source_reference_id AND "project_id" = v_project_id FOR UPDATE;
    IF NOT FOUND OR v_reference."status"::text <> 'ACTIVE'
      OR v_reference."technical_asset_id" IS DISTINCT FROM v_technical_asset_id
      OR v_reference."asset_release_id" IS DISTINCT FROM v_asset_release_id
      OR v_reference."asset_release_version_id" IS DISTINCT FROM v_asset_release_version_id THEN
      RAISE EXCEPTION 'project asset reference is not an exact active source fact' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF v_source_usage_id IS NOT NULL THEN
    SELECT * INTO v_usage FROM "project_asset_usages"
     WHERE "id" = v_source_usage_id AND "project_id" = v_project_id FOR UPDATE;
    IF NOT FOUND OR v_usage."status"::text <> 'ACTIVE'
      OR v_usage."reference_id" IS DISTINCT FROM v_source_reference_id
      OR v_usage."technical_asset_id" IS DISTINCT FROM v_technical_asset_id
      OR v_usage."asset_release_id" IS DISTINCT FROM v_asset_release_id
      OR v_usage."asset_release_version_id" IS DISTINCT FROM v_asset_release_version_id
      OR v_usage."component_snapshot_id" IS DISTINCT FROM v_component_snapshot_id THEN
      RAISE EXCEPTION 'project asset usage is not an exact active source fact' USING ERRCODE = '23514';
    END IF;
  END IF;
  SELECT "rnd_project_id" INTO v_rnd_project_id FROM "technical_assets" WHERE "id" = v_technical_asset_id;
  PERFORM 1 FROM "rnd_projects" WHERE "id" = v_rnd_project_id FOR UPDATE;
  SELECT "status"::text INTO v_asset_status FROM "technical_assets" WHERE "id" = v_technical_asset_id FOR UPDATE;
  SELECT "status"::text INTO v_rnd_status FROM "rnd_projects" WHERE "id" = v_rnd_project_id;
  IF NOT FOUND OR v_asset_status IN ('DISABLED', 'CANCELED')
    OR v_rnd_status IN ('COMPLETED', 'CANCELED') THEN
    RAISE EXCEPTION 'technical asset or R&D project is unavailable for new project asset facts' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM "asset_releases" WHERE "id" = v_asset_release_id AND "technical_asset_id" = v_technical_asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'asset release source facts not found' USING ERRCODE = '23514'; END IF;
  SELECT * INTO v_release_version FROM "asset_release_versions"
   WHERE "id" = v_asset_release_version_id AND "release_id" = v_asset_release_id AND "technical_asset_id" = v_technical_asset_id FOR UPDATE;
  v_release_version_status := v_release_version."status"::text;
  IF NOT FOUND OR v_release_version_status <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'new project asset facts require an exact PUBLISHED ReleaseVersion' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'project_asset_references' THEN
    IF NEW."release_revision" IS DISTINCT FROM v_release_version."revision"
      OR NEW."snapshot_checksum" IS DISTINCT FROM v_release_version."snapshot_checksum"
      OR NEW."source_watermark" IS DISTINCT FROM v_release_version."source_watermark" THEN
      RAISE EXCEPTION 'project asset reference must freeze exact ReleaseVersion facts' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'project_asset_usages' THEN
    IF NEW."release_revision" IS DISTINCT FROM v_reference."release_revision"
      OR NEW."snapshot_checksum" IS DISTINCT FROM v_reference."snapshot_checksum"
      OR NEW."source_watermark" IS DISTINCT FROM v_reference."source_watermark" THEN
      RAISE EXCEPTION 'project asset usage must freeze exact reference facts' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF v_component_snapshot_id IS NOT NULL THEN
    PERFORM 1 FROM "asset_component_snapshots"
     WHERE "id" = v_component_snapshot_id AND "release_version_id" = v_asset_release_version_id
       AND "technical_asset_id" = v_technical_asset_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'asset component source facts not found' USING ERRCODE = '23514'; END IF;
  END IF;
  PERFORM 1 FROM "asset_release_recalls" recall
    JOIN "asset_release_recall_revisions" revision ON revision."id" = recall."current_revision_id" AND revision."technical_asset_id" = recall."technical_asset_id"
    JOIN "asset_release_recall_affected_versions" affected ON affected."recall_id" = recall."id" AND affected."technical_asset_id" = recall."technical_asset_id"
   WHERE recall."technical_asset_id" = v_technical_asset_id
     AND recall."current_state"::text = 'ACTIVE' AND revision."state"::text = 'ACTIVE'
     AND affected."asset_release_version_id" = v_asset_release_version_id
  FOR UPDATE OF recall, revision;
  IF FOUND THEN RAISE EXCEPTION 'exact release version is subject to an active recall' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER asset_release_recalls_validate_insert BEFORE INSERT ON "asset_release_recalls" FOR EACH ROW EXECUTE FUNCTION validate_asset_release_recall_insert();
CREATE TRIGGER asset_release_recalls_validate_mutation BEFORE UPDATE OR DELETE ON "asset_release_recalls" FOR EACH ROW EXECUTE FUNCTION validate_asset_release_recall_mutation();
CREATE CONSTRAINT TRIGGER asset_release_recalls_require_complete AFTER INSERT OR UPDATE ON "asset_release_recalls" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_asset_release_recall_complete();
CREATE TRIGGER asset_release_recall_revisions_validate BEFORE INSERT ON "asset_release_recall_revisions" FOR EACH ROW EXECUTE FUNCTION validate_asset_release_recall_revision();
CREATE CONSTRAINT TRIGGER asset_release_recall_revisions_require_applied AFTER INSERT ON "asset_release_recall_revisions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_asset_release_recall_revision_applied();
CREATE TRIGGER asset_release_recall_revisions_reject_mutation BEFORE UPDATE OR DELETE ON "asset_release_recall_revisions" FOR EACH ROW EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_release_recall_affected_versions_validate BEFORE INSERT ON "asset_release_recall_affected_versions" FOR EACH ROW EXECUTE FUNCTION validate_asset_release_recall_affected_version();
CREATE TRIGGER asset_release_recall_affected_versions_reject_mutation BEFORE UPDATE OR DELETE ON "asset_release_recall_affected_versions" FOR EACH ROW EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_project_impacts_validate_insert BEFORE INSERT ON "asset_project_impacts" FOR EACH ROW EXECUTE FUNCTION validate_asset_project_impact_insert();
CREATE TRIGGER asset_project_impacts_validate_mutation BEFORE UPDATE OR DELETE ON "asset_project_impacts" FOR EACH ROW EXECUTE FUNCTION validate_asset_project_impact_mutation();
CREATE CONSTRAINT TRIGGER asset_project_impacts_require_complete AFTER INSERT ON "asset_project_impacts" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_asset_project_impact_complete();
CREATE TRIGGER asset_impact_assessment_revisions_validate_insert BEFORE INSERT ON "asset_impact_assessment_revisions" FOR EACH ROW EXECUTE FUNCTION validate_asset_impact_assessment_revision_insert();
CREATE CONSTRAINT TRIGGER asset_impact_assessment_revisions_require_applied AFTER INSERT ON "asset_impact_assessment_revisions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_asset_impact_assessment_applied();
CREATE TRIGGER asset_impact_dispositions_validate_insert BEFORE INSERT ON "asset_impact_dispositions" FOR EACH ROW EXECUTE FUNCTION validate_asset_impact_disposition_insert();
CREATE CONSTRAINT TRIGGER asset_impact_dispositions_require_applied AFTER INSERT ON "asset_impact_dispositions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_asset_impact_disposition_applied();
CREATE TRIGGER asset_impact_assessment_revisions_reject_mutation BEFORE UPDATE OR DELETE ON "asset_impact_assessment_revisions" FOR EACH ROW EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_impact_dispositions_reject_mutation BEFORE UPDATE OR DELETE ON "asset_impact_dispositions" FOR EACH ROW EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_impact_risk_requests_validate_insert BEFORE INSERT ON "asset_impact_risk_acceptance_requests" FOR EACH ROW EXECUTE FUNCTION validate_asset_impact_risk_request_insert();
CREATE CONSTRAINT TRIGGER asset_impact_risk_requests_require_applied AFTER INSERT ON "asset_impact_risk_acceptance_requests" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_asset_impact_risk_request_applied();
CREATE TRIGGER asset_impact_risk_requests_validate_mutation BEFORE UPDATE OR DELETE ON "asset_impact_risk_acceptance_requests" FOR EACH ROW EXECUTE FUNCTION validate_asset_impact_risk_request_mutation();
CREATE TRIGGER asset_impact_risk_decisions_validate_insert BEFORE INSERT ON "asset_impact_risk_acceptance_decisions" FOR EACH ROW EXECUTE FUNCTION validate_asset_impact_risk_decision_insert();
CREATE CONSTRAINT TRIGGER asset_impact_risk_decisions_require_applied AFTER INSERT ON "asset_impact_risk_acceptance_decisions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_asset_impact_risk_decision_applied();
CREATE TRIGGER asset_impact_risk_decisions_reject_mutation BEFORE UPDATE OR DELETE ON "asset_impact_risk_acceptance_decisions" FOR EACH ROW EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_upgrade_candidates_validate_insert BEFORE INSERT ON "asset_upgrade_candidates" FOR EACH ROW EXECUTE FUNCTION validate_asset_upgrade_candidate_insert();
CREATE TRIGGER asset_upgrade_candidates_reject_mutation BEFORE UPDATE OR DELETE ON "asset_upgrade_candidates" FOR EACH ROW EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_upgrade_adoptions_validate_insert BEFORE INSERT ON "asset_upgrade_adoptions" FOR EACH ROW EXECUTE FUNCTION validate_asset_upgrade_adoption_insert();
CREATE CONSTRAINT TRIGGER asset_upgrade_adoptions_require_complete AFTER INSERT ON "asset_upgrade_adoptions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_asset_upgrade_adoption_complete();
CREATE TRIGGER asset_upgrade_adoptions_reject_mutation BEFORE UPDATE OR DELETE ON "asset_upgrade_adoptions" FOR EACH ROW EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_upgrade_usage_mappings_validate_insert BEFORE INSERT ON "asset_upgrade_usage_mappings" FOR EACH ROW EXECUTE FUNCTION validate_asset_upgrade_usage_mapping_insert();
CREATE TRIGGER asset_upgrade_usage_mappings_reject_mutation BEFORE UPDATE OR DELETE ON "asset_upgrade_usage_mappings" FOR EACH ROW EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_impact_alert_projection_attempts_validate_insert BEFORE INSERT ON "asset_impact_alert_projection_attempts" FOR EACH ROW EXECUTE FUNCTION validate_asset_impact_alert_projection_attempt_insert();
CREATE TRIGGER asset_impact_alert_projection_attempts_reject_mutation BEFORE UPDATE OR DELETE ON "asset_impact_alert_projection_attempts" FOR EACH ROW EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER project_asset_references_write_availability BEFORE INSERT ON "project_asset_references" FOR EACH ROW EXECUTE FUNCTION validate_project_asset_write_availability();
CREATE TRIGGER project_asset_usages_write_availability BEFORE INSERT ON "project_asset_usages" FOR EACH ROW EXECUTE FUNCTION validate_project_asset_write_availability();
CREATE TRIGGER project_asset_derivations_write_availability BEFORE INSERT ON "project_asset_derivations" FOR EACH ROW EXECUTE FUNCTION validate_project_asset_write_availability();
CREATE TRIGGER asset_releases_insert_availability BEFORE INSERT ON "asset_releases" FOR EACH ROW EXECUTE FUNCTION validate_asset_release_insert_availability();
CREATE TRIGGER asset_release_versions_insert_availability BEFORE INSERT ON "asset_release_versions" FOR EACH ROW EXECUTE FUNCTION validate_asset_release_insert_availability();
CREATE CONSTRAINT TRIGGER technical_assets_require_deactivation_event AFTER UPDATE ON "technical_assets" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_technical_asset_deactivation_event();

CREATE TRIGGER asset_release_recalls_reject_truncate BEFORE TRUNCATE ON "asset_release_recalls" FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_release_recall_revisions_reject_truncate BEFORE TRUNCATE ON "asset_release_recall_revisions" FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_release_recall_affected_versions_reject_truncate BEFORE TRUNCATE ON "asset_release_recall_affected_versions" FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_project_impacts_reject_truncate BEFORE TRUNCATE ON "asset_project_impacts" FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_impact_assessment_revisions_reject_truncate BEFORE TRUNCATE ON "asset_impact_assessment_revisions" FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_impact_dispositions_reject_truncate BEFORE TRUNCATE ON "asset_impact_dispositions" FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_impact_risk_requests_reject_truncate BEFORE TRUNCATE ON "asset_impact_risk_acceptance_requests" FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_impact_risk_decisions_reject_truncate BEFORE TRUNCATE ON "asset_impact_risk_acceptance_decisions" FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_upgrade_candidates_reject_truncate BEFORE TRUNCATE ON "asset_upgrade_candidates" FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_upgrade_adoptions_reject_truncate BEFORE TRUNCATE ON "asset_upgrade_adoptions" FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_upgrade_usage_mappings_reject_truncate BEFORE TRUNCATE ON "asset_upgrade_usage_mappings" FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_064_append_only();
CREATE TRIGGER asset_impact_alert_projection_attempts_reject_truncate BEFORE TRUNCATE ON "asset_impact_alert_projection_attempts" FOR EACH STATEMENT EXECUTE FUNCTION reject_apm_064_append_only();

COMMIT;
