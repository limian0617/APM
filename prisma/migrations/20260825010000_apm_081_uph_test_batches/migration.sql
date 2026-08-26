BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_TEST_BATCH_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_TEST_BATCH_REVISION_METADATA_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_CYCLE_SAMPLE_APPENDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_CYCLE_SAMPLE_CORRECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_TEST_BATCH_PRODUCTION_COUNT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_TEST_BATCH_MODULE_QUALITY_COUNT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_TEST_BATCH_EVIDENCE_REFERENCED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_TEST_BATCH_PM_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_TEST_BATCH_LOCKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_TEST_BATCH_REVISION_REPLACED';

ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'UPH_TEST_BATCH';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'UPH_TEST_BATCH_REVISION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'UPH_MODULE_CYCLE_SAMPLE';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'UPH_TEST_BATCH_EVIDENCE';

CREATE TYPE "UphTestBatchScope" AS ENUM ('TOPOLOGY_ROOT');
CREATE TYPE "UphTestBatchRevisionStatus" AS ENUM ('DRAFT', 'PM_CONFIRMED', 'LOCKED', 'SUPERSEDED');
CREATE TYPE "UphTestBatchSampleCaptureMethod" AS ENUM ('DEVICE_EVENT', 'MANUAL_ENTRY');
CREATE TYPE "UphTestBatchSampleDisposition" AS ENUM ('INCLUDED', 'EXCLUDED');
CREATE TYPE "UphTestBatchExclusionReasonCode" AS ENUM (
  'SETUP_OR_CHANGEOVER',
  'EXTERNAL_WAITING',
  'UPSTREAM_MATERIAL_STARVATION',
  'DOWNSTREAM_BLOCKAGE',
  'SAFETY_INTERLOCK',
  'CAPTURE_DEVICE_FAULT',
  'OBSERVATION_INTERRUPTED',
  'MANUAL_ENTRY_CORRECTION'
);
CREATE TYPE "UphTestBatchEvidencePurpose" AS ENUM (
  'ROOT_PRODUCTION',
  'MODULE_QUALITY',
  'CYCLE_SAMPLE',
  'PROTOCOL',
  'OBSERVATION_WINDOW'
);

CREATE TABLE "project_uph_test_batches" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "batch_number" TEXT NOT NULL,
  "scope" "UphTestBatchScope" NOT NULL DEFAULT 'TOPOLOGY_ROOT',
  "current_work_revision_id" TEXT,
  "current_locked_revision_id" TEXT,
  "resource_version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_uph_test_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_test_batches_batch_number_check" CHECK (length(btrim("batch_number")) BETWEEN 1 AND 191),
  CONSTRAINT "project_uph_test_batches_resource_version_check" CHECK ("resource_version" > 0),
  -- current_work_revision_id IS NULL OR current_work_revision_id <> current_locked_revision_id
  CONSTRAINT "project_uph_test_batches_pointer_alias_check" CHECK (
    "current_work_revision_id" IS NULL OR "current_work_revision_id" <> "current_locked_revision_id"
  )
);

CREATE TABLE "project_uph_test_batch_revisions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "revision_number" INTEGER NOT NULL,
  "supersedes_revision_id" TEXT,
  "status" "UphTestBatchRevisionStatus" NOT NULL DEFAULT 'DRAFT',
  "resource_version" INTEGER NOT NULL DEFAULT 1,
  "topology_version_id" TEXT NOT NULL,
  "topology_root_node_id" TEXT NOT NULL,
  "formula_version_id" TEXT NOT NULL,
  "plan_declaration_reason" TEXT NOT NULL,
  "planned_production_seconds" BIGINT NOT NULL,
  "plan_snapshot_json" JSONB NOT NULL,
  "plan_checksum" TEXT NOT NULL,
  "plan_declared_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "observation_started_at" TIMESTAMPTZ(3) NOT NULL,
  "observation_ended_at" TIMESTAMPTZ(3),
  "timezone" TEXT NOT NULL,
  "test_protocol_code" TEXT NOT NULL,
  "test_protocol_version" INTEGER NOT NULL,
  "protocol_snapshot_json" JSONB NOT NULL,
  "protocol_checksum" TEXT NOT NULL,
  "source_binding_snapshot_json" JSONB NOT NULL,
  "source_watermark" TEXT NOT NULL,
  "source_checksum" TEXT NOT NULL,
  "process_owner_membership_id" TEXT NOT NULL,
  "process_owner_user_id" TEXT NOT NULL,
  "process_owner_role" "ProjectRole" NOT NULL,
  "process_owner_snapshot_json" JSONB NOT NULL,
  "process_owner_checksum" TEXT NOT NULL,
  "pm_confirmer_membership_id" TEXT,
  "pm_confirmer_user_id" TEXT,
  "pm_confirmer_role" "ProjectRole",
  "pm_confirmer_snapshot_json" JSONB,
  "pm_confirmer_checksum" TEXT,
  "pm_confirmed_at" TIMESTAMPTZ(3),
  "quality_locker_membership_id" TEXT,
  "quality_locker_user_id" TEXT,
  "quality_locker_role" "ProjectRole",
  "quality_locker_snapshot_json" JSONB,
  "quality_locker_checksum" TEXT,
  "locked_at" TIMESTAMPTZ(3),
  "confirmed_input_snapshot_json" JSONB,
  "confirmed_input_checksum" TEXT,
  "statistics_snapshot_json" JSONB,
  "statistics_checksum" TEXT,
  "locked_snapshot_json" JSONB,
  "locked_checksum" TEXT,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_uph_test_batch_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_test_batch_revision_base_check" CHECK (
    "revision_number" > 0
    AND "resource_version" > 0
    AND length(btrim("plan_declaration_reason")) BETWEEN 1 AND 1024
    AND "planned_production_seconds" > 0
    AND length(btrim("timezone")) BETWEEN 1 AND 100
    AND "plan_checksum" ~ '^[0-9a-f]{64}$'
    AND "test_protocol_code" = 'UPH_TEST_PROTOCOL'
    AND "test_protocol_version" = 1
    AND "protocol_checksum" ~ '^[0-9a-f]{64}$'
    AND "source_checksum" ~ '^[0-9a-f]{64}$'
    AND "source_watermark" <> ''
    AND "process_owner_checksum" ~ '^[0-9a-f]{64}$'
    AND "process_owner_role" = 'ENGINEER'
  ),
  CONSTRAINT "project_uph_test_batch_revision_window_check" CHECK (
    "observation_ended_at" IS NULL OR "observation_ended_at" > "observation_started_at"
  ),
  CONSTRAINT "project_uph_test_batch_revision_pm_fact_check" CHECK (
    ("pm_confirmer_membership_id" IS NULL AND "pm_confirmer_user_id" IS NULL AND "pm_confirmer_role" IS NULL
      AND "pm_confirmer_snapshot_json" IS NULL AND "pm_confirmer_checksum" IS NULL AND "pm_confirmed_at" IS NULL)
    OR
    ("pm_confirmer_membership_id" IS NOT NULL AND "pm_confirmer_user_id" IS NOT NULL
      AND "pm_confirmer_user_id" <> "process_owner_user_id"
      AND "pm_confirmer_role" = 'PROJECT_MANAGER' AND "pm_confirmer_snapshot_json" IS NOT NULL
      AND "pm_confirmer_checksum" ~ '^[0-9a-f]{64}$' AND "pm_confirmed_at" IS NOT NULL)
  ),
  CONSTRAINT "project_uph_test_batch_revision_quality_fact_check" CHECK (
    ("quality_locker_membership_id" IS NULL AND "quality_locker_user_id" IS NULL AND "quality_locker_role" IS NULL
      AND "quality_locker_snapshot_json" IS NULL AND "quality_locker_checksum" IS NULL AND "locked_at" IS NULL)
    OR
    ("quality_locker_membership_id" IS NOT NULL AND "quality_locker_user_id" IS NOT NULL
      AND "pm_confirmer_user_id" IS NOT NULL
      AND "quality_locker_user_id" <> "process_owner_user_id"
      AND "quality_locker_user_id" <> "pm_confirmer_user_id"
      AND "quality_locker_role" = 'QUALITY' AND "quality_locker_snapshot_json" IS NOT NULL
      AND "quality_locker_checksum" ~ '^[0-9a-f]{64}$' AND "locked_at" IS NOT NULL)
  ),
  CONSTRAINT "project_uph_test_batch_revision_checksum_presence_check" CHECK (
    ("status" = 'DRAFT'
      AND "pm_confirmer_membership_id" IS NULL AND "quality_locker_membership_id" IS NULL
      AND "confirmed_input_snapshot_json" IS NULL AND "confirmed_input_checksum" IS NULL
      AND "statistics_snapshot_json" IS NULL AND "statistics_checksum" IS NULL
      AND "locked_snapshot_json" IS NULL AND "locked_checksum" IS NULL)
    OR
    ("status" = 'PM_CONFIRMED'
      AND "pm_confirmer_membership_id" IS NOT NULL AND "quality_locker_membership_id" IS NULL
      AND "confirmed_input_snapshot_json" IS NOT NULL AND "confirmed_input_checksum" ~ '^[0-9a-f]{64}$'
      AND "statistics_snapshot_json" IS NULL AND "statistics_checksum" IS NULL
      AND "locked_snapshot_json" IS NULL AND "locked_checksum" IS NULL)
    OR
    ("status" = 'LOCKED'
      AND "pm_confirmer_membership_id" IS NOT NULL AND "quality_locker_membership_id" IS NOT NULL
      AND "confirmed_input_snapshot_json" IS NOT NULL AND "confirmed_input_checksum" ~ '^[0-9a-f]{64}$'
      AND "statistics_snapshot_json" IS NOT NULL AND "statistics_checksum" ~ '^[0-9a-f]{64}$'
      AND "locked_snapshot_json" IS NOT NULL AND "locked_checksum" ~ '^[0-9a-f]{64}$')
    OR
    ("status" = 'SUPERSEDED'
      AND "pm_confirmer_membership_id" IS NOT NULL
      AND "confirmed_input_snapshot_json" IS NOT NULL AND "confirmed_input_checksum" ~ '^[0-9a-f]{64}$'
      AND (("quality_locker_membership_id" IS NULL
            AND "statistics_snapshot_json" IS NULL AND "statistics_checksum" IS NULL
            AND "locked_snapshot_json" IS NULL AND "locked_checksum" IS NULL)
        OR ("quality_locker_membership_id" IS NOT NULL
            AND "statistics_snapshot_json" IS NOT NULL AND "statistics_checksum" ~ '^[0-9a-f]{64}$'
            AND "locked_snapshot_json" IS NOT NULL AND "locked_checksum" ~ '^[0-9a-f]{64}$')))
  )
);

CREATE TABLE "project_uph_test_batch_revision_module_bindings" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "project_module_id" TEXT NOT NULL,
  "ct_definition_id" TEXT NOT NULL,
  "ct_version_id" TEXT NOT NULL,
  "ct_source_snapshot_json" JSONB NOT NULL,
  "ct_source_checksum" TEXT NOT NULL,
  "ct_source_watermark" TEXT NOT NULL,
  "quality_input_count" BIGINT,
  "first_pass_good_count" BIGINT,
  "first_pass_nonconforming_count" BIGINT,
  "rework_input_count" BIGINT,
  "rework_recovered_good_count" BIGINT,
  "valid_sample_count" INTEGER,
  "excluded_sample_count" INTEGER,
  "arithmetic_mean_seconds" NUMERIC(20, 6),
  "p50_seconds" NUMERIC(20, 6),
  "p90_seconds" NUMERIC(20, 6),
  "max_seconds" NUMERIC(20, 6),
  "spread_p90_minus_p50_seconds" NUMERIC(20, 6),
  CONSTRAINT "project_uph_test_batch_revision_module_bindings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_test_batch_binding_quality_count_check" CHECK (
    ("quality_input_count" IS NULL AND "first_pass_good_count" IS NULL AND "first_pass_nonconforming_count" IS NULL
      AND "rework_input_count" IS NULL AND "rework_recovered_good_count" IS NULL)
    OR
    ("quality_input_count" >= 0 AND "first_pass_good_count" >= 0 AND "first_pass_nonconforming_count" >= 0
      AND "rework_input_count" >= 0 AND "rework_recovered_good_count" >= 0
      AND "quality_input_count" = "first_pass_good_count" + "first_pass_nonconforming_count"
      AND "rework_recovered_good_count" <= "rework_input_count"
      AND "rework_input_count" <= "first_pass_nonconforming_count"
      AND "first_pass_nonconforming_count" <= "quality_input_count")
  ),
  CONSTRAINT "project_uph_test_batch_binding_statistics_check" CHECK (
    ("valid_sample_count" IS NULL AND "excluded_sample_count" IS NULL AND "arithmetic_mean_seconds" IS NULL
      AND "p50_seconds" IS NULL AND "p90_seconds" IS NULL AND "max_seconds" IS NULL
      AND "spread_p90_minus_p50_seconds" IS NULL)
    OR
    ("valid_sample_count" >= 10 AND "excluded_sample_count" >= 0
      AND "arithmetic_mean_seconds" > 0 AND "p50_seconds" > 0 AND "p90_seconds" > 0
      AND "max_seconds" > 0 AND "spread_p90_minus_p50_seconds" >= 0)
  )
);

