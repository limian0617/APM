-- APM-012 classifies projects and adds a project-owned delivery-unit/module tree.
CREATE TYPE "ProjectType" AS ENUM ('LEGACY', 'CUSTOMER_DELIVERY', 'INTERNAL_RND');
CREATE TYPE "EquipmentShape" AS ENUM ('SINGLE_MACHINE', 'LINE');
CREATE TYPE "ProjectStructureStatus" AS ENUM ('UNCONFIGURED', 'READY');
CREATE TYPE "DeliveryUnitType" AS ENUM ('LINE', 'AREA', 'MACHINE');
CREATE TYPE "ProjectStructureNodeStatus" AS ENUM ('ACTIVE', 'DISABLED');

ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_STRUCTURE_INITIALIZED';
ALTER TYPE "AuditAction" ADD VALUE 'DELIVERY_UNIT_STATUS_CHANGED';
ALTER TYPE "AuditObjectType" ADD VALUE 'DELIVERY_UNIT';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_MODULE';

ALTER TABLE "projects"
  ADD COLUMN "project_type" "ProjectType" NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "equipment_shape" "EquipmentShape",
  ADD COLUMN "structure_status" "ProjectStructureStatus" NOT NULL DEFAULT 'UNCONFIGURED',
  ADD CONSTRAINT "projects_structure_classification_check" CHECK (
    (
      "project_type" = 'LEGACY'
      AND "equipment_shape" IS NULL
      AND "structure_status" = 'UNCONFIGURED'
    ) OR (
      "initialization_status" = 'READY'
      AND "project_type" = 'INTERNAL_RND'
      AND "equipment_shape" IS NULL
      AND "structure_status" = 'READY'
    ) OR (
      "initialization_status" = 'READY'
      AND "project_type" = 'CUSTOMER_DELIVERY'
      AND "equipment_shape" IS NOT NULL
      AND "structure_status" = 'READY'
    )
  );

CREATE TABLE "delivery_units" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "parent_id" TEXT,
  "unit_type" "DeliveryUnitType" NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "ProjectStructureNodeStatus" NOT NULL DEFAULT 'ACTIVE',
  "position" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "delivery_units_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "delivery_units_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_.-]{1,99}$'),
  CONSTRAINT "delivery_units_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "delivery_units_position_check" CHECK ("position" >= 0),
  CONSTRAINT "delivery_units_version_check" CHECK ("version" > 0),
  CONSTRAINT "delivery_units_not_own_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);

CREATE TABLE "project_modules" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "delivery_unit_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "ProjectStructureNodeStatus" NOT NULL DEFAULT 'ACTIVE',
  "position" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_modules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_modules_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_.-]{1,99}$'),
  CONSTRAINT "project_modules_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "project_modules_position_check" CHECK ("position" >= 0),
  CONSTRAINT "project_modules_version_check" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "delivery_units_project_id_code_key" ON "delivery_units"("project_id", "code");
CREATE UNIQUE INDEX "delivery_units_id_project_id_key" ON "delivery_units"("id", "project_id");
CREATE UNIQUE INDEX "delivery_units_project_id_parent_id_position_key"
  ON "delivery_units"("project_id", "parent_id", "position");
CREATE UNIQUE INDEX "delivery_units_project_root_position_key"
  ON "delivery_units"("project_id", "position") WHERE "parent_id" IS NULL;
CREATE INDEX "delivery_units_project_id_unit_type_status_idx"
  ON "delivery_units"("project_id", "unit_type", "status");
CREATE INDEX "delivery_units_parent_id_position_idx" ON "delivery_units"("parent_id", "position");
CREATE UNIQUE INDEX "project_modules_project_id_code_key" ON "project_modules"("project_id", "code");
CREATE UNIQUE INDEX "project_modules_delivery_unit_id_position_key"
  ON "project_modules"("delivery_unit_id", "position");
