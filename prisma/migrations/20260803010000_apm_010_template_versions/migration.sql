-- APM-010 configuration templates use mutable masters/drafts and immutable
-- published component/template versions with exact relational references.
CREATE TYPE "TemplateComponentType" AS ENUM ('STAGE', 'GATE', 'ROLE', 'WBS', 'CAPABILITY_RULE');
CREATE TYPE "TemplateMasterStatus" AS ENUM ('DRAFT', 'ACTIVE', 'DISABLED');
CREATE TYPE "TemplateVersionStatus" AS ENUM ('PUBLISHED');

ALTER TYPE "AuditAction" ADD VALUE 'TEMPLATE_COMPONENT_DRAFT_SAVED';
ALTER TYPE "AuditAction" ADD VALUE 'TEMPLATE_COMPONENT_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE 'TEMPLATE_COMPONENT_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'TEMPLATE_DRAFT_SAVED';
ALTER TYPE "AuditAction" ADD VALUE 'TEMPLATE_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE 'TEMPLATE_STATUS_CHANGED';
ALTER TYPE "AuditObjectType" ADD VALUE 'TEMPLATE_COMPONENT';
ALTER TYPE "AuditObjectType" ADD VALUE 'TEMPLATE';
ALTER TYPE "AuditObjectType" ADD VALUE 'TEMPLATE_VERSION';

CREATE TABLE "template_components" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "component_type" "TemplateComponentType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "draft_content" JSONB NOT NULL,
    "status" "TemplateMasterStatus" NOT NULL DEFAULT 'DRAFT',
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "template_components_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "template_components_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_.-]{2,100}$'),
    CONSTRAINT "template_components_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
    CONSTRAINT "template_components_description_check" CHECK ("description" IS NULL OR length("description") <= 2000),
    CONSTRAINT "template_components_content_check" CHECK (jsonb_typeof("draft_content") = 'object'),
    CONSTRAINT "template_components_version_check" CHECK ("version" > 0 AND "current_version" >= 0),
    CONSTRAINT "template_components_status_check" CHECK (
      ("current_version" = 0 AND "status" = 'DRAFT')
      OR ("current_version" > 0 AND "status" IN ('ACTIVE', 'DISABLED'))
    )
);

CREATE TABLE "template_component_versions" (
    "id" TEXT NOT NULL,
    "component_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "TemplateVersionStatus" NOT NULL DEFAULT 'PUBLISHED',
    "component_type" "TemplateComponentType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "content_json" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "published_by_id" TEXT NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "template_component_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "template_component_versions_version_check" CHECK ("version" > 0),
    CONSTRAINT "template_component_versions_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
    CONSTRAINT "template_component_versions_description_check" CHECK ("description" IS NULL OR length("description") <= 2000),
    CONSTRAINT "template_component_versions_content_check" CHECK (jsonb_typeof("content_json") = 'object'),
    CONSTRAINT "template_component_versions_checksum_check" CHECK ("checksum" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "TemplateMasterStatus" NOT NULL DEFAULT 'DRAFT',
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "updated_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "templates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "templates_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_.-]{2,100}$'),
    CONSTRAINT "templates_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
    CONSTRAINT "templates_description_check" CHECK ("description" IS NULL OR length("description") <= 2000),
    CONSTRAINT "templates_version_check" CHECK ("version" > 0 AND "current_version" >= 0),
    CONSTRAINT "templates_status_check" CHECK (
      ("current_version" = 0 AND "status" = 'DRAFT')
      OR ("current_version" > 0 AND "status" IN ('ACTIVE', 'DISABLED'))
    )
);

CREATE TABLE "template_draft_components" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "component_version_id" TEXT NOT NULL,
    "component_type" "TemplateComponentType" NOT NULL,
    "slot" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "template_draft_components_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "template_draft_components_slot_check" CHECK ("slot" ~ '^[A-Z][A-Z0-9_.-]{1,99}$'),
    CONSTRAINT "template_draft_components_position_check" CHECK ("position" >= 0)
);

