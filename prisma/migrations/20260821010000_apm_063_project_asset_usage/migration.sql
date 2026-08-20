-- APM-063 project asset references, usage facts and derivations.
-- All relations are project-scoped and historical facts are retained.

ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_ASSET_REFERENCE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_ASSET_REFERENCE_READ';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_ASSET_REFERENCE_RETIRED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_ASSET_USAGE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_ASSET_USAGE_READ';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_ASSET_USAGE_RETIRED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_ASSET_DERIVATION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_ASSET_DERIVATION_READ';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_ASSET_USAGE_SNAPSHOT_READ';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_ASSET_REFERENCE';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_ASSET_USAGE';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_ASSET_DERIVATION';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_ASSET_USAGE_SNAPSHOT';

INSERT INTO "permissions" ("id", "code", "description") VALUES
  ('permission-project-asset-usage-read', 'PROJECT_ASSET_USAGE_READ', '读取项目资产引用、实际使用与派生事实'),
  ('permission-project-asset-usage-manage', 'PROJECT_ASSET_USAGE_MANAGE', '创建、退役项目资产引用与实际使用事实')
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
  ('role-project-manager', 'permission-project-asset-usage-read', 'PROJECT'),
  ('role-project-manager', 'permission-project-asset-usage-manage', 'PROJECT'),
  ('role-engineer', 'permission-project-asset-usage-read', 'PROJECT'),
  ('role-engineer', 'permission-project-asset-usage-manage', 'PROJECT'),
  ('role-quality', 'permission-project-asset-usage-read', 'PROJECT'),
  ('role-technical-asset-maintainer', 'permission-project-asset-usage-read', 'ALL'),
  ('role-technical-asset-maintainer', 'permission-project-asset-usage-manage', 'ALL'),
  ('role-admin', 'permission-project-asset-usage-read', 'ALL'),
  ('role-admin', 'permission-project-asset-usage-manage', 'ALL')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

ALTER TABLE "delivery_units" DROP CONSTRAINT "delivery_units_parent_id_fkey";
ALTER TABLE "project_modules" DROP CONSTRAINT "project_modules_delivery_unit_id_fkey";
CREATE UNIQUE INDEX "project_modules_id_project_id_delivery_unit_id_key"
  ON "project_modules"("id", "project_id", "delivery_unit_id");
