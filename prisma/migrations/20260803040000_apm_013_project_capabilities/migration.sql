-- APM-013 freezes template capability policy into each project while evaluating
-- the effective state against the current company switch.
CREATE TYPE "ProjectCapabilityConfigurationStatus" AS ENUM ('UNCONFIGURED', 'READY');

ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_CAPABILITIES_CONFIRMED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_CAPABILITY_CHANGED';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_CAPABILITY';

ALTER TABLE "projects"
  ADD COLUMN "capability_configuration_status" "ProjectCapabilityConfigurationStatus" NOT NULL DEFAULT 'UNCONFIGURED',
  ADD COLUMN "capabilities_configured_at" TIMESTAMP(3),
  ADD CONSTRAINT "projects_capability_configuration_check" CHECK (
    (
      "capability_configuration_status" = 'UNCONFIGURED'
      AND "capabilities_configured_at" IS NULL
    ) OR (
      "capability_configuration_status" = 'READY'
      AND "initialization_status" = 'READY'
      AND "capabilities_configured_at" IS NOT NULL
    )
  );

CREATE TABLE "project_capabilities" (
  "project_id" TEXT NOT NULL,
  "capability_code" "CapabilityCode" NOT NULL,
  "template_allowed" BOOLEAN NOT NULL,
  "template_required" BOOLEAN NOT NULL,
  "selected_enabled" BOOLEAN NOT NULL,
  "source_snapshot_component_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_capabilities_pkey" PRIMARY KEY ("project_id", "capability_code"),
  CONSTRAINT "project_capabilities_version_check" CHECK ("version" > 0),
  CONSTRAINT "project_capabilities_policy_check" CHECK (
    (NOT "template_required" OR "template_allowed")
    AND (NOT "template_required" OR "selected_enabled")
    AND (NOT "selected_enabled" OR "template_allowed")
    AND (NOT "template_allowed" OR "source_snapshot_component_id" IS NOT NULL)
  )
);

