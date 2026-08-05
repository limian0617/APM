-- APM-052: Mechanical drawings extend controlled-document version facts.
CREATE TYPE "DrawingFileRole" AS ENUM ('CAD_SOURCE', 'PDF_PREVIEW', 'STEP_EXCHANGE');
CREATE TYPE "DrawingImportPairingStatus" AS ENUM ('PAIRED', 'UNPAIRED', 'AMBIGUOUS');
CREATE TYPE "DrawingImportBatchStatus" AS ENUM ('PENDING_CONFIRMATION', 'CONFIRMED', 'REJECTED');
CREATE TYPE "DrawingImportItemStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

ALTER TYPE "AuditAction" ADD VALUE 'MECHANICAL_DRAWING_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'MECHANICAL_DRAWING_VERSION_DRAFTED';
ALTER TYPE "AuditAction" ADD VALUE 'MECHANICAL_DRAWING_VERSION_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE 'MECHANICAL_DRAWING_IMPORT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'MECHANICAL_DRAWING_IMPORT_CONFIRMED';
ALTER TYPE "AuditObjectType" ADD VALUE 'MECHANICAL_DRAWING';
ALTER TYPE "AuditObjectType" ADD VALUE 'MECHANICAL_DRAWING_VERSION_FILE';
ALTER TYPE "AuditObjectType" ADD VALUE 'MECHANICAL_DRAWING_IMPORT_BATCH';
ALTER TYPE "AuditObjectType" ADD VALUE 'MECHANICAL_DRAWING_IMPORT_ITEM';

CREATE TABLE "mechanical_drawings" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "drawing_number" TEXT NOT NULL,
  "drawing_type" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mechanical_drawings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mechanical_drawings_number_check" CHECK (
    "drawing_number" ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
  ),
  CONSTRAINT "mechanical_drawings_type_check" CHECK (
    "drawing_type" ~ '^[A-Z][A-Z0-9._-]{0,63}$'
  ),
  CONSTRAINT "mechanical_drawings_version_check" CHECK ("version" > 0)
);

CREATE TABLE "mechanical_drawing_version_files" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "drawing_id" TEXT NOT NULL,
  "document_version_id" TEXT NOT NULL,
  "file_id" TEXT NOT NULL,
  "role" "DrawingFileRole" NOT NULL,
  "file_sha256" TEXT NOT NULL,
  "file_mime_type" TEXT NOT NULL,
  "file_size" BIGINT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mechanical_drawing_version_files_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mechanical_drawing_version_files_sha256_check" CHECK (
    "file_sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "mechanical_drawing_version_files_mime_check" CHECK (
    length(btrim("file_mime_type")) BETWEEN 3 AND 191
  ),
  CONSTRAINT "mechanical_drawing_version_files_size_check" CHECK ("file_size" > 0)
);

CREATE TABLE "mechanical_drawing_import_batches" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "status" "DrawingImportBatchStatus" NOT NULL DEFAULT 'PENDING_CONFIRMATION',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mechanical_drawing_import_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mechanical_drawing_import_batches_version_check" CHECK ("version" > 0)
);

CREATE TABLE "mechanical_drawing_import_items" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "filename_stem" TEXT NOT NULL,
  "pairing_status" "DrawingImportPairingStatus" NOT NULL,
  "status" "DrawingImportItemStatus" NOT NULL DEFAULT 'PENDING',
  "confirmed_drawing_id" TEXT,
  "drawing_number" TEXT,
  "title" TEXT,
  "drawing_type" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mechanical_drawing_import_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mechanical_drawing_import_items_filename_stem_check" CHECK (
    length(btrim("filename_stem")) BETWEEN 1 AND 256
  ),
  CONSTRAINT "mechanical_drawing_import_items_confirmation_check" CHECK (
    ("status" = 'PENDING'
      AND "confirmed_drawing_id" IS NULL
      AND "drawing_number" IS NULL
      AND "title" IS NULL
      AND "drawing_type" IS NULL)
    OR ("status" = 'REJECTED'
      AND "confirmed_drawing_id" IS NULL
      AND "drawing_number" IS NULL
      AND "title" IS NULL
      AND "drawing_type" IS NULL)
    OR ("status" = 'CONFIRMED'
      AND "confirmed_drawing_id" IS NOT NULL
      AND "drawing_number" ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
      AND length(btrim("title")) BETWEEN 1 AND 256
      AND "drawing_type" ~ '^[A-Z][A-Z0-9._-]{0,63}$')
  )
);

CREATE TABLE "mechanical_drawing_import_item_files" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "file_id" TEXT NOT NULL,
  "inferred_role" "DrawingFileRole",
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mechanical_drawing_import_item_files_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mechanical_drawings_document_id_key"
  ON "mechanical_drawings"("document_id");