CREATE INDEX "project_modules_project_id_status_idx" ON "project_modules"("project_id", "status");
CREATE INDEX "project_modules_delivery_unit_id_status_idx"
  ON "project_modules"("delivery_unit_id", "status");
CREATE INDEX "projects_project_type_equipment_shape_structure_status_idx"
  ON "projects"("project_type", "equipment_shape", "structure_status");

ALTER TABLE "delivery_units" ADD CONSTRAINT "delivery_units_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_units" ADD CONSTRAINT "delivery_units_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "delivery_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_units" ADD CONSTRAINT "delivery_units_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_units" ADD CONSTRAINT "delivery_units_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_modules" ADD CONSTRAINT "project_modules_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_modules" ADD CONSTRAINT "project_modules_delivery_unit_id_fkey"
  FOREIGN KEY ("delivery_unit_id") REFERENCES "delivery_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_modules" ADD CONSTRAINT "project_modules_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_modules" ADD CONSTRAINT "project_modules_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_project_structure_classification_transition() RETURNS trigger AS $$
BEGIN
  IF OLD."structure_status" = 'READY'
    AND (
      OLD."project_type" IS DISTINCT FROM NEW."project_type"
      OR OLD."equipment_shape" IS DISTINCT FROM NEW."equipment_shape"
      OR OLD."structure_status" IS DISTINCT FROM NEW."structure_status"
    ) THEN
    RAISE EXCEPTION 'ready project structure classification is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_delivery_unit_hierarchy() RETURNS trigger AS $$
DECLARE
  project_type_value "ProjectType";
  equipment_shape_value "EquipmentShape";
  structure_status_value "ProjectStructureStatus";
  parent_project_id TEXT;
  parent_type "DeliveryUnitType";
  has_cycle BOOLEAN;
BEGIN
  SELECT "project_type", "equipment_shape", "structure_status"
    INTO project_type_value, equipment_shape_value, structure_status_value
    FROM "projects" WHERE "id" = NEW."project_id";

  IF project_type_value IS DISTINCT FROM 'CUSTOMER_DELIVERY'
    OR structure_status_value IS DISTINCT FROM 'READY' THEN
    RAISE EXCEPTION 'delivery units require a ready customer delivery project' USING ERRCODE = '23514';
  END IF;

  IF NEW."parent_id" IS NOT NULL THEN
    SELECT "project_id", "unit_type" INTO parent_project_id, parent_type
      FROM "delivery_units" WHERE "id" = NEW."parent_id";
    IF parent_project_id IS NULL OR parent_project_id IS DISTINCT FROM NEW."project_id" THEN
      RAISE EXCEPTION 'delivery unit parent must belong to the same project' USING ERRCODE = '23514';
    END IF;

    WITH RECURSIVE ancestors AS (
      SELECT "id", "parent_id" FROM "delivery_units" WHERE "id" = NEW."parent_id"
      UNION ALL
      SELECT parent."id", parent."parent_id"
        FROM "delivery_units" parent
        JOIN ancestors child ON parent."id" = child."parent_id"
    )
    SELECT EXISTS (SELECT 1 FROM ancestors WHERE "id" = NEW."id") INTO has_cycle;
    IF has_cycle THEN
      RAISE EXCEPTION 'delivery unit hierarchy cannot contain a cycle' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF equipment_shape_value = 'SINGLE_MACHINE' THEN
    IF NEW."unit_type" IS DISTINCT FROM 'MACHINE' OR NEW."parent_id" IS NOT NULL THEN
      RAISE EXCEPTION 'single-machine projects only allow one root machine' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "delivery_units"
      WHERE "project_id" = NEW."project_id" AND "id" <> NEW."id"
    ) THEN
      RAISE EXCEPTION 'single-machine projects only allow one root machine' USING ERRCODE = '23514';
    END IF;
  ELSIF equipment_shape_value = 'LINE' THEN
    IF NEW."unit_type" = 'LINE' AND NEW."parent_id" IS NOT NULL THEN
      RAISE EXCEPTION 'line units must be project roots' USING ERRCODE = '23514';
    ELSIF NEW."unit_type" = 'AREA'
      AND (NEW."parent_id" IS NULL OR parent_type IS DISTINCT FROM 'LINE') THEN
      RAISE EXCEPTION 'area units must be children of line units' USING ERRCODE = '23514';
    ELSIF NEW."unit_type" = 'MACHINE'
      AND (NEW."parent_id" IS NULL OR parent_type NOT IN ('LINE', 'AREA')) THEN
      RAISE EXCEPTION 'machine units must be children of line or area units' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_project_module_machine() RETURNS trigger AS $$
