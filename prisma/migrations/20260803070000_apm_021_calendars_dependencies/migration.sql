-- APM-021 adds versioned project work calendars and FS/SS/FF task dependencies.
-- Forecast calculation, CPM, recalculation jobs, baselines, and progress projections remain out of scope.
CREATE TYPE "PlanningCalendarStatus" AS ENUM ('ACTIVE', 'CLOSED');
CREATE TYPE "TaskDependencyStatus" AS ENUM ('ACTIVE', 'CLOSED');
CREATE TYPE "TaskDependencyType" AS ENUM ('FS', 'SS', 'FF');

ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_CALENDAR_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_CALENDAR_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'PROJECT_CALENDAR_CLOSED';
ALTER TYPE "AuditAction" ADD VALUE 'TASK_DEPENDENCY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'TASK_DEPENDENCY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'TASK_DEPENDENCY_CLOSED';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_CALENDAR';
ALTER TYPE "AuditObjectType" ADD VALUE 'TASK_DEPENDENCY';

CREATE TABLE "project_calendars" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "status" "PlanningCalendarStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "closed_at" TIMESTAMP(3),
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_calendars_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_calendars_version_check" CHECK ("version" > 0),
  CONSTRAINT "project_calendars_closed_check" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL))
);

CREATE TABLE "project_calendar_revisions" (
  "id" TEXT NOT NULL,
  "calendar_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "time_zone" TEXT NOT NULL,
  "weekly_rules" JSONB NOT NULL,
  "exceptions" JSONB NOT NULL,
  "checksum" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_calendar_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_calendar_revisions_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "project_calendar_revisions_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "project_calendar_revisions_timezone_check" CHECK (length(btrim("time_zone")) BETWEEN 1 AND 100),
  CONSTRAINT "project_calendar_revisions_checksum_check" CHECK ("checksum" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "project_calendar_revisions_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024)
);

CREATE TABLE "task_dependencies" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "predecessor_task_id" TEXT NOT NULL,
  "successor_task_id" TEXT NOT NULL,
  "dependency_type" "TaskDependencyType" NOT NULL,
  "lag_minutes" INTEGER NOT NULL DEFAULT 0,
  "status" "TaskDependencyStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "closed_at" TIMESTAMP(3),
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_dependencies_distinct_tasks_check" CHECK ("predecessor_task_id" <> "successor_task_id"),
  CONSTRAINT "task_dependencies_lag_check" CHECK ("lag_minutes" BETWEEN -5256000 AND 5256000),
  CONSTRAINT "task_dependencies_version_check" CHECK ("version" > 0),
  CONSTRAINT "task_dependencies_closed_check" CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "project_calendars_project_id_key" ON "project_calendars"("project_id");
CREATE UNIQUE INDEX "project_calendars_id_project_id_key" ON "project_calendars"("id", "project_id");
CREATE INDEX "project_calendars_status_updated_at_idx" ON "project_calendars"("status", "updated_at");
CREATE UNIQUE INDEX "project_calendar_revisions_calendar_id_revision_key" ON "project_calendar_revisions"("calendar_id", "revision");
CREATE INDEX "project_calendar_revisions_project_id_revision_idx" ON "project_calendar_revisions"("project_id", "revision");
CREATE INDEX "project_calendar_revisions_checksum_idx" ON "project_calendar_revisions"("checksum");
CREATE UNIQUE INDEX "task_dependencies_project_id_predecessor_task_id_successor_task_id_key"
  ON "task_dependencies"("project_id", "predecessor_task_id", "successor_task_id");
CREATE UNIQUE INDEX "task_dependencies_id_project_id_key" ON "task_dependencies"("id", "project_id");
CREATE INDEX "task_dependencies_project_id_status_predecessor_task_id_idx"
  ON "task_dependencies"("project_id", "status", "predecessor_task_id");
CREATE INDEX "task_dependencies_project_id_status_successor_task_id_idx"
  ON "task_dependencies"("project_id", "status", "successor_task_id");

ALTER TABLE "project_calendars" ADD CONSTRAINT "project_calendars_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_calendars" ADD CONSTRAINT "project_calendars_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_calendars" ADD CONSTRAINT "project_calendars_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_calendar_revisions" ADD CONSTRAINT "project_calendar_revisions_calendar_id_project_id_fkey"
  FOREIGN KEY ("calendar_id", "project_id") REFERENCES "project_calendars"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_calendar_revisions" ADD CONSTRAINT "project_calendar_revisions_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_calendar_revisions" ADD CONSTRAINT "project_calendar_revisions_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_predecessor_task_id_project_id_fkey"
  FOREIGN KEY ("predecessor_task_id", "project_id") REFERENCES "planning_tasks"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_successor_task_id_project_id_fkey"
  FOREIGN KEY ("successor_task_id", "project_id") REFERENCES "planning_tasks"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION valid_work_intervals(intervals JSONB, allow_empty BOOLEAN) RETURNS BOOLEAN AS $$
DECLARE
  interval_value JSONB;
BEGIN
  IF jsonb_typeof(intervals) IS DISTINCT FROM 'array'
    OR jsonb_array_length(intervals) > 8
    OR (NOT allow_empty AND jsonb_array_length(intervals) = 0) THEN
    RETURN FALSE;
  END IF;
  FOR interval_value IN SELECT value FROM jsonb_array_elements(intervals) LOOP
    IF jsonb_typeof(interval_value) IS DISTINCT FROM 'object'
      OR NOT (interval_value ? 'startMinute')
      OR NOT (interval_value ? 'endMinute')
      OR (SELECT count(*) FROM jsonb_object_keys(interval_value)) <> 2
      OR jsonb_typeof(interval_value->'startMinute') IS DISTINCT FROM 'number'
      OR jsonb_typeof(interval_value->'endMinute') IS DISTINCT FROM 'number'
      OR (interval_value->>'startMinute') !~ '^\d{1,4}$'
      OR (interval_value->>'endMinute') !~ '^\d{1,4}$'
      OR (interval_value->>'startMinute')::INTEGER < 0
      OR (interval_value->>'endMinute')::INTEGER > 1440
      OR (interval_value->>'startMinute')::INTEGER >= (interval_value->>'endMinute')::INTEGER THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(intervals) WITH ORDINALITY first_interval(value, ordinal)
    JOIN jsonb_array_elements(intervals) WITH ORDINALITY second_interval(value, ordinal)
      ON first_interval.ordinal < second_interval.ordinal
    WHERE (first_interval.value->>'startMinute')::INTEGER < (second_interval.value->>'endMinute')::INTEGER
      AND (second_interval.value->>'startMinute')::INTEGER < (first_interval.value->>'endMinute')::INTEGER
  ) THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE FUNCTION validate_project_calendar_revision() RETURNS trigger AS $$