CREATE UNIQUE INDEX "mechanical_drawings_id_project_id_key"
  ON "mechanical_drawings"("id", "project_id");
CREATE UNIQUE INDEX "mechanical_drawings_document_project_key"
  ON "mechanical_drawings"("document_id", "project_id");
CREATE UNIQUE INDEX "mechanical_drawings_project_number_key"
  ON "mechanical_drawings"("project_id", "drawing_number");
CREATE INDEX "mechanical_drawings_project_type_number_idx"
  ON "mechanical_drawings"("project_id", "drawing_type", "drawing_number");
CREATE UNIQUE INDEX "mechanical_drawing_version_files_document_version_role_key"
  ON "mechanical_drawing_version_files"("document_version_id", "role");
CREATE UNIQUE INDEX "mechanical_drawing_version_files_id_project_id_key"
  ON "mechanical_drawing_version_files"("id", "project_id");
CREATE INDEX "mechanical_drawing_version_files_project_drawing_version_idx"
  ON "mechanical_drawing_version_files"("project_id", "drawing_id", "document_version_id");
CREATE INDEX "mechanical_drawing_version_files_file_id_idx"
  ON "mechanical_drawing_version_files"("file_id");
CREATE UNIQUE INDEX "mechanical_drawing_import_batches_id_project_id_key"
  ON "mechanical_drawing_import_batches"("id", "project_id");
CREATE INDEX "mechanical_drawing_import_batches_project_status_created_idx"
  ON "mechanical_drawing_import_batches"("project_id", "status", "created_at");
CREATE UNIQUE INDEX "mechanical_drawing_import_items_id_project_id_key"
  ON "mechanical_drawing_import_items"("id", "project_id");
CREATE INDEX "mechanical_drawing_import_items_batch_status_idx"
  ON "mechanical_drawing_import_items"("batch_id", "status");
CREATE INDEX "mechanical_drawing_import_items_project_drawing_idx"
  ON "mechanical_drawing_import_items"("project_id", "confirmed_drawing_id");
CREATE UNIQUE INDEX "mechanical_drawing_import_item_files_item_file_key"
  ON "mechanical_drawing_import_item_files"("item_id", "file_id");
CREATE INDEX "mechanical_drawing_import_item_files_project_file_idx"
  ON "mechanical_drawing_import_item_files"("project_id", "file_id");

ALTER TABLE "mechanical_drawings"
  ADD CONSTRAINT "mechanical_drawings_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "mechanical_drawings_document_project_fkey"
    FOREIGN KEY ("document_id", "project_id") REFERENCES "controlled_documents"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "mechanical_drawings_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mechanical_drawing_version_files"
  ADD CONSTRAINT "mechanical_drawing_version_files_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "mechanical_drawing_version_files_drawing_project_fkey"
    FOREIGN KEY ("drawing_id", "project_id") REFERENCES "mechanical_drawings"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "mechanical_drawing_version_files_document_version_project_fkey"
    FOREIGN KEY ("document_version_id", "project_id") REFERENCES "controlled_document_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "mechanical_drawing_version_files_file_project_fkey"
    FOREIGN KEY ("file_id", "project_id") REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mechanical_drawing_import_batches"
  ADD CONSTRAINT "mechanical_drawing_import_batches_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "mechanical_drawing_import_batches_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mechanical_drawing_import_items"
  ADD CONSTRAINT "mechanical_drawing_import_items_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "mechanical_drawing_import_items_batch_project_fkey"
    FOREIGN KEY ("batch_id", "project_id") REFERENCES "mechanical_drawing_import_batches"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "mechanical_drawing_import_items_confirmed_drawing_project_fkey"
    FOREIGN KEY ("confirmed_drawing_id", "project_id") REFERENCES "mechanical_drawings"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mechanical_drawing_import_item_files"
  ADD CONSTRAINT "mechanical_drawing_import_item_files_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "mechanical_drawing_import_item_files_item_project_fkey"
    FOREIGN KEY ("item_id", "project_id") REFERENCES "mechanical_drawing_import_items"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "mechanical_drawing_import_item_files_file_project_fkey"
    FOREIGN KEY ("file_id", "project_id") REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_mechanical_drawing_relation() RETURNS trigger AS $$
DECLARE
  document_code TEXT;
BEGIN
  SELECT "code" INTO document_code
    FROM "controlled_documents"
    WHERE "id" = NEW."document_id" AND "project_id" = NEW."project_id";
  IF document_code IS NULL OR document_code IS DISTINCT FROM NEW."drawing_number" THEN
    RAISE EXCEPTION 'mechanical drawing number must equal controlled document code'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_mechanical_drawing_version_file() RETURNS trigger AS $$
DECLARE
  drawing_document_id TEXT;
  version_document_id TEXT;
  file_status "FileObjectStatus";
  file_sha256 TEXT;
  file_mime TEXT;
  file_size BIGINT;
  source_file_id TEXT;