CREATE TABLE "template_versions" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "TemplateVersionStatus" NOT NULL DEFAULT 'PUBLISHED',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "checksum" TEXT NOT NULL,
    "published_by_id" TEXT NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "template_versions_version_check" CHECK ("version" > 0),
    CONSTRAINT "template_versions_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
    CONSTRAINT "template_versions_description_check" CHECK ("description" IS NULL OR length("description") <= 2000),
    CONSTRAINT "template_versions_checksum_check" CHECK ("checksum" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "template_version_components" (
    "id" TEXT NOT NULL,
    "template_version_id" TEXT NOT NULL,
    "component_version_id" TEXT NOT NULL,
    "component_type" "TemplateComponentType" NOT NULL,
    "slot" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "template_version_components_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "template_version_components_slot_check" CHECK ("slot" ~ '^[A-Z][A-Z0-9_.-]{1,99}$'),
    CONSTRAINT "template_version_components_position_check" CHECK ("position" >= 0)
);

CREATE UNIQUE INDEX "template_components_code_key" ON "template_components"("code");
CREATE INDEX "template_components_component_type_status_code_idx" ON "template_components"("component_type", "status", "code");
CREATE UNIQUE INDEX "template_component_versions_component_id_version_key" ON "template_component_versions"("component_id", "version");
CREATE INDEX "template_component_versions_component_type_published_at_idx" ON "template_component_versions"("component_type", "published_at");
CREATE INDEX "template_component_versions_published_by_id_published_at_idx" ON "template_component_versions"("published_by_id", "published_at");
CREATE UNIQUE INDEX "templates_code_key" ON "templates"("code");
CREATE INDEX "templates_status_code_idx" ON "templates"("status", "code");
CREATE UNIQUE INDEX "template_draft_components_template_id_slot_key" ON "template_draft_components"("template_id", "slot");
CREATE UNIQUE INDEX "template_draft_components_template_id_position_key" ON "template_draft_components"("template_id", "position");
CREATE INDEX "template_draft_components_component_version_id_idx" ON "template_draft_components"("component_version_id");
CREATE UNIQUE INDEX "template_versions_template_id_version_key" ON "template_versions"("template_id", "version");
CREATE INDEX "template_versions_published_by_id_published_at_idx" ON "template_versions"("published_by_id", "published_at");
CREATE UNIQUE INDEX "template_version_components_template_version_id_slot_key" ON "template_version_components"("template_version_id", "slot");
CREATE UNIQUE INDEX "template_version_components_template_version_id_position_key" ON "template_version_components"("template_version_id", "position");
CREATE INDEX "template_version_components_component_version_id_idx" ON "template_version_components"("component_version_id");

ALTER TABLE "template_components" ADD CONSTRAINT "template_components_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "template_components" ADD CONSTRAINT "template_components_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "template_component_versions" ADD CONSTRAINT "template_component_versions_component_id_fkey"
  FOREIGN KEY ("component_id") REFERENCES "template_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "template_component_versions" ADD CONSTRAINT "template_component_versions_published_by_id_fkey"
  FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "templates" ADD CONSTRAINT "templates_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "templates" ADD CONSTRAINT "templates_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "template_draft_components" ADD CONSTRAINT "template_draft_components_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "template_draft_components" ADD CONSTRAINT "template_draft_components_component_version_id_fkey"
  FOREIGN KEY ("component_version_id") REFERENCES "template_component_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_published_by_id_fkey"
  FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "template_version_components" ADD CONSTRAINT "template_version_components_template_version_id_fkey"
  FOREIGN KEY ("template_version_id") REFERENCES "template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "template_version_components" ADD CONSTRAINT "template_version_components_component_version_id_fkey"
  FOREIGN KEY ("component_version_id") REFERENCES "template_component_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_template_immutable_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is immutable: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_template_master_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% must be disabled instead of removed', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_template_component_type() RETURNS trigger AS $$
DECLARE actual_type "TemplateComponentType";
BEGIN
  IF TG_TABLE_NAME = 'template_component_versions' THEN
    SELECT "component_type" INTO actual_type FROM "template_components" WHERE "id" = NEW."component_id";
  ELSE
    SELECT "component_type" INTO actual_type FROM "template_component_versions" WHERE "id" = NEW."component_version_id";
  END IF;
  IF actual_type IS NULL OR actual_type IS DISTINCT FROM NEW."component_type" THEN
    RAISE EXCEPTION 'template component type does not match the referenced version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER template_component_versions_type_check
  BEFORE INSERT OR UPDATE ON "template_component_versions"
  FOR EACH ROW EXECUTE FUNCTION enforce_template_component_type();
CREATE TRIGGER template_draft_components_type_check
  BEFORE INSERT OR UPDATE ON "template_draft_components"
  FOR EACH ROW EXECUTE FUNCTION enforce_template_component_type();
CREATE TRIGGER template_version_components_type_check
  BEFORE INSERT OR UPDATE ON "template_version_components"
  FOR EACH ROW EXECUTE FUNCTION enforce_template_component_type();

CREATE TRIGGER template_components_reject_delete
  BEFORE DELETE ON "template_components" FOR EACH STATEMENT EXECUTE FUNCTION reject_template_master_removal();
CREATE TRIGGER template_components_reject_truncate
  BEFORE TRUNCATE ON "template_components" FOR EACH STATEMENT EXECUTE FUNCTION reject_template_master_removal();
CREATE TRIGGER templates_reject_delete
  BEFORE DELETE ON "templates" FOR EACH STATEMENT EXECUTE FUNCTION reject_template_master_removal();
CREATE TRIGGER templates_reject_truncate
  BEFORE TRUNCATE ON "templates" FOR EACH STATEMENT EXECUTE FUNCTION reject_template_master_removal();

CREATE TRIGGER template_component_versions_reject_update_delete
  BEFORE UPDATE OR DELETE ON "template_component_versions" FOR EACH STATEMENT EXECUTE FUNCTION reject_template_immutable_mutation();
CREATE TRIGGER template_component_versions_reject_truncate
  BEFORE TRUNCATE ON "template_component_versions" FOR EACH STATEMENT EXECUTE FUNCTION reject_template_immutable_mutation();
CREATE TRIGGER template_versions_reject_update_delete
  BEFORE UPDATE OR DELETE ON "template_versions" FOR EACH STATEMENT EXECUTE FUNCTION reject_template_immutable_mutation();
CREATE TRIGGER template_versions_reject_truncate
  BEFORE TRUNCATE ON "template_versions" FOR EACH STATEMENT EXECUTE FUNCTION reject_template_immutable_mutation();
CREATE TRIGGER template_version_components_reject_update_delete
  BEFORE UPDATE OR DELETE ON "template_version_components" FOR EACH STATEMENT EXECUTE FUNCTION reject_template_immutable_mutation();
CREATE TRIGGER template_version_components_reject_truncate
  BEFORE TRUNCATE ON "template_version_components" FOR EACH STATEMENT EXECUTE FUNCTION reject_template_immutable_mutation();
