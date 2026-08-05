CREATE TYPE "PublicLibraryMaterialType" AS ENUM (
  'DRIVER', 'FIRMWARE', 'TOOL', 'MANUAL', 'TRAINING', 'STANDARD', 'TEMPLATE'
);
CREATE TYPE "PublicLibraryDocumentStatus" AS ENUM ('ACTIVE', 'VOIDED');
CREATE TYPE "PublicLibraryDocumentVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'VOIDED');
CREATE TYPE "ProjectPublicLibraryReferenceStatus" AS ENUM ('ACTIVE', 'RETIRED');

CREATE TABLE "public_library_documents" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "material_type" "PublicLibraryMaterialType" NOT NULL,
  "status" "PublicLibraryDocumentStatus" NOT NULL DEFAULT 'ACTIVE',
  "current_published_version_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "voided_by_id" TEXT,
  "voided_at" TIMESTAMP(3),
  "void_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "public_library_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public_library_document_versions" (
  "id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "PublicLibraryDocumentVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "source_file_id" TEXT NOT NULL,
  "source_file_sha256" TEXT NOT NULL,
  "source_mime_type" TEXT NOT NULL,
  "source_file_size" BIGINT NOT NULL,
  "applicable_models" JSONB NOT NULL DEFAULT '[]',
  "applicable_platforms" JSONB NOT NULL DEFAULT '[]',
  "created_by_id" TEXT NOT NULL,
  "published_by_id" TEXT,
  "published_at" TIMESTAMP(3),
  "voided_by_id" TEXT,
  "voided_at" TIMESTAMP(3),
  "void_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "public_library_document_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_public_library_references" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "public_library_document_id" TEXT NOT NULL,
  "public_document_version_id" TEXT NOT NULL,
  "document_code" TEXT NOT NULL,
  "document_title" TEXT NOT NULL,
  "material_type" "PublicLibraryMaterialType" NOT NULL,
  "document_version" INTEGER NOT NULL,
  "source_file_sha256" TEXT NOT NULL,
  "applicable_models" JSONB NOT NULL DEFAULT '[]',
  "applicable_platforms" JSONB NOT NULL DEFAULT '[]',
  "status" "ProjectPublicLibraryReferenceStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "retired_by_id" TEXT,
  "retired_at" TIMESTAMP(3),
  "retire_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_public_library_references_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "public_library_documents_code_key" ON "public_library_documents"("code");
CREATE UNIQUE INDEX "public_library_documents_single_current_published"
  ON "public_library_documents"("current_published_version_id")
  WHERE "current_published_version_id" IS NOT NULL;
CREATE INDEX "public_library_documents_status_material_type_code_idx"
  ON "public_library_documents"("status", "material_type", "code");
CREATE INDEX "public_library_documents_created_by_id_created_at_idx"
  ON "public_library_documents"("created_by_id", "created_at");
CREATE UNIQUE INDEX "public_library_document_versions_document_id_version_key"
  ON "public_library_document_versions"("document_id", "version");
CREATE INDEX "public_library_document_versions_status_created_at_idx"
  ON "public_library_document_versions"("status", "created_at");
CREATE INDEX "public_library_document_versions_source_file_id_idx"
  ON "public_library_document_versions"("source_file_id");
CREATE UNIQUE INDEX "project_public_library_references_project_id_public_document_version_id_key"
  ON "project_public_library_references"("project_id", "public_document_version_id");
CREATE INDEX "project_public_library_references_project_id_status_created_at_idx"
  ON "project_public_library_references"("project_id", "status", "created_at");
CREATE INDEX "project_public_library_references_public_library_document_id_document_version_idx"
  ON "project_public_library_references"("public_library_document_id", "document_version");