CREATE TABLE "project_uph_test_batch_revision_production_counts" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "actual_gross_output_count" BIGINT NOT NULL,
  "final_good_output_count" BIGINT NOT NULL,
  CONSTRAINT "project_uph_test_batch_revision_production_counts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_test_batch_production_count_check" CHECK (
    "actual_gross_output_count" >= 0
    AND "final_good_output_count" >= 0
    AND "final_good_output_count" <= "actual_gross_output_count"
  )
);

CREATE TABLE "project_uph_module_cycle_samples" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "module_binding_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "correction_of_sample_id" TEXT,
  "source_event_id" TEXT,
  "cycle_duration_seconds" NUMERIC(20, 6) NOT NULL,
  "observed_at" TIMESTAMPTZ(3) NOT NULL,
  "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "capture_method" "UphTestBatchSampleCaptureMethod" NOT NULL,
  "captured_by_membership_id" TEXT NOT NULL,
  "captured_by_user_id" TEXT NOT NULL,
  "captured_by_role" "ProjectRole" NOT NULL,
  "captured_by_snapshot_json" JSONB NOT NULL,
  "captured_by_checksum" TEXT NOT NULL,
  "disposition" "UphTestBatchSampleDisposition" NOT NULL,
  "exclusion_reason_code" "UphTestBatchExclusionReasonCode",
  CONSTRAINT "project_uph_module_cycle_samples_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_module_cycle_sample_check" CHECK (
    "ordinal" > 0
    AND "cycle_duration_seconds" > 0
    AND "captured_by_role" = 'ENGINEER'
    AND "captured_by_checksum" ~ '^[0-9a-f]{64}$'
    AND ("capture_method" <> 'DEVICE_EVENT' OR "source_event_id" IS NOT NULL)
    AND (("disposition" = 'INCLUDED' AND "exclusion_reason_code" IS NULL)
      OR ("disposition" = 'EXCLUDED' AND "exclusion_reason_code" IS NOT NULL))
  )
);

CREATE TABLE "project_uph_test_batch_revision_evidence" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "file_object_id" TEXT NOT NULL,
  "sample_id" TEXT,
  "purpose" "UphTestBatchEvidencePurpose",
  "file_sha256" TEXT NOT NULL,
  "sensitivity" "FileSensitivity" NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_uph_test_batch_revision_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_test_batch_revision_evidence_hash_check" CHECK ("file_sha256" ~ '^[0-9a-f]{64}$')
);

ALTER TABLE "project_uph_ct_definition_versions"
  ADD CONSTRAINT "project_uph_ct_definition_versions_id_definition_project_key"
  UNIQUE ("id", "ct_definition_id", "project_id");

CREATE UNIQUE INDEX "project_uph_test_batches_id_project_id_key"
  ON "project_uph_test_batches" ("id", "project_id");
CREATE UNIQUE INDEX "project_uph_test_batches_project_id_batch_number_key"
  ON "project_uph_test_batches" ("project_id", "batch_number");
CREATE UNIQUE INDEX "project_uph_test_batch_revisions_id_project_id_key"
  ON "project_uph_test_batch_revisions" ("id", "project_id");
CREATE UNIQUE INDEX "project_uph_test_batch_revisions_batch_revision_project_key"
  ON "project_uph_test_batch_revisions" ("batch_id", "revision_number", "project_id");
CREATE UNIQUE INDEX "project_uph_test_batch_revisions_supersedes_revision_id_key"
  ON "project_uph_test_batch_revisions" ("supersedes_revision_id");
CREATE UNIQUE INDEX "project_uph_test_batch_revisions_lineage_root_key"
  ON "project_uph_test_batch_revisions" ("project_id", "batch_id")
  WHERE "supersedes_revision_id" IS NULL;
CREATE UNIQUE INDEX "project_uph_test_batch_revisions_current_work_key"
  ON "project_uph_test_batch_revisions" ("project_id", "batch_id")
  WHERE status IN ('DRAFT', 'PM_CONFIRMED');
CREATE UNIQUE INDEX "project_uph_test_batch_revisions_current_locked_key"
  ON "project_uph_test_batch_revisions" ("project_id", "batch_id")
  WHERE status = 'LOCKED';
CREATE UNIQUE INDEX "project_uph_test_batch_revision_bindings_id_revision_project_key"
  ON "project_uph_test_batch_revision_module_bindings" ("id", "revision_id", "project_id");
CREATE UNIQUE INDEX "project_uph_test_batch_revision_bindings_revision_module_project_key"
  ON "project_uph_test_batch_revision_module_bindings" ("revision_id", "project_module_id", "project_id");
CREATE UNIQUE INDEX "project_uph_test_batch_revision_production_counts_revision_project_key"
  ON "project_uph_test_batch_revision_production_counts" ("revision_id", "project_id");
CREATE UNIQUE INDEX "project_uph_module_cycle_samples_id_revision_project_key"
  ON "project_uph_module_cycle_samples" ("id", "revision_id", "project_id");
CREATE UNIQUE INDEX "project_uph_module_cycle_samples_binding_ordinal_project_key"
  ON "project_uph_module_cycle_samples" ("module_binding_id", "ordinal", "project_id");
CREATE UNIQUE INDEX "project_uph_module_cycle_samples_correction_of_key"
  ON "project_uph_module_cycle_samples" ("correction_of_sample_id")
  WHERE "correction_of_sample_id" IS NOT NULL;
CREATE UNIQUE INDEX "project_uph_module_cycle_samples_source_event_key"
  ON "project_uph_module_cycle_samples" ("module_binding_id", "source_event_id", "project_id")
  WHERE "source_event_id" IS NOT NULL;
CREATE UNIQUE INDEX "project_uph_test_batch_revision_evidence_revision_file_key"
  ON "project_uph_test_batch_revision_evidence" ("revision_id", "file_object_id");
CREATE INDEX "project_uph_test_batch_revisions_project_batch_status_idx"
  ON "project_uph_test_batch_revisions" ("project_id", "batch_id", "status");
CREATE INDEX "project_uph_test_batch_revision_bindings_project_module_idx"
  ON "project_uph_test_batch_revision_module_bindings" ("project_id", "project_module_id");
CREATE INDEX "project_uph_module_cycle_samples_revision_project_idx"
  ON "project_uph_module_cycle_samples" ("revision_id", "project_id");
CREATE INDEX "project_uph_test_batch_revision_evidence_project_revision_idx"
  ON "project_uph_test_batch_revision_evidence" ("project_id", "revision_id");

