CREATE TYPE "ProjectMilestoneStatus" AS ENUM (
  'PENDING',
  'ACHIEVED',
  'VOID'
);

CREATE TYPE "ProjectMilestoneAchievementSource" AS ENUM (
  'MANUAL',
  'LINKED_TASKS'
);

CREATE TYPE "ProjectMilestoneEventType" AS ENUM (
  'CREATED',
  'UPDATED',
  'TASK_LINKED',
  'TASK_LINK_VOIDED',
  'ACHIEVED_MANUALLY',
  'ACHIEVED_FROM_LINKED_TASKS',
  'VOIDED'
);

CREATE TYPE "ProjectMilestoneTaskLinkStatus" AS ENUM (
  'ACTIVE',
  'VOID'
);

ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_MILESTONE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_MILESTONE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_MILESTONE_TASK_LINKED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_MILESTONE_TASK_LINK_VOIDED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_MILESTONE_ACHIEVED_MANUALLY';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_MILESTONE_ACHIEVED_FROM_LINKED_TASKS';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_MILESTONE_VOIDED';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_MILESTONE';

CREATE TABLE "project_milestones" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_snapshot_component_id" TEXT,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "position" INTEGER NOT NULL,
  "target_at" TIMESTAMP(3),
  "status" "ProjectMilestoneStatus" NOT NULL DEFAULT 'PENDING',
  "achievement_source" "ProjectMilestoneAchievementSource",
  "achieved_at" TIMESTAMP(3),
  "voided_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_milestones_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_milestones_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_.-]{1,99}$'),
  CONSTRAINT "project_milestones_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "project_milestones_description_check" CHECK ("description" IS NULL OR length(btrim("description")) BETWEEN 1 AND 2000),
  CONSTRAINT "project_milestones_position_check" CHECK ("position" BETWEEN 0 AND 1000000),
  CONSTRAINT "project_milestones_version_check" CHECK ("version" > 0),
  CONSTRAINT "project_milestones_achievement_check" CHECK (
    ("achievement_source" IS NULL) = ("achieved_at" IS NULL)
    AND (
      ("status" = 'PENDING' AND "achievement_source" IS NULL AND "voided_at" IS NULL)
      OR ("status" = 'ACHIEVED' AND "achievement_source" IS NOT NULL AND "voided_at" IS NULL)
      OR ("status" = 'VOID' AND "voided_at" IS NOT NULL)
    )
  )
);

CREATE TABLE "project_milestone_task_links" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "milestone_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "status" "ProjectMilestoneTaskLinkStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voided_by_id" TEXT,
  "voided_at" TIMESTAMP(3),
  "void_reason" TEXT,
  CONSTRAINT "project_milestone_task_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_milestone_task_links_void_check" CHECK (
    ("status" = 'ACTIVE' AND "voided_by_id" IS NULL AND "voided_at" IS NULL AND "void_reason" IS NULL)
    OR (
      "status" = 'VOID'
      AND "voided_by_id" IS NOT NULL
      AND "voided_at" IS NOT NULL
      AND length(btrim("void_reason")) BETWEEN 1 AND 1024
    )
  )
);

CREATE TABLE "project_milestone_events" (
  "id" TEXT NOT NULL,
  "milestone_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_type" "ProjectMilestoneEventType" NOT NULL,
  "from_status" "ProjectMilestoneStatus",
  "to_status" "ProjectMilestoneStatus" NOT NULL,
  "reason" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_milestone_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_milestone_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "project_milestone_events_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "project_milestone_events_snapshot_check" CHECK (jsonb_typeof("snapshot_json") = 'object'),
  CONSTRAINT "project_milestone_events_created_check" CHECK (
    "event_type" <> 'CREATED'
    OR ("from_status" IS NULL AND "to_status" = 'PENDING' AND "sequence" = 1)
  )
);

-- Composite keys are created before the corresponding project-scoped foreign keys.
CREATE UNIQUE INDEX "project_milestones_project_id_code_key"
  ON "project_milestones"("project_id", "code");
