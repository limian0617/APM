-- APM-102: immutable controlled FAT/SAT reports, customer confirmations and sensitive evidence.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_REPORT_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_REPORT_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_REPORT_DOWNLOADED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_CONFIRMATION_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_CONFIRMATION_SUPERSEDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_CONFIRMATION_READ';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_REPORT';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_CONFIRMATION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_CONFIRMATION_EVIDENCE';

CREATE TYPE "AcceptanceReportStatus" AS ENUM ('GENERATING', 'FAILED', 'READY', 'PUBLISHED', 'SUPERSEDED');
CREATE TYPE "AcceptanceConfirmationDecision" AS ENUM ('ACCEPTED', 'ACCEPTED_WITH_RESERVATIONS', 'REJECTED');
CREATE TYPE "AcceptanceConfirmationChannel" AS ENUM ('SIGNED_DOCUMENT', 'EMAIL', 'MEETING_MINUTES', 'OTHER');
CREATE TYPE "AcceptanceConfirmationStatus" AS ENUM ('ACTIVE', 'SUPERSEDED');

CREATE TABLE "acceptance_reports" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "acceptance_type" "AcceptanceType" NOT NULL,
  "scope_type" "AcceptanceScopeType" NOT NULL,
  "scope_id" TEXT NOT NULL,
  "report_number" TEXT NOT NULL,
  "report_version" INTEGER NOT NULL,
  "source_batch_id" TEXT NOT NULL,
  "final_batch_id" TEXT NOT NULL,
  "retest_chain_json" JSONB NOT NULL,
  "template_version_id" TEXT NOT NULL,
  "template_checksum" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "snapshot_checksum" TEXT NOT NULL,
  "renderer_version" TEXT NOT NULL,
  "pdf_file_id" TEXT NOT NULL,
  "pdf_sha256" TEXT NOT NULL,
  "pdf_size" BIGINT NOT NULL,
  "pdf_mime_type" TEXT NOT NULL,
  "controlled_document_version_id" TEXT NOT NULL,
  "status" "AcceptanceReportStatus" NOT NULL DEFAULT 'GENERATING',
  "requested_by_id" TEXT NOT NULL,
  "generated_at" TIMESTAMP(3),
  "failure_code" TEXT,
  "failure_message" TEXT,
  "supersedes_report_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acceptance_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acceptance_reports_project_number_version_key" UNIQUE ("project_id", "report_number", "report_version"),
  CONSTRAINT "acceptance_reports_id_project_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "acceptance_reports_pdf_file_project_key" UNIQUE ("pdf_file_id", "project_id"),
  CONSTRAINT "acceptance_reports_document_version_project_key" UNIQUE ("controlled_document_version_id", "project_id"),
  CONSTRAINT "acceptance_reports_report_version_check" CHECK ("report_version" > 0),
  CONSTRAINT "acceptance_reports_hash_check" CHECK (
    "snapshot_checksum" ~ '^[0-9a-f]{64}$' AND "pdf_sha256" ~ '^[0-9a-f]{64}$'
  )
);
CREATE INDEX "acceptance_reports_project_status_created_idx" ON "acceptance_reports"("project_id", "acceptance_type", "status", "created_at");
CREATE INDEX "acceptance_reports_project_source_created_idx" ON "acceptance_reports"("project_id", "source_batch_id", "created_at");
CREATE UNIQUE INDEX "acceptance_reports_active_source_unique"
  ON "acceptance_reports"("project_id", "source_batch_id")
  WHERE "status" IN ('GENERATING', 'READY', 'PUBLISHED');

CREATE TABLE "acceptance_confirmations" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "report_id" TEXT NOT NULL,
  "report_checksum" TEXT NOT NULL,
  "controlled_document_version_id" TEXT NOT NULL,
  "decision" "AcceptanceConfirmationDecision" NOT NULL,
  "customer_organization" TEXT NOT NULL,
  "customer_representative" TEXT NOT NULL,
  "representative_title" TEXT NOT NULL,
  "confirmation_channel" "AcceptanceConfirmationChannel" NOT NULL,
  "customer_confirmed_at" TIMESTAMP(3) NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "comment" TEXT NOT NULL,
  "recorded_by_id" TEXT NOT NULL,
  "supersedes_confirmation_id" TEXT,
  "confirmation_checksum" TEXT NOT NULL,
  "status" "AcceptanceConfirmationStatus" NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT "acceptance_confirmations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acceptance_confirmations_id_project_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "acceptance_confirmations_checksum_project_key" UNIQUE ("confirmation_checksum", "project_id"),
  CONSTRAINT "acceptance_confirmations_hash_check" CHECK ("confirmation_checksum" ~ '^[0-9a-f]{64}$')
);
CREATE INDEX "acceptance_confirmations_project_report_recorded_idx" ON "acceptance_confirmations"("project_id", "report_id", "recorded_at");