ALTER TABLE "project_uph_test_batches"
  ADD CONSTRAINT "project_uph_test_batches_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batches_current_work_fkey"
    FOREIGN KEY ("current_work_revision_id", "project_id") REFERENCES "project_uph_test_batch_revisions"("id", "project_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "project_uph_test_batches_current_locked_fkey"
    FOREIGN KEY ("current_locked_revision_id", "project_id") REFERENCES "project_uph_test_batch_revisions"("id", "project_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_uph_test_batch_revisions"
  ADD CONSTRAINT "project_uph_test_batch_revisions_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_revisions_batch_fkey"
    FOREIGN KEY ("batch_id", "project_id") REFERENCES "project_uph_test_batches"("id", "project_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "project_uph_test_batch_revisions_supersedes_fkey"
    FOREIGN KEY ("supersedes_revision_id", "project_id") REFERENCES "project_uph_test_batch_revisions"("id", "project_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "project_uph_test_batch_revisions_topology_version_fkey"
    FOREIGN KEY ("topology_version_id", "project_id") REFERENCES "project_uph_topology_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_revisions_topology_root_fkey"
    FOREIGN KEY ("topology_root_node_id", "topology_version_id") REFERENCES "project_uph_topology_nodes"("id", "topology_version_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_revisions_formula_version_fkey"
    FOREIGN KEY ("formula_version_id", "project_id") REFERENCES "project_uph_formula_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_revisions_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_revisions_process_member_fkey"
    FOREIGN KEY ("process_owner_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_revisions_pm_member_fkey"
    FOREIGN KEY ("pm_confirmer_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_revisions_quality_member_fkey"
    FOREIGN KEY ("quality_locker_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_revisions_process_user_fkey"
    FOREIGN KEY ("process_owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_revisions_pm_user_fkey"
    FOREIGN KEY ("pm_confirmer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_revisions_quality_user_fkey"
    FOREIGN KEY ("quality_locker_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_uph_test_batch_revision_module_bindings"
  ADD CONSTRAINT "project_uph_test_batch_bindings_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_bindings_revision_fkey"
    FOREIGN KEY ("revision_id", "project_id") REFERENCES "project_uph_test_batch_revisions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_bindings_module_fkey"
    FOREIGN KEY ("project_module_id", "project_id") REFERENCES "project_modules"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_bindings_ct_version_fkey"
    FOREIGN KEY ("ct_version_id", "ct_definition_id", "project_id") REFERENCES "project_uph_ct_definition_versions"("id", "ct_definition_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_uph_test_batch_revision_production_counts"
  ADD CONSTRAINT "project_uph_test_batch_production_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_production_revision_fkey"
    FOREIGN KEY ("revision_id", "project_id") REFERENCES "project_uph_test_batch_revisions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_uph_module_cycle_samples"
  ADD CONSTRAINT "project_uph_module_cycle_samples_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_module_cycle_samples_revision_fkey"
    FOREIGN KEY ("revision_id", "project_id") REFERENCES "project_uph_test_batch_revisions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_module_cycle_samples_binding_fkey"
    FOREIGN KEY ("module_binding_id", "revision_id", "project_id") REFERENCES "project_uph_test_batch_revision_module_bindings"("id", "revision_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_module_cycle_samples_correction_of_fkey"
    FOREIGN KEY ("correction_of_sample_id", "revision_id", "project_id") REFERENCES "project_uph_module_cycle_samples"("id", "revision_id", "project_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "project_uph_module_cycle_samples_captured_member_fkey"
    FOREIGN KEY ("captured_by_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_module_cycle_samples_captured_user_fkey"
    FOREIGN KEY ("captured_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_uph_test_batch_revision_evidence"
  ADD CONSTRAINT "project_uph_test_batch_evidence_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_evidence_revision_fkey"
    FOREIGN KEY ("revision_id", "project_id") REFERENCES "project_uph_test_batch_revisions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_evidence_sample_fkey"
    FOREIGN KEY ("sample_id", "revision_id", "project_id") REFERENCES "project_uph_module_cycle_samples"("id", "revision_id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_test_batch_evidence_file_fkey"
    FOREIGN KEY ("file_object_id", "project_id") REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "uph_test_batch_checksum"(payload JSONB) RETURNS TEXT AS $$
  SELECT encode(digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex');
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION "uph_test_batch_responsibility_checksum"(
  membership_id TEXT,
  user_id TEXT,
  role "ProjectRole",
  fact_at TIMESTAMPTZ,
  referenced_checksum TEXT
) RETURNS TEXT AS $$
  SELECT "uph_test_batch_checksum"(
    jsonb_strip_nulls(jsonb_build_object(
      'membershipId', membership_id,
      'userId', user_id,
      'role', role::text,
      'factAt', fact_at,
      'referencedChecksum', referenced_checksum
    ))
  );
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION "uph_test_batch_responsibility_snapshot"(
  membership_id TEXT,
  user_id TEXT,
  role "ProjectRole",
  fact_at TIMESTAMPTZ,
  referenced_checksum TEXT
) RETURNS JSONB AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'membershipId', membership_id,
    'userId', user_id,
    'role', role::text,
    'factAt', fact_at,
    'referencedChecksum', referenced_checksum
  ));
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION "uph_test_batch_source_binding_snapshot"(revision_row "project_uph_test_batch_revisions") RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'topology', jsonb_build_object(
      'topologyVersionId', topology."id",
      'topologySnapshot', topology."snapshot_json",
      'topologyChecksum', topology."snapshot_checksum",
      'topologyWatermark', topology."source_watermark",
      'topologyRootNodeId', root."id",
      'topologyRootSnapshot', root."source_snapshot_json",
      'topologyRootChecksum', root."source_checksum",
      'topologyRootWatermark', root."source_watermark"
    ),
    'formula', jsonb_build_object(
      'formulaVersionId', formula."id",
      'formulaSnapshot', formula."formula_json",
      'formulaChecksum', formula."snapshot_checksum",
      'formulaWatermark', concat(formula."id", ':', formula."resource_version", ':', formula."snapshot_checksum")
    ),
    'moduleBindings', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'projectModuleId', binding."project_module_id",
          'ctDefinitionId', binding."ct_definition_id",
          'ctVersionId', binding."ct_version_id",
          'ctSnapshot', binding."ct_source_snapshot_json",
          'ctChecksum', binding."ct_source_checksum",
          'ctWatermark', binding."ct_source_watermark"
        ) ORDER BY binding."project_module_id", binding."id"
      )
      FROM "project_uph_test_batch_revision_module_bindings" binding
      WHERE binding."revision_id" = revision_row."id"
        AND binding."project_id" = revision_row."project_id"
    ), '[]'::jsonb)
  )
  FROM "project_uph_topology_versions" topology
  JOIN "project_uph_topology_nodes" root
    ON root."id" = revision_row."topology_root_node_id"
   AND root."topology_version_id" = topology."id"
   AND root."project_id" = revision_row."project_id"
  JOIN "project_uph_formula_versions" formula
    ON formula."id" = revision_row."formula_version_id"
   AND formula."project_id" = revision_row."project_id"
  WHERE topology."id" = revision_row."topology_version_id"
    AND topology."project_id" = revision_row."project_id";
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "uph_test_batch_source_watermark"(revision_row "project_uph_test_batch_revisions") RETURNS TEXT AS $$
  SELECT "uph_test_batch_checksum"("uph_test_batch_source_binding_snapshot"(revision_row));
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "uph_test_batch_plan_snapshot"(revision_row "project_uph_test_batch_revisions") RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'planDeclarationReason', revision_row."plan_declaration_reason",
    'plannedProductionSeconds', revision_row."planned_production_seconds",
    'planDeclaredAt', revision_row."plan_declared_at",
    'processOwnerMembershipId', revision_row."process_owner_membership_id",
    'processOwnerUserId', revision_row."process_owner_user_id",
    'processOwnerRole', revision_row."process_owner_role"::TEXT
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "uph_test_batch_confirmed_input_snapshot"(revision_row "project_uph_test_batch_revisions") RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'sources', revision_row."source_binding_snapshot_json",
    'protocol', revision_row."protocol_snapshot_json",
    'planSnapshotJson', revision_row."plan_snapshot_json",
    'planChecksum', revision_row."plan_checksum",
    'observationWindow', jsonb_build_object(
      'observationStartedAt', revision_row."observation_started_at",
      'observationEndedAt', revision_row."observation_ended_at",
      'timezone', revision_row."timezone"
    ),
    'samples', COALESCE((
      SELECT jsonb_agg(to_jsonb(sample) ORDER BY sample."module_binding_id", sample."ordinal", sample."id")
      FROM "project_uph_module_cycle_samples" sample
      WHERE sample."revision_id" = revision_row."id" AND sample."project_id" = revision_row."project_id"
    ), '[]'::jsonb),
    'productionCount', (
      SELECT to_jsonb(counts)
      FROM "project_uph_test_batch_revision_production_counts" counts
      WHERE counts."revision_id" = revision_row."id" AND counts."project_id" = revision_row."project_id"
    ),
    'moduleQualityCounts', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'projectModuleId', binding."project_module_id",
          'qualityInputCount', binding."quality_input_count",
          'firstPassGoodCount', binding."first_pass_good_count",
          'firstPassNonconformingCount', binding."first_pass_nonconforming_count",
          'reworkInputCount', binding."rework_input_count",
          'reworkRecoveredGoodCount', binding."rework_recovered_good_count"
        ) ORDER BY binding."project_module_id", binding."id"
      )
      FROM "project_uph_test_batch_revision_module_bindings" binding
      WHERE binding."revision_id" = revision_row."id" AND binding."project_id" = revision_row."project_id"
    ), '[]'::jsonb),
    'evidence', COALESCE((
      SELECT jsonb_agg(to_jsonb(evidence) ORDER BY evidence."id")
      FROM "project_uph_test_batch_revision_evidence" evidence
      WHERE evidence."revision_id" = revision_row."id" AND evidence."project_id" = revision_row."project_id"
    ), '[]'::jsonb)
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "uph_test_batch_rebuilt_module_statistics"(
  revision_row "project_uph_test_batch_revisions"
) RETURNS TABLE (
  binding_id TEXT,
  valid_sample_count INTEGER,
  excluded_sample_count INTEGER,
  arithmetic_mean_seconds NUMERIC(20, 6),
  p50_seconds NUMERIC(20, 6),
  p90_seconds NUMERIC(20, 6),
  max_seconds NUMERIC(20, 6),
  spread_p90_minus_p50_seconds NUMERIC(20, 6)
) AS $$
  WITH ordered_samples AS (
    SELECT sample."module_binding_id" AS binding_id,
           sample."cycle_duration_seconds" AS duration,
           row_number() OVER (
             PARTITION BY sample."module_binding_id"
             ORDER BY sample."cycle_duration_seconds", sample."ordinal", sample."id"
           ) AS ordinal_rank,
           count(*) OVER (PARTITION BY sample."module_binding_id") AS sample_count
    FROM "project_uph_module_cycle_samples" sample
    WHERE sample."revision_id" = revision_row."id"
      AND sample."project_id" = revision_row."project_id"
      AND sample."disposition" = 'INCLUDED'
  ),
  percentile_rank AS (
    SELECT binding_id,
           max(sample_count)::NUMERIC AS sample_count,
           1 + (max(sample_count) - 1) * 0.50::NUMERIC AS p50_rank,
           1 + (max(sample_count) - 1) * 0.90::NUMERIC AS p90_rank,
           sum(duration) / max(sample_count) AS mean_raw,
           max(duration) AS max_raw
    FROM ordered_samples
    GROUP BY binding_id
  ),
  percentile_values AS (
    SELECT rank.binding_id,
           rank.mean_raw,
           rank.max_raw,
           (SELECT lower_sample.duration + (rank.p50_rank - floor(rank.p50_rank)) * (upper_sample.duration - lower_sample.duration)
              FROM ordered_samples lower_sample
              JOIN ordered_samples upper_sample ON upper_sample.binding_id = lower_sample.binding_id
             WHERE lower_sample.binding_id = rank.binding_id
               AND lower_sample.ordinal_rank = floor(rank.p50_rank)::INTEGER
               AND upper_sample.ordinal_rank = ceil(rank.p50_rank)::INTEGER) AS p50_raw,
           (SELECT lower_sample.duration + (rank.p90_rank - floor(rank.p90_rank)) * (upper_sample.duration - lower_sample.duration)
              FROM ordered_samples lower_sample
              JOIN ordered_samples upper_sample ON upper_sample.binding_id = lower_sample.binding_id
             WHERE lower_sample.binding_id = rank.binding_id
               AND lower_sample.ordinal_rank = floor(rank.p90_rank)::INTEGER
               AND upper_sample.ordinal_rank = ceil(rank.p90_rank)::INTEGER) AS p90_raw
    FROM percentile_rank rank
  ),
  raw_statistics AS (
    SELECT values.*, values.p90_raw - values.p50_raw AS spread_raw
    FROM percentile_values values
  ),
  sample_counts AS (
    SELECT binding."id" AS binding_id,
           count(sample."id") FILTER (WHERE sample."disposition" = 'INCLUDED')::INTEGER AS valid_sample_count,
           count(sample."id") FILTER (WHERE sample."disposition" = 'EXCLUDED')::INTEGER AS excluded_sample_count
    FROM "project_uph_test_batch_revision_module_bindings" binding
    LEFT JOIN "project_uph_module_cycle_samples" sample
      ON sample."module_binding_id" = binding."id"
     AND sample."revision_id" = binding."revision_id"
     AND sample."project_id" = binding."project_id"
    WHERE binding."revision_id" = revision_row."id"
      AND binding."project_id" = revision_row."project_id"
    GROUP BY binding."id"
  )
  SELECT counts.binding_id,
         counts.valid_sample_count,
         counts.excluded_sample_count,
         round(values.mean_raw, 6)::NUMERIC(20, 6) AS arithmetic_mean_seconds,
         round(values.p50_raw, 6)::NUMERIC(20, 6) AS p50_seconds,
         round(values.p90_raw, 6)::NUMERIC(20, 6) AS p90_seconds,
         round(values.max_raw, 6)::NUMERIC(20, 6) AS max_seconds,
         round(values.spread_raw, 6)::NUMERIC(20, 6) AS spread_p90_minus_p50_seconds
  FROM sample_counts counts
  LEFT JOIN raw_statistics values ON values.binding_id = counts.binding_id;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "uph_test_batch_statistics_snapshot"(revision_row "project_uph_test_batch_revisions") RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'confirmedInputChecksum', revision_row."confirmed_input_checksum",
    'moduleStatistics', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'projectModuleId', binding."project_module_id",
          'validSampleCount', statistics.valid_sample_count,
          'excludedSampleCount', statistics.excluded_sample_count,
          'arithmeticMeanSeconds', statistics.arithmetic_mean_seconds,
          'p50Seconds', statistics.p50_seconds,
          'p90Seconds', statistics.p90_seconds,
          'maxSeconds', statistics.max_seconds,
          'spreadP90MinusP50Seconds', statistics.spread_p90_minus_p50_seconds
        ) ORDER BY binding."project_module_id", binding."id"
      )
      FROM "project_uph_test_batch_revision_module_bindings" binding
      JOIN "uph_test_batch_rebuilt_module_statistics"(revision_row) statistics
        ON statistics.binding_id = binding."id"
      WHERE binding."revision_id" = revision_row."id" AND binding."project_id" = revision_row."project_id"
    ), '[]'::jsonb)
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "uph_test_batch_locked_snapshot"(revision_row "project_uph_test_batch_revisions") RETURNS JSONB AS $$
  SELECT jsonb_build_object(
    'confirmedInputChecksum', revision_row."confirmed_input_checksum",
    'statisticsChecksum', revision_row."statistics_checksum"
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "project_uph_test_batch_binding_guard"() RETURNS TRIGGER AS $$
DECLARE
  revision_row "project_uph_test_batch_revisions"%ROWTYPE;
  predecessor_row "project_uph_test_batch_revisions"%ROWTYPE;
  revision_id_value TEXT;
  project_id_value TEXT;
  expected_modules INTEGER;
  bound_modules INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'project_uph_test_batch_revisions' THEN
    revision_id_value := COALESCE(NEW."id", OLD."id");
    project_id_value := COALESCE(NEW."project_id", OLD."project_id");
  ELSIF TG_TABLE_NAME = 'project_uph_test_batch_revision_module_bindings' THEN
    revision_id_value := COALESCE(NEW."revision_id", OLD."revision_id");
    project_id_value := COALESCE(NEW."project_id", OLD."project_id");
  ELSE
    RAISE EXCEPTION 'UPH test-batch binding guard received an unsupported table' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO revision_row
  FROM "project_uph_test_batch_revisions"
  WHERE "id" = revision_id_value AND "project_id" = project_id_value;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'UPH test-batch revision is required for binding' USING ERRCODE = '23514';
  END IF;

  IF (revision_row."status" IN ('DRAFT', 'PM_CONFIRMED')
      OR (revision_row."status" = 'SUPERSEDED' AND revision_row."quality_locker_membership_id" IS NULL))
    AND EXISTS (
      SELECT 1
      FROM "project_uph_test_batch_revision_module_bindings" binding
      WHERE binding."revision_id" = revision_row."id"
        AND binding."project_id" = revision_row."project_id"
        AND (binding."valid_sample_count" IS NOT NULL
          OR binding."excluded_sample_count" IS NOT NULL
          OR binding."arithmetic_mean_seconds" IS NOT NULL
          OR binding."p50_seconds" IS NOT NULL
          OR binding."p90_seconds" IS NOT NULL
          OR binding."max_seconds" IS NOT NULL
          OR binding."spread_p90_minus_p50_seconds" IS NOT NULL)
    ) THEN
    RAISE EXCEPTION 'UPH binding statistics must be null before LOCKED facts exist' USING ERRCODE = '23514';
  END IF;

  IF revision_row."supersedes_revision_id" IS NULL THEN
    -- Current-PUBLISHED resolution is an initial-create rule only.  Later
    -- draft/confirmation/lock writes must retain (not re-resolve) the frozen source.
    IF TG_OP = 'INSERT' AND NOT EXISTS (
      SELECT 1
      FROM "project_uph_topology_versions" topology
      JOIN "project_uph_formula_versions" formula
        ON formula."id" = revision_row."formula_version_id" AND formula."project_id" = revision_row."project_id"
      JOIN "project_uph_topology_nodes" root
        ON root."id" = revision_row."topology_root_node_id"
       AND root."topology_version_id" = revision_row."topology_version_id"
       AND root."project_id" = revision_row."project_id"
      WHERE topology."id" = revision_row."topology_version_id"
        AND topology."project_id" = revision_row."project_id"
        AND topology."status" = 'PUBLISHED'
        AND topology."id" = (
          SELECT root."current_published_version_id"
          FROM "project_uph_topologies" root
          WHERE root."project_id" = revision_row."project_id"
        )
        AND formula."status" = 'PUBLISHED'
        AND formula."id" = (
          SELECT root."current_published_version_id"
          FROM "project_uph_formulas" root
          WHERE root."project_id" = revision_row."project_id"
        )
        AND root."parent_relation" = 'ROOT'
    ) THEN
      RAISE EXCEPTION 'UPH test-batch requires exact current PUBLISHED topology root and formula' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO predecessor_row FROM "project_uph_test_batch_revisions"
    WHERE "id" = revision_row."supersedes_revision_id"
      AND "project_id" = revision_row."project_id";
    IF NOT FOUND
      OR (revision_row."topology_version_id", revision_row."topology_root_node_id", revision_row."formula_version_id",
          revision_row."source_binding_snapshot_json", revision_row."source_watermark", revision_row."source_checksum")
         IS DISTINCT FROM
         (predecessor_row."topology_version_id", predecessor_row."topology_root_node_id", predecessor_row."formula_version_id",
          predecessor_row."source_binding_snapshot_json", predecessor_row."source_watermark", predecessor_row."source_checksum") THEN
      RAISE EXCEPTION 'UPH successor must retain the predecessor exact frozen source binding' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "project_uph_test_batch_revision_module_bindings" binding
    JOIN "project_uph_ct_definitions" definition
      ON definition."id" = binding."ct_definition_id" AND definition."project_id" = binding."project_id"
    JOIN "project_uph_ct_definition_versions" version
      ON version."id" = binding."ct_version_id"
     AND version."ct_definition_id" = binding."ct_definition_id"
     AND version."project_id" = binding."project_id"
    WHERE binding."revision_id" = revision_row."id"
      AND binding."project_id" = revision_row."project_id"
      AND definition."project_module_id" <> binding."project_module_id"
  ) THEN
    RAISE EXCEPTION 'UPH test-batch ct definition/version pairing is invalid' USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE tree AS (
    SELECT node."id", node."project_module_id"
    FROM "project_uph_topology_nodes" node
    WHERE node."id" = revision_row."topology_root_node_id"
      AND node."topology_version_id" = revision_row."topology_version_id"
    UNION ALL
    SELECT child."id", child."project_module_id"
    FROM "project_uph_topology_nodes" child
    JOIN tree ON child."parent_node_id" = tree."id"
    WHERE child."topology_version_id" = revision_row."topology_version_id"
  )
  SELECT count(*) INTO expected_modules FROM tree WHERE "project_module_id" IS NOT NULL;
  SELECT count(*) INTO bound_modules
  FROM "project_uph_test_batch_revision_module_bindings"
  WHERE "revision_id" = revision_row."id" AND "project_id" = revision_row."project_id";
  IF expected_modules = 0 OR expected_modules <> bound_modules OR EXISTS (
    WITH RECURSIVE tree AS (
      SELECT node."id", node."project_module_id"
      FROM "project_uph_topology_nodes" node
      WHERE node."id" = revision_row."topology_root_node_id"
        AND node."topology_version_id" = revision_row."topology_version_id"
      UNION ALL
      SELECT child."id", child."project_module_id"
      FROM "project_uph_topology_nodes" child
      JOIN tree ON child."parent_node_id" = tree."id"
      WHERE child."topology_version_id" = revision_row."topology_version_id"
    )
    SELECT 1 FROM tree
    LEFT JOIN "project_uph_test_batch_revision_module_bindings" binding
      ON binding."revision_id" = revision_row."id"
     AND binding."project_id" = revision_row."project_id"
     AND binding."project_module_id" = tree."project_module_id"
    WHERE tree."project_module_id" IS NOT NULL AND binding."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'UPH test-batch must bind the complete topology-root PROJECT_MODULE CT version set' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
      SELECT 1 FROM "project_uph_test_batch_revision_module_bindings" binding
      JOIN "project_uph_ct_definition_versions" version
        ON version."id" = binding."ct_version_id"
       AND version."ct_definition_id" = binding."ct_definition_id"
       AND version."project_id" = binding."project_id"
       WHERE binding."revision_id" = revision_row."id"
         AND binding."project_id" = revision_row."project_id"
         AND (binding."ct_source_snapshot_json" IS DISTINCT FROM version."snapshot_json"
           OR binding."ct_source_checksum" IS DISTINCT FROM version."snapshot_checksum"
           OR binding."ct_source_watermark" IS DISTINCT FROM version."source_watermark")
    ) THEN
    RAISE EXCEPTION 'UPH test-batch binding must freeze exact CT source snapshot/checksum/watermark' USING ERRCODE = '23514';
  END IF;
  IF revision_row."supersedes_revision_id" IS NULL AND TG_OP = 'INSERT' AND EXISTS (
    SELECT 1
    FROM "project_uph_test_batch_revision_module_bindings" binding
    JOIN "project_uph_ct_definitions" definition
      ON definition."id" = binding."ct_definition_id" AND definition."project_id" = binding."project_id"
    WHERE binding."revision_id" = revision_row."id"
      AND binding."project_id" = revision_row."project_id"
       AND (binding."ct_version_id" <> definition."current_published_version_id"
         OR NOT EXISTS (
           SELECT 1 FROM "project_uph_ct_definition_versions" version
           WHERE version."id" = binding."ct_version_id"
             AND version."ct_definition_id" = binding."ct_definition_id"
             AND version."project_id" = binding."project_id"
             AND version."status" = 'PUBLISHED'
         ))
  ) THEN
    RAISE EXCEPTION 'UPH test-batch requires each module current PUBLISHED CT version' USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_test_batch_responsibility_guard"() RETURNS TRIGGER AS $$
DECLARE
  actor_status "UserStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT actor."status" INTO actor_status
    FROM "project_members" member
    JOIN "users" actor ON actor."id" = member."user_id"
    WHERE member."id" = NEW."process_owner_membership_id"
      AND member."project_id" = NEW."project_id"
      AND member."user_id" = NEW."process_owner_user_id"
      AND member."project_role" = 'ENGINEER'
      AND member."left_at" IS NULL
      AND actor."status" = 'ACTIVE'
    FOR KEY SHARE OF member, actor;
    IF NOT FOUND OR NEW."created_by_id" IS DISTINCT FROM NEW."process_owner_user_id" THEN
      RAISE EXCEPTION 'UPH process owner must be created by an active same-project ENGINEER membership' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."process_owner_snapshot_json" IS DISTINCT FROM "uph_test_batch_responsibility_snapshot"(
      NEW."process_owner_membership_id", NEW."process_owner_user_id", 'ENGINEER'::"ProjectRole", NEW."created_at", NULL
    ) OR NEW."process_owner_checksum" IS DISTINCT FROM "uph_test_batch_responsibility_checksum"(
      NEW."process_owner_membership_id", NEW."process_owner_user_id", 'ENGINEER'::"ProjectRole", NEW."created_at", NULL
    ) THEN
    RAISE EXCEPTION 'UPH process owner responsibility snapshot/checksum is immutable' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."pm_confirmer_membership_id" IS NULL AND NEW."pm_confirmer_membership_id" IS NOT NULL THEN
    SELECT actor."status" INTO actor_status
    FROM "project_members" member
    JOIN "users" actor ON actor."id" = member."user_id"
    WHERE member."id" = NEW."pm_confirmer_membership_id"
      AND member."project_id" = NEW."project_id"
      AND member."user_id" = NEW."pm_confirmer_user_id"
      AND member."project_role" = 'PROJECT_MANAGER'
      AND member."left_at" IS NULL
      AND actor."status" = 'ACTIVE'
    FOR KEY SHARE OF member, actor;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'UPH PM confirmer must first form from an active same-project PROJECT_MANAGER membership' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."pm_confirmer_membership_id" IS NOT NULL AND (
    NEW."pm_confirmer_snapshot_json" IS DISTINCT FROM "uph_test_batch_responsibility_snapshot"(
      NEW."pm_confirmer_membership_id", NEW."pm_confirmer_user_id", 'PROJECT_MANAGER'::"ProjectRole",
      NEW."pm_confirmed_at", NEW."confirmed_input_checksum"
    ) OR NEW."pm_confirmer_checksum" IS DISTINCT FROM "uph_test_batch_responsibility_checksum"(
      NEW."pm_confirmer_membership_id", NEW."pm_confirmer_user_id", 'PROJECT_MANAGER'::"ProjectRole",
      NEW."pm_confirmed_at", NEW."confirmed_input_checksum"
    )
  ) THEN
    RAISE EXCEPTION 'UPH PM confirmer responsibility snapshot/checksum is immutable' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."quality_locker_membership_id" IS NULL AND NEW."quality_locker_membership_id" IS NOT NULL THEN
    SELECT actor."status" INTO actor_status
    FROM "project_members" member
    JOIN "users" actor ON actor."id" = member."user_id"
    WHERE member."id" = NEW."quality_locker_membership_id"
      AND member."project_id" = NEW."project_id"
      AND member."user_id" = NEW."quality_locker_user_id"
      AND member."project_role" = 'QUALITY'
      AND member."left_at" IS NULL
      AND actor."status" = 'ACTIVE'
    FOR KEY SHARE OF member, actor;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'UPH QUALITY locker must first form from an active same-project QUALITY membership' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."quality_locker_membership_id" IS NOT NULL AND (
    NEW."quality_locker_snapshot_json" IS DISTINCT FROM "uph_test_batch_responsibility_snapshot"(
      NEW."quality_locker_membership_id", NEW."quality_locker_user_id", 'QUALITY'::"ProjectRole",
      NEW."locked_at", NEW."locked_checksum"
    ) OR NEW."quality_locker_checksum" IS DISTINCT FROM "uph_test_batch_responsibility_checksum"(
      NEW."quality_locker_membership_id", NEW."quality_locker_user_id", 'QUALITY'::"ProjectRole",
      NEW."locked_at", NEW."locked_checksum"
    )
  ) THEN
    RAISE EXCEPTION 'UPH QUALITY locker responsibility snapshot/checksum is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_test_batch_revision_checksum_guard"() RETURNS TRIGGER AS $$
DECLARE
  revision_row "project_uph_test_batch_revisions"%ROWTYPE;
  expected_protocol JSONB := jsonb_build_object(
    'code', 'UPH_TEST_PROTOCOL',
    'version', 1,
    'unit', 'seconds/cycle',
    'secondsPerCycle', true,
    'decimalScale', 6,
    'rounding', 'HALF_UP',
    'captureMethods', jsonb_build_array('MANUAL_ENTRY', 'DEVICE_EVENT'),
    'minimumIncludedCycleSamplesPerModule', 10,
    'statisticsEligibility', jsonb_build_object('eligibleForStatistics', 'disposition=INCLUDED'),
    'statistics', jsonb_build_object(
      'arithmeticMean', 'MEAN', 'maximum', 'MAXIMUM', 'percentile', 'R-7', 'spread', 'P90_MINUS_P50'
    ),
    'exclusionReasonCodes', jsonb_build_array(
      'SETUP_OR_CHANGEOVER', 'EXTERNAL_WAITING', 'UPSTREAM_MATERIAL_STARVATION', 'DOWNSTREAM_BLOCKAGE',
      'SAFETY_INTERLOCK', 'CAPTURE_DEVICE_FAULT', 'OBSERVATION_INTERRUPTED', 'MANUAL_ENTRY_CORRECTION'
    )
  );
BEGIN
  SELECT * INTO revision_row
  FROM "project_uph_test_batch_revisions"
  WHERE "id" = COALESCE(NEW."id", OLD."id")
    AND "project_id" = COALESCE(NEW."project_id", OLD."project_id");
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF revision_row."protocol_snapshot_json" IS DISTINCT FROM expected_protocol
    OR revision_row."protocol_checksum" IS DISTINCT FROM "uph_test_batch_checksum"(expected_protocol) THEN
    RAISE EXCEPTION 'UPH_TEST_PROTOCOL@1 snapshot/checksum is invalid' USING ERRCODE = '23514';
  END IF;
  IF revision_row."plan_snapshot_json" IS DISTINCT FROM "uph_test_batch_plan_snapshot"(revision_row)
    OR revision_row."plan_checksum" IS DISTINCT FROM "uph_test_batch_checksum"(revision_row."plan_snapshot_json") THEN
    RAISE EXCEPTION 'UPH test-batch plan snapshot/checksum must rebuild from the declared plan and process owner' USING ERRCODE = '23514';
  END IF;
  IF revision_row."source_binding_snapshot_json" IS DISTINCT FROM "uph_test_batch_source_binding_snapshot"(revision_row)
    OR revision_row."source_watermark" IS DISTINCT FROM "uph_test_batch_source_watermark"(revision_row)
    OR revision_row."source_checksum" IS DISTINCT FROM "uph_test_batch_checksum"(revision_row."source_binding_snapshot_json") THEN
    RAISE EXCEPTION 'UPH test-batch source binding snapshot/checksum/watermark must rebuild from exact sources' USING ERRCODE = '23514';
  END IF;

  IF revision_row."status" IN ('PM_CONFIRMED', 'LOCKED', 'SUPERSEDED') THEN
    IF revision_row."observation_ended_at" IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM "project_uph_test_batch_revision_production_counts" counts
        WHERE counts."revision_id" = revision_row."id" AND counts."project_id" = revision_row."project_id"
      )
      OR EXISTS (
        SELECT 1 FROM "project_uph_test_batch_revision_module_bindings" binding
        WHERE binding."revision_id" = revision_row."id"
          AND binding."project_id" = revision_row."project_id"
          AND (binding."quality_input_count" IS NULL
            OR binding."first_pass_good_count" IS NULL
            OR binding."first_pass_nonconforming_count" IS NULL
            OR binding."rework_input_count" IS NULL
            OR binding."rework_recovered_good_count" IS NULL)
      )
      OR EXISTS (
        SELECT 1 FROM "project_uph_module_cycle_samples" sample
        WHERE sample."revision_id" = revision_row."id"
          AND sample."project_id" = revision_row."project_id"
          AND (sample."observed_at" < revision_row."observation_started_at"
            OR sample."observed_at" > revision_row."observation_ended_at")
      )
      OR EXISTS (
        SELECT 1 FROM "project_uph_test_batch_revision_module_bindings" binding
        WHERE binding."revision_id" = revision_row."id"
          AND binding."project_id" = revision_row."project_id"
          AND 10 > (SELECT count(*) FROM "project_uph_module_cycle_samples" sample
                    WHERE sample."module_binding_id" = binding."id"
                      AND sample."revision_id" = binding."revision_id"
                      AND sample."project_id" = binding."project_id"
                      AND sample."disposition" = 'INCLUDED')
      ) THEN
      RAISE EXCEPTION 'PM_CONFIRM requires a closed observation window and ten INCLUDED samples per module' USING ERRCODE = '23514';
    END IF;
    -- Rebuild confirmed input snapshot from source, plan/window, all samples, counts, and evidence.
    IF revision_row."confirmed_input_snapshot_json" IS DISTINCT FROM "uph_test_batch_confirmed_input_snapshot"(revision_row)
      OR revision_row."confirmed_input_checksum" IS DISTINCT FROM "uph_test_batch_checksum"(revision_row."confirmed_input_snapshot_json") THEN
      RAISE EXCEPTION 'rebuild confirmed input snapshot/checksum from revision facts failed' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF revision_row."status" = 'LOCKED'
    OR (revision_row."status" = 'SUPERSEDED' AND revision_row."quality_locker_membership_id" IS NOT NULL) THEN
    IF EXISTS (
      SELECT 1
      FROM "project_uph_test_batch_revision_module_bindings" binding
      JOIN "uph_test_batch_rebuilt_module_statistics"(revision_row) rebuilt ON rebuilt.binding_id = binding."id"
      WHERE binding."revision_id" = revision_row."id"
        AND binding."project_id" = revision_row."project_id"
        AND (binding."valid_sample_count", binding."excluded_sample_count", binding."arithmetic_mean_seconds",
             binding."p50_seconds", binding."p90_seconds", binding."max_seconds", binding."spread_p90_minus_p50_seconds")
            IS DISTINCT FROM
            (rebuilt.valid_sample_count, rebuilt.excluded_sample_count, rebuilt.arithmetic_mean_seconds,
             rebuilt.p50_seconds, rebuilt.p90_seconds, rebuilt.max_seconds, rebuilt.spread_p90_minus_p50_seconds)
    ) THEN
      RAISE EXCEPTION 'locked UPH binding statistics must rebuild from INCLUDED and EXCLUDED cycle samples' USING ERRCODE = '23514';
    END IF;
    IF revision_row."statistics_snapshot_json" IS DISTINCT FROM "uph_test_batch_statistics_snapshot"(revision_row)
      OR revision_row."statistics_checksum" IS DISTINCT FROM "uph_test_batch_checksum"(revision_row."statistics_snapshot_json")
      OR revision_row."locked_snapshot_json" IS DISTINCT FROM "uph_test_batch_locked_snapshot"(revision_row)
      OR revision_row."locked_checksum" IS DISTINCT FROM "uph_test_batch_checksum"(revision_row."locked_snapshot_json") THEN
      RAISE EXCEPTION 'rebuild statistics snapshot/checksum and locked checksum chain failed' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_test_batch_root_immutable_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'UPH test-batch roots are append-only' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."resource_version" <> 1 THEN
    RAISE EXCEPTION 'UPH test-batch root must start at resource version one' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
      OR NEW."batch_number" IS DISTINCT FROM OLD."batch_number"
      OR NEW."scope" IS DISTINCT FROM OLD."scope"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'UPH test-batch root identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW."resource_version" <> OLD."resource_version" + 1 THEN
      RAISE EXCEPTION 'UPH test-batch root resource version must increment by one' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_test_batch_revision_insert_guard"() RETURNS TRIGGER AS $$
DECLARE
  predecessor "project_uph_test_batch_revisions"%ROWTYPE;
BEGIN
  IF NEW."status" <> 'DRAFT' OR NEW."resource_version" <> 1 THEN
    RAISE EXCEPTION 'new UPH test-batch revision must be created as DRAFT with resource version one' USING ERRCODE = '23514';
  END IF;
  IF NEW."supersedes_revision_id" IS NULL THEN
    IF NEW."revision_number" <> 1 THEN
      RAISE EXCEPTION 'initial UPH test-batch revision must be revision number one' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO predecessor
    FROM "project_uph_test_batch_revisions"
    WHERE "id" = NEW."supersedes_revision_id" AND "project_id" = NEW."project_id";
    IF NOT FOUND
      OR predecessor."batch_id" <> NEW."batch_id"
      OR NEW."revision_number" <> predecessor."revision_number" + 1
      OR predecessor."status" NOT IN ('PM_CONFIRMED', 'LOCKED', 'SUPERSEDED') THEN
      RAISE EXCEPTION 'UPH test-batch successor must directly follow an allowed same-batch predecessor' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."pm_confirmer_membership_id" IS NOT NULL OR NEW."quality_locker_membership_id" IS NOT NULL
    OR NEW."confirmed_input_snapshot_json" IS NOT NULL OR NEW."statistics_snapshot_json" IS NOT NULL
    OR NEW."locked_snapshot_json" IS NOT NULL THEN
    RAISE EXCEPTION 'successor must clear PM, QUALITY, checksum, and binding statistics facts' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_test_batch_revision_immutable_guard"() RETURNS TRIGGER AS $$
DECLARE
  old_json JSONB;
  new_json JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'UPH test-batch revisions are append-only' USING ERRCODE = '55000';
  END IF;
  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."batch_id" IS DISTINCT FROM OLD."batch_id"
    OR NEW."revision_number" IS DISTINCT FROM OLD."revision_number"
    OR NEW."supersedes_revision_id" IS DISTINCT FROM OLD."supersedes_revision_id"
    OR NEW."topology_version_id" IS DISTINCT FROM OLD."topology_version_id"
    OR NEW."topology_root_node_id" IS DISTINCT FROM OLD."topology_root_node_id"
    OR NEW."formula_version_id" IS DISTINCT FROM OLD."formula_version_id"
    OR NEW."test_protocol_code" IS DISTINCT FROM OLD."test_protocol_code"
    OR NEW."test_protocol_version" IS DISTINCT FROM OLD."test_protocol_version"
    OR NEW."protocol_snapshot_json" IS DISTINCT FROM OLD."protocol_snapshot_json"
    OR NEW."protocol_checksum" IS DISTINCT FROM OLD."protocol_checksum"
    OR NEW."source_binding_snapshot_json" IS DISTINCT FROM OLD."source_binding_snapshot_json"
    OR NEW."source_watermark" IS DISTINCT FROM OLD."source_watermark"
    OR NEW."source_checksum" IS DISTINCT FROM OLD."source_checksum"
    OR NEW."process_owner_membership_id" IS DISTINCT FROM OLD."process_owner_membership_id"
    OR NEW."process_owner_user_id" IS DISTINCT FROM OLD."process_owner_user_id"
    OR NEW."process_owner_role" IS DISTINCT FROM OLD."process_owner_role"
    OR NEW."process_owner_snapshot_json" IS DISTINCT FROM OLD."process_owner_snapshot_json"
    OR NEW."process_owner_checksum" IS DISTINCT FROM OLD."process_owner_checksum"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'UPH test-batch frozen source binding and identity are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."resource_version" <> OLD."resource_version" + 1 THEN
    RAISE EXCEPTION 'UPH test-batch resource version must increment by one' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'SUPERSEDED UPH test-batch revision is immutable' USING ERRCODE = '55000';
  ELSIF OLD."status" = 'LOCKED' THEN
    IF NEW."status" <> 'SUPERSEDED'
      OR (old_json - ARRAY['status', 'resource_version']) IS DISTINCT FROM (new_json - ARRAY['status', 'resource_version']) THEN
      RAISE EXCEPTION 'LOCKED UPH test-batch revision is immutable' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD."status" = 'PM_CONFIRMED' THEN
    IF NEW."status" = 'SUPERSEDED' THEN
      IF (old_json - ARRAY['status', 'resource_version']) IS DISTINCT FROM (new_json - ARRAY['status', 'resource_version']) THEN
        RAISE EXCEPTION 'PM_CONFIRMED replacement must retain PM facts only' USING ERRCODE = '55000';
      END IF;
    ELSIF NEW."status" <> 'LOCKED'
      OR (old_json - ARRAY[
        'status', 'resource_version', 'quality_locker_membership_id', 'quality_locker_user_id', 'quality_locker_role',
        'quality_locker_snapshot_json', 'quality_locker_checksum', 'locked_at', 'statistics_snapshot_json',
        'statistics_checksum', 'locked_snapshot_json', 'locked_checksum'
      ]) IS DISTINCT FROM (new_json - ARRAY[
        'status', 'resource_version', 'quality_locker_membership_id', 'quality_locker_user_id', 'quality_locker_role',
        'quality_locker_snapshot_json', 'quality_locker_checksum', 'locked_at', 'statistics_snapshot_json',
        'statistics_checksum', 'locked_snapshot_json', 'locked_checksum'
      ]) THEN
      RAISE EXCEPTION 'PM_CONFIRMED UPH test-batch facts are immutable' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD."status" = 'DRAFT' AND NEW."status" NOT IN ('DRAFT', 'PM_CONFIRMED') THEN
    RAISE EXCEPTION 'DRAFT UPH test-batch may only transition to PM_CONFIRMED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_test_batch_binding_immutable_guard"() RETURNS TRIGGER AS $$
DECLARE
  status_value "UphTestBatchRevisionStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'UPH test-batch bindings are append-only' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT "status" INTO status_value FROM "project_uph_test_batch_revisions"
    WHERE "id" = OLD."revision_id" AND "project_id" = OLD."project_id";
  ELSE
    SELECT "status" INTO status_value FROM "project_uph_test_batch_revisions"
    WHERE "id" = NEW."revision_id" AND "project_id" = NEW."project_id";
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."revision_id" IS DISTINCT FROM OLD."revision_id"
    OR NEW."project_module_id" IS DISTINCT FROM OLD."project_module_id"
    OR NEW."ct_definition_id" IS DISTINCT FROM OLD."ct_definition_id"
    OR NEW."ct_version_id" IS DISTINCT FROM OLD."ct_version_id"
    OR NEW."ct_source_snapshot_json" IS DISTINCT FROM OLD."ct_source_snapshot_json"
    OR NEW."ct_source_checksum" IS DISTINCT FROM OLD."ct_source_checksum"
    OR NEW."ct_source_watermark" IS DISTINCT FROM OLD."ct_source_watermark"
  ) THEN
    RAISE EXCEPTION 'UPH test-batch source binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF status_value IN ('LOCKED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'locked UPH test-batch binding facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF status_value = 'PM_CONFIRMED' AND TG_OP = 'UPDATE' AND (
    NEW."quality_input_count" IS DISTINCT FROM OLD."quality_input_count"
    OR NEW."first_pass_good_count" IS DISTINCT FROM OLD."first_pass_good_count"
    OR NEW."first_pass_nonconforming_count" IS DISTINCT FROM OLD."first_pass_nonconforming_count"
    OR NEW."rework_input_count" IS DISTINCT FROM OLD."rework_input_count"
    OR NEW."rework_recovered_good_count" IS DISTINCT FROM OLD."rework_recovered_good_count"
  ) THEN
    RAISE EXCEPTION 'PM_CONFIRMED UPH test-batch counts are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM "project_uph_test_batch_revisions" revision
    WHERE revision."id" = NEW."revision_id"
      AND revision."project_id" = NEW."project_id"
      AND revision."supersedes_revision_id" IS NOT NULL
  ) AND (NEW."valid_sample_count" IS NOT NULL OR NEW."excluded_sample_count" IS NOT NULL
    OR NEW."arithmetic_mean_seconds" IS NOT NULL OR NEW."p50_seconds" IS NOT NULL
    OR NEW."p90_seconds" IS NOT NULL OR NEW."max_seconds" IS NOT NULL
    OR NEW."spread_p90_minus_p50_seconds" IS NOT NULL) THEN
    RAISE EXCEPTION 'successor binding statistics must be cleared before re-confirmation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_test_batch_child_immutable_guard"() RETURNS TRIGGER AS $$
