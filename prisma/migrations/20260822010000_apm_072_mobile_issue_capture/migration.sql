BEGIN;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_CAPTURE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_CAPTURE_CONFIRMED';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'ISSUE_CAPTURE';

CREATE TYPE "IssueCaptureStatus" AS ENUM ('PENDING_CONFIRMATION', 'CONFIRMED');

CREATE TABLE "issue_captures" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "input_text" TEXT,
  "voice_file_id" TEXT,
  "voice_file_sha256" TEXT,
  "status" "IssueCaptureStatus" NOT NULL DEFAULT 'PENDING_CONFIRMATION',
  "issue_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "confirmed_at" TIMESTAMP(3),
  CONSTRAINT "issue_captures_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "issue_captures_input_check" CHECK (
    ("input_text" IS NULL OR length(btrim("input_text")) BETWEEN 1 AND 10000)
    AND ("input_text" IS NOT NULL OR "voice_file_id" IS NOT NULL)
    AND (("voice_file_id" IS NULL AND "voice_file_sha256" IS NULL)
      OR ("voice_file_id" IS NOT NULL AND "voice_file_sha256" IS NOT NULL
        AND "voice_file_sha256" ~ '^[0-9a-f]{64}$'))
    AND "version" > 0
    AND (("status" = 'PENDING_CONFIRMATION' AND "issue_id" IS NULL AND "confirmed_at" IS NULL)
      OR ("status" = 'CONFIRMED' AND "issue_id" IS NOT NULL AND "confirmed_at" IS NOT NULL))
  )
);

CREATE TABLE "issue_capture_attachments" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "capture_id" TEXT NOT NULL,
  "file_id" TEXT NOT NULL,
  "file_sha256" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "issue_capture_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "issue_capture_attachments_sha256_check" CHECK ("file_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "issue_captures_id_project_id_key"
  ON "issue_captures"("id", "project_id");
CREATE UNIQUE INDEX "issue_captures_issue_project_key"
  ON "issue_captures"("issue_id", "project_id");
CREATE INDEX "issue_captures_project_creator_status_created_idx"
  ON "issue_captures"("project_id", "created_by_id", "status", "created_at");
CREATE UNIQUE INDEX "issue_capture_attachments_capture_file_key"
  ON "issue_capture_attachments"("capture_id", "file_id");
CREATE INDEX "issue_capture_attachments_project_file_idx"
  ON "issue_capture_attachments"("project_id", "file_id");

ALTER TABLE "issue_captures"
  ADD CONSTRAINT "issue_captures_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "issue_captures_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "issue_captures_voice_file_project_fkey"
  FOREIGN KEY ("voice_file_id", "project_id") REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "issue_captures_issue_project_fkey"
  FOREIGN KEY ("issue_id", "project_id") REFERENCES "issues"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "issue_capture_attachments"
  ADD CONSTRAINT "issue_capture_attachments_capture_project_fkey"
  FOREIGN KEY ("capture_id", "project_id") REFERENCES "issue_captures"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "issue_capture_attachments_file_project_fkey"
  FOREIGN KEY ("file_id", "project_id") REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "guard_issue_capture_insert"()
RETURNS TRIGGER AS $$
DECLARE
  file_status "FileObjectStatus";
  file_sha TEXT;
  file_mime TEXT;
BEGIN
  IF NEW."status" <> 'PENDING_CONFIRMATION'
    OR NEW."version" <> 1
    OR NEW."issue_id" IS NOT NULL
    OR NEW."confirmed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'issue capture must start pending at version 1' USING ERRCODE = '23514';
  END IF;
  NEW."created_at" := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
  IF NEW."voice_file_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "status", "sha256", COALESCE("verified_mime_type", "declared_mime_type")
    INTO file_status, file_sha, file_mime
    FROM "file_objects"
    WHERE "id" = NEW."voice_file_id" AND "project_id" = NEW."project_id"
    FOR UPDATE;
  IF NOT FOUND OR file_status <> 'AVAILABLE' OR file_sha IS NULL
    OR file_sha IS DISTINCT FROM NEW."voice_file_sha256"
    OR file_mime NOT LIKE 'audio/%' THEN
    RAISE EXCEPTION 'issue capture voice must be an exact AVAILABLE project audio file' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "validate_issue_capture_attachment"()
RETURNS TRIGGER AS $$
DECLARE
  capture_status "IssueCaptureStatus";
  file_status "FileObjectStatus";
  file_sha TEXT;
  file_mime TEXT;
BEGIN
  NEW."created_at" := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
  SELECT "status" INTO capture_status
    FROM "issue_captures"
    WHERE "id" = NEW."capture_id" AND "project_id" = NEW."project_id"
    FOR UPDATE;
  SELECT "status", "sha256", COALESCE("verified_mime_type", "declared_mime_type")
    INTO file_status, file_sha, file_mime
    FROM "file_objects"
    WHERE "id" = NEW."file_id" AND "project_id" = NEW."project_id"
    FOR UPDATE;
  IF capture_status IS DISTINCT FROM 'PENDING_CONFIRMATION'
    OR file_status IS DISTINCT FROM 'AVAILABLE'
    OR file_sha IS DISTINCT FROM NEW."file_sha256"
    OR (file_mime NOT LIKE 'image/%' AND file_mime NOT LIKE 'video/%') THEN
    RAISE EXCEPTION 'issue capture media must be an exact AVAILABLE project image or video' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "guard_issue_capture_update"()
