-- CreateEnum
CREATE TYPE "ArchiveSourceFormulaVersion" AS ENUM ('ARCHIVE.SOURCE@1', 'ARCHIVE.SOURCE@2');

-- CreateEnum
CREATE TYPE "RetrospectiveInputApplicability" AS ENUM ('APPLICABLE', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "RetrospectiveScopeType" AS ENUM ('PROJECT', 'DELIVERY_UNIT');

-- CreateEnum
CREATE TYPE "ProjectRetrospectiveStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "RetrospectiveReviewDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ClosurePolicyStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ClosurePolicyVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "KnowledgeEntryStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "KnowledgeEntryVersionStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'REJECTED', 'SUPERSEDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "KnowledgeReviewDecision" AS ENUM ('PUBLISH', 'REJECT');

-- CreateEnum
CREATE TYPE "KnowledgeReuseCorrectionType" AS ENUM ('TEXT_CORRECTION', 'USAGE_WITHDRAWN', 'SCOPE_CORRECTION');

-- APM104_LEGACY_DDL TYPE ArchiveManifestSourceType
ALTER TYPE "ArchiveManifestSourceType" ADD VALUE IF NOT EXISTS 'PROJECT_RETROSPECTIVE_VERSION';

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROJECT_RETROSPECTIVE_DRAFT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROJECT_RETROSPECTIVE_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROJECT_RETROSPECTIVE_REVIEWED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROJECT_CLOSURE_POLICY_UPGRADED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROJECT_CLOSURE_RECORD_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ENTRY_VERSION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ENTRY_REVIEWED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ENTRY_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_REUSE_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_REUSE_CORRECTED';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'PROJECT_RETROSPECTIVE';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'PROJECT_RETROSPECTIVE_VERSION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'PROJECT_CLOSURE_POLICY_VERSION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'PROJECT_CLOSURE_RECORD';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ENTRY';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ENTRY_VERSION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_REUSE_RECORD';

-- DropIndex
DROP INDEX "project_gate_definitions_project_id_code_key";

-- APM104_LEGACY_DDL TABLE project_archive_versions
ALTER TABLE public."project_archive_versions" ADD COLUMN     "archive_source_formula_version" "ArchiveSourceFormulaVersion" NOT NULL DEFAULT 'ARCHIVE.SOURCE@1',
ADD COLUMN     "retrospective_input_applicability" "RetrospectiveInputApplicability" NOT NULL DEFAULT 'NOT_APPLICABLE',
ADD COLUMN     "retrospective_input_snapshot_json" JSONB,
ADD COLUMN     "retrospective_input_watermark" TEXT,
ADD COLUMN     "retrospective_input_watermark_version" TEXT,
ALTER COLUMN "archive_source_formula_version" DROP DEFAULT,
ALTER COLUMN "retrospective_input_applicability" DROP DEFAULT,
ADD CONSTRAINT "archive_version_retrospective_input_check" CHECK (
  ("retrospective_input_applicability" = 'APPLICABLE'
    AND "retrospective_input_watermark_version" = 'RETROSPECTIVE.INPUT@1'
    AND "retrospective_input_snapshot_json" IS NOT NULL
    AND "retrospective_input_watermark" ~ '^[0-9a-f]{64}$')
  OR
  ("retrospective_input_applicability" = 'NOT_APPLICABLE'
    AND "retrospective_input_watermark_version" IS NULL
    AND "retrospective_input_snapshot_json" IS NULL
    AND "retrospective_input_watermark" IS NULL)
);

-- APM104_LEGACY_DDL TABLE project_gate_definitions
ALTER TABLE public."project_gate_definitions" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1;

-- APM104_LEGACY_DDL TABLE project_gate_instances
ALTER TABLE public."project_gate_instances" ADD COLUMN     "archive_source_formula_version" "ArchiveSourceFormulaVersion",
ADD COLUMN     "closure_policy_checksum" TEXT,
ADD COLUMN     "closure_policy_version_id" TEXT,
ADD CONSTRAINT "project_gate_policy_tuple_check" CHECK (
  ("closure_policy_version_id" IS NULL AND "archive_source_formula_version" IS NULL AND "closure_policy_checksum" IS NULL)
  OR
  ("closure_policy_version_id" IS NOT NULL AND "archive_source_formula_version" IS NOT NULL AND "closure_policy_checksum" ~ '^[0-9a-f]{64}$')
);

-- APM104_LEGACY_DDL TABLE gate_check_snapshots
ALTER TABLE public."gate_check_snapshots" ADD COLUMN     "archive_source_formula_version" "ArchiveSourceFormulaVersion",
ADD COLUMN     "closure_policy_checksum" TEXT,
ADD COLUMN     "closure_policy_version_id" TEXT,
ADD CONSTRAINT "gate_check_snapshot_policy_tuple_check" CHECK (
  ("closure_policy_version_id" IS NULL AND "archive_source_formula_version" IS NULL AND "closure_policy_checksum" IS NULL)
  OR
  ("closure_policy_version_id" IS NOT NULL AND "archive_source_formula_version" IS NOT NULL AND "closure_policy_checksum" ~ '^[0-9a-f]{64}$')
);

-- APM104_LEGACY_DDL TABLE gate_submissions
ALTER TABLE public."gate_submissions" ADD COLUMN     "archive_source_formula_version" "ArchiveSourceFormulaVersion",
ADD COLUMN     "closure_policy_checksum" TEXT,
ADD COLUMN     "closure_policy_version_id" TEXT,
ADD CONSTRAINT "gate_submission_policy_tuple_check" CHECK (
  ("closure_policy_version_id" IS NULL AND "archive_source_formula_version" IS NULL AND "closure_policy_checksum" IS NULL)
  OR
  ("closure_policy_version_id" IS NOT NULL AND "archive_source_formula_version" IS NOT NULL AND "closure_policy_checksum" ~ '^[0-9a-f]{64}$')
);

-- CreateTable
CREATE TABLE "project_retrospectives" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "current_version_id" TEXT,
    "latest_approved_version_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_retrospectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_retrospective_versions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "retrospective_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "supersedes_version_id" TEXT,
    "status" "ProjectRetrospectiveStatus" NOT NULL,
    "retrospective_input_archive_version_id" TEXT NOT NULL,
    "retrospective_input_manifest_checksum" TEXT NOT NULL,
    "retrospective_input_source_watermark" TEXT NOT NULL,
    "retrospective_input_watermark_version" TEXT NOT NULL,
    "retrospective_input_watermark" TEXT NOT NULL,
    "project_snapshot_json" JSONB NOT NULL,
    "delivery_summary_json" JSONB NOT NULL,
    "successful_practices_json" JSONB NOT NULL,
    "shortcomings_json" JSONB NOT NULL,
    "improvements_json" JSONB NOT NULL,
    "knowledge_disposition_json" JSONB NOT NULL,
    "ip_declaration_json" JSONB NOT NULL,
    "content_checksum" TEXT NOT NULL,
    "submitted_by_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_retrospective_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_retrospective_contributions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "retrospective_version_id" TEXT NOT NULL,
    "scope_type" "RetrospectiveScopeType" NOT NULL,
    "delivery_unit_id" TEXT,
    "discipline" TEXT NOT NULL,
    "contributor_membership_id" TEXT NOT NULL,
    "fact_text" TEXT NOT NULL,
    "impact_text" TEXT NOT NULL,
    "reusable" BOOLEAN NOT NULL,
    "required" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_retrospective_contributions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "retrospective_contribution_scope_check" CHECK (
      ("scope_type" = 'PROJECT' AND "delivery_unit_id" IS NULL)
      OR ("scope_type" = 'DELIVERY_UNIT' AND "delivery_unit_id" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "project_retrospective_participants" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "retrospective_version_id" TEXT NOT NULL,
    "membership_id" TEXT NOT NULL,
    "role_code" TEXT NOT NULL,
    "responsibility_text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_retrospective_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_retrospective_issue_sources" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "retrospective_version_id" TEXT NOT NULL,
    "issue_id" TEXT NOT NULL,
    "issue_history_id" TEXT NOT NULL,
    "issue_history_sequence" INTEGER NOT NULL,
    "source_checksum" TEXT NOT NULL,
    "snapshot_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_retrospective_issue_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_retrospective_reviews" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "retrospective_id" TEXT NOT NULL,
    "retrospective_version_id" TEXT NOT NULL,
    "decision" "RetrospectiveReviewDecision" NOT NULL,
    "reason" TEXT NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "reviewed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_retrospective_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_closure_policies" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "status" "ClosurePolicyStatus" NOT NULL,
    "current_version_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_closure_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_closure_policy_versions" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "policy_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" "ClosurePolicyVersionStatus" NOT NULL,
    "source_template_snapshot_id" TEXT NOT NULL,
    "source_gate_definition_id" TEXT NOT NULL,
    "archive_checker_code" TEXT NOT NULL,
    "archive_checker_version" INTEGER NOT NULL,
    "retrospective_checker_code" TEXT NOT NULL,
    "retrospective_checker_version" INTEGER NOT NULL,
    "archive_source_formula_version" "ArchiveSourceFormulaVersion" NOT NULL,
    "self_reference_exclusion_version" TEXT NOT NULL,
    "binding_checksum" TEXT NOT NULL,
    "policy_checksum" TEXT NOT NULL,
    "upgrade_reason" TEXT,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_closure_policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_closure_records" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "archive_b_id" TEXT NOT NULL,
    "archive_source_formula_version" "ArchiveSourceFormulaVersion" NOT NULL,
    "archive_b_manifest_checksum" TEXT NOT NULL,
    "archive_b_source_watermark" TEXT NOT NULL,
    "closure_policy_version_id" TEXT NOT NULL,
    "closure_policy_checksum" TEXT NOT NULL,
    "gate_instance_id" TEXT NOT NULL,
    "gate_check_snapshot_id" TEXT NOT NULL,
    "gate_submission_id" TEXT NOT NULL,
    "gate_approval_snapshot_json" JSONB NOT NULL,
    "retrospective_version_id" TEXT NOT NULL,
    "retrospective_content_checksum" TEXT NOT NULL,
    "closed_by_id" TEXT NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_closure_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_entries" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "KnowledgeEntryStatus" NOT NULL,
    "current_published_version_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_entry_versions" (
    "id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "source_project_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "supersedes_version_id" TEXT,
    "status" "KnowledgeEntryVersionStatus" NOT NULL,
    "title" TEXT NOT NULL,
    "sanitized_summary" TEXT NOT NULL,
    "experience_type" TEXT NOT NULL,
    "discipline" TEXT NOT NULL,
    "normalized_keywords_json" JSONB NOT NULL,
    "normalized_keywords_text" TEXT NOT NULL,
    "applicable_project_types_json" JSONB NOT NULL,
    "applicable_stage_codes_json" JSONB NOT NULL,
    "preconditions" TEXT NOT NULL,
    "recommended_practice" TEXT NOT NULL,
    "anti_patterns" TEXT NOT NULL,
    "limitations" TEXT NOT NULL,
    "ip_sanitization_declaration" TEXT NOT NULL,
    "internal_reusable" BOOLEAN NOT NULL,
    "content_checksum" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "submitted_by_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "published_by_id" TEXT,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_entry_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_entry_sources" (
    "id" TEXT NOT NULL,
    "knowledge_version_id" TEXT NOT NULL,
    "source_project_id" TEXT NOT NULL,
    "final_archive_version_id" TEXT NOT NULL,
    "final_archive_formula" "ArchiveSourceFormulaVersion" NOT NULL,
    "final_archive_manifest_checksum" TEXT NOT NULL,
    "final_archive_source_watermark" TEXT NOT NULL,
    "retrospective_input_archive_version_id" TEXT NOT NULL,
    "retrospective_input_formula" "ArchiveSourceFormulaVersion" NOT NULL,
    "retrospective_input_manifest_checksum" TEXT NOT NULL,
    "retrospective_input_source_watermark" TEXT NOT NULL,
    "retrospective_input_watermark" TEXT NOT NULL,
    "retrospective_version_id" TEXT NOT NULL,
    "retrospective_version_no" INTEGER NOT NULL,
    "retrospective_content_checksum" TEXT NOT NULL,
    "issue_id" TEXT,
    "issue_history_id" TEXT,
    "issue_history_sequence" INTEGER,
    "source_checksum" TEXT NOT NULL,
    "sanitized_snapshot_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_entry_sources_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_entry_source_issue_tuple_check" CHECK (
      ("issue_id" IS NULL AND "issue_history_id" IS NULL AND "issue_history_sequence" IS NULL)
      OR ("issue_id" IS NOT NULL AND "issue_history_id" IS NOT NULL AND "issue_history_sequence" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "knowledge_entry_reviews" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "knowledge_entry_id" TEXT NOT NULL,
    "knowledge_version_id" TEXT NOT NULL,
    "decision" "KnowledgeReviewDecision" NOT NULL,
    "reason" TEXT NOT NULL,
    "ip_confirmed" BOOLEAN NOT NULL,
    "sanitization_confirmed" BOOLEAN NOT NULL,
    "reviewer_id" TEXT NOT NULL,
    "reviewed_at" TIMESTAMP(3) NOT NULL,
    "source_checksum" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_entry_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_reuse_records" (
    "id" TEXT NOT NULL,
    "target_project_id" TEXT NOT NULL,
    "target_delivery_unit_id" TEXT,
    "knowledge_entry_id" TEXT NOT NULL,
    "knowledge_version_id" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "evidence_summary" TEXT NOT NULL,
    "confirmed_by_id" TEXT NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_reuse_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_reuse_corrections" (
    "id" TEXT NOT NULL,
    "target_project_id" TEXT NOT NULL,
    "reuse_record_id" TEXT NOT NULL,
    "correction_type" "KnowledgeReuseCorrectionType" NOT NULL,
    "reason" TEXT NOT NULL,
    "correction_text" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_reuse_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_retrospectives_project_id_key" ON "project_retrospectives"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_retrospectives_current_version_id_key" ON "project_retrospectives"("current_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_retrospectives_latest_approved_version_id_key" ON "project_retrospectives"("latest_approved_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_retrospectives_id_project_id_key" ON "project_retrospectives"("id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_retrospectives_current_version_id_project_id_key" ON "project_retrospectives"("current_version_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_retrospectives_latest_approved_version_id_project_i_key" ON "project_retrospectives"("latest_approved_version_id", "project_id");

-- CreateIndex
CREATE INDEX "project_retrospective_versions_project_id_status_created_at_idx" ON "project_retrospective_versions"("project_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "project_retrospective_versions_project_id_retrospective_inp_idx" ON "project_retrospective_versions"("project_id", "retrospective_input_archive_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_retrospective_versions_retrospective_id_version_no_key" ON "project_retrospective_versions"("retrospective_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "project_retrospective_versions_id_project_id_key" ON "project_retrospective_versions"("id", "project_id");

-- CreateIndex
CREATE INDEX "project_retrospective_contributions_project_id_retrospectiv_idx" ON "project_retrospective_contributions"("project_id", "retrospective_version_id");

-- CreateIndex
CREATE INDEX "project_retrospective_contributions_project_id_delivery_uni_idx" ON "project_retrospective_contributions"("project_id", "delivery_unit_id");

-- CreateIndex
CREATE INDEX "project_retrospective_contributions_project_id_contributor__idx" ON "project_retrospective_contributions"("project_id", "contributor_membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_retrospective_contributions_id_project_id_key" ON "project_retrospective_contributions"("id", "project_id");

-- CreateIndex
CREATE INDEX "project_retrospective_participants_project_id_membership_id_idx" ON "project_retrospective_participants"("project_id", "membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_retrospective_participants_retrospective_version_id_key" ON "project_retrospective_participants"("retrospective_version_id", "membership_id", "role_code");

-- CreateIndex
CREATE UNIQUE INDEX "project_retrospective_participants_id_project_id_key" ON "project_retrospective_participants"("id", "project_id");

-- CreateIndex
CREATE INDEX "project_retrospective_issue_sources_project_id_issue_id_idx" ON "project_retrospective_issue_sources"("project_id", "issue_id");

-- CreateIndex
CREATE INDEX "project_retrospective_issue_sources_project_id_issue_histor_idx" ON "project_retrospective_issue_sources"("project_id", "issue_history_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_retrospective_issue_sources_retrospective_version_i_key" ON "project_retrospective_issue_sources"("retrospective_version_id", "issue_history_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_retrospective_issue_sources_id_project_id_key" ON "project_retrospective_issue_sources"("id", "project_id");

-- CreateIndex
CREATE INDEX "project_retrospective_reviews_project_id_retrospective_vers_idx" ON "project_retrospective_reviews"("project_id", "retrospective_version_id", "reviewed_at");

-- CreateIndex
CREATE UNIQUE INDEX "project_retrospective_reviews_id_project_id_key" ON "project_retrospective_reviews"("id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_closure_policies_project_id_key" ON "project_closure_policies"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_closure_policies_current_version_id_key" ON "project_closure_policies"("current_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_closure_policies_id_project_id_key" ON "project_closure_policies"("id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_closure_policies_current_version_id_project_id_key" ON "project_closure_policies"("current_version_id", "project_id");

-- CreateIndex
CREATE INDEX "project_closure_policy_versions_project_id_status_effective_idx" ON "project_closure_policy_versions"("project_id", "status", "effective_at");

-- CreateIndex
CREATE INDEX "project_closure_policy_versions_project_id_source_template__idx" ON "project_closure_policy_versions"("project_id", "source_template_snapshot_id");

-- CreateIndex
CREATE INDEX "project_closure_policy_versions_project_id_source_gate_defi_idx" ON "project_closure_policy_versions"("project_id", "source_gate_definition_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_closure_policy_versions_policy_id_version_no_key" ON "project_closure_policy_versions"("policy_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "project_closure_policy_versions_id_project_id_key" ON "project_closure_policy_versions"("id", "project_id");

CREATE UNIQUE INDEX "project_closure_policy_versions_active_project_key"
ON "project_closure_policy_versions"("project_id") WHERE "status" = 'ACTIVE';

-- CreateIndex
CREATE UNIQUE INDEX "project_closure_records_project_id_key" ON "project_closure_records"("project_id");

-- CreateIndex
CREATE INDEX "project_closure_records_project_id_archive_b_id_idx" ON "project_closure_records"("project_id", "archive_b_id");

-- CreateIndex
CREATE INDEX "project_closure_records_project_id_closure_policy_version_i_idx" ON "project_closure_records"("project_id", "closure_policy_version_id");

-- CreateIndex
CREATE INDEX "project_closure_records_project_id_retrospective_version_id_idx" ON "project_closure_records"("project_id", "retrospective_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_closure_records_id_project_id_key" ON "project_closure_records"("id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_entries_code_key" ON "knowledge_entries"("code");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_entries_current_published_version_id_key" ON "knowledge_entries"("current_published_version_id");

-- CreateIndex
CREATE INDEX "knowledge_entry_versions_source_project_id_status_published_idx" ON "knowledge_entry_versions"("source_project_id", "status", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_entry_versions_entry_id_version_no_key" ON "knowledge_entry_versions"("entry_id", "version_no");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_entry_versions_id_entry_id_key" ON "knowledge_entry_versions"("id", "entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_entry_versions_id_source_project_id_key" ON "knowledge_entry_versions"("id", "source_project_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_entry_versions_id_entry_id_source_project_id_key" ON "knowledge_entry_versions"("id", "entry_id", "source_project_id");

-- CreateIndex
CREATE INDEX "knowledge_entry_sources_source_project_id_knowledge_version_idx" ON "knowledge_entry_sources"("source_project_id", "knowledge_version_id");

-- CreateIndex
CREATE INDEX "knowledge_entry_sources_source_project_id_retrospective_inp_idx" ON "knowledge_entry_sources"("source_project_id", "retrospective_input_archive_version_id");

-- CreateIndex
CREATE INDEX "knowledge_entry_sources_source_project_id_final_archive_ver_idx" ON "knowledge_entry_sources"("source_project_id", "final_archive_version_id");

-- CreateIndex
CREATE INDEX "knowledge_entry_sources_source_project_id_retrospective_ver_idx" ON "knowledge_entry_sources"("source_project_id", "retrospective_version_id");

-- CreateIndex
CREATE INDEX "knowledge_entry_sources_source_project_id_issue_id_idx" ON "knowledge_entry_sources"("source_project_id", "issue_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_entry_sources_id_source_project_id_key" ON "knowledge_entry_sources"("id", "source_project_id");

CREATE UNIQUE INDEX "knowledge_entry_sources_issue_history_active_key"
ON "knowledge_entry_sources"("knowledge_version_id", "issue_history_id")
WHERE "issue_history_id" IS NOT NULL;

-- CreateIndex
CREATE INDEX "knowledge_entry_reviews_project_id_knowledge_entry_id_knowl_idx" ON "knowledge_entry_reviews"("project_id", "knowledge_entry_id", "knowledge_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_entry_reviews_id_project_id_key" ON "knowledge_entry_reviews"("id", "project_id");

-- CreateIndex
CREATE INDEX "knowledge_reuse_records_target_project_id_target_delivery_u_idx" ON "knowledge_reuse_records"("target_project_id", "target_delivery_unit_id");

-- CreateIndex
CREATE INDEX "knowledge_reuse_records_target_project_id_confirmed_by_id_idx" ON "knowledge_reuse_records"("target_project_id", "confirmed_by_id");

-- CreateIndex
CREATE INDEX "knowledge_reuse_records_knowledge_entry_id_knowledge_versio_idx" ON "knowledge_reuse_records"("knowledge_entry_id", "knowledge_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_reuse_records_target_project_id_knowledge_version_key" ON "knowledge_reuse_records"("target_project_id", "knowledge_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_reuse_records_id_target_project_id_key" ON "knowledge_reuse_records"("id", "target_project_id");

-- CreateIndex
CREATE INDEX "knowledge_reuse_corrections_target_project_id_reuse_record__idx" ON "knowledge_reuse_corrections"("target_project_id", "reuse_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_reuse_corrections_id_target_project_id_key" ON "knowledge_reuse_corrections"("id", "target_project_id");

-- CreateIndex
-- APM104_LEGACY_DDL TABLE project_template_snapshots
ALTER TABLE public."project_template_snapshots" ADD CONSTRAINT "project_template_snapshots_id_project_id_key" UNIQUE ("id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_gate_definitions_project_id_code_revision_key" ON "project_gate_definitions"("project_id", "code", "revision");

-- CreateIndex
-- APM104_LEGACY_DDL TABLE issue_histories
ALTER TABLE public."issue_histories" ADD CONSTRAINT "issue_histories_id_project_id_key" UNIQUE ("id", "project_id");

-- AddForeignKey
ALTER TABLE "project_retrospectives" ADD CONSTRAINT "project_retrospectives_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospectives" ADD CONSTRAINT "project_retrospectives_current_version_id_project_id_fkey" FOREIGN KEY ("current_version_id", "project_id") REFERENCES "project_retrospective_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospectives" ADD CONSTRAINT "project_retrospectives_latest_approved_version_id_project__fkey" FOREIGN KEY ("latest_approved_version_id", "project_id") REFERENCES "project_retrospective_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospectives" ADD CONSTRAINT "project_retrospectives_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospectives" ADD CONSTRAINT "project_retrospectives_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_versions" ADD CONSTRAINT "project_retrospective_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_versions" ADD CONSTRAINT "project_retrospective_versions_retrospective_id_project_id_fkey" FOREIGN KEY ("retrospective_id", "project_id") REFERENCES "project_retrospectives"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_versions" ADD CONSTRAINT "project_retrospective_versions_supersedes_version_id_proje_fkey" FOREIGN KEY ("supersedes_version_id", "project_id") REFERENCES "project_retrospective_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_versions" ADD CONSTRAINT "project_retrospective_versions_retrospective_input_archive_fkey" FOREIGN KEY ("retrospective_input_archive_version_id", "project_id") REFERENCES "project_archive_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_versions" ADD CONSTRAINT "project_retrospective_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_versions" ADD CONSTRAINT "project_retrospective_versions_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_contributions" ADD CONSTRAINT "project_retrospective_contributions_retrospective_version__fkey" FOREIGN KEY ("retrospective_version_id", "project_id") REFERENCES "project_retrospective_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_contributions" ADD CONSTRAINT "project_retrospective_contributions_delivery_unit_id_proje_fkey" FOREIGN KEY ("delivery_unit_id", "project_id") REFERENCES "delivery_units"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_contributions" ADD CONSTRAINT "project_retrospective_contributions_contributor_membership_fkey" FOREIGN KEY ("contributor_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_participants" ADD CONSTRAINT "project_retrospective_participants_retrospective_version_i_fkey" FOREIGN KEY ("retrospective_version_id", "project_id") REFERENCES "project_retrospective_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_participants" ADD CONSTRAINT "project_retrospective_participants_membership_id_project_i_fkey" FOREIGN KEY ("membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_issue_sources" ADD CONSTRAINT "project_retrospective_issue_sources_retrospective_version__fkey" FOREIGN KEY ("retrospective_version_id", "project_id") REFERENCES "project_retrospective_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_issue_sources" ADD CONSTRAINT "project_retrospective_issue_sources_issue_id_project_id_fkey" FOREIGN KEY ("issue_id", "project_id") REFERENCES "issues"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_issue_sources" ADD CONSTRAINT "project_retrospective_issue_sources_issue_history_id_proje_fkey" FOREIGN KEY ("issue_history_id", "project_id") REFERENCES "issue_histories"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_reviews" ADD CONSTRAINT "project_retrospective_reviews_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_reviews" ADD CONSTRAINT "project_retrospective_reviews_retrospective_id_project_id_fkey" FOREIGN KEY ("retrospective_id", "project_id") REFERENCES "project_retrospectives"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_reviews" ADD CONSTRAINT "retrospective_review_version_pair_fkey" FOREIGN KEY ("retrospective_version_id", "project_id") REFERENCES "project_retrospective_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_retrospective_reviews" ADD CONSTRAINT "project_retrospective_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_policies" ADD CONSTRAINT "project_closure_policies_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_policies" ADD CONSTRAINT "project_closure_policies_current_version_id_project_id_fkey" FOREIGN KEY ("current_version_id", "project_id") REFERENCES "project_closure_policy_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_policies" ADD CONSTRAINT "project_closure_policies_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_policies" ADD CONSTRAINT "project_closure_policies_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_policy_versions" ADD CONSTRAINT "project_closure_policy_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_policy_versions" ADD CONSTRAINT "project_closure_policy_versions_policy_id_project_id_fkey" FOREIGN KEY ("policy_id", "project_id") REFERENCES "project_closure_policies"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_policy_versions" ADD CONSTRAINT "project_closure_policy_versions_source_template_snapshot_i_fkey" FOREIGN KEY ("source_template_snapshot_id", "project_id") REFERENCES "project_template_snapshots"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_policy_versions" ADD CONSTRAINT "project_closure_policy_versions_source_gate_definition_id__fkey" FOREIGN KEY ("source_gate_definition_id", "project_id") REFERENCES "project_gate_definitions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_policy_versions" ADD CONSTRAINT "project_closure_policy_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_records" ADD CONSTRAINT "project_closure_records_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_records" ADD CONSTRAINT "project_closure_records_archive_b_id_project_id_fkey" FOREIGN KEY ("archive_b_id", "project_id") REFERENCES "project_archive_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_records" ADD CONSTRAINT "project_closure_records_closure_policy_version_id_project__fkey" FOREIGN KEY ("closure_policy_version_id", "project_id") REFERENCES "project_closure_policy_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_records" ADD CONSTRAINT "project_closure_records_policy_fkey" FOREIGN KEY ("project_id") REFERENCES "project_closure_policies"("project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_records" ADD CONSTRAINT "project_closure_records_gate_instance_id_project_id_fkey" FOREIGN KEY ("gate_instance_id", "project_id") REFERENCES "project_gate_instances"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_records" ADD CONSTRAINT "project_closure_records_gate_check_snapshot_id_project_id_fkey" FOREIGN KEY ("gate_check_snapshot_id", "project_id") REFERENCES "gate_check_snapshots"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_records" ADD CONSTRAINT "project_closure_records_gate_submission_id_project_id_fkey" FOREIGN KEY ("gate_submission_id", "project_id") REFERENCES "gate_submissions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_records" ADD CONSTRAINT "project_closure_records_retrospective_version_id_project_i_fkey" FOREIGN KEY ("retrospective_version_id", "project_id") REFERENCES "project_retrospective_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_closure_records" ADD CONSTRAINT "project_closure_records_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_current_published_version_id_fkey" FOREIGN KEY ("current_published_version_id") REFERENCES "knowledge_entry_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_versions" ADD CONSTRAINT "knowledge_entry_versions_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "knowledge_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_versions" ADD CONSTRAINT "knowledge_entry_versions_source_project_id_fkey" FOREIGN KEY ("source_project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_versions" ADD CONSTRAINT "knowledge_entry_versions_supersedes_version_id_fkey" FOREIGN KEY ("supersedes_version_id") REFERENCES "knowledge_entry_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_versions" ADD CONSTRAINT "knowledge_entry_versions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_versions" ADD CONSTRAINT "knowledge_entry_versions_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_versions" ADD CONSTRAINT "knowledge_entry_versions_published_by_id_fkey" FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_sources" ADD CONSTRAINT "knowledge_entry_sources_knowledge_version_id_source_projec_fkey" FOREIGN KEY ("knowledge_version_id", "source_project_id") REFERENCES "knowledge_entry_versions"("id", "source_project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_sources" ADD CONSTRAINT "knowledge_entry_sources_source_project_id_fkey" FOREIGN KEY ("source_project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_sources" ADD CONSTRAINT "knowledge_entry_sources_archive_a_fkey" FOREIGN KEY ("retrospective_input_archive_version_id", "source_project_id") REFERENCES "project_archive_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_sources" ADD CONSTRAINT "knowledge_entry_sources_archive_b_fkey" FOREIGN KEY ("final_archive_version_id", "source_project_id") REFERENCES "project_archive_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_sources" ADD CONSTRAINT "knowledge_entry_sources_retrospective_version_id_source_pr_fkey" FOREIGN KEY ("retrospective_version_id", "source_project_id") REFERENCES "project_retrospective_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_sources" ADD CONSTRAINT "knowledge_entry_sources_issue_id_source_project_id_fkey" FOREIGN KEY ("issue_id", "source_project_id") REFERENCES "issues"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_sources" ADD CONSTRAINT "knowledge_entry_sources_issue_history_id_source_project_id_fkey" FOREIGN KEY ("issue_history_id", "source_project_id") REFERENCES "issue_histories"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_reviews" ADD CONSTRAINT "knowledge_entry_reviews_knowledge_entry_id_fkey" FOREIGN KEY ("knowledge_entry_id") REFERENCES "knowledge_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_reviews" ADD CONSTRAINT "knowledge_entry_reviews_version_entry_project_fkey" FOREIGN KEY ("knowledge_version_id", "knowledge_entry_id", "project_id") REFERENCES "knowledge_entry_versions"("id", "entry_id", "source_project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_reviews" ADD CONSTRAINT "knowledge_entry_reviews_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_reviews" ADD CONSTRAINT "knowledge_entry_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_reuse_records" ADD CONSTRAINT "knowledge_reuse_records_target_project_id_fkey" FOREIGN KEY ("target_project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_reuse_records" ADD CONSTRAINT "knowledge_reuse_records_target_delivery_unit_id_target_pro_fkey" FOREIGN KEY ("target_delivery_unit_id", "target_project_id") REFERENCES "delivery_units"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_reuse_records" ADD CONSTRAINT "knowledge_reuse_records_knowledge_entry_id_fkey" FOREIGN KEY ("knowledge_entry_id") REFERENCES "knowledge_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_reuse_records" ADD CONSTRAINT "knowledge_reuse_records_version_entry_fkey" FOREIGN KEY ("knowledge_version_id", "knowledge_entry_id") REFERENCES "knowledge_entry_versions"("id", "entry_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_reuse_records" ADD CONSTRAINT "knowledge_reuse_records_confirmed_by_id_target_project_id_fkey" FOREIGN KEY ("confirmed_by_id", "target_project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_reuse_corrections" ADD CONSTRAINT "knowledge_reuse_corrections_reuse_record_id_target_project_fkey" FOREIGN KEY ("reuse_record_id", "target_project_id") REFERENCES "knowledge_reuse_records"("id", "target_project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_reuse_corrections" ADD CONSTRAINT "knowledge_reuse_corrections_target_project_id_fkey" FOREIGN KEY ("target_project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_reuse_corrections" ADD CONSTRAINT "knowledge_reuse_corrections_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_gate_instances" ADD CONSTRAINT "project_gate_instances_closure_policy_version_id_project_i_fkey" FOREIGN KEY ("closure_policy_version_id", "project_id") REFERENCES "project_closure_policy_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_check_snapshots" ADD CONSTRAINT "gate_check_snapshots_closure_policy_version_id_project_id_fkey" FOREIGN KEY ("closure_policy_version_id", "project_id") REFERENCES "project_closure_policy_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_submissions" ADD CONSTRAINT "gate_submissions_closure_policy_version_id_project_id_fkey" FOREIGN KEY ("closure_policy_version_id", "project_id") REFERENCES "project_closure_policy_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION
    WHEN SQLSTATE '42501' OR SQLSTATE '58P01' OR SQLSTATE '0A000' THEN
      RAISE NOTICE 'pg_trgm unavailable: %', SQLSTATE;
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX knowledge_entry_versions_search_trgm_idx ON knowledge_entry_versions USING gin (normalized_keywords_text gin_trgm_ops)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "reject_apm104_append_only_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "retrospective_contributions_immutable"
BEFORE UPDATE OR DELETE ON "project_retrospective_contributions"
FOR EACH ROW EXECUTE FUNCTION "reject_apm104_append_only_mutation"();
CREATE TRIGGER "retrospective_participants_immutable"
BEFORE UPDATE OR DELETE ON "project_retrospective_participants"
FOR EACH ROW EXECUTE FUNCTION "reject_apm104_append_only_mutation"();
CREATE TRIGGER "retrospective_issue_sources_immutable"
BEFORE UPDATE OR DELETE ON "project_retrospective_issue_sources"
FOR EACH ROW EXECUTE FUNCTION "reject_apm104_append_only_mutation"();
CREATE TRIGGER "retrospective_reviews_immutable"
BEFORE UPDATE OR DELETE ON "project_retrospective_reviews"
FOR EACH ROW EXECUTE FUNCTION "reject_apm104_append_only_mutation"();
CREATE TRIGGER "project_closure_records_immutable"
BEFORE UPDATE OR DELETE ON "project_closure_records"
FOR EACH ROW EXECUTE FUNCTION "reject_apm104_append_only_mutation"();
CREATE TRIGGER "knowledge_entry_sources_immutable"
BEFORE UPDATE OR DELETE ON "knowledge_entry_sources"
FOR EACH ROW EXECUTE FUNCTION "reject_apm104_append_only_mutation"();
CREATE TRIGGER "knowledge_entry_reviews_immutable"
BEFORE UPDATE OR DELETE ON "knowledge_entry_reviews"
FOR EACH ROW EXECUTE FUNCTION "reject_apm104_append_only_mutation"();
CREATE TRIGGER "knowledge_reuse_records_immutable"
BEFORE UPDATE OR DELETE ON "knowledge_reuse_records"
FOR EACH ROW EXECUTE FUNCTION "reject_apm104_append_only_mutation"();
CREATE TRIGGER "knowledge_reuse_corrections_immutable"
BEFORE UPDATE OR DELETE ON "knowledge_reuse_corrections"
FOR EACH ROW EXECUTE FUNCTION "reject_apm104_append_only_mutation"();

CREATE OR REPLACE FUNCTION "validate_project_retrospective_version_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'project retrospective versions are immutable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'submitted_by_id', 'submitted_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'submitted_by_id', 'submitted_at']) THEN
    RAISE EXCEPTION 'project retrospective version facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF (OLD."status" = 'DRAFT' AND NEW."status" IN ('IN_REVIEW', 'SUPERSEDED'))
     OR (OLD."status" = 'IN_REVIEW' AND NEW."status" IN ('APPROVED', 'REJECTED')) THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = NEW."status"
     AND OLD."submitted_by_id" IS NOT DISTINCT FROM NEW."submitted_by_id"
     AND OLD."submitted_at" IS NOT DISTINCT FROM NEW."submitted_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid retrospective status transition' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "retrospective_versions_immutable"
BEFORE UPDATE OR DELETE ON "project_retrospective_versions"
FOR EACH ROW EXECUTE FUNCTION "validate_project_retrospective_version_mutation"();

CREATE OR REPLACE FUNCTION "validate_knowledge_entry_version_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'knowledge entry versions are immutable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'submitted_by_id', 'submitted_at', 'published_by_id', 'published_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'submitted_by_id', 'submitted_at', 'published_by_id', 'published_at']) THEN
    RAISE EXCEPTION 'knowledge entry version facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF (OLD."status" = 'DRAFT' AND NEW."status" IN ('IN_REVIEW', 'SUPERSEDED'))
     OR (OLD."status" = 'IN_REVIEW' AND NEW."status" IN ('PUBLISHED', 'REJECTED'))
     OR (OLD."status" = 'PUBLISHED' AND NEW."status" IN ('SUPERSEDED', 'REVOKED'))
     OR (OLD."status" = 'SUPERSEDED' AND NEW."status" = 'REVOKED') THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = NEW."status"
     AND OLD."submitted_by_id" IS NOT DISTINCT FROM NEW."submitted_by_id"
     AND OLD."submitted_at" IS NOT DISTINCT FROM NEW."submitted_at"
     AND OLD."published_by_id" IS NOT DISTINCT FROM NEW."published_by_id"
     AND OLD."published_at" IS NOT DISTINCT FROM NEW."published_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid knowledge version status transition' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "knowledge_entry_versions_immutable"
BEFORE UPDATE OR DELETE ON "knowledge_entry_versions"
FOR EACH ROW EXECUTE FUNCTION "validate_knowledge_entry_version_mutation"();

CREATE OR REPLACE FUNCTION "validate_project_retrospective_pointer_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'project retrospective aggregates are immutable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['current_version_id', 'latest_approved_version_id', 'version', 'updated_by_id', 'updated_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['current_version_id', 'latest_approved_version_id', 'version', 'updated_by_id', 'updated_at']) THEN
    RAISE EXCEPTION 'project retrospective identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_retrospective_pointer_check"
BEFORE UPDATE OR DELETE ON "project_retrospectives"
FOR EACH ROW EXECUTE FUNCTION "validate_project_retrospective_pointer_mutation"();

CREATE OR REPLACE FUNCTION "validate_closure_policy_version_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'closure policy versions are immutable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'closure policy version facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF (OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE')
     OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'SUPERSEDED')
     OR OLD."status" = NEW."status" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid closure policy status transition' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "closure_policy_versions_immutable"
BEFORE UPDATE OR DELETE ON "project_closure_policy_versions"
FOR EACH ROW EXECUTE FUNCTION "validate_closure_policy_version_mutation"();

-- APM104_LEGACY_DDL FUNCTION validate_project_archive_version_mutation
CREATE OR REPLACE FUNCTION public."validate_project_archive_version_mutation"()
RETURNS TRIGGER AS $$
DECLARE
  latest_integrity_status "ArchiveIntegrityCheckStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'project archive versions are immutable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'finalized_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'finalized_at']) THEN
    RAISE EXCEPTION 'project archive version facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'VERIFYING' AND NEW."status" IN ('READY', 'FAILED') THEN RETURN NEW; END IF;
  IF OLD."status" IN ('READY', 'FAILED') AND NEW."status" = 'VERIFYING' THEN RETURN NEW; END IF;
  IF OLD."status" = 'READY' AND NEW."status" = 'FINALIZED' AND NEW."finalized_at" IS NOT NULL THEN
    SELECT "status" INTO latest_integrity_status
    FROM "project_archive_integrity_checks"
    WHERE "archive_version_id" = NEW."id"
    ORDER BY "sequence" DESC LIMIT 1;
    IF latest_integrity_status IS DISTINCT FROM 'PASSED' THEN
      RAISE EXCEPTION 'project_archive_versions_latest_integrity_check_passed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = NEW."status" AND OLD."finalized_at" IS NOT DISTINCT FROM NEW."finalized_at" THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid project archive version status transition' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

-- Extend the stable authorization vocabulary for APM-104. These seeds are
-- idempotent and are consumed by the runtime authorization repository.
INSERT INTO "permissions" ("id", "code", "description") VALUES
('permission-project-retrospective-read', 'PROJECT_RETROSPECTIVE_READ', '读取项目结项复盘事实'),
('permission-project-retrospective-manage', 'PROJECT_RETROSPECTIVE_MANAGE', '创建和提交项目结项复盘'),
('permission-project-retrospective-review', 'PROJECT_RETROSPECTIVE_REVIEW', '独立审核项目结项复盘'),
('permission-knowledge-read', 'KNOWLEDGE_READ', '读取已发布且人工脱敏的内部知识'),
('permission-knowledge-review', 'KNOWLEDGE_REVIEW', '审核人工脱敏内部知识'),
('permission-knowledge-reuse-confirm', 'KNOWLEDGE_REUSE_CONFIRM', '确认内部知识在目标项目中的复用')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
('role-project-manager', 'permission-project-retrospective-read', 'PROJECT'),
('role-department-lead', 'permission-project-retrospective-read', 'DEPARTMENT'),
('role-quality', 'permission-project-retrospective-read', 'PROJECT'),
('role-admin', 'permission-project-retrospective-read', 'ALL'),
('role-project-manager', 'permission-project-retrospective-manage', 'PROJECT'),
('role-department-lead', 'permission-project-retrospective-manage', 'DEPARTMENT'),
('role-admin', 'permission-project-retrospective-manage', 'ALL'),
('role-department-lead', 'permission-project-retrospective-review', 'DEPARTMENT'),
('role-quality', 'permission-project-retrospective-review', 'PROJECT'),
('role-admin', 'permission-project-retrospective-review', 'ALL'),
('role-project-manager', 'permission-knowledge-read', 'ALL'),
('role-department-lead', 'permission-knowledge-read', 'ALL'),
('role-engineer', 'permission-knowledge-read', 'ALL'),
('role-procurement', 'permission-knowledge-read', 'ALL'),
('role-quality', 'permission-knowledge-read', 'ALL'),
('role-technical-asset-maintainer', 'permission-knowledge-read', 'ALL'),
('role-executive', 'permission-knowledge-read', 'ALL'),
('role-admin', 'permission-knowledge-read', 'ALL'),
('role-department-lead', 'permission-knowledge-review', 'ALL'),
('role-quality', 'permission-knowledge-review', 'ALL'),
('role-admin', 'permission-knowledge-review', 'ALL'),
('role-project-manager', 'permission-knowledge-reuse-confirm', 'PROJECT'),
('role-quality', 'permission-knowledge-reuse-confirm', 'PROJECT'),
('role-admin', 'permission-knowledge-reuse-confirm', 'ALL')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