CREATE TABLE "project_capability_revisions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "capability_code" "CapabilityCode" NOT NULL,
  "version" INTEGER NOT NULL,
  "template_allowed" BOOLEAN NOT NULL,
  "template_required" BOOLEAN NOT NULL,
  "selected_enabled" BOOLEAN NOT NULL,
  "source_snapshot_component_id" TEXT,
  "company_enabled" BOOLEAN NOT NULL,
  "company_version" INTEGER NOT NULL,
  "effective_enabled" BOOLEAN NOT NULL,
  "changed_by_id" TEXT NOT NULL,
  "change_reason" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_capability_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_capability_revisions_version_check" CHECK ("version" > 0),
  CONSTRAINT "project_capability_revisions_company_version_check" CHECK ("company_version" > 0),
  CONSTRAINT "project_capability_revisions_reason_check" CHECK (length(btrim("change_reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "project_capability_revisions_policy_check" CHECK (
    (NOT "template_required" OR "template_allowed")
    AND (NOT "template_required" OR "selected_enabled")
    AND (NOT "selected_enabled" OR "template_allowed")
    AND "effective_enabled" = (
      "company_enabled" AND "template_allowed" AND "selected_enabled"
    )
  )
);

CREATE INDEX "projects_capability_configuration_status_created_at_idx"
  ON "projects"("capability_configuration_status", "created_at");
CREATE INDEX "project_capabilities_capability_code_selected_enabled_idx"
  ON "project_capabilities"("capability_code", "selected_enabled");
CREATE INDEX "project_capabilities_source_snapshot_component_id_idx"
  ON "project_capabilities"("source_snapshot_component_id");
CREATE UNIQUE INDEX "project_capability_revisions_project_id_capability_code_version_key"
  ON "project_capability_revisions"("project_id", "capability_code", "version");
CREATE INDEX "project_capability_revisions_changed_by_id_created_at_idx"
  ON "project_capability_revisions"("changed_by_id", "created_at");
CREATE INDEX "project_capability_revisions_project_id_created_at_idx"
  ON "project_capability_revisions"("project_id", "created_at");

ALTER TABLE "project_capabilities" ADD CONSTRAINT "project_capabilities_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_capabilities" ADD CONSTRAINT "project_capabilities_capability_code_fkey"
  FOREIGN KEY ("capability_code") REFERENCES "company_capabilities"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_capabilities" ADD CONSTRAINT "project_capabilities_source_snapshot_component_id_fkey"
  FOREIGN KEY ("source_snapshot_component_id") REFERENCES "project_template_snapshot_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_capabilities" ADD CONSTRAINT "project_capabilities_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_capabilities" ADD CONSTRAINT "project_capabilities_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_capability_revisions" ADD CONSTRAINT "project_capability_revisions_capability_fkey"
  FOREIGN KEY ("project_id", "capability_code") REFERENCES "project_capabilities"("project_id", "capability_code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_capability_revisions" ADD CONSTRAINT "project_capability_revisions_company_revision_fkey"
  FOREIGN KEY ("capability_code", "company_version") REFERENCES "company_capability_revisions"("capability_code", "version") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_capability_revisions" ADD CONSTRAINT "project_capability_revisions_changed_by_id_fkey"
  FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_project_capability_configuration_transition() RETURNS trigger AS $$
BEGIN
  IF OLD."capability_configuration_status" = 'READY'
    AND (
      NEW."capability_configuration_status" IS DISTINCT FROM OLD."capability_configuration_status"
      OR NEW."capabilities_configured_at" IS DISTINCT FROM OLD."capabilities_configured_at"
    ) THEN
    RAISE EXCEPTION 'ready project capability configuration is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_project_capability_source() RETURNS trigger AS $$
DECLARE
  project_initialization_status "ProjectInitializationStatus";
  project_configuration_status "ProjectCapabilityConfigurationStatus";
  source_project_id TEXT;
  source_component_type "TemplateComponentType";
BEGIN
  SELECT "initialization_status", "capability_configuration_status"
    INTO project_initialization_status, project_configuration_status
    FROM "projects" WHERE "id" = NEW."project_id";

  IF project_initialization_status IS DISTINCT FROM 'READY'
    OR project_configuration_status IS DISTINCT FROM 'READY' THEN
    RAISE EXCEPTION 'project capabilities require a ready project configuration' USING ERRCODE = '23514';
  END IF;

  IF NEW."source_snapshot_component_id" IS NOT NULL THEN
    SELECT snapshot."project_id", component."component_type"
      INTO source_project_id, source_component_type
      FROM "project_template_snapshot_components" component
      JOIN "project_template_snapshots" snapshot ON snapshot."id" = component."snapshot_id"
      WHERE component."id" = NEW."source_snapshot_component_id";
    IF source_project_id IS DISTINCT FROM NEW."project_id"
      OR source_component_type IS DISTINCT FROM 'CAPABILITY_RULE' THEN
      RAISE EXCEPTION 'capability policy source must be a capability snapshot in the same project' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_project_capability_stable_policy() RETURNS trigger AS $$
BEGIN
  IF OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."capability_code" IS DISTINCT FROM NEW."capability_code"
    OR OLD."template_allowed" IS DISTINCT FROM NEW."template_allowed"
    OR OLD."template_required" IS DISTINCT FROM NEW."template_required"
    OR OLD."source_snapshot_component_id" IS DISTINCT FROM NEW."source_snapshot_component_id"
    OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'project capability template policy is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_project_capability_revision() RETURNS trigger AS $$
DECLARE
  current_capability "project_capabilities"%ROWTYPE;
BEGIN
  SELECT * INTO current_capability
    FROM "project_capabilities"
    WHERE "project_id" = NEW."project_id" AND "capability_code" = NEW."capability_code";
  IF current_capability."project_id" IS NULL
    OR current_capability."version" IS DISTINCT FROM NEW."version"
    OR current_capability."template_allowed" IS DISTINCT FROM NEW."template_allowed"
    OR current_capability."template_required" IS DISTINCT FROM NEW."template_required"
    OR current_capability."selected_enabled" IS DISTINCT FROM NEW."selected_enabled"
    OR current_capability."source_snapshot_component_id" IS DISTINCT FROM NEW."source_snapshot_component_id" THEN
    RAISE EXCEPTION 'project capability revision must snapshot the current selection' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_project_capability_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is durable and cannot be removed', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER projects_capability_configuration_transition
  BEFORE UPDATE OF "capability_configuration_status", "capabilities_configured_at" ON "projects"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_capability_configuration_transition();
CREATE TRIGGER project_capabilities_source_check
  BEFORE INSERT OR UPDATE OF "project_id", "source_snapshot_component_id" ON "project_capabilities"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_capability_source();
CREATE TRIGGER project_capabilities_stable_policy
  BEFORE UPDATE ON "project_capabilities"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_capability_stable_policy();
CREATE TRIGGER project_capability_revisions_snapshot_check
  BEFORE INSERT ON "project_capability_revisions"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_capability_revision();
CREATE TRIGGER project_capabilities_reject_delete
  BEFORE DELETE ON "project_capabilities"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_project_capability_removal();
CREATE TRIGGER project_capabilities_reject_truncate
  BEFORE TRUNCATE ON "project_capabilities"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_project_capability_removal();
CREATE TRIGGER project_capability_revisions_reject_mutation
  BEFORE UPDATE OR DELETE ON "project_capability_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_project_capability_removal();
CREATE TRIGGER project_capability_revisions_reject_truncate
  BEFORE TRUNCATE ON "project_capability_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_project_capability_removal();