ALTER TABLE "delivery_units" ADD CONSTRAINT "delivery_units_parent_project_fkey"
  FOREIGN KEY ("parent_id", "project_id") REFERENCES "delivery_units"("id", "project_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_modules" ADD CONSTRAINT "project_modules_delivery_unit_project_fkey"
  FOREIGN KEY ("delivery_unit_id", "project_id") REFERENCES "delivery_units"("id", "project_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "asset_release_versions_id_release_id_technical_asset_id_key"
  ON "asset_release_versions"("id", "release_id", "technical_asset_id");
CREATE UNIQUE INDEX "asset_component_snapshots_id_release_version_id_technical_asset_id_key"
  ON "asset_component_snapshots"("id", "release_version_id", "technical_asset_id");

CREATE TYPE "ProjectAssetReferenceStatus" AS ENUM ('ACTIVE', 'RETIRED');
CREATE TYPE "ProjectAssetUsageStatus" AS ENUM ('ACTIVE', 'RETIRED');
CREATE TYPE "ProjectAssetUsageScopeType" AS ENUM ('PROJECT', 'DELIVERY_UNIT', 'MODULE');
CREATE TYPE "ProjectAssetDerivationTargetType" AS ENUM ('CONTROLLED_DOCUMENT_VERSION', 'MECHANICAL_DRAWING_VERSION');

CREATE TABLE "project_asset_references" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "asset_release_id" TEXT NOT NULL,
  "asset_release_version_id" TEXT NOT NULL,
  "release_code" TEXT NOT NULL,
  "release_revision" INTEGER NOT NULL,
  "snapshot_checksum" TEXT NOT NULL,
  "source_watermark" TEXT NOT NULL,
  "status" "ProjectAssetReferenceStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "retired_by_id" TEXT,
  "retired_at" TIMESTAMP(3),
  "retire_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_asset_references_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_asset_references_release_code_check" CHECK ("release_code" ~ '^[A-Z][A-Z0-9._-]{2,100}$'),
  CONSTRAINT "project_asset_references_revision_check" CHECK ("release_revision" > 0),
  CONSTRAINT "project_asset_references_checksum_check" CHECK ("snapshot_checksum" ~ '^[0-9a-f]{64}$' AND "source_watermark" <> ''),
  CONSTRAINT "project_asset_references_version_check" CHECK ("version" > 0),
  CONSTRAINT "project_asset_references_status_dates_check" CHECK (("status" = 'ACTIVE' AND "retired_at" IS NULL AND "retired_by_id" IS NULL AND "retire_reason" IS NULL) OR ("status" = 'RETIRED' AND "retired_at" IS NOT NULL AND "retired_by_id" IS NOT NULL AND length(btrim("retire_reason")) > 0))
);

CREATE TABLE "project_asset_usages" (
  "id" TEXT NOT NULL,
  "usage_key" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "reference_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "asset_release_id" TEXT NOT NULL,
  "asset_release_version_id" TEXT NOT NULL,
  "component_snapshot_id" TEXT NOT NULL,
  "release_revision" INTEGER NOT NULL,
  "snapshot_checksum" TEXT NOT NULL,
  "source_watermark" TEXT NOT NULL,
  "quantity" DECIMAL(20,6) NOT NULL,
  "configuration_json" JSONB NOT NULL,
  "scope_type" "ProjectAssetUsageScopeType" NOT NULL,
  "scope_id" TEXT NOT NULL,
  "delivery_unit_id" TEXT,
  "module_id" TEXT,
  "status" "ProjectAssetUsageStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "retired_by_id" TEXT,
  "retired_at" TIMESTAMP(3),
  "retire_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_asset_usages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_asset_usages_quantity_check" CHECK ("quantity" > 0),
  CONSTRAINT "project_asset_usages_configuration_check" CHECK (jsonb_typeof("configuration_json") = 'object'),
  CONSTRAINT "project_asset_usages_revision_check" CHECK ("release_revision" > 0),
  CONSTRAINT "project_asset_usages_checksum_check" CHECK ("snapshot_checksum" ~ '^[0-9a-f]{64}$' AND "source_watermark" <> ''),
  CONSTRAINT "project_asset_usages_version_check" CHECK ("version" > 0),
  CONSTRAINT "project_asset_usages_scope_check" CHECK (
    ("scope_type" = 'PROJECT' AND "scope_id" = "project_id" AND "delivery_unit_id" IS NULL AND "module_id" IS NULL)
    OR ("scope_type" = 'DELIVERY_UNIT' AND "delivery_unit_id" IS NOT NULL AND "module_id" IS NULL AND "scope_id" = "delivery_unit_id")
    OR ("scope_type" = 'MODULE' AND "delivery_unit_id" IS NOT NULL AND "module_id" IS NOT NULL AND "scope_id" = "module_id")
  ),
  CONSTRAINT "project_asset_usages_status_dates_check" CHECK (("status" = 'ACTIVE' AND "retired_at" IS NULL AND "retired_by_id" IS NULL AND "retire_reason" IS NULL) OR ("status" = 'RETIRED' AND "retired_at" IS NOT NULL AND "retired_by_id" IS NOT NULL AND length(btrim("retire_reason")) > 0))
);

CREATE TABLE "project_asset_derivations" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_reference_id" TEXT NOT NULL,
  "source_usage_id" TEXT NOT NULL,
  "source_technical_asset_id" TEXT NOT NULL,
  "source_asset_release_id" TEXT NOT NULL,
  "source_asset_release_version_id" TEXT NOT NULL,
  "source_component_snapshot_id" TEXT NOT NULL,
  "source_release_revision" INTEGER NOT NULL,
  "source_snapshot_checksum" TEXT NOT NULL,
  "source_watermark" TEXT NOT NULL,
  "target_controlled_document_version_id" TEXT NOT NULL,
  "target_mechanical_drawing_id" TEXT,
  "target_file_id" TEXT NOT NULL,
  "target_source_file_sha256" TEXT NOT NULL,
  "target_type" "ProjectAssetDerivationTargetType" NOT NULL,
  "target_document_version" INTEGER NOT NULL,
  "target_document_version_status" "ControlledDocumentVersionStatus" NOT NULL,
  "target_file_status" "FileObjectStatus" NOT NULL,
  "target_binding_key" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_asset_derivations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_asset_derivations_revision_check" CHECK ("source_release_revision" > 0),
  CONSTRAINT "project_asset_derivations_checksum_check" CHECK ("source_snapshot_checksum" ~ '^[0-9a-f]{64}$' AND "target_source_file_sha256" ~ '^[0-9a-f]{64}$' AND "source_watermark" <> ''),
  CONSTRAINT "project_asset_derivations_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "project_asset_derivations_target_status_check" CHECK ("target_document_version" > 0 AND "target_document_version_status" <> 'VOIDED' AND "target_file_status" = 'AVAILABLE'),
  CONSTRAINT "project_asset_derivations_target_type_check" CHECK (("target_type" = 'CONTROLLED_DOCUMENT_VERSION' AND "target_mechanical_drawing_id" IS NULL) OR ("target_type" = 'MECHANICAL_DRAWING_VERSION' AND "target_mechanical_drawing_id" IS NOT NULL))
);