CREATE UNIQUE INDEX "project_milestones_id_project_id_key"
  ON "project_milestones"("id", "project_id");
CREATE INDEX "project_milestones_project_id_status_position_idx"
  ON "project_milestones"("project_id", "status", "position");
CREATE INDEX "project_milestones_source_snapshot_component_id_idx"
  ON "project_milestones"("source_snapshot_component_id");
CREATE UNIQUE INDEX "project_milestone_task_links_milestone_id_task_id_key"
  ON "project_milestone_task_links"("milestone_id", "task_id");
CREATE INDEX "project_milestone_task_links_milestone_id_status_idx"
  ON "project_milestone_task_links"("milestone_id", "status");
CREATE INDEX "project_milestone_task_links_task_id_status_idx"
  ON "project_milestone_task_links"("task_id", "status");
CREATE UNIQUE INDEX "project_milestone_events_milestone_id_sequence_key"
  ON "project_milestone_events"("milestone_id", "sequence");
CREATE INDEX "project_milestone_events_project_id_created_at_idx"
  ON "project_milestone_events"("project_id", "created_at");
CREATE INDEX "project_milestone_events_actor_id_created_at_idx"
  ON "project_milestone_events"("actor_id", "created_at");

ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_source_snapshot_component_id_fkey"
  FOREIGN KEY ("source_snapshot_component_id") REFERENCES "project_template_snapshot_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_milestone_task_links" ADD CONSTRAINT "project_milestone_task_links_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_milestone_task_links" ADD CONSTRAINT "project_milestone_task_links_milestone_id_project_id_fkey"
  FOREIGN KEY ("milestone_id", "project_id") REFERENCES "project_milestones"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_milestone_task_links" ADD CONSTRAINT "project_milestone_task_links_task_id_project_id_fkey"
  FOREIGN KEY ("task_id", "project_id") REFERENCES "planning_tasks"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_milestone_task_links" ADD CONSTRAINT "project_milestone_task_links_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_milestone_task_links" ADD CONSTRAINT "project_milestone_task_links_voided_by_id_fkey"
  FOREIGN KEY ("voided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_milestone_events" ADD CONSTRAINT "project_milestone_events_milestone_id_project_id_fkey"
  FOREIGN KEY ("milestone_id", "project_id") REFERENCES "project_milestones"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_milestone_events" ADD CONSTRAINT "project_milestone_events_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_milestone_events" ADD CONSTRAINT "project_milestone_events_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_project_milestone_task_link_project() RETURNS trigger AS $$
DECLARE
  milestone_project_id TEXT;
  task_project_id TEXT;
BEGIN
  SELECT "project_id" INTO milestone_project_id
    FROM "project_milestones" WHERE "id" = NEW."milestone_id";
  SELECT "project_id" INTO task_project_id
    FROM "planning_tasks" WHERE "id" = NEW."task_id";
  IF milestone_project_id IS NULL
    OR task_project_id IS NULL
    OR milestone_project_id IS DISTINCT FROM task_project_id
    OR milestone_project_id IS DISTINCT FROM NEW."project_id" THEN
    RAISE EXCEPTION 'project milestone task link requires milestone and task from the same project'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_project_milestone_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'project_milestone_events is append-only: % is forbidden', TG_OP
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_milestone_task_links_project_check
  BEFORE INSERT OR UPDATE OF "project_id", "milestone_id", "task_id"
  ON "project_milestone_task_links"
  FOR EACH ROW EXECUTE FUNCTION enforce_project_milestone_task_link_project();
CREATE TRIGGER project_milestone_events_reject_mutation
  BEFORE UPDATE OR DELETE ON "project_milestone_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_project_milestone_event_mutation();
CREATE TRIGGER project_milestone_events_reject_truncate
  BEFORE TRUNCATE ON "project_milestone_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_project_milestone_event_mutation();
