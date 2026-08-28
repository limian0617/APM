-- APM-020 adds project-owned WBS nodes and executable planning tasks without
-- introducing calendars, dependencies, baselines, CPM, or progress projections.
CREATE TYPE "PlanningNodeStatus" AS ENUM ('ACTIVE', 'CLOSED');
CREATE TYPE "PlanningTaskStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED');

ALTER TYPE "AuditAction" ADD VALUE 'WBS_NODE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'WBS_NODE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'WBS_NODE_CLOSED';
ALTER TYPE "AuditAction" ADD VALUE 'PLANNING_TASK_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PLANNING_TASK_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'PLANNING_TASK_PROGRESS_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'PLANNING_TASK_CLOSED';
ALTER TYPE "AuditObjectType" ADD VALUE 'WBS_NODE';
ALTER TYPE "AuditObjectType" ADD VALUE 'PLANNING_TASK';

CREATE UNIQUE INDEX "project_members_id_project_id_key"
  ON "project_members"("id", "project_id");

CREATE TABLE "wbs_nodes" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "parent_id" TEXT,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "position" INTEGER NOT NULL,
  "status" "PlanningNodeStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "closed_at" TIMESTAMP(3),
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "wbs_nodes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wbs_nodes_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_.-]{1,99}$'),
  CONSTRAINT "wbs_nodes_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "wbs_nodes_description_check" CHECK ("description" IS NULL OR length(btrim("description")) BETWEEN 1 AND 2000),
  CONSTRAINT "wbs_nodes_position_check" CHECK ("position" BETWEEN 0 AND 1000000),
  CONSTRAINT "wbs_nodes_version_check" CHECK ("version" > 0),
  CONSTRAINT "wbs_nodes_closed_check" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL))
);

