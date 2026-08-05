-- APM-050 controlled-document aggregate and immutable version facts.
CREATE TYPE "ControlledDocumentStatus" AS ENUM ('ACTIVE', 'VOIDED');
CREATE TYPE "ControlledDocumentVersionStatus" AS ENUM (
  'DRAFT', 'PUBLISHED', 'SUPERSEDED', 'VOIDED'
);

ALTER TYPE "AuditAction" ADD VALUE 'CONTROLLED_DOCUMENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTROLLED_DOCUMENT_VERSION_DRAFTED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTROLLED_DOCUMENT_VERSION_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE 'CONTROLLED_DOCUMENT_VOIDED';
ALTER TYPE "AuditAction" ADD VALUE 'SENSITIVE_FILE_READ';
ALTER TYPE "AuditObjectType" ADD VALUE 'CONTROLLED_DOCUMENT';
ALTER TYPE "AuditObjectType" ADD VALUE 'CONTROLLED_DOCUMENT_VERSION';

CREATE TABLE "controlled_documents" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" "ControlledDocumentStatus" NOT NULL DEFAULT 'ACTIVE',
  "current_published_version_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "voided_by_id" TEXT,
  "voided_at" TIMESTAMP(3),
  "void_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "controlled_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "controlled_documents_code_check" CHECK (
    "code" ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
  ),
  CONSTRAINT "controlled_documents_title_check" CHECK (
    length(btrim("title")) BETWEEN 1 AND 256
  ),
  CONSTRAINT "controlled_documents_version_check" CHECK ("version" > 0),
  CONSTRAINT "controlled_documents_void_check" CHECK (
    ("status" = 'ACTIVE' AND "voided_by_id" IS NULL AND "voided_at" IS NULL AND "void_reason" IS NULL)
    OR (
      "status" = 'VOIDED'
      AND "voided_by_id" IS NOT NULL
      AND "voided_at" IS NOT NULL
      AND length(btrim("void_reason")) BETWEEN 1 AND 1024
    )
  )
);

CREATE TABLE "controlled_document_versions" (
  "id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "ControlledDocumentVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "source_file_id" TEXT NOT NULL,
  "source_file_sha256" TEXT NOT NULL,
  "source_mime_type" TEXT NOT NULL,
  "source_file_size" BIGINT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "published_by_id" TEXT,
  "published_at" TIMESTAMP(3),
  "voided_by_id" TEXT,
  "voided_at" TIMESTAMP(3),
  "void_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "controlled_document_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "controlled_document_versions_version_check" CHECK ("version" > 0),
  CONSTRAINT "controlled_document_versions_sha256_check" CHECK (
    "source_file_sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "controlled_document_versions_mime_check" CHECK (
    length(btrim("source_mime_type")) BETWEEN 3 AND 191
  ),
  CONSTRAINT "controlled_document_versions_size_check" CHECK ("source_file_size" > 0),
  CONSTRAINT "controlled_document_versions_lifecycle_check" CHECK (
    ("status" = 'DRAFT' AND "published_by_id" IS NULL AND "published_at" IS NULL AND "voided_by_id" IS NULL AND "voided_at" IS NULL AND "void_reason" IS NULL)
    OR ("status" = 'PUBLISHED' AND "published_by_id" IS NOT NULL AND "published_at" IS NOT NULL AND "voided_by_id" IS NULL AND "voided_at" IS NULL AND "void_reason" IS NULL)
    OR ("status" = 'SUPERSEDED' AND "voided_by_id" IS NULL AND "voided_at" IS NULL AND "void_reason" IS NULL)
    OR ("status" = 'VOIDED' AND "voided_by_id" IS NOT NULL AND "voided_at" IS NOT NULL AND length(btrim("void_reason")) BETWEEN 1 AND 1024)
  )
);

CREATE UNIQUE INDEX "file_objects_id_project_id_key" ON "file_objects"("id", "project_id");
CREATE UNIQUE INDEX "controlled_documents_project_id_code_key" ON "controlled_documents"("project_id", "code");
CREATE UNIQUE INDEX "controlled_documents_id_project_id_key" ON "controlled_documents"("id", "project_id");
CREATE UNIQUE INDEX "controlled_documents_current_version_project_key"
  ON "controlled_documents"("current_published_version_id", "project_id");
CREATE INDEX "controlled_documents_project_id_status_code_idx"
  ON "controlled_documents"("project_id", "status", "code");