DECLARE
  revision_id_value TEXT;
  project_id_value TEXT;
  status_value "UphTestBatchRevisionStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    revision_id_value := OLD."revision_id";
    project_id_value := OLD."project_id";
  ELSE
    revision_id_value := NEW."revision_id";
    project_id_value := NEW."project_id";
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'UPH test-batch raw facts are append-only' USING ERRCODE = '55000';
  END IF;
  SELECT "status" INTO status_value FROM "project_uph_test_batch_revisions"
  WHERE "id" = revision_id_value AND "project_id" = project_id_value;
  IF status_value <> 'DRAFT' THEN
    RAISE EXCEPTION 'confirmed or locked UPH test-batch raw facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'project_uph_test_batch_revision_evidence' AND TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'UPH test-batch evidence manifest is append-only and cannot be detached or rewritten' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_test_batch_sample_append_guard"() RETURNS TRIGGER AS $$
DECLARE
  status_value "UphTestBatchRevisionStatus";
  project_id_value TEXT;
  revision_id_value TEXT;
  module_binding_id_value TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    project_id_value := OLD."project_id";
    revision_id_value := OLD."revision_id";
    module_binding_id_value := OLD."module_binding_id";
    SELECT "status" INTO status_value FROM "project_uph_test_batch_revisions"
    WHERE "id" = OLD."revision_id" AND "project_id" = OLD."project_id";
  ELSE
    project_id_value := NEW."project_id";
    revision_id_value := NEW."revision_id";
    module_binding_id_value := NEW."module_binding_id";
    SELECT "status" INTO status_value FROM "project_uph_test_batch_revisions"
    WHERE "id" = NEW."revision_id" AND "project_id" = NEW."project_id";
  END IF;
  IF status_value IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'confirmed or locked UPH cycle samples are immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'UPH cycle samples cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."captured_by_snapshot_json" IS DISTINCT FROM "uph_test_batch_responsibility_snapshot"(
      NEW."captured_by_membership_id", NEW."captured_by_user_id", 'ENGINEER'::"ProjectRole", NEW."recorded_at", NULL
    ) OR NEW."captured_by_checksum" IS DISTINCT FROM "uph_test_batch_responsibility_checksum"(
      NEW."captured_by_membership_id", NEW."captured_by_user_id", 'ENGINEER'::"ProjectRole", NEW."recorded_at", NULL
    ) THEN
      RAISE EXCEPTION 'UPH sample capture responsibility snapshot/checksum must be immutable' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM "project_members" member
      JOIN "users" actor ON actor."id" = member."user_id" AND actor."status" = 'ACTIVE'
      WHERE member."id" = NEW."captured_by_membership_id"
        AND member."project_id" = NEW."project_id"
        AND member."user_id" = NEW."captured_by_user_id"
        AND member."project_role" = 'ENGINEER'
        AND member."left_at" IS NULL
    ) AND NOT EXISTS (
      SELECT 1
      FROM "project_uph_test_batch_revisions" successor
      JOIN "project_uph_test_batch_revisions" predecessor
        ON predecessor."id" = successor."supersedes_revision_id"
       AND predecessor."project_id" = successor."project_id"
       AND predecessor."batch_id" = successor."batch_id"
       AND successor."revision_number" = predecessor."revision_number" + 1
      JOIN "project_uph_test_batch_revision_module_bindings" successor_binding
        ON successor_binding."id" = NEW."module_binding_id"
       AND successor_binding."revision_id" = successor."id"
       AND successor_binding."project_id" = successor."project_id"
      JOIN "project_uph_test_batch_revision_module_bindings" predecessor_binding
        ON predecessor_binding."revision_id" = predecessor."id"
       AND predecessor_binding."project_id" = predecessor."project_id"
       AND predecessor_binding."project_module_id" = successor_binding."project_module_id"
       AND predecessor_binding."ct_definition_id" = successor_binding."ct_definition_id"
       AND predecessor_binding."ct_version_id" = successor_binding."ct_version_id"
       AND predecessor_binding."ct_source_snapshot_json" IS NOT DISTINCT FROM successor_binding."ct_source_snapshot_json"
       AND predecessor_binding."ct_source_checksum" IS NOT DISTINCT FROM successor_binding."ct_source_checksum"
       AND predecessor_binding."ct_source_watermark" IS NOT DISTINCT FROM successor_binding."ct_source_watermark"
      JOIN "project_uph_module_cycle_samples" predecessor_sample
        ON predecessor_sample."project_id" = predecessor."project_id"
       AND predecessor_sample."revision_id" = predecessor."id"
       AND predecessor_sample."module_binding_id" = predecessor_binding."id"
       AND predecessor_sample."ordinal" = NEW."ordinal"
       AND predecessor_sample."source_event_id" IS NOT DISTINCT FROM NEW."source_event_id"
       AND predecessor_sample."cycle_duration_seconds" IS NOT DISTINCT FROM NEW."cycle_duration_seconds"
       AND predecessor_sample."observed_at" IS NOT DISTINCT FROM NEW."observed_at"
       AND predecessor_sample."recorded_at" IS NOT DISTINCT FROM NEW."recorded_at"
       AND predecessor_sample."capture_method" IS NOT DISTINCT FROM NEW."capture_method"
       AND predecessor_sample."captured_by_membership_id" IS NOT DISTINCT FROM NEW."captured_by_membership_id"
       AND predecessor_sample."captured_by_user_id" IS NOT DISTINCT FROM NEW."captured_by_user_id"
       AND predecessor_sample."captured_by_role" IS NOT DISTINCT FROM NEW."captured_by_role"
       AND predecessor_sample."captured_by_snapshot_json" IS NOT DISTINCT FROM NEW."captured_by_snapshot_json"
       AND predecessor_sample."captured_by_checksum" IS NOT DISTINCT FROM NEW."captured_by_checksum"
       AND predecessor_sample."disposition" IS NOT DISTINCT FROM NEW."disposition"
       AND predecessor_sample."exclusion_reason_code" IS NOT DISTINCT FROM NEW."exclusion_reason_code"
      LEFT JOIN "project_uph_module_cycle_samples" predecessor_corrected
        ON predecessor_corrected."id" = predecessor_sample."correction_of_sample_id"
       AND predecessor_corrected."project_id" = predecessor_sample."project_id"
       AND predecessor_corrected."revision_id" = predecessor_sample."revision_id"
      LEFT JOIN "project_uph_module_cycle_samples" successor_corrected
        ON successor_corrected."id" = NEW."correction_of_sample_id"
       AND successor_corrected."project_id" = NEW."project_id"
       AND successor_corrected."revision_id" = NEW."revision_id"
       AND successor_corrected."module_binding_id" = NEW."module_binding_id"
      WHERE successor."id" = NEW."revision_id"
        AND successor."project_id" = NEW."project_id"
        AND (
          (predecessor_sample."correction_of_sample_id" IS NULL AND NEW."correction_of_sample_id" IS NULL)
          OR (
            predecessor_sample."correction_of_sample_id" IS NOT NULL
            AND NEW."correction_of_sample_id" IS NOT NULL
            AND successor_corrected."ordinal" IS NOT DISTINCT FROM predecessor_corrected."ordinal"
            AND successor_corrected."source_event_id" IS NOT DISTINCT FROM predecessor_corrected."source_event_id"
            AND successor_corrected."cycle_duration_seconds" IS NOT DISTINCT FROM predecessor_corrected."cycle_duration_seconds"
            AND successor_corrected."observed_at" IS NOT DISTINCT FROM predecessor_corrected."observed_at"
            AND successor_corrected."recorded_at" IS NOT DISTINCT FROM predecessor_corrected."recorded_at"
            AND successor_corrected."capture_method" IS NOT DISTINCT FROM predecessor_corrected."capture_method"
            AND successor_corrected."captured_by_membership_id" IS NOT DISTINCT FROM predecessor_corrected."captured_by_membership_id"
            AND successor_corrected."captured_by_user_id" IS NOT DISTINCT FROM predecessor_corrected."captured_by_user_id"
            AND successor_corrected."captured_by_role" IS NOT DISTINCT FROM predecessor_corrected."captured_by_role"
            AND successor_corrected."captured_by_snapshot_json" IS NOT DISTINCT FROM predecessor_corrected."captured_by_snapshot_json"
            AND successor_corrected."captured_by_checksum" IS NOT DISTINCT FROM predecessor_corrected."captured_by_checksum"
            AND successor_corrected."disposition" IS NOT DISTINCT FROM predecessor_corrected."disposition"
            AND successor_corrected."exclusion_reason_code" IS NOT DISTINCT FROM predecessor_corrected."exclusion_reason_code"
          )
        )
    ) THEN
      RAISE EXCEPTION 'UPH sample must freeze an active same-project ENGINEER capture membership' USING ERRCODE = '23514';
    END IF;
    IF NEW."exclusion_reason_code" = 'MANUAL_ENTRY_CORRECTION' THEN
      RAISE EXCEPTION 'manual correction exclusion is server-owned and cannot be appended directly' USING ERRCODE = '23514';
    END IF;
    IF NEW."correction_of_sample_id" IS NOT NULL AND (
      NEW."capture_method" <> 'MANUAL_ENTRY'
      OR NEW."disposition" <> 'INCLUDED'
      OR NEW."exclusion_reason_code" IS NOT NULL
      OR NEW."source_event_id" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'manual correction replacement must be a MANUAL_ENTRY INCLUDED sample without exclusion or source event' USING ERRCODE = '23514';
    END IF;
    IF NEW."correction_of_sample_id" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "project_uph_module_cycle_samples" corrected
      WHERE corrected."id" = NEW."correction_of_sample_id"
        AND corrected."project_id" = NEW."project_id"
        AND corrected."revision_id" = NEW."revision_id"
        AND corrected."module_binding_id" = NEW."module_binding_id"
        AND corrected."disposition" = 'EXCLUDED'
        AND corrected."exclusion_reason_code" = 'MANUAL_ENTRY_CORRECTION'
        AND NEW."ordinal" = (
          SELECT max(existing."ordinal") FROM "project_uph_module_cycle_samples" existing
          WHERE existing."project_id" = NEW."project_id"
            AND existing."revision_id" = NEW."revision_id"
            AND existing."module_binding_id" = NEW."module_binding_id"
        )
    ) THEN
      RAISE EXCEPTION 'manual correction replacement must follow its corrected sample at the next ordinal' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW."disposition" <> 'EXCLUDED' OR NEW."exclusion_reason_code" <> 'MANUAL_ENTRY_CORRECTION'
    OR OLD."disposition" <> 'INCLUDED' OR OLD."exclusion_reason_code" IS NOT NULL
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."revision_id" IS DISTINCT FROM OLD."revision_id"
    OR NEW."module_binding_id" IS DISTINCT FROM OLD."module_binding_id"
    OR NEW."ordinal" IS DISTINCT FROM OLD."ordinal"
    OR NEW."correction_of_sample_id" IS DISTINCT FROM OLD."correction_of_sample_id"
    OR NEW."cycle_duration_seconds" IS DISTINCT FROM OLD."cycle_duration_seconds"
    OR NEW."observed_at" IS DISTINCT FROM OLD."observed_at"
    OR NEW."recorded_at" IS DISTINCT FROM OLD."recorded_at"
    OR NEW."capture_method" IS DISTINCT FROM OLD."capture_method"
    OR NEW."source_event_id" IS DISTINCT FROM OLD."source_event_id"
    OR NEW."captured_by_membership_id" IS DISTINCT FROM OLD."captured_by_membership_id"
    OR NEW."captured_by_user_id" IS DISTINCT FROM OLD."captured_by_user_id"
    OR NEW."captured_by_role" IS DISTINCT FROM OLD."captured_by_role"
    OR NEW."captured_by_snapshot_json" IS DISTINCT FROM OLD."captured_by_snapshot_json"
    OR NEW."captured_by_checksum" IS DISTINCT FROM OLD."captured_by_checksum" THEN
    RAISE EXCEPTION 'cycle duration, observation, capture, and source event are immutable outside a manual correction' USING ERRCODE = '55000';
  END IF;
    IF NOT EXISTS (
    SELECT 1 FROM "project_uph_module_cycle_samples" replacement
    WHERE replacement."correction_of_sample_id" = OLD."id"
      AND replacement."project_id" = OLD."project_id"
      AND replacement."revision_id" = OLD."revision_id"
      AND replacement."module_binding_id" = OLD."module_binding_id"
      AND replacement."capture_method" = 'MANUAL_ENTRY'
      AND replacement."ordinal" > OLD."ordinal"
      AND replacement."ordinal" = (
        SELECT max(existing."ordinal") FROM "project_uph_module_cycle_samples" existing
        WHERE existing."project_id" = OLD."project_id"
          AND existing."revision_id" = OLD."revision_id"
          AND existing."module_binding_id" = OLD."module_binding_id"
      )
    ) THEN
    RAISE EXCEPTION 'manual correction must append next ordinal replacement in the same transaction' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT min(existing."ordinal") AS first_ordinal,
             max(existing."ordinal") AS last_ordinal,
             count(*)::INTEGER AS ordinal_count
      FROM "project_uph_module_cycle_samples" existing
      WHERE existing."project_id" = project_id_value
        AND existing."revision_id" = revision_id_value
        AND existing."module_binding_id" = module_binding_id_value
    ) ordinals
    WHERE ordinals.ordinal_count > 0
      AND (ordinals.first_ordinal <> 1 OR ordinals.last_ordinal <> ordinals.ordinal_count)
  ) THEN
    RAISE EXCEPTION 'UPH cycle sample ordinals must be a continuous sequence starting at one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_test_batch_validate_evidence_file"() RETURNS TRIGGER AS $$