DECLARE
  calendar_version INTEGER;
  calendar_status "PlanningCalendarStatus";
  day_rule JSONB;
  day_number INTEGER;
  seen_days INTEGER[] := ARRAY[]::INTEGER[];
  exception_rule JSONB;
  exception_date TEXT;
  parsed_date DATE;
  seen_dates TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT "version", "status" INTO calendar_version, calendar_status
    FROM "project_calendars"
    WHERE "id" = NEW."calendar_id" AND "project_id" = NEW."project_id";
  IF calendar_version IS DISTINCT FROM NEW."revision" OR calendar_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'calendar revision must match the active calendar version' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW."time_zone") THEN
    RAISE EXCEPTION 'calendar time zone must be an IANA time zone' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(NEW."weekly_rules") IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW."weekly_rules") NOT BETWEEN 1 AND 7 THEN
    RAISE EXCEPTION 'calendar weekly rules must contain one to seven days' USING ERRCODE = '23514';
  END IF;
  FOR day_rule IN SELECT value FROM jsonb_array_elements(NEW."weekly_rules") LOOP
    IF jsonb_typeof(day_rule) IS DISTINCT FROM 'object'
      OR NOT (day_rule ? 'dayOfWeek')
      OR NOT (day_rule ? 'intervals')
      OR (SELECT count(*) FROM jsonb_object_keys(day_rule)) <> 2
      OR jsonb_typeof(day_rule->'dayOfWeek') IS DISTINCT FROM 'number'
      OR (day_rule->>'dayOfWeek') !~ '^[1-7]$'
      OR NOT valid_work_intervals(day_rule->'intervals', FALSE) THEN
      RAISE EXCEPTION 'calendar weekly rule is invalid' USING ERRCODE = '23514';
    END IF;
    day_number := (day_rule->>'dayOfWeek')::INTEGER;
    IF array_position(seen_days, day_number) IS NOT NULL THEN
      RAISE EXCEPTION 'calendar weekday is duplicated' USING ERRCODE = '23514';
    END IF;
    seen_days := array_append(seen_days, day_number);
  END LOOP;
  IF jsonb_typeof(NEW."exceptions") IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW."exceptions") > 3660 THEN
    RAISE EXCEPTION 'calendar exceptions must be an array of at most 3660 dates' USING ERRCODE = '23514';
  END IF;
  FOR exception_rule IN SELECT value FROM jsonb_array_elements(NEW."exceptions") LOOP
    IF jsonb_typeof(exception_rule) IS DISTINCT FROM 'object'
      OR NOT (exception_rule ? 'date')
      OR NOT (exception_rule ? 'intervals')
      OR (SELECT count(*) FROM jsonb_object_keys(exception_rule)) <> 2
      OR jsonb_typeof(exception_rule->'date') IS DISTINCT FROM 'string'
      OR NOT valid_work_intervals(exception_rule->'intervals', TRUE) THEN
      RAISE EXCEPTION 'calendar exception is invalid' USING ERRCODE = '23514';
    END IF;
    exception_date := exception_rule->>'date';
    IF exception_date !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'calendar exception date is invalid' USING ERRCODE = '23514';
    END IF;
    BEGIN
      parsed_date := exception_date::DATE;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'calendar exception date is invalid' USING ERRCODE = '23514';
    END;
    IF to_char(parsed_date, 'YYYY-MM-DD') <> exception_date
      OR array_position(seen_dates, exception_date) IS NOT NULL THEN
      RAISE EXCEPTION 'calendar exception date is invalid or duplicated' USING ERRCODE = '23514';
    END IF;
    seen_dates := array_append(seen_dates, exception_date);
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_project_calendar_update() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'project calendar stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'closed project calendar is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'CLOSED' THEN
    NULL;
  ELSIF NEW."status" IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'invalid project calendar status transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'project calendar version must advance once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_calendar_revision_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'project calendar revisions are append-only: % is forbidden', TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_task_dependency_relations() RETURNS trigger AS $$