CREATE UNIQUE INDEX "project_asset_references_id_project_id_key" ON "project_asset_references"("id", "project_id");
CREATE UNIQUE INDEX "project_asset_references_exact_fact_key" ON "project_asset_references"("id", "project_id", "technical_asset_id", "asset_release_id", "asset_release_version_id");
CREATE UNIQUE INDEX "project_asset_references_project_id_asset_release_version_id_key" ON "project_asset_references"("project_id", "asset_release_version_id");
CREATE INDEX "project_asset_references_project_id_status_created_at_idx" ON "project_asset_references"("project_id", "status", "created_at");
CREATE INDEX "project_asset_references_technical_asset_id_asset_release_version_id_idx" ON "project_asset_references"("technical_asset_id", "asset_release_version_id");
CREATE UNIQUE INDEX "project_asset_usages_project_id_usage_key_key" ON "project_asset_usages"("project_id", "usage_key");
CREATE UNIQUE INDEX "project_asset_usages_id_project_id_key" ON "project_asset_usages"("id", "project_id");
CREATE UNIQUE INDEX "project_asset_usages_active_scope_key" ON "project_asset_usages"("project_id", "asset_release_version_id", "component_snapshot_id", "scope_type", "scope_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "project_asset_usages_project_id_status_scope_idx" ON "project_asset_usages"("project_id", "status", "scope_type", "scope_id");
CREATE INDEX "project_asset_usages_reference_id_status_idx" ON "project_asset_usages"("reference_id", "status");
CREATE INDEX "project_asset_derivations_project_id_source_usage_id_created_at_idx" ON "project_asset_derivations"("project_id", "source_usage_id", "created_at");
CREATE INDEX "project_asset_derivations_project_id_target_document_idx" ON "project_asset_derivations"("project_id", "target_controlled_document_version_id");
CREATE UNIQUE INDEX "project_asset_derivations_project_id_target_binding_key_key" ON "project_asset_derivations"("project_id", "target_binding_key");

ALTER TABLE "project_asset_references"
  ADD CONSTRAINT "project_asset_references_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_references_technical_asset_fkey" FOREIGN KEY ("technical_asset_id") REFERENCES "technical_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_references_release_fkey" FOREIGN KEY ("asset_release_id", "technical_asset_id") REFERENCES "asset_releases"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_references_release_version_fkey" FOREIGN KEY ("asset_release_version_id", "asset_release_id", "technical_asset_id") REFERENCES "asset_release_versions"("id", "release_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_references_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_references_retired_by_fkey" FOREIGN KEY ("retired_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_asset_usages"
  ADD CONSTRAINT "project_asset_usages_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_usages_reference_exact_fact_fkey" FOREIGN KEY ("reference_id", "project_id", "technical_asset_id", "asset_release_id", "asset_release_version_id") REFERENCES "project_asset_references"("id", "project_id", "technical_asset_id", "asset_release_id", "asset_release_version_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_usages_technical_asset_fkey" FOREIGN KEY ("technical_asset_id") REFERENCES "technical_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_usages_release_fkey" FOREIGN KEY ("asset_release_id", "technical_asset_id") REFERENCES "asset_releases"("id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_usages_release_version_fkey" FOREIGN KEY ("asset_release_version_id", "asset_release_id", "technical_asset_id") REFERENCES "asset_release_versions"("id", "release_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_usages_component_snapshot_fkey" FOREIGN KEY ("component_snapshot_id", "asset_release_version_id", "technical_asset_id") REFERENCES "asset_component_snapshots"("id", "release_version_id", "technical_asset_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_usages_delivery_unit_fkey" FOREIGN KEY ("delivery_unit_id", "project_id") REFERENCES "delivery_units"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_usages_module_fkey" FOREIGN KEY ("module_id", "project_id", "delivery_unit_id") REFERENCES "project_modules"("id", "project_id", "delivery_unit_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_usages_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_usages_retired_by_fkey" FOREIGN KEY ("retired_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_asset_derivations"
  ADD CONSTRAINT "project_asset_derivations_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_derivations_source_reference_fkey" FOREIGN KEY ("source_reference_id", "project_id") REFERENCES "project_asset_references"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_derivations_source_usage_fkey" FOREIGN KEY ("source_usage_id", "project_id") REFERENCES "project_asset_usages"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_derivations_target_document_version_fkey" FOREIGN KEY ("target_controlled_document_version_id", "project_id") REFERENCES "controlled_document_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_derivations_target_drawing_fkey" FOREIGN KEY ("target_mechanical_drawing_id", "project_id") REFERENCES "mechanical_drawings"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_derivations_target_file_fkey" FOREIGN KEY ("target_file_id", "project_id") REFERENCES "file_objects"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_asset_derivations_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_project_asset_derivation_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'project asset derivations are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_project_asset_derivation_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'project asset derivations cannot be truncated' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_project_asset_reference_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'RETIRED' OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.technical_asset_id IS DISTINCT FROM OLD.technical_asset_id
    OR NEW.asset_release_id IS DISTINCT FROM OLD.asset_release_id
    OR NEW.asset_release_version_id IS DISTINCT FROM OLD.asset_release_version_id
    OR NEW.release_code IS DISTINCT FROM OLD.release_code
    OR NEW.release_revision IS DISTINCT FROM OLD.release_revision
    OR NEW.snapshot_checksum IS DISTINCT FROM OLD.snapshot_checksum
    OR NEW.source_watermark IS DISTINCT FROM OLD.source_watermark
    OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    RAISE EXCEPTION 'project asset reference historical fields are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED' AND NEW.version = OLD.version + 1
    AND NEW.retired_by_id IS NOT NULL AND NEW.retire_reason IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM project_asset_usages WHERE project_id = OLD.project_id AND reference_id = OLD.id AND status = 'ACTIVE') THEN
      RAISE EXCEPTION 'project asset reference has active usage' USING ERRCODE = '23514';
    END IF;
    NEW.retired_at := CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'project asset reference only supports ACTIVE to RETIRED' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_project_asset_usage_reference_state() RETURNS trigger AS $$
DECLARE reference_status "ProjectAssetReferenceStatus";
BEGIN
  -- Serialize usage INSERT with reference retirement on the same project/reference row.
  SELECT status INTO reference_status
    FROM project_asset_references
   WHERE id = NEW.reference_id AND project_id = NEW.project_id
   FOR UPDATE;
  IF reference_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'project asset usage must reference an ACTIVE reference' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_project_asset_usage_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'RETIRED' OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.usage_key IS DISTINCT FROM OLD.usage_key
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.reference_id IS DISTINCT FROM OLD.reference_id
    OR NEW.technical_asset_id IS DISTINCT FROM OLD.technical_asset_id
    OR NEW.asset_release_id IS DISTINCT FROM OLD.asset_release_id
    OR NEW.asset_release_version_id IS DISTINCT FROM OLD.asset_release_version_id
    OR NEW.component_snapshot_id IS DISTINCT FROM OLD.component_snapshot_id
    OR NEW.release_revision IS DISTINCT FROM OLD.release_revision
    OR NEW.snapshot_checksum IS DISTINCT FROM OLD.snapshot_checksum
    OR NEW.source_watermark IS DISTINCT FROM OLD.source_watermark
    OR NEW.quantity IS DISTINCT FROM OLD.quantity
    OR NEW.configuration_json IS DISTINCT FROM OLD.configuration_json
    OR NEW.scope_type IS DISTINCT FROM OLD.scope_type
    OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
    OR NEW.delivery_unit_id IS DISTINCT FROM OLD.delivery_unit_id
    OR NEW.module_id IS DISTINCT FROM OLD.module_id
    OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    RAISE EXCEPTION 'project asset usage historical fields are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED' AND NEW.version = OLD.version + 1
    AND NEW.retired_by_id IS NOT NULL AND NEW.retire_reason IS NOT NULL THEN
    NEW.retired_at := CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'project asset usage only supports ACTIVE to RETIRED' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_project_asset_derivation_source() RETURNS trigger AS $$
DECLARE usage_row RECORD; drawing_document_id TEXT; version_document_id TEXT; version_number INTEGER; version_status "ControlledDocumentVersionStatus"; document_status "ControlledDocumentStatus"; file_sha TEXT; file_status "FileObjectStatus"; file_match BOOLEAN; expected_binding_key TEXT;
BEGIN
  SELECT u.project_id, u.reference_id, u.technical_asset_id, u.asset_release_id, u.asset_release_version_id, u.component_snapshot_id,
         u.release_revision, u.snapshot_checksum, u.source_watermark
    INTO usage_row FROM project_asset_usages u
   WHERE u.id = NEW.source_usage_id AND u.project_id = NEW.project_id AND u.status = 'ACTIVE';
  IF NOT FOUND OR NEW.source_reference_id IS DISTINCT FROM usage_row.reference_id
    OR NEW.source_technical_asset_id IS DISTINCT FROM usage_row.technical_asset_id
    OR NEW.source_asset_release_id IS DISTINCT FROM usage_row.asset_release_id
    OR NEW.source_asset_release_version_id IS DISTINCT FROM usage_row.asset_release_version_id
    OR NEW.source_component_snapshot_id IS DISTINCT FROM usage_row.component_snapshot_id
    OR NEW.source_release_revision IS DISTINCT FROM usage_row.release_revision
    OR NEW.source_snapshot_checksum IS DISTINCT FROM usage_row.snapshot_checksum
    OR NEW.source_watermark IS DISTINCT FROM usage_row.source_watermark THEN
    RAISE EXCEPTION 'project asset derivation source must match active exact usage' USING ERRCODE = '23514';
  END IF;
  SELECT v.document_id, v.version, v.status, d.status INTO version_document_id, version_number, version_status, document_status
    FROM controlled_document_versions v JOIN controlled_documents d ON d.id = v.document_id AND d.project_id = v.project_id
   WHERE v.id = NEW.target_controlled_document_version_id AND v.project_id = NEW.project_id;
  SELECT sha256, status INTO file_sha, file_status FROM file_objects WHERE id = NEW.target_file_id AND project_id = NEW.project_id;
  IF version_document_id IS NULL OR version_status = 'VOIDED' OR document_status <> 'ACTIVE'
    OR file_status <> 'AVAILABLE' OR file_sha IS DISTINCT FROM NEW.target_source_file_sha256
    OR NEW.target_document_version IS DISTINCT FROM version_number
    OR NEW.target_document_version_status IS DISTINCT FROM version_status
    OR NEW.target_file_status IS DISTINCT FROM file_status THEN
    RAISE EXCEPTION 'project asset derivation target document/file is not an exact available fact' USING ERRCODE = '23514';
  END IF;
  expected_binding_key := NEW.target_type::text || ':' || NEW.target_controlled_document_version_id || ':' || coalesce(NEW.target_mechanical_drawing_id, '-') || ':' || NEW.target_file_id;
  IF NEW.target_binding_key IS DISTINCT FROM expected_binding_key THEN
    RAISE EXCEPTION 'project asset derivation target binding key is not canonical' USING ERRCODE = '23514';
  END IF;
  IF NEW.target_mechanical_drawing_id IS NOT NULL THEN
    SELECT document_id INTO drawing_document_id FROM mechanical_drawings
     WHERE id = NEW.target_mechanical_drawing_id AND project_id = NEW.project_id;
    IF drawing_document_id IS DISTINCT FROM version_document_id THEN
      RAISE EXCEPTION 'project asset derivation drawing must match target document version' USING ERRCODE = '23514';
    END IF;
    SELECT EXISTS(SELECT 1 FROM mechanical_drawing_version_files
      WHERE project_id = NEW.project_id AND drawing_id = NEW.target_mechanical_drawing_id
        AND document_version_id = NEW.target_controlled_document_version_id AND file_id = NEW.target_file_id
        AND file_sha256 = NEW.target_source_file_sha256) INTO file_match;
    IF NOT file_match THEN
      RAISE EXCEPTION 'project asset derivation target drawing file must match exact document version' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_project_asset_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'project asset facts cannot be truncated' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_asset_reference_validate_mutation BEFORE UPDATE OR DELETE ON project_asset_references FOR EACH ROW EXECUTE FUNCTION validate_project_asset_reference_mutation();
CREATE TRIGGER project_asset_usage_validate_mutation BEFORE UPDATE OR DELETE ON project_asset_usages FOR EACH ROW EXECUTE FUNCTION validate_project_asset_usage_mutation();
CREATE TRIGGER project_asset_usage_reference_state BEFORE INSERT ON project_asset_usages FOR EACH ROW EXECUTE FUNCTION validate_project_asset_usage_reference_state();
CREATE TRIGGER project_asset_derivation_validate_source BEFORE INSERT ON project_asset_derivations FOR EACH ROW EXECUTE FUNCTION validate_project_asset_derivation_source();
CREATE TRIGGER project_asset_derivation_reject_mutation BEFORE UPDATE OR DELETE ON project_asset_derivations FOR EACH ROW EXECUTE FUNCTION reject_project_asset_derivation_mutation();
CREATE TRIGGER project_asset_references_reject_truncate BEFORE TRUNCATE ON project_asset_references FOR EACH STATEMENT EXECUTE FUNCTION reject_project_asset_truncate();
CREATE TRIGGER project_asset_usages_reject_truncate BEFORE TRUNCATE ON project_asset_usages FOR EACH STATEMENT EXECUTE FUNCTION reject_project_asset_truncate();
CREATE TRIGGER project_asset_derivations_reject_truncate BEFORE TRUNCATE ON project_asset_derivations FOR EACH STATEMENT EXECUTE FUNCTION reject_project_asset_derivation_truncate();
