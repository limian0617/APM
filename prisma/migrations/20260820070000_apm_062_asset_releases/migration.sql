-- APM-062 AST-001 immutable asset Release versions and component snapshots.
-- Project usage/derivation, upgrade/recall, and other later asset packages remain deferred.
CREATE TYPE "AssetReleaseVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');
CREATE TYPE "AssetComponentType" AS ENUM ('MECHANICAL_DRAWING', 'SOFTWARE', 'VALIDATION_REPORT');

ALTER TYPE "AuditAction" ADD VALUE 'ASSET_RELEASE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'ASSET_RELEASE_VERSION_DRAFTED';
ALTER TYPE "AuditAction" ADD VALUE 'ASSET_RELEASE_VERSION_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE 'ASSET_RELEASE_VERSION_SUPERSEDED';
ALTER TYPE "AuditAction" ADD VALUE 'ASSET_RELEASE_READ';
ALTER TYPE "AuditObjectType" ADD VALUE 'ASSET_RELEASE';
ALTER TYPE "AuditObjectType" ADD VALUE 'ASSET_RELEASE_VERSION';
ALTER TYPE "AuditObjectType" ADD VALUE 'ASSET_COMPONENT_SNAPSHOT';

CREATE TABLE "asset_releases" (
  "id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "release_code" TEXT NOT NULL,
  "current_version_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "asset_releases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_releases_release_code_check" CHECK ("release_code" ~ '^[A-Z][A-Z0-9._-]{2,100}$'),
  CONSTRAINT "asset_releases_version_check" CHECK ("version" > 0)
);

CREATE TABLE "asset_release_versions" (
  "id" TEXT NOT NULL,
  "release_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" "AssetReleaseVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "release_notes" TEXT,
  "snapshot_checksum" TEXT NOT NULL,
  "source_watermark" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "published_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  "superseded_at" TIMESTAMP(3),
  CONSTRAINT "asset_release_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_release_versions_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "asset_release_versions_checksum_check" CHECK (
    "snapshot_checksum" ~ '^[0-9a-f]{64}$' AND "source_watermark" <> ''
  ),
  CONSTRAINT "asset_release_versions_status_dates_check" CHECK (
    ("status" = 'DRAFT' AND "published_at" IS NULL AND "superseded_at" IS NULL)
    OR ("status" = 'PUBLISHED' AND "published_at" IS NOT NULL AND "superseded_at" IS NULL)
    OR ("status" = 'SUPERSEDED' AND "published_at" IS NOT NULL AND "superseded_at" IS NOT NULL)
  )
);