CREATE INDEX "controlled_documents_created_by_id_created_at_idx"
  ON "controlled_documents"("created_by_id", "created_at");
CREATE UNIQUE INDEX "controlled_document_versions_document_id_version_key"
  ON "controlled_document_versions"("document_id", "version");
CREATE UNIQUE INDEX "controlled_document_versions_id_project_id_key"
  ON "controlled_document_versions"("id", "project_id");
CREATE UNIQUE INDEX "controlled_document_versions_one_published_per_document_key"
  ON "controlled_document_versions"("document_id") WHERE "status" = 'PUBLISHED';
CREATE INDEX "controlled_document_versions_project_id_status_created_at_idx"
  ON "controlled_document_versions"("project_id", "status", "created_at");
CREATE INDEX "controlled_document_versions_source_file_id_idx"
  ON "controlled_document_versions"("source_file_id");

ALTER TABLE "controlled_documents"
  ADD CONSTRAINT "controlled_documents_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "controlled_documents_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "controlled_documents_voided_by_id_fkey"
    FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "controlled_document_versions"
  ADD CONSTRAINT "controlled_document_versions_document_project_fkey"
    FOREIGN KEY ("document_id", "project_id") REFERENCES "controlled_documents"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "controlled_document_versions_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "controlled_document_versions_source_file_project_fkey"
    FOREIGN KEY ("source_file_id", "project_id") REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "controlled_document_versions_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "controlled_document_versions_published_by_id_fkey"
    FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "controlled_document_versions_voided_by_id_fkey"
    FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "controlled_documents"
  ADD CONSTRAINT "controlled_documents_current_version_project_fkey"
    FOREIGN KEY ("current_published_version_id", "project_id") REFERENCES "controlled_document_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_controlled_document_version_source() RETURNS trigger AS $$
DECLARE
  file_status "FileObjectStatus";
  file_sha256 TEXT;
  file_mime TEXT;
  file_size BIGINT;
BEGIN
  SELECT "status", "sha256", "verified_mime_type", "verified_size"
    INTO file_status, file_sha256, file_mime, file_size
    FROM "file_objects"
    WHERE "id" = NEW."source_file_id" AND "project_id" = NEW."project_id";
  IF file_status IS DISTINCT FROM 'AVAILABLE'::"FileObjectStatus"
    OR file_sha256 IS NULL
    OR file_mime IS NULL
    OR file_size IS NULL THEN
    RAISE EXCEPTION 'controlled document versions require an available verified source file'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."source_file_sha256" IS DISTINCT FROM file_sha256
    OR NEW."source_mime_type" IS DISTINCT FROM file_mime
    OR NEW."source_file_size" IS DISTINCT FROM file_size THEN
    RAISE EXCEPTION 'controlled document version source snapshot must match FileObject verification'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_controlled_document_version_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'controlled document versions are append-only' USING ERRCODE = '55000';
  END IF;
  IF NEW."document_id" IS DISTINCT FROM OLD."document_id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."source_file_id" IS DISTINCT FROM OLD."source_file_id"
    OR NEW."source_file_sha256" IS DISTINCT FROM OLD."source_file_sha256"
    OR NEW."source_mime_type" IS DISTINCT FROM OLD."source_mime_type"
    OR NEW."source_file_size" IS DISTINCT FROM OLD."source_file_size"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'controlled document version content is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'DRAFT'
    AND (
      NEW."published_by_id" IS DISTINCT FROM OLD."published_by_id"
      OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
    ) THEN
    RAISE EXCEPTION 'controlled document version published facts are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = OLD."status" THEN
    RAISE EXCEPTION 'controlled document versions cannot be updated without a lifecycle transition'
      USING ERRCODE = '55000';
  END IF;
  IF (OLD."status" = 'DRAFT' AND NEW."status" IN ('PUBLISHED', 'SUPERSEDED', 'VOIDED'))
    OR (OLD."status" = 'PUBLISHED' AND NEW."status" IN ('SUPERSEDED', 'VOIDED'))
    OR (OLD."status" = 'SUPERSEDED' AND NEW."status" = 'VOIDED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid controlled document version transition: % -> %', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_controlled_document_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'controlled documents cannot be deleted; void them instead' USING ERRCODE = '55000';
  END IF;
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."code" IS DISTINCT FROM OLD."code"
    OR NEW."title" IS DISTINCT FROM OLD."title"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'controlled document identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'VOIDED' THEN
    RAISE EXCEPTION 'voided controlled documents are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'controlled document commands must advance resource version exactly once'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'ACTIVE' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'ACTIVE' AND NEW."status" = 'VOIDED' AND NEW."current_published_version_id" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid controlled document transition: % -> %', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_controlled_document_current_version() RETURNS trigger AS $$
DECLARE
  target_document_id TEXT;
  target_project_id TEXT;
  document_status "ControlledDocumentStatus";
  current_version_id TEXT;
  published_count INTEGER;
  published_version_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'controlled_documents' THEN
    target_document_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
  ELSE
    target_document_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."document_id" ELSE NEW."document_id" END;
  END IF;
  target_project_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."project_id" ELSE NEW."project_id" END;
  SELECT "status", "current_published_version_id"
    INTO document_status, current_version_id
    FROM "controlled_documents"
    WHERE "id" = target_document_id AND "project_id" = target_project_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*), max("id")
    INTO published_count, published_version_id
    FROM "controlled_document_versions"
    WHERE "document_id" = target_document_id AND "status" = 'PUBLISHED';
  IF document_status = 'VOIDED' THEN
    IF current_version_id IS NOT NULL OR published_count <> 0 THEN
      RAISE EXCEPTION 'voided controlled document cannot retain a published version' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;
  IF published_count = 0 AND current_version_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF published_count <> 1 OR current_version_id IS DISTINCT FROM published_version_id THEN
    RAISE EXCEPTION 'controlled document must reference exactly one current published version'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_controlled_document_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'controlled document facts cannot be truncated' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER controlled_document_versions_validate_source
  BEFORE INSERT OR UPDATE OF "source_file_id", "source_file_sha256", "source_mime_type", "source_file_size"
  ON "controlled_document_versions"
  FOR EACH ROW EXECUTE FUNCTION validate_controlled_document_version_source();
