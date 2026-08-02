-- APM-011 creates projects from one exact published template version and owns
-- a deep, immutable copy of every referenced component version.
CREATE TYPE "ProjectInitializationStatus" AS ENUM ('LEGACY', 'READY');
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_CREATED';

ALTER TABLE "projects"
  ADD COLUMN "initialization_status" "ProjectInitializationStatus" NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "source_template_version_id" TEXT,
  ADD COLUMN "source_template_checksum" TEXT,
  ADD COLUMN "initialized_at" TIMESTAMP(3),
  ADD CONSTRAINT "projects_template_source_check" CHECK (
    (
      "initialization_status" = 'LEGACY'
      AND "source_template_version_id" IS NULL
      AND "source_template_checksum" IS NULL
      AND "initialized_at" IS NULL
    ) OR (
      "initialization_status" = 'READY'
      AND "source_template_version_id" IS NOT NULL
      AND "source_template_checksum" ~ '^[0-9a-f]{64}$'
      AND "initialized_at" IS NOT NULL
    )
  );

CREATE TABLE "project_template_snapshots" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_template_version_id" TEXT NOT NULL,
  "source_template_checksum" TEXT NOT NULL,
  "snapshot_checksum" TEXT NOT NULL,
  "template_code" TEXT NOT NULL,
  "template_name" TEXT NOT NULL,
  "template_version" INTEGER NOT NULL,
  "template_published_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_template_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_template_snapshots_source_checksum_check" CHECK ("source_template_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_template_snapshots_snapshot_checksum_check" CHECK ("snapshot_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_template_snapshots_code_check" CHECK ("template_code" ~ '^[A-Z][A-Z0-9_.-]{2,100}$'),
  CONSTRAINT "project_template_snapshots_name_check" CHECK (length(btrim("template_name")) BETWEEN 1 AND 200),
  CONSTRAINT "project_template_snapshots_version_check" CHECK ("template_version" > 0)
);

CREATE TABLE "project_template_snapshot_components" (
  "id" TEXT NOT NULL,
  "snapshot_id" TEXT NOT NULL,
  "source_component_version_id" TEXT NOT NULL,
  "component_type" "TemplateComponentType" NOT NULL,
  "slot" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "source_checksum" TEXT NOT NULL,
  "component_code" TEXT NOT NULL,
  "component_name" TEXT NOT NULL,
  "component_version" INTEGER NOT NULL,
  "description" TEXT,
  "content_json" JSONB NOT NULL,
  CONSTRAINT "project_template_snapshot_components_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_template_snapshot_components_slot_check" CHECK ("slot" ~ '^[A-Z][A-Z0-9_.-]{1,99}$'),
  CONSTRAINT "project_template_snapshot_components_position_check" CHECK ("position" >= 0),
  CONSTRAINT "project_template_snapshot_components_checksum_check" CHECK ("source_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_template_snapshot_components_code_check" CHECK ("component_code" ~ '^[A-Z][A-Z0-9_.-]{2,100}$'),
  CONSTRAINT "project_template_snapshot_components_name_check" CHECK (length(btrim("component_name")) BETWEEN 1 AND 200),
  CONSTRAINT "project_template_snapshot_components_version_check" CHECK ("component_version" > 0),
  CONSTRAINT "project_template_snapshot_components_content_check" CHECK (jsonb_typeof("content_json") = 'object')
);

CREATE UNIQUE INDEX "project_template_snapshots_project_id_key" ON "project_template_snapshots"("project_id");
CREATE INDEX "project_template_snapshots_source_template_version_id_created_at_idx"
  ON "project_template_snapshots"("source_template_version_id", "created_at");
CREATE UNIQUE INDEX "project_template_snapshot_components_snapshot_id_slot_key"
  ON "project_template_snapshot_components"("snapshot_id", "slot");
CREATE UNIQUE INDEX "project_template_snapshot_components_snapshot_id_position_key"
  ON "project_template_snapshot_components"("snapshot_id", "position");
CREATE INDEX "project_template_snapshot_components_source_component_version_id_idx"
  ON "project_template_snapshot_components"("source_component_version_id");
CREATE INDEX "projects_source_template_version_id_idx" ON "projects"("source_template_version_id");
CREATE INDEX "projects_initialization_status_created_at_idx" ON "projects"("initialization_status", "created_at");

ALTER TABLE "projects" ADD CONSTRAINT "projects_source_template_version_id_fkey"
  FOREIGN KEY ("source_template_version_id") REFERENCES "template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_template_snapshots" ADD CONSTRAINT "project_template_snapshots_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_template_snapshots" ADD CONSTRAINT "project_template_snapshots_source_template_version_id_fkey"
  FOREIGN KEY ("source_template_version_id") REFERENCES "template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_template_snapshot_components" ADD CONSTRAINT "project_template_snapshot_components_snapshot_id_fkey"
  FOREIGN KEY ("snapshot_id") REFERENCES "project_template_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_template_snapshot_components" ADD CONSTRAINT "project_template_snapshot_components_source_component_version_id_fkey"
  FOREIGN KEY ("source_component_version_id") REFERENCES "template_component_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_project_template_snapshot_source() RETURNS trigger AS $$
DECLARE
  project_source_id TEXT;
  project_source_checksum TEXT;
  project_status "ProjectInitializationStatus";
  source_checksum TEXT;
  source_version INTEGER;
  source_name TEXT;
  source_published_at TIMESTAMP(3);
  source_code TEXT;
BEGIN
  SELECT "source_template_version_id", "source_template_checksum", "initialization_status"
    INTO project_source_id, project_source_checksum, project_status
    FROM "projects" WHERE "id" = NEW."project_id";
  SELECT version_row."checksum", version_row."version", version_row."name", version_row."published_at", template."code"
    INTO source_checksum, source_version, source_name, source_published_at, source_code
    FROM "template_versions" version_row
    JOIN "templates" template ON template."id" = version_row."template_id"
    WHERE version_row."id" = NEW."source_template_version_id";
  IF project_status IS DISTINCT FROM 'READY'
    OR project_source_id IS DISTINCT FROM NEW."source_template_version_id"
    OR project_source_checksum IS DISTINCT FROM NEW."source_template_checksum"
    OR source_checksum IS DISTINCT FROM NEW."source_template_checksum"
    OR source_version IS DISTINCT FROM NEW."template_version"
    OR source_name IS DISTINCT FROM NEW."template_name"
    OR source_published_at IS DISTINCT FROM NEW."template_published_at"
    OR source_code IS DISTINCT FROM NEW."template_code" THEN
    RAISE EXCEPTION 'project template snapshot does not match its exact source version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_project_template_snapshot_component_source() RETURNS trigger AS $$
DECLARE source_record RECORD;
BEGIN
  SELECT version_row."component_type", version_row."checksum", version_row."version",
         version_row."name", version_row."description", version_row."content_json", component."code"
    INTO source_record
    FROM "template_component_versions" version_row
    JOIN "template_components" component ON component."id" = version_row."component_id"
    WHERE version_row."id" = NEW."source_component_version_id";
  IF source_record IS NULL
    OR source_record."component_type" IS DISTINCT FROM NEW."component_type"
    OR source_record."checksum" IS DISTINCT FROM NEW."source_checksum"
    OR source_record."version" IS DISTINCT FROM NEW."component_version"
    OR source_record."name" IS DISTINCT FROM NEW."component_name"
    OR source_record."description" IS DISTINCT FROM NEW."description"
    OR source_record."content_json" IS DISTINCT FROM NEW."content_json"
    OR source_record."code" IS DISTINCT FROM NEW."component_code" THEN
    RAISE EXCEPTION 'project component snapshot does not match its exact source version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_project_template_snapshot_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is immutable: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_template_snapshots_source_check
  BEFORE INSERT ON "project_template_snapshots"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_template_snapshot_source();
CREATE TRIGGER project_template_snapshot_components_source_check
  BEFORE INSERT ON "project_template_snapshot_components"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_template_snapshot_component_source();
CREATE TRIGGER project_template_snapshots_reject_update_delete
  BEFORE UPDATE OR DELETE ON "project_template_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_project_template_snapshot_mutation();
CREATE TRIGGER project_template_snapshots_reject_truncate
  BEFORE TRUNCATE ON "project_template_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_project_template_snapshot_mutation();
CREATE TRIGGER project_template_snapshot_components_reject_update_delete
  BEFORE UPDATE OR DELETE ON "project_template_snapshot_components"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_project_template_snapshot_mutation();
CREATE TRIGGER project_template_snapshot_components_reject_truncate
  BEFORE TRUNCATE ON "project_template_snapshot_components"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_project_template_snapshot_mutation();