BEGIN
  SELECT "document_id" INTO drawing_document_id
    FROM "mechanical_drawings"
    WHERE "id" = NEW."drawing_id" AND "project_id" = NEW."project_id";
  SELECT "document_id", "source_file_id" INTO version_document_id, source_file_id
    FROM "controlled_document_versions"
    WHERE "id" = NEW."document_version_id" AND "project_id" = NEW."project_id";
  SELECT "status", "sha256", "verified_mime_type", "verified_size"
    INTO file_status, file_sha256, file_mime, file_size
    FROM "file_objects"
    WHERE "id" = NEW."file_id" AND "project_id" = NEW."project_id";
  IF drawing_document_id IS NULL
    OR version_document_id IS DISTINCT FROM drawing_document_id THEN
    RAISE EXCEPTION 'drawing version file must belong to the drawing controlled document'
      USING ERRCODE = '23514';
  END IF;
  IF file_status IS DISTINCT FROM 'AVAILABLE'::"FileObjectStatus"
    OR file_sha256 IS NULL
    OR file_mime IS NULL
    OR file_size IS NULL THEN
    RAISE EXCEPTION 'drawing version files require an available verified file'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."file_sha256" IS DISTINCT FROM file_sha256
    OR NEW."file_mime_type" IS DISTINCT FROM file_mime
    OR NEW."file_size" IS DISTINCT FROM file_size THEN
    RAISE EXCEPTION 'drawing version file snapshot must match FileObject verification'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."role" = 'CAD_SOURCE'::"DrawingFileRole"
    AND NEW."file_id" IS DISTINCT FROM source_file_id THEN
    RAISE EXCEPTION 'drawing CAD source must match the controlled document version source file'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_mechanical_drawing_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'drawing facts must be retained instead of removed' USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."document_id" IS DISTINCT FROM OLD."document_id"
    OR NEW."drawing_number" IS DISTINCT FROM OLD."drawing_number"
    OR NEW."drawing_type" IS DISTINCT FROM OLD."drawing_type"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'mechanical drawing identity is immutable and commands advance version once'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_mechanical_drawing_version_file_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'drawing version file facts are immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_mechanical_drawing_import_batch_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'drawing import batches must be retained instead of removed' USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'drawing import batch identity is immutable and commands advance version once'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'PENDING_CONFIRMATION'::"DrawingImportBatchStatus"
    AND NEW."status" IN ('CONFIRMED'::"DrawingImportBatchStatus", 'REJECTED'::"DrawingImportBatchStatus") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid drawing import batch transition: % -> %', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_mechanical_drawing_import_item_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'drawing import items must be retained instead of removed' USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."batch_id" IS DISTINCT FROM OLD."batch_id"
    OR NEW."filename_stem" IS DISTINCT FROM OLD."filename_stem"
    OR NEW."pairing_status" IS DISTINCT FROM OLD."pairing_status"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'drawing import item identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'PENDING'::"DrawingImportItemStatus"
    AND NEW."status" IN ('CONFIRMED'::"DrawingImportItemStatus", 'REJECTED'::"DrawingImportItemStatus") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid drawing import item transition: % -> %', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_mechanical_drawing_import_item_file() RETURNS trigger AS $$
DECLARE
  file_status "FileObjectStatus";
BEGIN
  SELECT "status" INTO file_status
    FROM "file_objects"
    WHERE "id" = NEW."file_id" AND "project_id" = NEW."project_id";
  IF file_status IS DISTINCT FROM 'AVAILABLE'::"FileObjectStatus" THEN
    RAISE EXCEPTION 'drawing import candidates require available files' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_mechanical_drawing_import_item_file_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'drawing import item file facts are immutable' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_mechanical_drawing_version_file_completeness() RETURNS trigger AS $$
DECLARE
  target_document_id TEXT;
  target_project_id TEXT;
  drawing_id_value TEXT;
  version_id_value TEXT;
  cad_count INTEGER;