ALTER TABLE "public_library_documents"
  ADD CONSTRAINT "public_library_documents_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "public_library_documents_voided_by_id_fkey"
  FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public_library_document_versions"
  ADD CONSTRAINT "public_library_document_versions_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "public_library_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "public_library_document_versions_source_file_id_fkey"
  FOREIGN KEY ("source_file_id") REFERENCES "file_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "public_library_document_versions_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "public_library_document_versions_published_by_id_fkey"
  FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "public_library_document_versions_voided_by_id_fkey"
  FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public_library_documents"
  ADD CONSTRAINT "public_library_documents_current_published_version_id_fkey"
  FOREIGN KEY ("current_published_version_id") REFERENCES "public_library_document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_public_library_references"
  ADD CONSTRAINT "project_public_library_references_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_public_library_references_document_id_fkey"
  FOREIGN KEY ("public_library_document_id") REFERENCES "public_library_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_public_library_references_version_id_fkey"
  FOREIGN KEY ("public_document_version_id") REFERENCES "public_library_document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_public_library_references_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_public_library_references_retired_by_id_fkey"
  FOREIGN KEY ("retired_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_public_library_version_source() RETURNS trigger AS $$
DECLARE
  source_status "FileObjectStatus";
  source_hash TEXT;
  source_mime TEXT;
  source_size BIGINT;
BEGIN
  SELECT "status", "sha256", "verified_mime_type", "verified_size"
    INTO source_status, source_hash, source_mime, source_size
    FROM "file_objects" WHERE "id" = NEW."source_file_id";
  IF source_status IS DISTINCT FROM 'AVAILABLE'
    OR source_hash IS NULL
    OR source_mime IS NULL
    OR source_size IS NULL
    OR NEW."source_file_sha256" IS DISTINCT FROM source_hash
    OR NEW."source_mime_type" IS DISTINCT FROM source_mime
    OR NEW."source_file_size" IS DISTINCT FROM source_size THEN
    RAISE EXCEPTION 'public library versions require an available verified source file snapshot'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_public_library_current_publication() RETURNS trigger AS $$
DECLARE
  current_document_id TEXT;
  current_status "PublicLibraryDocumentVersionStatus";
BEGIN
  IF NEW."current_published_version_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "document_id", "status"
    INTO current_document_id, current_status
    FROM "public_library_document_versions"
    WHERE "id" = NEW."current_published_version_id";
  IF current_document_id IS DISTINCT FROM NEW."id" OR current_status IS DISTINCT FROM 'PUBLISHED' THEN
    RAISE EXCEPTION 'current public library version must be published and belong to its document'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_project_public_library_reference() RETURNS trigger AS $$
DECLARE
  version_document_id TEXT;
  version_number INTEGER;
  version_status "PublicLibraryDocumentVersionStatus";
  version_hash TEXT;
  version_models JSONB;
  version_platforms JSONB;
  document_code TEXT;
  document_title TEXT;
  document_material_type "PublicLibraryMaterialType";
BEGIN
  SELECT version."document_id", version."version", version."status", version."source_file_sha256",
         version."applicable_models", version."applicable_platforms", document."code", document."title", document."material_type"
    INTO version_document_id, version_number, version_status, version_hash,
         version_models, version_platforms, document_code, document_title, document_material_type
    FROM "public_library_document_versions" version
    JOIN "public_library_documents" document ON document."id" = version."document_id"
    WHERE version."id" = NEW."public_document_version_id";
  IF version_document_id IS DISTINCT FROM NEW."public_library_document_id"
    OR version_status IS DISTINCT FROM 'PUBLISHED'
    OR NEW."document_version" IS DISTINCT FROM version_number
    OR NEW."source_file_sha256" IS DISTINCT FROM version_hash
    OR NEW."applicable_models" IS DISTINCT FROM version_models
    OR NEW."applicable_platforms" IS DISTINCT FROM version_platforms
    OR NEW."document_code" IS DISTINCT FROM document_code
    OR NEW."document_title" IS DISTINCT FROM document_title
    OR NEW."material_type" IS DISTINCT FROM document_material_type THEN
    RAISE EXCEPTION 'project public library reference must be an exact published version snapshot'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_public_library_version_stability() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."document_id" IS DISTINCT FROM NEW."document_id"
    OR OLD."version" IS DISTINCT FROM NEW."version"
    OR OLD."source_file_id" IS DISTINCT FROM NEW."source_file_id"
    OR OLD."source_file_sha256" IS DISTINCT FROM NEW."source_file_sha256"
    OR OLD."source_mime_type" IS DISTINCT FROM NEW."source_mime_type"
    OR OLD."source_file_size" IS DISTINCT FROM NEW."source_file_size"
    OR OLD."applicable_models" IS DISTINCT FROM NEW."applicable_models"
    OR OLD."applicable_platforms" IS DISTINCT FROM NEW."applicable_platforms"
    OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'public library version identity and content are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_project_public_library_reference_stability() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."public_library_document_id" IS DISTINCT FROM NEW."public_library_document_id"
    OR OLD."public_document_version_id" IS DISTINCT FROM NEW."public_document_version_id"
    OR OLD."document_code" IS DISTINCT FROM NEW."document_code"
    OR OLD."document_title" IS DISTINCT FROM NEW."document_title"
    OR OLD."material_type" IS DISTINCT FROM NEW."material_type"
    OR OLD."document_version" IS DISTINCT FROM NEW."document_version"
    OR OLD."source_file_sha256" IS DISTINCT FROM NEW."source_file_sha256"
    OR OLD."applicable_models" IS DISTINCT FROM NEW."applicable_models"
    OR OLD."applicable_platforms" IS DISTINCT FROM NEW."applicable_platforms"
    OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
    OR OLD."status" = 'RETIRED'
    OR NEW."status" NOT IN ('ACTIVE', 'RETIRED') THEN
    RAISE EXCEPTION 'project public library reference is immutable except one retirement transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_public_library_fact_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% must be voided, superseded, or retired instead of removed', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER public_library_versions_source_check
  BEFORE INSERT OR UPDATE OF "source_file_id", "source_file_sha256", "source_mime_type", "source_file_size"
  ON "public_library_document_versions" FOR EACH ROW EXECUTE FUNCTION enforce_public_library_version_source();
CREATE TRIGGER public_library_documents_current_publication_check
  BEFORE INSERT OR UPDATE OF "current_published_version_id"
  ON "public_library_documents" FOR EACH ROW EXECUTE FUNCTION enforce_public_library_current_publication();
CREATE TRIGGER project_public_library_references_exact_version_check
  BEFORE INSERT OR UPDATE OF "public_library_document_id", "public_document_version_id", "document_code", "document_title", "material_type", "document_version", "source_file_sha256", "applicable_models", "applicable_platforms"
  ON "project_public_library_references" FOR EACH ROW EXECUTE FUNCTION enforce_project_public_library_reference();
CREATE TRIGGER public_library_versions_reject_mutation
  BEFORE UPDATE ON "public_library_document_versions" FOR EACH ROW EXECUTE FUNCTION enforce_public_library_version_stability();
CREATE TRIGGER project_public_library_references_reject_mutation
  BEFORE UPDATE ON "project_public_library_references" FOR EACH ROW EXECUTE FUNCTION enforce_project_public_library_reference_stability();
CREATE TRIGGER public_library_documents_reject_delete
  BEFORE DELETE OR TRUNCATE ON "public_library_documents" FOR EACH STATEMENT EXECUTE FUNCTION reject_public_library_fact_removal();
CREATE TRIGGER public_library_versions_reject_delete
  BEFORE DELETE OR TRUNCATE ON "public_library_document_versions" FOR EACH STATEMENT EXECUTE FUNCTION reject_public_library_fact_removal();
CREATE TRIGGER project_public_library_references_reject_delete
  BEFORE DELETE OR TRUNCATE ON "project_public_library_references" FOR EACH STATEMENT EXECUTE FUNCTION reject_public_library_fact_removal();

ALTER TYPE "AuditAction" ADD VALUE 'PUBLIC_LIBRARY_DOCUMENT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PUBLIC_LIBRARY_VERSION_DRAFTED';
ALTER TYPE "AuditAction" ADD VALUE 'PUBLIC_LIBRARY_VERSION_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE 'PUBLIC_LIBRARY_DOCUMENT_VOIDED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_PUBLIC_LIBRARY_REFERENCE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_PUBLIC_LIBRARY_REFERENCE_RETIRED';
ALTER TYPE "AuditObjectType" ADD VALUE 'PUBLIC_LIBRARY_DOCUMENT';
ALTER TYPE "AuditObjectType" ADD VALUE 'PUBLIC_LIBRARY_DOCUMENT_VERSION';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_PUBLIC_LIBRARY_REFERENCE';