DECLARE
  unit_project_id TEXT;
  unit_type_value "DeliveryUnitType";
  project_type_value "ProjectType";
  structure_status_value "ProjectStructureStatus";
BEGIN
  SELECT "project_id", "unit_type" INTO unit_project_id, unit_type_value
    FROM "delivery_units" WHERE "id" = NEW."delivery_unit_id";
  SELECT "project_type", "structure_status" INTO project_type_value, structure_status_value
    FROM "projects" WHERE "id" = NEW."project_id";
  IF unit_project_id IS NULL
    OR unit_project_id IS DISTINCT FROM NEW."project_id"
    OR unit_type_value IS DISTINCT FROM 'MACHINE'
    OR project_type_value IS DISTINCT FROM 'CUSTOMER_DELIVERY'
    OR structure_status_value IS DISTINCT FROM 'READY' THEN
    RAISE EXCEPTION 'project modules must belong to a machine in the same ready project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_delivery_unit_stable_identity() RETURNS trigger AS $$
BEGIN
  IF OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."parent_id" IS DISTINCT FROM NEW."parent_id"
    OR OLD."unit_type" IS DISTINCT FROM NEW."unit_type"
    OR OLD."code" IS DISTINCT FROM NEW."code"
    OR OLD."position" IS DISTINCT FROM NEW."position"
    OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'delivery unit stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_project_module_stable_identity() RETURNS trigger AS $$
BEGIN
  IF OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."delivery_unit_id" IS DISTINCT FROM NEW."delivery_unit_id"
    OR OLD."code" IS DISTINCT FROM NEW."code"
    OR OLD."position" IS DISTINCT FROM NEW."position"
    OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'project module stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_project_structure_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% must be disabled instead of removed', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER projects_structure_classification_transition
  BEFORE UPDATE OF "project_type", "equipment_shape", "structure_status" ON "projects"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_structure_classification_transition();
CREATE TRIGGER delivery_units_hierarchy_check
  BEFORE INSERT OR UPDATE OF "project_id", "parent_id", "unit_type" ON "delivery_units"
  FOR EACH ROW EXECUTE FUNCTION enforce_delivery_unit_hierarchy();
CREATE TRIGGER project_modules_machine_check
  BEFORE INSERT OR UPDATE OF "project_id", "delivery_unit_id" ON "project_modules"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_module_machine();
CREATE TRIGGER delivery_units_stable_identity
  BEFORE UPDATE ON "delivery_units" FOR EACH ROW EXECUTE FUNCTION enforce_delivery_unit_stable_identity();
CREATE TRIGGER project_modules_stable_identity
  BEFORE UPDATE ON "project_modules" FOR EACH ROW EXECUTE FUNCTION enforce_project_module_stable_identity();
CREATE TRIGGER delivery_units_reject_delete
  BEFORE DELETE ON "delivery_units" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_structure_removal();
CREATE TRIGGER delivery_units_reject_truncate
  BEFORE TRUNCATE ON "delivery_units" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_structure_removal();
CREATE TRIGGER project_modules_reject_delete
  BEFORE DELETE ON "project_modules" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_structure_removal();
CREATE TRIGGER project_modules_reject_truncate
  BEFORE TRUNCATE ON "project_modules" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_structure_removal();