DECLARE
  predecessor_status "PlanningTaskStatus";
  successor_status "PlanningTaskStatus";
BEGIN
  IF NEW."status" <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;
  SELECT "status" INTO predecessor_status FROM "planning_tasks"
    WHERE "id" = NEW."predecessor_task_id" AND "project_id" = NEW."project_id";
  SELECT "status" INTO successor_status FROM "planning_tasks"
    WHERE "id" = NEW."successor_task_id" AND "project_id" = NEW."project_id";
  IF predecessor_status IS NULL OR predecessor_status = 'CLOSED'
    OR successor_status IS NULL OR successor_status = 'CLOSED' THEN
    RAISE EXCEPTION 'task dependency requires active tasks in the same project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_task_dependency_acyclic() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'ACTIVE' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."project_id", 0));
  IF NEW."predecessor_task_id" = NEW."successor_task_id" OR EXISTS (
    WITH RECURSIVE reachable("task_id") AS (
      SELECT dependency."successor_task_id"
      FROM "task_dependencies" dependency
      WHERE dependency."project_id" = NEW."project_id"
        AND dependency."status" = 'ACTIVE'
        AND dependency."predecessor_task_id" = NEW."successor_task_id"
        AND dependency."id" <> NEW."id"
      UNION
      SELECT dependency."successor_task_id"
      FROM "task_dependencies" dependency
      JOIN reachable ON dependency."predecessor_task_id" = reachable."task_id"
      WHERE dependency."project_id" = NEW."project_id"
        AND dependency."status" = 'ACTIVE'
        AND dependency."id" <> NEW."id"
    )
    SELECT 1 FROM reachable WHERE "task_id" = NEW."predecessor_task_id"
  ) THEN
    RAISE EXCEPTION 'task dependency graph cannot contain a cycle' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_task_dependency_update() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."predecessor_task_id" IS DISTINCT FROM NEW."predecessor_task_id"
    OR OLD."successor_task_id" IS DISTINCT FROM NEW."successor_task_id"
    OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'task dependency stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'closed task dependency is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'CLOSED' THEN
    NULL;
  ELSIF NEW."status" IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'invalid task dependency status transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'task dependency version must advance once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION prevent_task_close_with_active_dependencies() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> 'CLOSED' AND NEW."status" = 'CLOSED' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW."project_id", 0));
  END IF;
  IF OLD."status" <> 'CLOSED' AND NEW."status" = 'CLOSED' AND EXISTS (
    SELECT 1 FROM "task_dependencies" dependency
    WHERE dependency."project_id" = NEW."project_id"
      AND dependency."status" = 'ACTIVE'
      AND (dependency."predecessor_task_id" = NEW."id" OR dependency."successor_task_id" = NEW."id")
  ) THEN
    RAISE EXCEPTION 'planning task with active dependencies cannot be closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_planning_schedule_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% must be closed instead of removed', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_calendars_update_check
  BEFORE UPDATE ON "project_calendars" FOR EACH ROW EXECUTE FUNCTION enforce_project_calendar_update();