CREATE TABLE "asset_component_snapshots" (
  "id" TEXT NOT NULL,
  "release_version_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "component_type" "AssetComponentType" NOT NULL,
  "source_project_id" TEXT NOT NULL,
  "source_drawing_id" TEXT,
  "source_document_version_id" TEXT NOT NULL,
  "source_file_id" TEXT NOT NULL,
  "source_version" INTEGER NOT NULL,
  "source_status" "ControlledDocumentVersionStatus" NOT NULL,
  "source_checksum" TEXT NOT NULL,
  "source_file_sha256" TEXT NOT NULL,
  "source_file_mime_type" TEXT NOT NULL,
  "source_file_size" BIGINT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "asset_component_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_component_snapshots_position_check" CHECK ("position" > 0),
  CONSTRAINT "asset_component_snapshots_source_version_check" CHECK ("source_version" > 0),
  CONSTRAINT "asset_component_snapshots_checksum_check" CHECK (
    "source_checksum" ~ '^[0-9a-f]{64}$' AND "source_file_sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "asset_component_snapshots_source_status_check" CHECK ("source_status" = 'PUBLISHED'),
  CONSTRAINT "asset_component_snapshots_file_size_check" CHECK ("source_file_size" >= 0)
);

CREATE UNIQUE INDEX "asset_releases_technical_asset_id_release_code_key"
  ON "asset_releases"("technical_asset_id", "release_code");
CREATE UNIQUE INDEX "asset_releases_id_technical_asset_id_key"
  ON "asset_releases"("id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_releases_current_version_id_technical_asset_id_key"
  ON "asset_releases"("current_version_id", "technical_asset_id");
CREATE INDEX "asset_releases_technical_asset_id_created_at_idx"
  ON "asset_releases"("technical_asset_id", "created_at");

CREATE UNIQUE INDEX "asset_release_versions_id_technical_asset_id_key"
  ON "asset_release_versions"("id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_release_versions_release_id_revision_key"
  ON "asset_release_versions"("release_id", "revision");
CREATE INDEX "asset_release_versions_technical_asset_id_status_created_at_idx"
  ON "asset_release_versions"("technical_asset_id", "status", "created_at");
CREATE INDEX "asset_release_versions_published_by_id_published_at_idx"
  ON "asset_release_versions"("published_by_id", "published_at");

CREATE UNIQUE INDEX "asset_component_snapshots_release_version_id_position_key"
  ON "asset_component_snapshots"("release_version_id", "position");
CREATE UNIQUE INDEX "asset_component_snapshots_id_technical_asset_id_key"
  ON "asset_component_snapshots"("id", "technical_asset_id");
CREATE INDEX "asset_component_snapshots_source_project_id_source_document_version_id_idx"
  ON "asset_component_snapshots"("source_project_id", "source_document_version_id");
CREATE INDEX "asset_component_snapshots_source_project_id_source_file_id_idx"
  ON "asset_component_snapshots"("source_project_id", "source_file_id");

ALTER TABLE "asset_releases"
  ADD CONSTRAINT "asset_releases_technical_asset_id_fkey"
    FOREIGN KEY ("technical_asset_id") REFERENCES "technical_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_releases_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_releases_current_version_fkey"
    FOREIGN KEY ("current_version_id", "technical_asset_id")
    REFERENCES "asset_release_versions"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "asset_release_versions"
  ADD CONSTRAINT "asset_release_versions_release_fkey"
    FOREIGN KEY ("release_id", "technical_asset_id")
    REFERENCES "asset_releases"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_release_versions_technical_asset_id_fkey"
    FOREIGN KEY ("technical_asset_id") REFERENCES "technical_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_release_versions_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_release_versions_published_by_id_fkey"
    FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "asset_component_snapshots"
  ADD CONSTRAINT "asset_component_snapshots_release_version_fkey"
    FOREIGN KEY ("release_version_id", "technical_asset_id")
    REFERENCES "asset_release_versions"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_component_snapshots_technical_asset_id_fkey"
    FOREIGN KEY ("technical_asset_id") REFERENCES "technical_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_component_snapshots_source_project_id_fkey"
    FOREIGN KEY ("source_project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_component_snapshots_source_drawing_fkey"
    FOREIGN KEY ("source_drawing_id", "source_project_id")
    REFERENCES "mechanical_drawings"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_component_snapshots_source_document_version_fkey"
    FOREIGN KEY ("source_document_version_id", "source_project_id")
    REFERENCES "controlled_document_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "asset_component_snapshots_source_file_fkey"
    FOREIGN KEY ("source_file_id", "source_project_id")
    REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_asset_component_source() RETURNS trigger AS $$
DECLARE
  source_status "ControlledDocumentVersionStatus";
  source_version INTEGER;
  source_file_id TEXT;
  source_file_sha256 TEXT;
  source_file_mime_type TEXT;
  source_file_size BIGINT;
  source_document_id TEXT;
  source_file_status "FileObjectStatus";
  drawing_document_id TEXT;
BEGIN
  SELECT cdv."status", cdv."version", cdv."source_file_id", cdv."source_file_sha256", cdv."source_mime_type",
         cdv."source_file_size", cdv."document_id"
    INTO source_status, source_version, source_file_id, source_file_sha256, source_file_mime_type,
         source_file_size, source_document_id
    FROM "controlled_document_versions" AS cdv
    WHERE cdv."id" = NEW."source_document_version_id" AND cdv."project_id" = NEW."source_project_id";
  IF NOT FOUND OR source_status IS DISTINCT FROM 'PUBLISHED' THEN
    RAISE EXCEPTION 'asset component source version must be published' USING ERRCODE = '23514';
  END IF;
  IF NEW."source_status" IS DISTINCT FROM source_status
    OR NEW."source_version" IS DISTINCT FROM source_version
    OR NEW."source_file_id" IS DISTINCT FROM source_file_id
    OR NEW."source_file_sha256" IS DISTINCT FROM source_file_sha256
    OR NEW."source_file_mime_type" IS DISTINCT FROM source_file_mime_type
    OR NEW."source_file_size" IS DISTINCT FROM source_file_size THEN
    RAISE EXCEPTION 'asset component source snapshot must match the exact published document version'
      USING ERRCODE = '23514';
  END IF;
  SELECT fo."status" INTO source_file_status
    FROM "file_objects" AS fo
    WHERE fo."id" = NEW."source_file_id" AND fo."project_id" = NEW."source_project_id";
  IF source_file_status IS DISTINCT FROM 'AVAILABLE' THEN
    RAISE EXCEPTION 'asset component source file must be available' USING ERRCODE = '23514';
  END IF;
  IF NEW."source_drawing_id" IS NOT NULL THEN
    SELECT md."document_id" INTO drawing_document_id
      FROM "mechanical_drawings" AS md
      WHERE md."id" = NEW."source_drawing_id" AND md."project_id" = NEW."source_project_id";
    IF drawing_document_id IS DISTINCT FROM source_document_id THEN
      RAISE EXCEPTION 'asset component drawing must match the source document version'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_release_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'asset releases cannot be deleted; create a new version instead' USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."technical_asset_id" IS DISTINCT FROM OLD."technical_asset_id"
    OR NEW."release_code" IS DISTINCT FROM OLD."release_code"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'asset release identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'asset release commands must advance resource version exactly once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_asset_release_version_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'asset release versions cannot be deleted; supersede them instead' USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."release_id" IS DISTINCT FROM OLD."release_id"
    OR NEW."technical_asset_id" IS DISTINCT FROM OLD."technical_asset_id"
    OR NEW."revision" IS DISTINCT FROM OLD."revision"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'asset release version identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'PUBLISHED' THEN
    IF NEW."status" = 'SUPERSEDED'
      AND NEW."release_notes" IS NOT DISTINCT FROM OLD."release_notes"
      AND NEW."snapshot_checksum" IS NOT DISTINCT FROM OLD."snapshot_checksum"
      AND NEW."source_watermark" IS NOT DISTINCT FROM OLD."source_watermark"
      AND NEW."published_by_id" IS NOT DISTINCT FROM OLD."published_by_id"
      AND NEW."published_at" IS NOT DISTINCT FROM OLD."published_at"
      AND NEW."superseded_at" IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'published asset release version payload is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" IN ('DRAFT', 'PUBLISHED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid asset release version transition: % -> %', OLD."status", NEW."status"
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_asset_release_component_mutation() RETURNS trigger AS $$
DECLARE
  version_status "AssetReleaseVersionStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'asset component snapshots cannot be deleted; create a new version instead' USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."release_version_id" IS DISTINCT FROM OLD."release_version_id"
    OR NEW."technical_asset_id" IS DISTINCT FROM OLD."technical_asset_id"
    OR NEW."position" IS DISTINCT FROM OLD."position"
    OR NEW."component_type" IS DISTINCT FROM OLD."component_type"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'asset component snapshot identity is immutable' USING ERRCODE = '55000';
  END IF;
  SELECT "status" INTO version_status
    FROM "asset_release_versions"
    WHERE "id" = NEW."release_version_id" AND "technical_asset_id" = NEW."technical_asset_id";
  IF version_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'published asset component snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_asset_release_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'asset release facts cannot be truncated' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER asset_component_snapshots_validate_source
  BEFORE INSERT OR UPDATE ON "asset_component_snapshots"
  FOR EACH ROW EXECUTE FUNCTION validate_asset_component_source();
CREATE TRIGGER asset_releases_validate_mutation
  BEFORE UPDATE OR DELETE ON "asset_releases"
  FOR EACH ROW EXECUTE FUNCTION validate_asset_release_mutation();
CREATE TRIGGER asset_release_versions_validate_mutation
  BEFORE UPDATE OR DELETE ON "asset_release_versions"
  FOR EACH ROW EXECUTE FUNCTION validate_asset_release_version_mutation();
CREATE TRIGGER asset_component_snapshots_reject_mutation
  BEFORE UPDATE OR DELETE ON "asset_component_snapshots"
  FOR EACH ROW EXECUTE FUNCTION reject_asset_release_component_mutation();
CREATE TRIGGER asset_releases_reject_truncate
  BEFORE TRUNCATE ON "asset_releases"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_asset_release_truncate();
CREATE TRIGGER asset_release_versions_reject_truncate
  BEFORE TRUNCATE ON "asset_release_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_asset_release_truncate();
CREATE TRIGGER asset_component_snapshots_reject_truncate
  BEFORE TRUNCATE ON "asset_component_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_asset_release_truncate();
