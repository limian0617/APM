-- APM-054: immutable project closure archive facts and integrity history.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROJECT_ARCHIVE_GENERATION_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROJECT_ARCHIVE_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROJECT_ARCHIVE_INTEGRITY_CHECK_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROJECT_ARCHIVE_INTEGRITY_CHECKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PROJECT_CLOSED';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'PROJECT_ARCHIVE';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'PROJECT_ARCHIVE_VERSION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'PROJECT_ARCHIVE_INTEGRITY_CHECK';

DO $$
BEGIN
  CREATE TYPE "ArchiveVersionStatus" AS ENUM ('VERIFYING', 'READY', 'FAILED', 'FINALIZED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "ArchiveManifestSourceType" AS ENUM (
    'CONTROLLED_DOCUMENT_VERSION',
    'MECHANICAL_DRAWING_VERSION',
    'DOCUMENT_REVIEW',
    'GATE_SUBMISSION',
    'GATE_SUBMISSION_DOCUMENT_REFERENCE',
    'ACCEPTANCE_BATCH',
    'ACCEPTANCE_REPORT',
    'ACCEPTANCE_CONFIRMATION'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "ArchiveIntegrityCheckStatus" AS ENUM ('PASSED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "ArchiveIntegrityItemStatus" AS ENUM ('PASSED', 'FAILED', 'NOT_APPLICABLE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "ArchiveExternalPublicationApplicability" AS ENUM ('NOT_APPLICABLE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "project_archives" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "final_archive_version_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_archives_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_archives_project_id_key" UNIQUE ("project_id"),
  CONSTRAINT "project_archives_id_project_id_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "project_archives_final_archive_version_id_key" UNIQUE ("final_archive_version_id"),
  CONSTRAINT "project_archives_final_archive_pair_key" UNIQUE ("final_archive_version_id", "id")
);

CREATE TABLE "project_archive_versions" (
  "id" TEXT NOT NULL,
  "archive_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "ArchiveVersionStatus" NOT NULL DEFAULT 'VERIFYING',
  "manifest_checksum" TEXT NOT NULL,
  "source_watermark" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "external_publication_applicability" "ArchiveExternalPublicationApplicability" NOT NULL,
  "external_publication_reason" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finalized_at" TIMESTAMP(3),
  CONSTRAINT "project_archive_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_archive_versions_id_project_id_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "project_archive_versions_id_archive_id_key" UNIQUE ("id", "archive_id"),
  CONSTRAINT "project_archive_versions_archive_version_key" UNIQUE ("archive_id", "version"),
  CONSTRAINT "project_archive_versions_version_check" CHECK ("version" > 0),
  CONSTRAINT "project_archive_versions_manifest_checksum_check" CHECK ("manifest_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_archive_versions_source_watermark_check" CHECK ("source_watermark" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_archive_versions_reason_check" CHECK (length(trim("external_publication_reason")) > 0)
);

CREATE TABLE "project_archive_manifest_items" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "archive_version_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "source_type" "ArchiveManifestSourceType" NOT NULL,
  "source_id" TEXT NOT NULL,
  "source_version" TEXT NOT NULL,
  "source_checksum" TEXT NOT NULL,
  "file_object_id" TEXT,
  "file_sha256" TEXT,
  "file_mime_type" TEXT,
  "file_size" BIGINT,
  "snapshot_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_archive_manifest_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_archive_manifest_items_archive_position_key" UNIQUE ("archive_version_id", "position"),
  CONSTRAINT "project_archive_manifest_items_id_project_id_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "project_archive_manifest_items_position_check" CHECK ("position" >= 0),
  CONSTRAINT "project_archive_manifest_items_source_id_check" CHECK (length(trim("source_id")) > 0),
  CONSTRAINT "project_archive_manifest_items_source_version_check" CHECK (length(trim("source_version")) > 0),
  CONSTRAINT "project_archive_manifest_items_source_checksum_check" CHECK ("source_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_archive_manifest_items_file_tuple_check" CHECK (
    ("file_object_id" IS NULL AND "file_sha256" IS NULL AND "file_mime_type" IS NULL AND "file_size" IS NULL)
    OR ("file_object_id" IS NOT NULL AND "file_sha256" ~ '^[0-9a-f]{64}$' AND "file_mime_type" IS NOT NULL AND "file_size" IS NOT NULL AND "file_size" >= 0)
  )
);

CREATE TABLE "project_archive_integrity_checks" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "archive_version_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "job_id" TEXT NOT NULL,
  "status" "ArchiveIntegrityCheckStatus" NOT NULL,
  "input_checksum" TEXT NOT NULL,
  "result_checksum" TEXT NOT NULL,
  "checked_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_archive_integrity_checks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_archive_integrity_checks_archive_sequence_key" UNIQUE ("archive_version_id", "sequence"),
  CONSTRAINT "project_archive_integrity_checks_job_id_key" UNIQUE ("job_id"),
  CONSTRAINT "project_archive_integrity_checks_id_project_id_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "project_archive_integrity_checks_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "project_archive_integrity_checks_input_checksum_check" CHECK ("input_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_archive_integrity_checks_result_checksum_check" CHECK ("result_checksum" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "project_archive_integrity_item_results" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "integrity_check_id" TEXT NOT NULL,
  "manifest_item_id" TEXT NOT NULL,
  "status" "ArchiveIntegrityItemStatus" NOT NULL,
  "actual_sha256" TEXT,
  "actual_size" BIGINT,
  "failure_code" TEXT,
  "failure_message" TEXT,
  "checked_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_archive_integrity_item_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_archive_integrity_item_results_check_item_key" UNIQUE ("integrity_check_id", "manifest_item_id"),
  CONSTRAINT "project_archive_integrity_item_results_actual_size_check" CHECK ("actual_size" IS NULL OR "actual_size" >= 0),
  CONSTRAINT "project_archive_integrity_item_results_actual_sha_check" CHECK ("actual_sha256" IS NULL OR "actual_sha256" ~ '^[0-9a-f]{64}$')
);

ALTER TABLE "projects" ADD COLUMN "final_archive_version_id" TEXT;
CREATE UNIQUE INDEX "projects_final_archive_version_id_key" ON "projects"("final_archive_version_id");
CREATE UNIQUE INDEX "projects_final_archive_pair_key" ON "projects"("final_archive_version_id", "id");

CREATE INDEX "project_archive_versions_project_status_created_idx" ON "project_archive_versions" ("project_id", "status", "created_at");
CREATE INDEX "project_archive_manifest_items_project_source_idx" ON "project_archive_manifest_items" ("project_id", "source_type", "source_id");
CREATE INDEX "project_archive_manifest_items_project_file_idx" ON "project_archive_manifest_items" ("project_id", "file_object_id");
CREATE INDEX "project_archive_integrity_checks_project_checked_idx" ON "project_archive_integrity_checks" ("project_id", "checked_at");
CREATE INDEX "project_archive_integrity_item_results_project_item_idx" ON "project_archive_integrity_item_results" ("project_id", "manifest_item_id");

ALTER TABLE "project_archives"
  ADD CONSTRAINT "project_archives_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_archives_final_version_fkey"
    FOREIGN KEY ("final_archive_version_id", "id") REFERENCES "project_archive_versions"("id", "archive_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_archive_versions"
  ADD CONSTRAINT "project_archive_versions_archive_fkey"
    FOREIGN KEY ("archive_id", "project_id") REFERENCES "project_archives"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_archive_versions_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_archive_versions_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_archive_manifest_items"
  ADD CONSTRAINT "project_archive_manifest_items_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_archive_manifest_items_archive_version_fkey"
    FOREIGN KEY ("archive_version_id", "project_id") REFERENCES "project_archive_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_archive_manifest_items_file_fkey"
    FOREIGN KEY ("file_object_id", "project_id") REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_archive_integrity_checks"
  ADD CONSTRAINT "project_archive_integrity_checks_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_archive_integrity_checks_archive_version_fkey"
    FOREIGN KEY ("archive_version_id", "project_id") REFERENCES "project_archive_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_archive_integrity_checks_job_fkey"
    FOREIGN KEY ("job_id") REFERENCES "persistent_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_archive_integrity_item_results"
  ADD CONSTRAINT "project_archive_integrity_item_results_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_archive_integrity_item_results_check_fkey"
    FOREIGN KEY ("integrity_check_id", "project_id") REFERENCES "project_archive_integrity_checks"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_archive_integrity_item_results_item_fkey"
    FOREIGN KEY ("manifest_item_id", "project_id") REFERENCES "project_archive_manifest_items"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_final_archive_version_fkey"
    FOREIGN KEY ("final_archive_version_id", "id") REFERENCES "project_archive_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "reject_project_archive_manifest_item_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'project archive manifest items are immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_archive_manifest_items_immutable"
BEFORE UPDATE OR DELETE ON "project_archive_manifest_items"
FOR EACH ROW EXECUTE FUNCTION "reject_project_archive_manifest_item_mutation"();

CREATE OR REPLACE FUNCTION "reject_project_archive_integrity_result_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'project archive integrity results are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_archive_integrity_checks_immutable"
BEFORE UPDATE OR DELETE ON "project_archive_integrity_checks"
FOR EACH ROW EXECUTE FUNCTION "reject_project_archive_integrity_result_mutation"();

CREATE TRIGGER "project_archive_integrity_item_results_immutable"
BEFORE UPDATE OR DELETE ON "project_archive_integrity_item_results"
FOR EACH ROW EXECUTE FUNCTION "reject_project_archive_integrity_result_mutation"();

CREATE OR REPLACE FUNCTION "validate_project_archive_version_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'project archive versions are immutable' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'finalized_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'finalized_at']) THEN
    RAISE EXCEPTION 'project archive version facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'VERIFYING' AND NEW."status" IN ('READY', 'FAILED') THEN
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('READY', 'FAILED') AND NEW."status" = 'VERIFYING' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'READY' AND NEW."status" = 'FINALIZED' AND NEW."finalized_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = NEW."status" AND OLD."finalized_at" IS NOT DISTINCT FROM NEW."finalized_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid project archive version status transition' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_archive_versions_status_guard"
BEFORE UPDATE OR DELETE ON "project_archive_versions"
FOR EACH ROW EXECUTE FUNCTION "validate_project_archive_version_mutation"();

CREATE OR REPLACE FUNCTION "validate_project_archive_final_reference"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'project archive aggregates are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."project_id" <> NEW."project_id" OR OLD."id" <> NEW."id" THEN
    RAISE EXCEPTION 'project archive identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."final_archive_version_id" IS NOT NULL AND
     OLD."final_archive_version_id" IS DISTINCT FROM NEW."final_archive_version_id" THEN
    RAISE EXCEPTION 'final archive version cannot be replaced' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_archives_final_reference_guard"
BEFORE UPDATE OR DELETE ON "project_archives"
FOR EACH ROW EXECUTE FUNCTION "validate_project_archive_final_reference"();