CREATE TABLE "acceptance_confirmation_evidence" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "confirmation_id" TEXT NOT NULL,
  "file_object_id" TEXT NOT NULL,
  "file_sha256" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acceptance_confirmation_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acceptance_confirmation_evidence_unique" UNIQUE ("confirmation_id", "file_object_id")
);
CREATE INDEX "acceptance_confirmation_evidence_project_confirmation_idx" ON "acceptance_confirmation_evidence"("project_id", "confirmation_id");
CREATE INDEX "acceptance_confirmation_evidence_file_project_idx" ON "acceptance_confirmation_evidence"("file_object_id", "project_id");

ALTER TABLE "acceptance_reports"
  ADD CONSTRAINT "acceptance_reports_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_reports_source_batch_project_fkey" FOREIGN KEY ("source_batch_id", "project_id") REFERENCES "acceptance_batches"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_reports_final_batch_project_fkey" FOREIGN KEY ("final_batch_id", "project_id") REFERENCES "acceptance_batches"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_reports_template_version_fkey" FOREIGN KEY ("template_version_id") REFERENCES "acceptance_template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_reports_pdf_file_project_fkey" FOREIGN KEY ("pdf_file_id", "project_id") REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_reports_document_version_project_fkey" FOREIGN KEY ("controlled_document_version_id", "project_id") REFERENCES "controlled_document_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_reports_requested_by_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_reports_supersedes_project_fkey" FOREIGN KEY ("supersedes_report_id", "project_id") REFERENCES "acceptance_reports"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "acceptance_confirmations"
  ADD CONSTRAINT "acceptance_confirmations_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_confirmations_report_project_fkey" FOREIGN KEY ("report_id", "project_id") REFERENCES "acceptance_reports"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_confirmations_document_version_project_fkey" FOREIGN KEY ("controlled_document_version_id", "project_id") REFERENCES "controlled_document_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_confirmations_recorded_by_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_confirmations_supersedes_project_fkey" FOREIGN KEY ("supersedes_confirmation_id", "project_id") REFERENCES "acceptance_confirmations"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "acceptance_confirmation_evidence"
  ADD CONSTRAINT "acceptance_confirmation_evidence_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_confirmation_evidence_confirmation_project_fkey" FOREIGN KEY ("confirmation_id", "project_id") REFERENCES "acceptance_confirmations"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_confirmation_evidence_file_project_fkey" FOREIGN KEY ("file_object_id", "project_id") REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "acceptance_confirmation_evidence_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "reject_acceptance_report_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'acceptance reports are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('READY', 'PUBLISHED') THEN
    IF NEW."status" <> 'SUPERSEDED'
       OR (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
      RAISE EXCEPTION 'ready acceptance reports are immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "acceptance_reports_immutable"
BEFORE UPDATE OR DELETE ON "acceptance_reports"
FOR EACH ROW EXECUTE FUNCTION "reject_acceptance_report_mutation"();

CREATE OR REPLACE FUNCTION "reject_acceptance_confirmation_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (OLD."status" = 'SUPERSEDED')
     OR NEW."status" <> 'SUPERSEDED'
     OR (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'acceptance confirmations are append-only' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "acceptance_confirmations_immutable"
BEFORE UPDATE OR DELETE ON "acceptance_confirmations"
FOR EACH ROW EXECUTE FUNCTION "reject_acceptance_confirmation_mutation"();

CREATE OR REPLACE FUNCTION "reject_acceptance_confirmation_evidence_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'acceptance confirmation evidence is append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "acceptance_confirmation_evidence_immutable"
BEFORE UPDATE OR DELETE ON "acceptance_confirmation_evidence"
FOR EACH ROW EXECUTE FUNCTION "reject_acceptance_confirmation_evidence_mutation"();