DECLARE
  file_row "file_objects"%ROWTYPE;
BEGIN
  SELECT * INTO file_row FROM "file_objects"
  WHERE "id" = NEW."file_object_id" AND "project_id" = NEW."project_id";
  IF NOT FOUND
    OR file_row."status" <> 'AVAILABLE'
    OR file_row."storage_area" <> 'CONTROLLED'
    OR file_row."scanned_at" IS NULL
    OR file_row."sha256" IS NULL
    OR NEW."file_sha256" IS DISTINCT FROM file_row."sha256"
    OR NEW."sensitivity" IS DISTINCT FROM file_row."sensitivity" THEN
    RAISE EXCEPTION 'UPH test-batch evidence must reference same-project AVAILABLE CONTROLLED scanned FileObject with SHA snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_test_batch_pointer_commit_guard"() RETURNS TRIGGER AS $$
DECLARE
  batch_row "project_uph_test_batches"%ROWTYPE;
  work_row "project_uph_test_batch_revisions"%ROWTYPE;
  locked_row "project_uph_test_batch_revisions"%ROWTYPE;
  revision_id_value TEXT;
  batch_id_value TEXT;
  project_id_value TEXT;
BEGIN
  IF TG_TABLE_NAME = 'project_uph_test_batches' THEN
    SELECT * INTO batch_row FROM "project_uph_test_batches"
    WHERE "id" = COALESCE(NEW."id", OLD."id")
      AND "project_id" = COALESCE(NEW."project_id", OLD."project_id");
  ELSIF TG_TABLE_NAME = 'project_uph_test_batch_revisions' THEN
    revision_id_value := COALESCE(NEW."id", OLD."id");
    project_id_value := COALESCE(NEW."project_id", OLD."project_id");
    SELECT "batch_id" INTO batch_id_value FROM "project_uph_test_batch_revisions"
    WHERE "id" = revision_id_value AND "project_id" = project_id_value;
    SELECT * INTO batch_row FROM "project_uph_test_batches"
    WHERE "id" = batch_id_value AND "project_id" = project_id_value;
  ELSE
    RAISE EXCEPTION 'UPH test-batch pointer guard received an unsupported table' USING ERRCODE = '23514';
  END IF;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF batch_row."current_work_revision_id" IS NOT NULL THEN
    SELECT * INTO work_row FROM "project_uph_test_batch_revisions"
    WHERE "id" = batch_row."current_work_revision_id" AND "project_id" = batch_row."project_id";
    IF NOT FOUND OR work_row."batch_id" <> batch_row."id" OR work_row."status" NOT IN ('DRAFT', 'PM_CONFIRMED') THEN
      RAISE EXCEPTION 'current work revision must be DRAFT or PM_CONFIRMED' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF batch_row."current_locked_revision_id" IS NOT NULL THEN
    SELECT * INTO locked_row FROM "project_uph_test_batch_revisions"
    WHERE "id" = batch_row."current_locked_revision_id" AND "project_id" = batch_row."project_id";
    IF NOT FOUND OR locked_row."batch_id" <> batch_row."id" OR locked_row."status" <> 'LOCKED' THEN
      RAISE EXCEPTION 'current locked revision must be LOCKED' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "project_uph_test_batch_revisions" revision
    WHERE revision."batch_id" = batch_row."id"
      AND revision."project_id" = batch_row."project_id"
      AND revision."status" IN ('DRAFT', 'PM_CONFIRMED')
  ) AND NOT EXISTS (
    SELECT 1 FROM "project_uph_test_batch_revisions" revision
    WHERE revision."id" = batch_row."current_work_revision_id"
      AND revision."batch_id" = batch_row."id"
      AND revision."project_id" = batch_row."project_id"
      AND revision."status" IN ('DRAFT', 'PM_CONFIRMED')
  ) THEN
    RAISE EXCEPTION 'UPH test-batch work revision must be current_work' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "project_uph_test_batch_revisions" revision
    WHERE revision."batch_id" = batch_row."id"
      AND revision."project_id" = batch_row."project_id"
      AND revision."status" = 'LOCKED'
  ) AND NOT EXISTS (
    SELECT 1 FROM "project_uph_test_batch_revisions" revision
    WHERE revision."id" = batch_row."current_locked_revision_id"
      AND revision."batch_id" = batch_row."id"
      AND revision."project_id" = batch_row."project_id"
      AND revision."status" = 'LOCKED'
  ) THEN
    RAISE EXCEPTION 'UPH test-batch locked revision must be current_locked' USING ERRCODE = '23514';
  END IF;
  IF batch_row."current_work_revision_id" IS NULL AND batch_row."current_locked_revision_id" IS NULL THEN
    RAISE EXCEPTION 'UPH test-batch must retain a current work or current locked revision' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_test_batch_revision_successor_guard"() RETURNS TRIGGER AS $$