BEGIN
  target_project_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."project_id" ELSE NEW."project_id" END;
  IF TG_TABLE_NAME = 'mechanical_drawing_version_files' THEN
    version_id_value := CASE WHEN TG_OP = 'DELETE' THEN OLD."document_version_id" ELSE NEW."document_version_id" END;
    SELECT "document_id" INTO target_document_id
      FROM "controlled_document_versions"
      WHERE "id" = version_id_value AND "project_id" = target_project_id;
  ELSIF TG_TABLE_NAME = 'mechanical_drawings' THEN
    drawing_id_value := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
    SELECT "document_id" INTO target_document_id
      FROM "mechanical_drawings"
      WHERE "id" = drawing_id_value AND "project_id" = target_project_id;
  ELSE
    target_document_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."document_id" ELSE NEW."document_id" END;
  END IF;
  IF target_document_id IS NULL THEN
    RETURN NULL;
  END IF;
  FOR version_id_value IN
    SELECT version_fact."id"
    FROM "controlled_document_versions" version_fact
    WHERE version_fact."document_id" = target_document_id
      AND version_fact."project_id" = target_project_id
  LOOP
    SELECT drawing."id" INTO drawing_id_value
      FROM "mechanical_drawings" drawing
      WHERE drawing."document_id" = target_document_id
        AND drawing."project_id" = target_project_id;
    IF drawing_id_value IS NULL THEN
      CONTINUE;
    END IF;
    SELECT count(*) INTO cad_count
      FROM "mechanical_drawing_version_files"
      WHERE "drawing_id" = drawing_id_value
        AND "document_version_id" = version_id_value
        AND "role" = 'CAD_SOURCE'::"DrawingFileRole";
    IF cad_count <> 1 THEN
      RAISE EXCEPTION 'mechanical drawings require exactly one CAD source attachment for each document version'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_mechanical_drawing_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'drawing facts must be retained instead of removed' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mechanical_drawings_validate_relation
  BEFORE INSERT OR UPDATE OF "document_id", "project_id", "drawing_number"
  ON "mechanical_drawings" FOR EACH ROW EXECUTE FUNCTION enforce_mechanical_drawing_relation();
CREATE TRIGGER mechanical_drawings_validate_mutation
  BEFORE UPDATE OR DELETE ON "mechanical_drawings"
  FOR EACH ROW EXECUTE FUNCTION validate_mechanical_drawing_mutation();
CREATE TRIGGER mechanical_drawings_reject_truncate
  BEFORE TRUNCATE ON "mechanical_drawings"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mechanical_drawing_truncate();
CREATE TRIGGER mechanical_drawing_version_files_validate
  BEFORE INSERT ON "mechanical_drawing_version_files"
  FOR EACH ROW EXECUTE FUNCTION validate_mechanical_drawing_version_file();
CREATE TRIGGER mechanical_drawing_version_files_reject_mutation
  BEFORE UPDATE OR DELETE ON "mechanical_drawing_version_files"
  FOR EACH ROW EXECUTE FUNCTION reject_mechanical_drawing_version_file_mutation();
CREATE TRIGGER mechanical_drawing_version_files_reject_truncate
  BEFORE TRUNCATE ON "mechanical_drawing_version_files"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mechanical_drawing_truncate();
CREATE TRIGGER mechanical_drawing_import_batches_validate_mutation
  BEFORE UPDATE OR DELETE ON "mechanical_drawing_import_batches"
  FOR EACH ROW EXECUTE FUNCTION validate_mechanical_drawing_import_batch_mutation();
CREATE TRIGGER mechanical_drawing_import_batches_reject_truncate
  BEFORE TRUNCATE ON "mechanical_drawing_import_batches"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mechanical_drawing_truncate();
CREATE TRIGGER mechanical_drawing_import_items_validate_mutation
  BEFORE UPDATE OR DELETE ON "mechanical_drawing_import_items"
  FOR EACH ROW EXECUTE FUNCTION validate_mechanical_drawing_import_item_mutation();
CREATE TRIGGER mechanical_drawing_import_items_reject_truncate
  BEFORE TRUNCATE ON "mechanical_drawing_import_items"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mechanical_drawing_truncate();
CREATE TRIGGER mechanical_drawing_import_item_files_validate
  BEFORE INSERT ON "mechanical_drawing_import_item_files"
  FOR EACH ROW EXECUTE FUNCTION validate_mechanical_drawing_import_item_file();
CREATE TRIGGER mechanical_drawing_import_item_files_reject_mutation
  BEFORE UPDATE OR DELETE ON "mechanical_drawing_import_item_files"
  FOR EACH ROW EXECUTE FUNCTION reject_mechanical_drawing_import_item_file_mutation();
CREATE TRIGGER mechanical_drawing_import_item_files_reject_truncate
  BEFORE TRUNCATE ON "mechanical_drawing_import_item_files"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mechanical_drawing_truncate();
CREATE CONSTRAINT TRIGGER mechanical_drawings_require_version_files
  AFTER INSERT OR UPDATE OR DELETE ON "mechanical_drawings"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_mechanical_drawing_version_file_completeness();
CREATE CONSTRAINT TRIGGER controlled_document_versions_require_drawing_files
  AFTER INSERT OR UPDATE OR DELETE ON "controlled_document_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_mechanical_drawing_version_file_completeness();
CREATE CONSTRAINT TRIGGER mechanical_drawing_version_files_complete_versions
  AFTER INSERT OR UPDATE OR DELETE ON "mechanical_drawing_version_files"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_mechanical_drawing_version_file_completeness();