CREATE TRIGGER controlled_document_versions_validate_mutation
  BEFORE UPDATE OR DELETE ON "controlled_document_versions"
  FOR EACH ROW EXECUTE FUNCTION validate_controlled_document_version_mutation();
CREATE TRIGGER controlled_documents_validate_mutation
  BEFORE UPDATE OR DELETE ON "controlled_documents"
  FOR EACH ROW EXECUTE FUNCTION validate_controlled_document_mutation();
CREATE TRIGGER controlled_document_versions_reject_truncate
  BEFORE TRUNCATE ON "controlled_document_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_controlled_document_truncate();
CREATE TRIGGER controlled_documents_reject_truncate
  BEFORE TRUNCATE ON "controlled_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_controlled_document_truncate();
CREATE CONSTRAINT TRIGGER controlled_documents_current_version_check
  AFTER INSERT OR UPDATE OR DELETE ON "controlled_documents"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_controlled_document_current_version();
CREATE CONSTRAINT TRIGGER controlled_document_versions_current_version_check
  AFTER INSERT OR UPDATE OR DELETE ON "controlled_document_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_controlled_document_current_version();

INSERT INTO "permissions" ("id", "code", "description") VALUES
('permission-controlled-document-read', 'CONTROLLED_DOCUMENT_READ', '读取授权项目中的受控文档和精确版本'),
('permission-controlled-document-manage', 'CONTROLLED_DOCUMENT_MANAGE', '创建、迭代、发布或作废授权项目中的受控文档');

INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
('role-project-manager', 'permission-controlled-document-read', 'PROJECT'),
('role-project-manager', 'permission-controlled-document-manage', 'PROJECT'),
('role-department-lead', 'permission-controlled-document-read', 'DEPARTMENT'),
('role-department-lead', 'permission-controlled-document-manage', 'DEPARTMENT'),
('role-engineer', 'permission-controlled-document-read', 'PROJECT'),
('role-engineer', 'permission-controlled-document-manage', 'PROJECT'),
('role-procurement', 'permission-controlled-document-read', 'PROJECT'),
('role-procurement', 'permission-controlled-document-manage', 'PROJECT'),
('role-quality', 'permission-controlled-document-read', 'PROJECT'),
('role-quality', 'permission-controlled-document-manage', 'PROJECT'),
('role-executive', 'permission-controlled-document-read', 'ALL'),
('role-admin', 'permission-controlled-document-read', 'ALL'),
('role-admin', 'permission-controlled-document-manage', 'ALL');