DECLARE
  predecessor_row "project_uph_test_batch_revisions"%ROWTYPE;
  successor_row "project_uph_test_batch_revisions"%ROWTYPE;
  terminal_row "project_uph_test_batch_revisions"%ROWTYPE;
  batch_row "project_uph_test_batches"%ROWTYPE;
  successor_count INTEGER;
BEGIN
  SELECT * INTO successor_row
  FROM "project_uph_test_batch_revisions"
  WHERE "id" = NEW."id" AND "project_id" = NEW."project_id";
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF successor_row."supersedes_revision_id" IS NOT NULL THEN
    SELECT * INTO predecessor_row
    FROM "project_uph_test_batch_revisions"
    WHERE "id" = successor_row."supersedes_revision_id" AND "project_id" = successor_row."project_id";
    IF NOT FOUND
      OR predecessor_row."batch_id" <> successor_row."batch_id"
      OR successor_row."revision_number" <> predecessor_row."revision_number" + 1 THEN
      RAISE EXCEPTION 'UPH test-batch successor must have an immediate same-batch predecessor' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO batch_row FROM "project_uph_test_batches"
    WHERE "id" = successor_row."batch_id" AND "project_id" = successor_row."project_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'UPH test-batch successor batch is required' USING ERRCODE = '23514';
    END IF;

    IF predecessor_row."quality_locker_membership_id" IS NULL THEN
      IF predecessor_row."status" <> 'SUPERSEDED'
        OR successor_row."status" NOT IN ('DRAFT', 'PM_CONFIRMED', 'LOCKED') THEN
        RAISE EXCEPTION 'UPH predecessor with no QUALITY fact must be SUPERSEDED before its successor persists' USING ERRCODE = '23514';
      END IF;
    ELSE
      WITH RECURSIVE lineage AS (
        SELECT successor_row."id", successor_row."project_id", successor_row."batch_id",
               successor_row."revision_number", successor_row."status", ARRAY[successor_row."id"]::TEXT[] AS path
        UNION ALL
        SELECT child."id", child."project_id", child."batch_id", child."revision_number", child."status",
               lineage.path || child."id"
        FROM "project_uph_test_batch_revisions" child
        JOIN lineage ON child."supersedes_revision_id" = lineage."id" AND child."project_id" = lineage."project_id"
        WHERE NOT child."id" = ANY(lineage.path)
      )
      SELECT revision.* INTO terminal_row
      FROM lineage
      JOIN "project_uph_test_batch_revisions" revision
        ON revision."id" = lineage."id" AND revision."project_id" = lineage."project_id"
      WHERE NOT EXISTS (
        SELECT 1 FROM "project_uph_test_batch_revisions" next_revision
        WHERE next_revision."supersedes_revision_id" = lineage."id"
          AND next_revision."project_id" = lineage."project_id"
      )
      ORDER BY lineage."revision_number" DESC
      LIMIT 1;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'UPH LOCKED correction lineage must have a terminal successor' USING ERRCODE = '23514';
      ELSIF terminal_row."status" IN ('DRAFT', 'PM_CONFIRMED') THEN
        IF predecessor_row."status" <> 'LOCKED'
          OR batch_row."current_locked_revision_id" IS DISTINCT FROM predecessor_row."id"
          OR batch_row."current_work_revision_id" IS DISTINCT FROM terminal_row."id" THEN
          RAISE EXCEPTION 'UPH LOCKED correction draft or PM successor must retain the predecessor locked pointer' USING ERRCODE = '23514';
        END IF;
      ELSIF terminal_row."status" = 'LOCKED' THEN
        IF predecessor_row."status" <> 'SUPERSEDED'
          OR batch_row."current_locked_revision_id" IS DISTINCT FROM terminal_row."id"
          OR batch_row."current_work_revision_id" IS NOT NULL THEN
          RAISE EXCEPTION 'UPH LOCKED correction may switch locked pointer only when its terminal successor locks' USING ERRCODE = '23514';
        END IF;
      ELSE
        RAISE EXCEPTION 'UPH LOCKED correction lineage terminal must be DRAFT, PM_CONFIRMED, or LOCKED' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  IF successor_row."status" <> 'SUPERSEDED' THEN RETURN NULL; END IF;
  SELECT count(*) INTO successor_count FROM "project_uph_test_batch_revisions"
  WHERE "supersedes_revision_id" = successor_row."id" AND "project_id" = successor_row."project_id";
  IF successor_count <> 1 THEN
    RAISE EXCEPTION 'SUPERSEDED revision must have exactly one successor' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO terminal_row FROM "project_uph_test_batch_revisions"
  WHERE "supersedes_revision_id" = successor_row."id" AND "project_id" = successor_row."project_id";
  IF terminal_row."batch_id" <> successor_row."batch_id" OR terminal_row."revision_number" <> successor_row."revision_number" + 1 THEN
    RAISE EXCEPTION 'UPH test-batch successor must remain in batch with continuous revision number' USING ERRCODE = '23514';
  END IF;
  IF successor_row."quality_locker_membership_id" IS NOT NULL THEN
    WITH RECURSIVE lineage AS (
      SELECT child."id", child."project_id", child."batch_id", child."revision_number", child."status",
             ARRAY[successor_row."id", child."id"]::TEXT[] AS path
      FROM "project_uph_test_batch_revisions" child
      WHERE child."supersedes_revision_id" = successor_row."id" AND child."project_id" = successor_row."project_id"
      UNION ALL
      SELECT child."id", child."project_id", child."batch_id", child."revision_number", child."status",
             lineage.path || child."id"
      FROM "project_uph_test_batch_revisions" child
      JOIN lineage ON child."supersedes_revision_id" = lineage."id" AND child."project_id" = lineage."project_id"
      WHERE NOT child."id" = ANY(lineage.path)
    )
    SELECT revision.* INTO terminal_row
    FROM lineage
    JOIN "project_uph_test_batch_revisions" revision
      ON revision."id" = lineage."id" AND revision."project_id" = lineage."project_id"
    WHERE NOT EXISTS (
      SELECT 1 FROM "project_uph_test_batch_revisions" next_revision
      WHERE next_revision."supersedes_revision_id" = lineage."id"
        AND next_revision."project_id" = lineage."project_id"
    )
    ORDER BY lineage."revision_number" DESC
    LIMIT 1;
    SELECT * INTO batch_row FROM "project_uph_test_batches"
    WHERE "id" = successor_row."batch_id" AND "project_id" = successor_row."project_id";
    IF NOT FOUND OR terminal_row."status" <> 'LOCKED'
      OR batch_row."current_locked_revision_id" IS DISTINCT FROM terminal_row."id" THEN
      RAISE EXCEPTION 'locked predecessor lineage must end at the current LOCKED revision' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_test_batch_reject_delete"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'UPH test-batch business facts cannot be deleted' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "project_uph_test_batch_reject_truncate"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'UPH test-batch business facts cannot be TRUNCATEd' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_uph_test_batch_roots_immutable_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "project_uph_test_batches"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_root_immutable_guard"();
