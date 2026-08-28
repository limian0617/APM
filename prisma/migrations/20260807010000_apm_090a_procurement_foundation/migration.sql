-- CreateEnum
CREATE TYPE "ProcurementMode" AS ENUM ('LOCAL', 'ERP');

-- CreateEnum
CREATE TYPE "ProcurementSource" AS ENUM ('LOCAL', 'ERP');

-- CreateEnum
CREATE TYPE "ProcurementBusinessType" AS ENUM ('STANDARD_PURCHASE', 'DRAWING_CUSTOM', 'OUTSOURCED_PROCESS');

-- CreateEnum
CREATE TYPE "MaterialReferenceStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "MaterialRequirementSource" AS ENUM ('ERP_BOM_MRP', 'DRAWING_PUBLISHED', 'EXCEL', 'MANUAL', 'CHANGE', 'ISSUE', 'SPARE_PART');

-- CreateEnum
CREATE TYPE "ProjectMaterialRequirementStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ProjectMaterialRequirementRevisionStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'SUPERSEDED', 'CANCELED');

-- AlterEnum
ALTER TYPE "CapabilityCode" ADD VALUE 'PROCUREMENT_COLLABORATION';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'PROCUREMENT_SETTINGS_CONFIGURED';
ALTER TYPE "AuditAction" ADD VALUE 'MATERIAL_REFERENCE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SUPPLIER_REFERENCE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'MATERIAL_REQUIREMENT_DRAFTED';
ALTER TYPE "AuditAction" ADD VALUE 'MATERIAL_REQUIREMENT_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE 'MATERIAL_REQUIREMENT_REVISED';
ALTER TYPE "AuditAction" ADD VALUE 'MATERIAL_REQUIREMENT_CANCELED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_PROCUREMENT_SETTINGS';
ALTER TYPE "AuditObjectType" ADD VALUE 'MATERIAL_REFERENCE';
ALTER TYPE "AuditObjectType" ADD VALUE 'SUPPLIER_REFERENCE';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_MATERIAL_REQUIREMENT';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_MATERIAL_REQUIREMENT_REVISION';

