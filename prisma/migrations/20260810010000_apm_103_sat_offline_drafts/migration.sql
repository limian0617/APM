-- APM-103: SAT-only offline drafts, immutable submissions, and review history.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_OFFLINE_DRAFT_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_OFFLINE_DRAFT_REVIEWED';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_OFFLINE_DRAFT_SUBMISSION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ACCEPTANCE_OFFLINE_DRAFT_REVIEW';

DO $$
BEGIN
  CREATE TYPE "OfflineAcceptanceDraftStatus" AS ENUM ('PENDING_REVIEW', 'CONFLICT', 'ACCEPTED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "OfflineAcceptanceDraftReviewDecision" AS ENUM ('ACCEPT', 'ACCEPT_WITH_CORRECTION', 'REJECT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "offline_acceptance_draft_submissions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "client_draft_id" TEXT NOT NULL,
  "baseline_batch_version" INTEGER NOT NULL,
  "baseline_result_revision_id" TEXT,
  "decision" "AcceptanceDecision" NOT NULL,
  "measured_value" TEXT,
  "measured_unit" TEXT,
  "note" TEXT,
  "captured_at" TIMESTAMP(3) NOT NULL,
  "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submitted_by_id" TEXT NOT NULL,
  "payload_checksum" TEXT NOT NULL,
  "server_result_snapshot" JSONB,
  "status" "OfflineAcceptanceDraftStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "offline_acceptance_draft_submissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "offline_acceptance_draft_submissions_id_project_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "offline_acceptance_draft_submissions_project_client_key" UNIQUE ("project_id", "client_draft_id"),
  CONSTRAINT "offline_acceptance_draft_submissions_version_check" CHECK ("version" > 0),
  CONSTRAINT "offline_acceptance_draft_submissions_checksum_check" CHECK ("payload_checksum" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "offline_acceptance_draft_reviews" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "submission_id" TEXT NOT NULL,
  "review_no" INTEGER NOT NULL,
  "decision" "OfflineAcceptanceDraftReviewDecision" NOT NULL,
  "reason" TEXT NOT NULL,
  "corrected_decision" "AcceptanceDecision",
  "corrected_measured_value" TEXT,
  "corrected_measured_unit" TEXT,
  "corrected_note" TEXT,
  "evidence_file_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "reviewed_result_revision_id" TEXT,
  "review_checksum" TEXT NOT NULL,
  "reviewed_by_id" TEXT NOT NULL,
  "reviewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "offline_acceptance_draft_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "offline_acceptance_draft_reviews_id_project_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "offline_acceptance_draft_reviews_submission_no_key" UNIQUE ("submission_id", "review_no"),
  CONSTRAINT "offline_acceptance_draft_reviews_checksum_check" CHECK ("review_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "offline_acceptance_draft_reviews_reason_check" CHECK (length(trim("reason")) > 0),
  CONSTRAINT "offline_acceptance_draft_reviews_evidence_array_check" CHECK (jsonb_typeof("evidence_file_ids") = 'array')
);

CREATE INDEX "offline_acceptance_draft_submissions_project_status_submitted_idx"
  ON "offline_acceptance_draft_submissions" ("project_id", "status", "submitted_at");
CREATE INDEX "offline_acceptance_draft_submissions_batch_item_submitted_idx"
  ON "offline_acceptance_draft_submissions" ("batch_id", "item_id", "submitted_at");
CREATE INDEX "offline_acceptance_draft_reviews_project_decision_reviewed_idx"
  ON "offline_acceptance_draft_reviews" ("project_id", "decision", "reviewed_at");

ALTER TABLE "offline_acceptance_draft_submissions"
  ADD CONSTRAINT "offline_acceptance_draft_submissions_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "offline_acceptance_draft_submissions_batch_project_fkey"
    FOREIGN KEY ("batch_id", "project_id") REFERENCES "acceptance_batches"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "offline_acceptance_draft_submissions_item_fkey"
    FOREIGN KEY ("item_id") REFERENCES "acceptance_test_item_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "offline_acceptance_draft_submissions_baseline_revision_project_fkey"
    FOREIGN KEY ("baseline_result_revision_id", "project_id") REFERENCES "acceptance_test_result_revisions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "offline_acceptance_draft_submissions_submitted_by_fkey"
    FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "offline_acceptance_draft_reviews"
  ADD CONSTRAINT "offline_acceptance_draft_reviews_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "offline_acceptance_draft_reviews_submission_project_fkey"
    FOREIGN KEY ("submission_id", "project_id") REFERENCES "offline_acceptance_draft_submissions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "offline_acceptance_draft_reviews_reviewed_by_fkey"
    FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "offline_acceptance_draft_reviews_result_revision_project_fkey"
    FOREIGN KEY ("reviewed_result_revision_id", "project_id") REFERENCES "acceptance_test_result_revisions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "validate_offline_acceptance_draft_submission"()
RETURNS TRIGGER AS $$
DECLARE
  batch_record RECORD;
  item_exists BOOLEAN;
  baseline_exists BOOLEAN;
BEGIN
  SELECT b."project_id", b."acceptance_type", b."status", b."template_version_id"
    INTO batch_record
    FROM "acceptance_batches" b
   WHERE b."id" = NEW."batch_id" AND b."project_id" = NEW."project_id";
  IF NOT FOUND OR batch_record."acceptance_type" <> 'SAT' THEN
    RAISE EXCEPTION 'ACCEPTANCE_OFFLINE_DRAFT_SAT_ONLY' USING ERRCODE = '23514';
  END IF;
  IF batch_record."status" <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'ACCEPTANCE_OFFLINE_DRAFT_BATCH_STATE' USING ERRCODE = '23514';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM "acceptance_test_item_definitions" item
    WHERE item."id" = NEW."item_id" AND item."template_version_id" = batch_record."template_version_id"
  ) INTO item_exists;
  IF NOT item_exists THEN
    RAISE EXCEPTION 'ACCEPTANCE_OFFLINE_DRAFT_ITEM_SCOPE' USING ERRCODE = '23514';
  END IF;
  IF NEW."baseline_result_revision_id" IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM "acceptance_test_result_revisions" revision
      JOIN "acceptance_test_results" result
        ON result."id" = revision."result_id" AND result."project_id" = revision."project_id"
      WHERE revision."id" = NEW."baseline_result_revision_id"
        AND revision."project_id" = NEW."project_id"
        AND result."batch_id" = NEW."batch_id"
        AND result."item_id" = NEW."item_id"
    ) INTO baseline_exists;
    IF NOT baseline_exists THEN
      RAISE EXCEPTION 'ACCEPTANCE_OFFLINE_DRAFT_BASELINE_SCOPE' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "offline_acceptance_draft_submission_scope_guard"