CREATE TRIGGER "project_uph_test_batch_revisions_insert_guard"
  BEFORE INSERT ON "project_uph_test_batch_revisions"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_revision_insert_guard"();
CREATE TRIGGER "project_uph_test_batch_revisions_immutable_guard"
  BEFORE UPDATE OR DELETE ON "project_uph_test_batch_revisions"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_revision_immutable_guard"();
CREATE TRIGGER "project_uph_test_batch_bindings_immutable_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "project_uph_test_batch_revision_module_bindings"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_binding_immutable_guard"();
CREATE TRIGGER "project_uph_test_batch_samples_immutable_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "project_uph_module_cycle_samples"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_child_immutable_guard"();
CREATE TRIGGER "project_uph_test_batch_counts_immutable_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "project_uph_test_batch_revision_production_counts"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_child_immutable_guard"();
CREATE TRIGGER "project_uph_test_batch_evidence_immutable_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "project_uph_test_batch_revision_evidence"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_child_immutable_guard"();
CREATE TRIGGER "project_uph_test_batch_evidence_file_guard"
  BEFORE INSERT OR UPDATE ON "project_uph_test_batch_revision_evidence"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_validate_evidence_file"();

CREATE TRIGGER "project_uph_test_batch_roots_delete_guard"
  BEFORE DELETE ON "project_uph_test_batches"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_reject_delete"();