CREATE TABLE "planning_tasks" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "wbs_node_id" TEXT NOT NULL,
  "responsibility_package_id" TEXT,
  "delivery_unit_id" TEXT,
  "module_id" TEXT,
  "owner_membership_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "position" INTEGER NOT NULL,
  "planned_start_at" TIMESTAMP(3) NOT NULL,
  "planned_finish_at" TIMESTAMP(3) NOT NULL,
  "planned_duration_minutes" INTEGER NOT NULL,
  "weight" INTEGER NOT NULL,
  "status" "PlanningTaskStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "actual_start_at" TIMESTAMP(3),
  "actual_finish_at" TIMESTAMP(3),
  "remaining_duration_minutes" INTEGER NOT NULL,
  "forecast_finish_at" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "closed_at" TIMESTAMP(3),
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "planning_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "planning_tasks_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_.-]{1,99}$'),
  CONSTRAINT "planning_tasks_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "planning_tasks_description_check" CHECK ("description" IS NULL OR length(btrim("description")) BETWEEN 1 AND 2000),
  CONSTRAINT "planning_tasks_position_check" CHECK ("position" BETWEEN 0 AND 1000000),
  CONSTRAINT "planning_tasks_plan_check" CHECK (
    "planned_finish_at" > "planned_start_at"
    AND "planned_duration_minutes" BETWEEN 1 AND 5256000
    AND "weight" BETWEEN 1 AND 1000000
  ),
  CONSTRAINT "planning_tasks_remaining_check" CHECK ("remaining_duration_minutes" BETWEEN 0 AND 5256000),
  CONSTRAINT "planning_tasks_version_check" CHECK ("version" > 0),
  CONSTRAINT "planning_tasks_state_check" CHECK (
    ("status" = 'NOT_STARTED' AND "actual_start_at" IS NULL AND "actual_finish_at" IS NULL
      AND "remaining_duration_minutes" > 0 AND "forecast_finish_at" >= "planned_start_at" AND "closed_at" IS NULL)
    OR ("status" = 'IN_PROGRESS' AND "actual_start_at" IS NOT NULL AND "actual_finish_at" IS NULL
      AND "remaining_duration_minutes" > 0 AND "forecast_finish_at" >= "actual_start_at" AND "closed_at" IS NULL)
    OR ("status" = 'COMPLETED' AND "actual_start_at" IS NOT NULL AND "actual_finish_at" IS NOT NULL
      AND "actual_finish_at" >= "actual_start_at" AND "remaining_duration_minutes" = 0
      AND "forecast_finish_at" = "actual_finish_at" AND "closed_at" IS NULL)
    OR ("status" = 'CLOSED' AND "closed_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "wbs_nodes_project_id_code_key" ON "wbs_nodes"("project_id", "code");
CREATE UNIQUE INDEX "wbs_nodes_id_project_id_key" ON "wbs_nodes"("id", "project_id");
CREATE UNIQUE INDEX "wbs_nodes_project_id_parent_id_position_key" ON "wbs_nodes"("project_id", "parent_id", "position") NULLS NOT DISTINCT;
CREATE INDEX "wbs_nodes_project_id_status_position_idx" ON "wbs_nodes"("project_id", "status", "position");
CREATE INDEX "wbs_nodes_parent_id_position_idx" ON "wbs_nodes"("parent_id", "position");
CREATE UNIQUE INDEX "planning_tasks_project_id_code_key" ON "planning_tasks"("project_id", "code");
CREATE UNIQUE INDEX "planning_tasks_id_project_id_key" ON "planning_tasks"("id", "project_id");
CREATE UNIQUE INDEX "planning_tasks_wbs_node_id_position_key" ON "planning_tasks"("wbs_node_id", "position");
CREATE INDEX "planning_tasks_project_id_status_code_idx" ON "planning_tasks"("project_id", "status", "code");
CREATE INDEX "planning_tasks_owner_membership_id_status_idx" ON "planning_tasks"("owner_membership_id", "status");
CREATE INDEX "planning_tasks_responsibility_package_id_status_idx" ON "planning_tasks"("responsibility_package_id", "status");
CREATE INDEX "planning_tasks_delivery_unit_id_status_idx" ON "planning_tasks"("delivery_unit_id", "status");
CREATE INDEX "planning_tasks_module_id_status_idx" ON "planning_tasks"("module_id", "status");

ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_parent_id_project_id_fkey"
  FOREIGN KEY ("parent_id", "project_id") REFERENCES "wbs_nodes"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wbs_nodes" ADD CONSTRAINT "wbs_nodes_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "planning_tasks" ADD CONSTRAINT "planning_tasks_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_tasks" ADD CONSTRAINT "planning_tasks_wbs_node_id_project_id_fkey"
  FOREIGN KEY ("wbs_node_id", "project_id") REFERENCES "wbs_nodes"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_tasks" ADD CONSTRAINT "planning_tasks_responsibility_package_id_project_id_fkey"
  FOREIGN KEY ("responsibility_package_id", "project_id") REFERENCES "responsibility_packages"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_tasks" ADD CONSTRAINT "planning_tasks_delivery_unit_id_project_id_fkey"
  FOREIGN KEY ("delivery_unit_id", "project_id") REFERENCES "delivery_units"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_tasks" ADD CONSTRAINT "planning_tasks_module_id_project_id_fkey"
  FOREIGN KEY ("module_id", "project_id") REFERENCES "project_modules"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_tasks" ADD CONSTRAINT "planning_tasks_owner_membership_id_project_id_fkey"
  FOREIGN KEY ("owner_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_tasks" ADD CONSTRAINT "planning_tasks_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_tasks" ADD CONSTRAINT "planning_tasks_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_wbs_node_hierarchy() RETURNS trigger AS $$
DECLARE
  candidate_id TEXT;
  parent_project_id TEXT;
  parent_status "PlanningNodeStatus";
BEGIN
  IF NEW."parent_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "project_id", "status" INTO parent_project_id, parent_status
    FROM "wbs_nodes" WHERE "id" = NEW."parent_id";
  IF parent_project_id IS DISTINCT FROM NEW."project_id" THEN
    RAISE EXCEPTION 'WBS parent must belong to the same project' USING ERRCODE = '23514';
  END IF;
  IF parent_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'WBS parent must be active' USING ERRCODE = '23514';
  END IF;
  candidate_id := NEW."parent_id";
  WHILE candidate_id IS NOT NULL LOOP
    IF candidate_id = NEW."id" THEN
      RAISE EXCEPTION 'WBS hierarchy cannot contain a cycle' USING ERRCODE = '23514';
    END IF;
    SELECT "parent_id" INTO candidate_id
      FROM "wbs_nodes" WHERE "id" = candidate_id AND "project_id" = NEW."project_id";
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_wbs_node_update() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."code" IS DISTINCT FROM NEW."code"
    OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'WBS stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'closed WBS node is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'CLOSED' THEN
    IF EXISTS (SELECT 1 FROM "wbs_nodes" WHERE "parent_id" = OLD."id" AND "status" = 'ACTIVE')
      OR EXISTS (SELECT 1 FROM "planning_tasks" WHERE "wbs_node_id" = OLD."id" AND "status" <> 'CLOSED') THEN
      RAISE EXCEPTION 'WBS node with active children or tasks cannot be closed' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'invalid WBS status transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'WBS version must advance once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_planning_task_relations() RETURNS trigger AS $$
DECLARE
  owner_left_at TIMESTAMP(3);
  owner_status "UserStatus";
  wbs_status "PlanningNodeStatus";
  package_status "ResponsibilityPackageStatus";
  delivery_status "ProjectStructureNodeStatus";
  module_status "ProjectStructureNodeStatus";
  module_delivery_unit_id TEXT;
BEGIN
  SELECT member."left_at", actor."status" INTO owner_left_at, owner_status
    FROM "project_members" member JOIN "users" actor ON actor."id" = member."user_id"
    WHERE member."id" = NEW."owner_membership_id" AND member."project_id" = NEW."project_id";
  IF owner_status IS DISTINCT FROM 'ACTIVE' OR owner_left_at IS NOT NULL THEN
    RAISE EXCEPTION 'planning task owner must be an active member of the same project' USING ERRCODE = '23514';
  END IF;
  SELECT "status" INTO wbs_status FROM "wbs_nodes"
    WHERE "id" = NEW."wbs_node_id" AND "project_id" = NEW."project_id";
  IF wbs_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'planning task WBS node must be active in the same project' USING ERRCODE = '23514';
  END IF;
  IF NEW."responsibility_package_id" IS NOT NULL THEN
    SELECT "status" INTO package_status FROM "responsibility_packages"
      WHERE "id" = NEW."responsibility_package_id" AND "project_id" = NEW."project_id";
    IF package_status IS NULL OR package_status = 'CLOSED' THEN
      RAISE EXCEPTION 'planning task responsibility package must be usable in the same project' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."delivery_unit_id" IS NOT NULL THEN
    SELECT "status" INTO delivery_status FROM "delivery_units"
      WHERE "id" = NEW."delivery_unit_id" AND "project_id" = NEW."project_id";
    IF delivery_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'planning task delivery unit must be active in the same project' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."module_id" IS NOT NULL THEN
    SELECT "status", "delivery_unit_id" INTO module_status, module_delivery_unit_id
      FROM "project_modules" WHERE "id" = NEW."module_id" AND "project_id" = NEW."project_id";
    IF module_status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'planning task module must be active in the same project' USING ERRCODE = '23514';
    END IF;
    IF NEW."delivery_unit_id" IS NOT NULL AND module_delivery_unit_id IS DISTINCT FROM NEW."delivery_unit_id" THEN
      RAISE EXCEPTION 'planning task module must belong to the selected delivery unit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_planning_task_update() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."code" IS DISTINCT FROM NEW."code"
    OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'planning task stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'closed planning task is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'NOT_STARTED' AND (
    OLD."wbs_node_id" IS DISTINCT FROM NEW."wbs_node_id"
    OR OLD."responsibility_package_id" IS DISTINCT FROM NEW."responsibility_package_id"
    OR OLD."delivery_unit_id" IS DISTINCT FROM NEW."delivery_unit_id"
    OR OLD."module_id" IS DISTINCT FROM NEW."module_id"
    OR OLD."owner_membership_id" IS DISTINCT FROM NEW."owner_membership_id"
    OR OLD."name" IS DISTINCT FROM NEW."name"
    OR OLD."description" IS DISTINCT FROM NEW."description"
    OR OLD."position" IS DISTINCT FROM NEW."position"
    OR OLD."planned_start_at" IS DISTINCT FROM NEW."planned_start_at"
    OR OLD."planned_finish_at" IS DISTINCT FROM NEW."planned_finish_at"
    OR OLD."planned_duration_minutes" IS DISTINCT FROM NEW."planned_duration_minutes"
    OR OLD."weight" IS DISTINCT FROM NEW."weight"
  ) THEN
    RAISE EXCEPTION 'planning task plan is editable only before work starts' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'CLOSED' THEN
    NULL;
  ELSIF NEW."status" NOT IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED') THEN
    RAISE EXCEPTION 'invalid planning task status transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'planning task version must advance once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_planning_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% must be closed instead of removed', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wbs_nodes_hierarchy_check
  BEFORE INSERT OR UPDATE OF "project_id", "parent_id" ON "wbs_nodes"
  FOR EACH ROW EXECUTE FUNCTION enforce_wbs_node_hierarchy();
CREATE TRIGGER wbs_nodes_update_check
  BEFORE UPDATE ON "wbs_nodes" FOR EACH ROW EXECUTE FUNCTION enforce_wbs_node_update();
CREATE TRIGGER wbs_nodes_reject_delete
  BEFORE DELETE ON "wbs_nodes" FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_removal();
CREATE TRIGGER wbs_nodes_reject_truncate
  BEFORE TRUNCATE ON "wbs_nodes" FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_removal();
CREATE TRIGGER planning_tasks_relation_check
  BEFORE INSERT OR UPDATE OF "project_id", "wbs_node_id", "responsibility_package_id", "delivery_unit_id", "module_id", "owner_membership_id"
  ON "planning_tasks" FOR EACH ROW EXECUTE FUNCTION enforce_planning_task_relations();
CREATE TRIGGER planning_tasks_update_check
  BEFORE UPDATE ON "planning_tasks" FOR EACH ROW EXECUTE FUNCTION enforce_planning_task_update();
CREATE TRIGGER planning_tasks_reject_delete
  BEFORE DELETE ON "planning_tasks" FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_removal();
CREATE TRIGGER planning_tasks_reject_truncate
  BEFORE TRUNCATE ON "planning_tasks" FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_removal();