CREATE TRIGGER project_calendars_reject_delete
  BEFORE DELETE ON "project_calendars" FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_schedule_removal();
CREATE TRIGGER project_calendars_reject_truncate
  BEFORE TRUNCATE ON "project_calendars" FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_schedule_removal();
CREATE TRIGGER project_calendar_revisions_validate
  BEFORE INSERT ON "project_calendar_revisions" FOR EACH ROW EXECUTE FUNCTION validate_project_calendar_revision();
CREATE TRIGGER project_calendar_revisions_reject_update
  BEFORE UPDATE ON "project_calendar_revisions" FOR EACH STATEMENT EXECUTE FUNCTION reject_calendar_revision_mutation();
CREATE TRIGGER project_calendar_revisions_reject_delete
  BEFORE DELETE ON "project_calendar_revisions" FOR EACH STATEMENT EXECUTE FUNCTION reject_calendar_revision_mutation();
CREATE TRIGGER project_calendar_revisions_reject_truncate
  BEFORE TRUNCATE ON "project_calendar_revisions" FOR EACH STATEMENT EXECUTE FUNCTION reject_calendar_revision_mutation();
CREATE TRIGGER task_dependencies_acyclic_check
  BEFORE INSERT OR UPDATE OF "predecessor_task_id", "successor_task_id", "status" ON "task_dependencies"
  FOR EACH ROW EXECUTE FUNCTION enforce_task_dependency_acyclic();
CREATE TRIGGER task_dependencies_relation_check
  BEFORE INSERT OR UPDATE OF "project_id", "predecessor_task_id", "successor_task_id", "status" ON "task_dependencies"
  FOR EACH ROW EXECUTE FUNCTION enforce_task_dependency_relations();
CREATE TRIGGER task_dependencies_update_check
  BEFORE UPDATE ON "task_dependencies" FOR EACH ROW EXECUTE FUNCTION enforce_task_dependency_update();
CREATE TRIGGER task_dependencies_reject_delete
  BEFORE DELETE ON "task_dependencies" FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_schedule_removal();
CREATE TRIGGER task_dependencies_reject_truncate
  BEFORE TRUNCATE ON "task_dependencies" FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_schedule_removal();
CREATE TRIGGER planning_tasks_dependency_close_check
  BEFORE UPDATE OF "status" ON "planning_tasks"
  FOR EACH ROW EXECUTE FUNCTION prevent_task_close_with_active_dependencies();