CREATE TRIGGER "project_uph_test_batch_revisions_delete_guard"
  BEFORE DELETE ON "project_uph_test_batch_revisions"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_reject_delete"();
CREATE TRIGGER "project_uph_test_batch_bindings_delete_guard"
  BEFORE DELETE ON "project_uph_test_batch_revision_module_bindings"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_reject_delete"();
CREATE TRIGGER "project_uph_test_batch_counts_delete_guard"
  BEFORE DELETE ON "project_uph_test_batch_revision_production_counts"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_reject_delete"();
CREATE TRIGGER "project_uph_test_batch_samples_delete_guard"
  BEFORE DELETE ON "project_uph_module_cycle_samples"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_reject_delete"();
CREATE TRIGGER "project_uph_test_batch_evidence_delete_guard"
  BEFORE DELETE ON "project_uph_test_batch_revision_evidence"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_reject_delete"();

CREATE TRIGGER "project_uph_test_batch_roots_truncate_guard"
  BEFORE TRUNCATE ON "project_uph_test_batches"
  FOR EACH STATEMENT EXECUTE FUNCTION "project_uph_test_batch_reject_truncate"();
CREATE TRIGGER "project_uph_test_batch_revisions_truncate_guard"
  BEFORE TRUNCATE ON "project_uph_test_batch_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "project_uph_test_batch_reject_truncate"();
CREATE TRIGGER "project_uph_test_batch_bindings_truncate_guard"
  BEFORE TRUNCATE ON "project_uph_test_batch_revision_module_bindings"
  FOR EACH STATEMENT EXECUTE FUNCTION "project_uph_test_batch_reject_truncate"();
CREATE TRIGGER "project_uph_test_batch_counts_truncate_guard"
  BEFORE TRUNCATE ON "project_uph_test_batch_revision_production_counts"
  FOR EACH STATEMENT EXECUTE FUNCTION "project_uph_test_batch_reject_truncate"();
CREATE TRIGGER "project_uph_test_batch_samples_truncate_guard"
  BEFORE TRUNCATE ON "project_uph_module_cycle_samples"
  FOR EACH STATEMENT EXECUTE FUNCTION "project_uph_test_batch_reject_truncate"();
CREATE TRIGGER "project_uph_test_batch_evidence_truncate_guard"
  BEFORE TRUNCATE ON "project_uph_test_batch_revision_evidence"
  FOR EACH STATEMENT EXECUTE FUNCTION "project_uph_test_batch_reject_truncate"();

CREATE CONSTRAINT TRIGGER "project_uph_test_batch_binding_guard"
  AFTER INSERT OR UPDATE ON "project_uph_test_batch_revisions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_binding_guard"();
CREATE CONSTRAINT TRIGGER "project_uph_test_batch_binding_guard"
  AFTER INSERT OR UPDATE ON "project_uph_test_batch_revision_module_bindings"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_binding_guard"();
CREATE CONSTRAINT TRIGGER "project_uph_test_batch_revision_checksum_guard"
  AFTER INSERT OR UPDATE ON "project_uph_test_batch_revisions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_revision_checksum_guard"();
CREATE TRIGGER "project_uph_test_batch_revision_responsibility_guard"
  BEFORE INSERT OR UPDATE ON "project_uph_test_batch_revisions"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_responsibility_guard"();
CREATE CONSTRAINT TRIGGER "project_uph_test_batch_sample_append_guard"
  AFTER INSERT OR UPDATE OR DELETE ON "project_uph_module_cycle_samples"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_sample_append_guard"();
CREATE CONSTRAINT TRIGGER "project_uph_test_batch_pointer_commit_guard"
  AFTER INSERT OR UPDATE ON "project_uph_test_batches"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_pointer_commit_guard"();
CREATE CONSTRAINT TRIGGER "project_uph_test_batch_pointer_commit_guard"
  AFTER INSERT OR UPDATE ON "project_uph_test_batch_revisions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_pointer_commit_guard"();
CREATE CONSTRAINT TRIGGER "project_uph_test_batch_revision_successor_guard"
  AFTER INSERT OR UPDATE ON "project_uph_test_batch_revisions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "project_uph_test_batch_revision_successor_guard"();

INSERT INTO "permissions" ("id", "code", "description") VALUES
  ('permission-project-uph-batch-manage', 'PROJECT_UPH_BATCH_MANAGE', '管理项目UPH测试批次草稿、样本、计数与证据'),
  ('permission-project-uph-batch-confirm', 'PROJECT_UPH_BATCH_CONFIRM', '确认项目UPH测试批次'),
  ('permission-project-uph-batch-lock', 'PROJECT_UPH_BATCH_LOCK', '锁定项目UPH测试批次')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
  ('role-engineer', 'permission-project-uph-batch-manage', 'PROJECT'),
  ('role-project-manager', 'permission-project-uph-batch-confirm', 'PROJECT'),
  ('role-quality', 'permission-project-uph-batch-lock', 'PROJECT')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

COMMIT;