BEFORE INSERT ON "offline_acceptance_draft_submissions"
FOR EACH ROW EXECUTE FUNCTION "validate_offline_acceptance_draft_submission"();

CREATE OR REPLACE FUNCTION "reject_offline_acceptance_draft_submission_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'offline acceptance draft submissions are append-only' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'version', 'updated_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status', 'version', 'updated_at']) THEN
    RAISE EXCEPTION 'offline acceptance draft submission input is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = OLD."status" AND NEW."version" <> OLD."version" THEN
    RAISE EXCEPTION 'offline acceptance draft version may change only with a status transition' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    OLD."status" IN ('PENDING_REVIEW', 'CONFLICT')
    AND NEW."status" IN ('ACCEPTED', 'REJECTED')
    AND NEW."version" = OLD."version" + 1
  ) THEN
    RAISE EXCEPTION 'offline acceptance draft status transition is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "offline_acceptance_draft_submissions_immutable"
BEFORE UPDATE OR DELETE ON "offline_acceptance_draft_submissions"
FOR EACH ROW EXECUTE FUNCTION "reject_offline_acceptance_draft_submission_mutation"();

CREATE OR REPLACE FUNCTION "reject_offline_acceptance_draft_review_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'offline acceptance draft reviews are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "offline_acceptance_draft_reviews_immutable"
BEFORE UPDATE OR DELETE ON "offline_acceptance_draft_reviews"
FOR EACH ROW EXECUTE FUNCTION "reject_offline_acceptance_draft_review_mutation"();