RETURNS TRIGGER AS $$
DECLARE
  issue_project_id TEXT;
  issue_source_type "IssueSourceType";
  issue_created_by_id TEXT;
  issue_confirmed_text TEXT;
  issue_phenomenon_description TEXT;
BEGIN
  IF OLD."status" <> 'PENDING_CONFIRMATION'
    OR NEW."status" <> 'CONFIRMED'
    OR NEW."version" <> OLD."version" + 1
    OR NEW."issue_id" IS NULL
    OR NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."input_text" IS DISTINCT FROM OLD."input_text"
    OR NEW."voice_file_id" IS DISTINCT FROM OLD."voice_file_id"
    OR NEW."voice_file_sha256" IS DISTINCT FROM OLD."voice_file_sha256"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'issue capture only supports controlled confirmation' USING ERRCODE = '23514';
  END IF;

  NEW."confirmed_at" := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
  SELECT "project_id", "source_type", "created_by_id", "confirmed_text", "phenomenon_description"
    INTO issue_project_id, issue_source_type, issue_created_by_id, issue_confirmed_text, issue_phenomenon_description
    FROM "issues"
    WHERE "id" = NEW."issue_id" AND "project_id" = NEW."project_id"
    FOR UPDATE;
  IF NOT FOUND
    OR issue_project_id IS DISTINCT FROM NEW."project_id"
    OR issue_source_type <> 'PROJECT'
    OR issue_created_by_id IS DISTINCT FROM NEW."created_by_id"
    OR issue_phenomenon_description IS DISTINCT FROM issue_confirmed_text THEN
    RAISE EXCEPTION 'issue capture confirmation requires its creator PROJECT Issue with exact confirmed text' USING ERRCODE = '23514';
  END IF;
  IF NEW."voice_file_id" IS NOT NULL THEN
    PERFORM "id" FROM "file_objects"
      WHERE "id" = NEW."voice_file_id" AND "project_id" = NEW."project_id"
      FOR UPDATE;
  END IF;
  PERFORM f."id" FROM "issue_capture_attachments" a
    JOIN "file_objects" f ON f."id" = a."file_id" AND f."project_id" = a."project_id"
    WHERE a."capture_id" = NEW."id"
    ORDER BY f."id"
    FOR UPDATE OF f;
  IF EXISTS (
    SELECT 1 FROM "file_objects" f
    WHERE f."id" = NEW."voice_file_id" AND f."project_id" = NEW."project_id"
      AND (f."status" <> 'AVAILABLE' OR f."sha256" IS DISTINCT FROM NEW."voice_file_sha256")
  ) OR EXISTS (
    SELECT 1 FROM "issue_capture_attachments" a
    JOIN "file_objects" f ON f."id" = a."file_id" AND f."project_id" = a."project_id"
    WHERE a."capture_id" = NEW."id"
      AND (f."status" <> 'AVAILABLE' OR f."sha256" IS DISTINCT FROM a."file_sha256")
  ) THEN
    RAISE EXCEPTION 'issue capture files are no longer AVAILABLE exact facts' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "reject_issue_capture_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'issue capture facts are append-only' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "issue_capture_insert_guard"
  BEFORE INSERT ON "issue_captures"
  FOR EACH ROW EXECUTE FUNCTION "guard_issue_capture_insert"();
CREATE TRIGGER "issue_capture_update_guard"
  BEFORE UPDATE ON "issue_captures"
  FOR EACH ROW EXECUTE FUNCTION "guard_issue_capture_update"();
CREATE TRIGGER "issue_capture_delete_guard"
  BEFORE DELETE ON "issue_captures"
  FOR EACH ROW EXECUTE FUNCTION "reject_issue_capture_mutation"();
CREATE TRIGGER "issue_capture_truncate_guard"
  BEFORE TRUNCATE ON "issue_captures"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_issue_capture_mutation"();
CREATE TRIGGER "issue_capture_attachment_insert_guard"
  BEFORE INSERT ON "issue_capture_attachments"
  FOR EACH ROW EXECUTE FUNCTION "validate_issue_capture_attachment"();
CREATE TRIGGER "issue_capture_attachment_update_guard"
  BEFORE UPDATE ON "issue_capture_attachments"
  FOR EACH ROW EXECUTE FUNCTION "reject_issue_capture_mutation"();
CREATE TRIGGER "issue_capture_attachment_delete_guard"
  BEFORE DELETE ON "issue_capture_attachments"
  FOR EACH ROW EXECUTE FUNCTION "reject_issue_capture_mutation"();
CREATE TRIGGER "issue_capture_attachment_truncate_guard"
  BEFORE TRUNCATE ON "issue_capture_attachments"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_issue_capture_mutation"();

COMMIT;