-- CreateTable
CREATE TABLE "project_procurement_settings" (
    "project_id" TEXT NOT NULL,
    "mode" "ProcurementMode" NOT NULL,
    "source_system" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "configured_by_id" TEXT NOT NULL,
    "configured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_id" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_procurement_settings_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "material_references" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source" "ProcurementSource" NOT NULL,
    "external_id" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "specification" TEXT,
    "drawing_number" TEXT,
    "status" "MaterialReferenceStatus" NOT NULL DEFAULT 'ACTIVE',
    "category_code" TEXT,
    "category_path" TEXT,
    "material_type" TEXT,
    "brand" TEXT,
    "material" TEXT,
    "tracking_unit" TEXT NOT NULL,
    "erp_unit" TEXT,
    "conversion_snapshot_json" JSONB,
    "default_procurement_days" INTEGER,
    "is_long_lead" BOOLEAN NOT NULL DEFAULT false,
    "source_version" TEXT,
    "source_hash" TEXT,
    "synced_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_references" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "source" "ProcurementSource" NOT NULL,
    "external_id" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "MaterialReferenceStatus" NOT NULL DEFAULT 'ACTIVE',
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "procurement_owner_name" TEXT,
    "capability_tags_json" JSONB NOT NULL DEFAULT '[]',
    "source_version" TEXT,
    "source_hash" TEXT,
    "synced_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_material_requirements" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "current_revision_id" TEXT,
    "status" "ProjectMaterialRequirementStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_material_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_material_requirement_revisions" (
    "id" TEXT NOT NULL,
    "requirement_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "delivery_unit_id" TEXT,
    "module_id" TEXT,
    "responsibility_package_id" TEXT,
    "task_id" TEXT,
    "material_reference_id" TEXT NOT NULL,
    "material_code_snapshot" TEXT NOT NULL,
    "material_name_snapshot" TEXT NOT NULL,
    "material_specification_snapshot" TEXT,
    "quantity" DECIMAL(18,6) NOT NULL,
    "tracking_unit" TEXT NOT NULL,
    "required_on" DATE NOT NULL,
    "predicted_assembly_start_on" DATE,
    "is_critical" BOOLEAN NOT NULL DEFAULT false,
    "is_long_lead" BOOLEAN NOT NULL DEFAULT false,
    "business_type" "ProcurementBusinessType" NOT NULL,
    "source" "MaterialRequirementSource" NOT NULL,
    "source_reference" TEXT,
    "source_version" TEXT,
    "drawing_id" TEXT,
    "drawing_version_id" TEXT,
    "outsourced_process" TEXT,
    "status" "ProjectMaterialRequirementRevisionStatus" NOT NULL DEFAULT 'DRAFT',
    "confirmed_by_id" TEXT,
    "confirmed_at" TIMESTAMP(3),
    "supersedes_revision_id" TEXT,
    "reason" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_material_requirement_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_procurement_settings_mode_configured_at_idx" ON "project_procurement_settings"("mode", "configured_at");

-- CreateIndex
CREATE INDEX "material_references_project_id_status_code_idx" ON "material_references"("project_id", "status", "code");

-- CreateIndex
CREATE UNIQUE INDEX "material_references_id_project_id_key" ON "material_references"("id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_references_project_id_code_key" ON "material_references"("project_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "material_references_source_external_id_key" ON "material_references"("source", "external_id");

-- CreateIndex
CREATE INDEX "supplier_references_project_id_status_code_idx" ON "supplier_references"("project_id", "status", "code");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_references_id_project_id_key" ON "supplier_references"("id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_references_project_id_code_key" ON "supplier_references"("project_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_references_source_external_id_key" ON "supplier_references"("source", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_material_requirements_current_revision_id_key" ON "project_material_requirements"("current_revision_id");

-- CreateIndex
CREATE INDEX "project_material_requirements_project_id_status_created_at_idx" ON "project_material_requirements"("project_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "project_material_requirements_id_project_id_key" ON "project_material_requirements"("id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_material_requirement_revisions_supersedes_revision__key" ON "project_material_requirement_revisions"("supersedes_revision_id");

-- CreateIndex
CREATE INDEX "project_material_requirement_revisions_project_id_status_re_idx" ON "project_material_requirement_revisions"("project_id", "status", "required_on");

-- CreateIndex
CREATE INDEX "project_material_requirement_revisions_material_reference_i_idx" ON "project_material_requirement_revisions"("material_reference_id", "project_id");

-- CreateIndex
CREATE INDEX "project_material_requirement_revisions_delivery_unit_id_pro_idx" ON "project_material_requirement_revisions"("delivery_unit_id", "project_id");

-- CreateIndex
CREATE INDEX "project_material_requirement_revisions_module_id_project_id_idx" ON "project_material_requirement_revisions"("module_id", "project_id");

-- CreateIndex
CREATE INDEX "project_material_requirement_revisions_responsibility_packa_idx" ON "project_material_requirement_revisions"("responsibility_package_id", "project_id");

-- CreateIndex
CREATE INDEX "project_material_requirement_revisions_task_id_project_id_idx" ON "project_material_requirement_revisions"("task_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_material_requirement_revisions_requirement_id_revis_key" ON "project_material_requirement_revisions"("requirement_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "project_material_requirement_revisions_id_project_id_key" ON "project_material_requirement_revisions"("id", "project_id");

-- AddForeignKey
ALTER TABLE "project_procurement_settings" ADD CONSTRAINT "project_procurement_settings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_procurement_settings" ADD CONSTRAINT "project_procurement_settings_configured_by_id_fkey" FOREIGN KEY ("configured_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_procurement_settings" ADD CONSTRAINT "project_procurement_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_references" ADD CONSTRAINT "material_references_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_references" ADD CONSTRAINT "material_references_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_references" ADD CONSTRAINT "material_references_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_references" ADD CONSTRAINT "supplier_references_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_references" ADD CONSTRAINT "supplier_references_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_references" ADD CONSTRAINT "supplier_references_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirements" ADD CONSTRAINT "project_material_requirements_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirements" ADD CONSTRAINT "project_material_requirements_current_revision_id_fkey" FOREIGN KEY ("current_revision_id") REFERENCES "project_material_requirement_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirements" ADD CONSTRAINT "project_material_requirements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirements" ADD CONSTRAINT "project_material_requirements_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirement_revisions" ADD CONSTRAINT "project_material_requirement_revisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirement_revisions" ADD CONSTRAINT "project_material_requirement_revisions_requirement_id_proj_fkey" FOREIGN KEY ("requirement_id", "project_id") REFERENCES "project_material_requirements"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirement_revisions" ADD CONSTRAINT "project_material_requirement_revisions_delivery_unit_id_pr_fkey" FOREIGN KEY ("delivery_unit_id", "project_id") REFERENCES "delivery_units"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirement_revisions" ADD CONSTRAINT "project_material_requirement_revisions_module_id_project_i_fkey" FOREIGN KEY ("module_id", "project_id") REFERENCES "project_modules"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirement_revisions" ADD CONSTRAINT "project_material_requirement_revisions_responsibility_pack_fkey" FOREIGN KEY ("responsibility_package_id", "project_id") REFERENCES "responsibility_packages"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirement_revisions" ADD CONSTRAINT "project_material_requirement_revisions_task_id_project_id_fkey" FOREIGN KEY ("task_id", "project_id") REFERENCES "planning_tasks"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirement_revisions" ADD CONSTRAINT "project_material_requirement_revisions_material_reference__fkey" FOREIGN KEY ("material_reference_id", "project_id") REFERENCES "material_references"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirement_revisions" ADD CONSTRAINT "project_material_requirement_revisions_drawing_id_project__fkey" FOREIGN KEY ("drawing_id", "project_id") REFERENCES "mechanical_drawings"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirement_revisions" ADD CONSTRAINT "project_material_requirement_revisions_drawing_version_id__fkey" FOREIGN KEY ("drawing_version_id", "project_id") REFERENCES "controlled_document_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirement_revisions" ADD CONSTRAINT "project_material_requirement_revisions_confirmed_by_id_fkey" FOREIGN KEY ("confirmed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirement_revisions" ADD CONSTRAINT "project_material_requirement_revisions_supersedes_revision_fkey" FOREIGN KEY ("supersedes_revision_id") REFERENCES "project_material_requirement_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_material_requirement_revisions" ADD CONSTRAINT "project_material_requirement_revisions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_procurement_settings"
  ADD CONSTRAINT "project_procurement_settings_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "project_procurement_settings_source_check" CHECK (
    ("mode" = 'LOCAL' AND "source_system" IS NULL)
    OR ("mode" = 'ERP' AND length(btrim("source_system")) BETWEEN 1 AND 191)
  );

ALTER TABLE "material_references"
  ADD CONSTRAINT "material_references_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  ADD CONSTRAINT "material_references_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "material_references_tracking_unit_check" CHECK ("tracking_unit" ~ '^[A-Z][A-Z0-9._-]{0,31}$'),
  ADD CONSTRAINT "material_references_default_procurement_days_check" CHECK (
    "default_procurement_days" IS NULL OR "default_procurement_days" >= 0
  ),
  ADD CONSTRAINT "material_references_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "material_references_source_check" CHECK (
    ("source" = 'LOCAL' AND "external_id" IS NULL AND "source_version" IS NULL AND "source_hash" IS NULL AND "synced_at" IS NULL)
    OR ("source" = 'ERP' AND length(btrim("external_id")) BETWEEN 1 AND 191)
  );

ALTER TABLE "supplier_references"
  ADD CONSTRAINT "supplier_references_code_check" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  ADD CONSTRAINT "supplier_references_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "supplier_references_capability_tags_check" CHECK (jsonb_typeof("capability_tags_json") = 'array'),
  ADD CONSTRAINT "supplier_references_version_check" CHECK ("version" > 0),
  ADD CONSTRAINT "supplier_references_source_check" CHECK (
    ("source" = 'LOCAL' AND "external_id" IS NULL AND "source_version" IS NULL AND "source_hash" IS NULL AND "synced_at" IS NULL)
    OR ("source" = 'ERP' AND length(btrim("external_id")) BETWEEN 1 AND 191)
  );

ALTER TABLE "project_material_requirements"
  ADD CONSTRAINT "project_material_requirements_version_check" CHECK ("version" > 0);

DROP INDEX "project_material_requirement_revisions_requirement_id_revis_key";

ALTER TABLE "project_material_requirement_revisions"
  ADD CONSTRAINT "project_material_requirement_revisions_quantity_check" CHECK ("quantity" > 0),
  ADD CONSTRAINT "project_material_requirement_revisions_revision_check" CHECK ("revision" > 0),
  ADD CONSTRAINT "project_material_requirement_revisions_tracking_unit_check" CHECK ("tracking_unit" ~ '^[A-Z][A-Z0-9._-]{0,31}$'),
  ADD CONSTRAINT "project_material_requirement_revisions_material_snapshot_check" CHECK (
    length(btrim("material_code_snapshot")) BETWEEN 1 AND 64
    AND length(btrim("material_name_snapshot")) BETWEEN 1 AND 200
  ),
  ADD CONSTRAINT "project_material_requirement_revisions_type_check" CHECK (
    ("business_type" = 'DRAWING_CUSTOM' AND "drawing_id" IS NOT NULL AND "drawing_version_id" IS NOT NULL AND "outsourced_process" IS NULL)
    OR ("business_type" = 'OUTSOURCED_PROCESS' AND "drawing_id" IS NULL AND "drawing_version_id" IS NULL AND length(btrim("outsourced_process")) > 0)
    OR ("business_type" = 'STANDARD_PURCHASE' AND "drawing_id" IS NULL AND "drawing_version_id" IS NULL AND "outsourced_process" IS NULL)
  ),
  ADD CONSTRAINT "project_material_requirement_revisions_confirmation_check" CHECK (
    ("status" = 'CONFIRMED' AND "confirmed_by_id" IS NOT NULL AND "confirmed_at" IS NOT NULL)
    OR ("status" <> 'CONFIRMED')
  ),
  ADD CONSTRAINT "project_material_requirement_revisions_reason_check" CHECK (
    "reason" IS NULL OR length(btrim("reason")) BETWEEN 1 AND 1024
  ),
  ADD CONSTRAINT "project_material_requirement_revisions_requirement_id_revision_key" UNIQUE ("requirement_id", "revision");

CREATE FUNCTION enforce_project_material_requirement_current_revision() RETURNS trigger AS $$
DECLARE
  revision_status "ProjectMaterialRequirementRevisionStatus";
BEGIN
  IF NEW."current_revision_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "status" INTO revision_status
    FROM "project_material_requirement_revisions"
    WHERE "id" = NEW."current_revision_id"
      AND "requirement_id" = NEW."id"
      AND "project_id" = NEW."project_id";

  IF revision_status IS NULL THEN
    RAISE EXCEPTION 'current material requirement revision must belong to the same requirement and project' USING ERRCODE = '23514';
  END IF;
  IF (NEW."status" = 'DRAFT' AND revision_status IS DISTINCT FROM 'DRAFT')
    OR (NEW."status" = 'CONFIRMED' AND revision_status IS DISTINCT FROM 'CONFIRMED')
    OR (NEW."status" = 'CANCELED' AND revision_status IS DISTINCT FROM 'CANCELED') THEN
    RAISE EXCEPTION 'material requirement status must match its current revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_project_material_requirement_revision() RETURNS trigger AS $$
DECLARE
  drawing_document_id TEXT;
  drawing_project_id TEXT;
  drawing_version_status "ControlledDocumentVersionStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'material requirement revisions are append-only and cannot be removed' USING ERRCODE = '55000';
  END IF;

  IF NEW."business_type" = 'DRAWING_CUSTOM' THEN
    SELECT drawing."document_id", drawing."project_id", version."status"
      INTO drawing_document_id, drawing_project_id, drawing_version_status
      FROM "mechanical_drawings" drawing
      JOIN "controlled_document_versions" version
        ON version."id" = NEW."drawing_version_id"
        AND version."project_id" = NEW."project_id"
        AND version."document_id" = drawing."document_id"
      WHERE drawing."id" = NEW."drawing_id"
        AND drawing."project_id" = NEW."project_id";
    IF drawing_project_id IS DISTINCT FROM NEW."project_id" THEN
      RAISE EXCEPTION 'drawing requirement must reference a drawing in the same project' USING ERRCODE = '23514';
    END IF;
    IF drawing_version_status IS DISTINCT FROM 'PUBLISHED' THEN
      RAISE EXCEPTION 'drawing requirement must reference an exact published drawing version' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."requirement_id" IS DISTINCT FROM NEW."requirement_id"
      OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
      OR OLD."revision" IS DISTINCT FROM NEW."revision"
      OR OLD."delivery_unit_id" IS DISTINCT FROM NEW."delivery_unit_id"
      OR OLD."module_id" IS DISTINCT FROM NEW."module_id"
      OR OLD."responsibility_package_id" IS DISTINCT FROM NEW."responsibility_package_id"
      OR OLD."task_id" IS DISTINCT FROM NEW."task_id"
      OR OLD."material_reference_id" IS DISTINCT FROM NEW."material_reference_id"
      OR OLD."material_code_snapshot" IS DISTINCT FROM NEW."material_code_snapshot"
      OR OLD."material_name_snapshot" IS DISTINCT FROM NEW."material_name_snapshot"
      OR OLD."material_specification_snapshot" IS DISTINCT FROM NEW."material_specification_snapshot"
      OR OLD."quantity" IS DISTINCT FROM NEW."quantity"
      OR OLD."tracking_unit" IS DISTINCT FROM NEW."tracking_unit"
      OR OLD."required_on" IS DISTINCT FROM NEW."required_on"
      OR OLD."predicted_assembly_start_on" IS DISTINCT FROM NEW."predicted_assembly_start_on"
      OR OLD."is_critical" IS DISTINCT FROM NEW."is_critical"
      OR OLD."is_long_lead" IS DISTINCT FROM NEW."is_long_lead"
      OR OLD."business_type" IS DISTINCT FROM NEW."business_type"
      OR OLD."source" IS DISTINCT FROM NEW."source"
      OR OLD."source_reference" IS DISTINCT FROM NEW."source_reference"
      OR OLD."source_version" IS DISTINCT FROM NEW."source_version"
      OR OLD."drawing_id" IS DISTINCT FROM NEW."drawing_id"
      OR OLD."drawing_version_id" IS DISTINCT FROM NEW."drawing_version_id"
      OR OLD."outsourced_process" IS DISTINCT FROM NEW."outsourced_process"
      OR OLD."supersedes_revision_id" IS DISTINCT FROM NEW."supersedes_revision_id"
      OR OLD."reason" IS DISTINCT FROM NEW."reason"
      OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
      OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
      RAISE EXCEPTION 'material requirement revision business content is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" IN ('SUPERSEDED', 'CANCELED') THEN
      RAISE EXCEPTION 'superseded or canceled material requirement revisions are immutable' USING ERRCODE = '55000';
    END IF;
    IF NOT (
      (OLD."status" = 'DRAFT' AND NEW."status" IN ('DRAFT', 'CONFIRMED', 'CANCELED'))
      OR (OLD."status" = 'CONFIRMED' AND NEW."status" IN ('CONFIRMED', 'SUPERSEDED', 'CANCELED'))
    ) THEN
      RAISE EXCEPTION 'invalid material requirement revision status transition' USING ERRCODE = '23514';
    END IF;
    IF OLD."status" <> 'CONFIRMED' AND NEW."status" = 'CONFIRMED'
      AND (NEW."confirmed_by_id" IS NULL OR NEW."confirmed_at" IS NULL) THEN
      RAISE EXCEPTION 'confirmed material requirement revisions require confirmation facts' USING ERRCODE = '23514';
    END IF;
    IF OLD."confirmed_by_id" IS DISTINCT FROM NEW."confirmed_by_id"
      OR OLD."confirmed_at" IS DISTINCT FROM NEW."confirmed_at" THEN
      IF NOT (OLD."status" = 'DRAFT' AND NEW."status" = 'CONFIRMED') THEN
        RAISE EXCEPTION 'confirmation facts can only be set when confirming a draft revision' USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_procurement_requirement_revision_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only and cannot be truncated', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_material_requirements_current_revision_check
  BEFORE INSERT OR UPDATE OF "project_id", "current_revision_id", "status"
  ON "project_material_requirements"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_material_requirement_current_revision();
CREATE TRIGGER project_material_requirement_revisions_immutable
  BEFORE UPDATE OR DELETE ON "project_material_requirement_revisions"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_material_requirement_revision();
CREATE TRIGGER project_material_requirement_revisions_reject_truncate
  BEFORE TRUNCATE ON "project_material_requirement_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_procurement_requirement_revision_truncate();

INSERT INTO "permissions" ("id", "code", "description") VALUES
  ('permission-project-procurement-read', 'PROJECT_PROCUREMENT_READ', '读取项目采购与物料协同数据'),
  ('permission-project-procurement-requirement-manage', 'PROJECT_PROCUREMENT_REQUIREMENT_MANAGE', '管理项目物料需求'),
  ('permission-project-procurement-tracking-manage', 'PROJECT_PROCUREMENT_TRACKING_MANAGE', '管理采购与委外跟踪'),
  ('permission-project-procurement-receipt-record', 'PROJECT_PROCUREMENT_RECEIPT_RECORD', '记录项目到货与委外履约事实'),
  ('permission-project-procurement-acceptance-record', 'PROJECT_PROCUREMENT_ACCEPTANCE_RECORD', '记录项目物料验收与可用事实'),
  ('permission-project-procurement-policy-manage', 'PROJECT_PROCUREMENT_POLICY_MANAGE', '配置项目采购运行模式和齐套政策'),
  ('permission-sensitive-procurement-read', 'SENSITIVE_PROCUREMENT_READ', '读取受限采购敏感字段');

INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
  ('role-project-manager', 'permission-project-procurement-read', 'PROJECT'),
  ('role-project-manager', 'permission-project-procurement-requirement-manage', 'PROJECT'),
  ('role-project-manager', 'permission-project-procurement-tracking-manage', 'PROJECT'),
  ('role-project-manager', 'permission-project-procurement-receipt-record', 'PROJECT'),
  ('role-project-manager', 'permission-project-procurement-policy-manage', 'PROJECT'),
  ('role-department-lead', 'permission-project-procurement-read', 'DEPARTMENT'),
  ('role-engineer', 'permission-project-procurement-read', 'PROJECT'),
  ('role-engineer', 'permission-project-procurement-receipt-record', 'PROJECT'),
  ('role-procurement', 'permission-project-procurement-read', 'PROJECT'),
  ('role-procurement', 'permission-project-procurement-requirement-manage', 'PROJECT'),
  ('role-procurement', 'permission-project-procurement-tracking-manage', 'PROJECT'),
  ('role-quality', 'permission-project-procurement-read', 'PROJECT'),
  ('role-quality', 'permission-project-procurement-acceptance-record', 'PROJECT'),
  ('role-executive', 'permission-project-procurement-read', 'ALL'),
  ('role-executive', 'permission-sensitive-procurement-read', 'ALL'),
  ('role-admin', 'permission-project-procurement-read', 'ALL'),
  ('role-admin', 'permission-project-procurement-requirement-manage', 'ALL'),
  ('role-admin', 'permission-project-procurement-tracking-manage', 'ALL'),
  ('role-admin', 'permission-project-procurement-receipt-record', 'ALL'),
  ('role-admin', 'permission-project-procurement-acceptance-record', 'ALL'),
  ('role-admin', 'permission-project-procurement-policy-manage', 'ALL'),
  ('role-admin', 'permission-sensitive-procurement-read', 'ALL');
