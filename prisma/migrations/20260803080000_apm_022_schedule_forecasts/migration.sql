-- APM-022 adds versioned asynchronous schedule recalculation and immutable CPM results.
-- Plan baselines, formal changes, and project progress projections remain out of scope.
CREATE TYPE "ScheduleRecalculationStatus" AS ENUM (
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SUPERSEDED'
);

CREATE TABLE "schedule_recalculations" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "input_version" INTEGER NOT NULL,
  "status" "ScheduleRecalculationStatus" NOT NULL DEFAULT 'PENDING',
  "algorithm_version" TEXT NOT NULL,
  "source_action" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "requested_by_id" TEXT NOT NULL,
  "calendar_revision_id" TEXT,
  "input_checksum" TEXT,
  "input_snapshot" JSONB,
  "result_checksum" TEXT,
  "task_count" INTEGER,
  "dependency_count" INTEGER,
  "error_code" TEXT,
  "error_message" TEXT,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "schedule_recalculations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "schedule_recalculations_input_version_check" CHECK ("input_version" > 0),
  CONSTRAINT "schedule_recalculations_algorithm_version_check" CHECK (length(btrim("algorithm_version")) BETWEEN 1 AND 100),
  CONSTRAINT "schedule_recalculations_source_action_check" CHECK (length(btrim("source_action")) BETWEEN 1 AND 191),
  CONSTRAINT "schedule_recalculations_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "schedule_recalculations_input_checksum_check" CHECK ("input_checksum" IS NULL OR "input_checksum" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "schedule_recalculations_result_checksum_check" CHECK ("result_checksum" IS NULL OR "result_checksum" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "schedule_recalculations_counts_check" CHECK (
    ("task_count" IS NULL OR "task_count" >= 0)
    AND ("dependency_count" IS NULL OR "dependency_count" >= 0)
  ),
  CONSTRAINT "schedule_recalculations_error_check" CHECK (
    ("error_code" IS NULL AND "error_message" IS NULL)
    OR (
      length(btrim("error_code")) BETWEEN 1 AND 100
      AND length(btrim("error_message")) BETWEEN 1 AND 2048
    )
  )
);

CREATE TABLE "project_schedule_states" (
  "project_id" TEXT NOT NULL,
  "input_version" INTEGER NOT NULL DEFAULT 0,
  "latest_published_input_version" INTEGER,
  "latest_published_recalculation_id" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_schedule_states_pkey" PRIMARY KEY ("project_id"),
  CONSTRAINT "project_schedule_states_input_version_check" CHECK ("input_version" >= 0),
  CONSTRAINT "project_schedule_states_publication_pointer_check" CHECK (
    ("latest_published_input_version" IS NULL) = ("latest_published_recalculation_id" IS NULL)
    AND (
      "latest_published_input_version" IS NULL
      OR "latest_published_input_version" BETWEEN 1 AND "input_version"
    )
  )
);

CREATE TABLE "schedule_task_forecasts" (
  "id" TEXT NOT NULL,
  "recalculation_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "duration_minutes" INTEGER NOT NULL,
  "predicted_start_at" TIMESTAMP(3) NOT NULL,
  "predicted_finish_at" TIMESTAMP(3) NOT NULL,
  "latest_start_at" TIMESTAMP(3) NOT NULL,
  "latest_finish_at" TIMESTAMP(3) NOT NULL,
  "total_float_minutes" INTEGER NOT NULL,
  "is_critical" BOOLEAN NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "schedule_task_forecasts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "schedule_task_forecasts_position_check" CHECK ("position" >= 0),
  CONSTRAINT "schedule_task_forecasts_duration_check" CHECK ("duration_minutes" > 0),
  CONSTRAINT "schedule_task_forecasts_dates_check" CHECK (
    "predicted_start_at" <= "predicted_finish_at"
    AND "latest_start_at" <= "latest_finish_at"
  ),
  CONSTRAINT "schedule_task_forecasts_critical_check" CHECK (
    "is_critical" = ("total_float_minutes" <= 0)
  )
);

CREATE UNIQUE INDEX "schedule_recalculations_project_id_input_version_key"
  ON "schedule_recalculations"("project_id", "input_version");
CREATE UNIQUE INDEX "schedule_recalculations_id_project_id_key"
  ON "schedule_recalculations"("id", "project_id");
CREATE INDEX "schedule_recalculations_project_id_status_requested_at_idx"
  ON "schedule_recalculations"("project_id", "status", "requested_at");
CREATE INDEX "schedule_recalculations_status_requested_at_idx"
  ON "schedule_recalculations"("status", "requested_at");
CREATE UNIQUE INDEX "project_schedule_states_latest_published_recalculation_id_key"
  ON "project_schedule_states"("latest_published_recalculation_id");
CREATE INDEX "project_schedule_states_input_version_idx"
  ON "project_schedule_states"("input_version");
CREATE UNIQUE INDEX "schedule_task_forecasts_recalculation_id_task_id_key"
  ON "schedule_task_forecasts"("recalculation_id", "task_id");
CREATE INDEX "schedule_task_forecasts_project_id_is_critical_position_idx"
  ON "schedule_task_forecasts"("project_id", "is_critical", "position");
CREATE INDEX "schedule_task_forecasts_project_id_task_id_created_at_idx"
  ON "schedule_task_forecasts"("project_id", "task_id", "created_at");

ALTER TABLE "schedule_recalculations" ADD CONSTRAINT "schedule_recalculations_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "schedule_recalculations" ADD CONSTRAINT "schedule_recalculations_requested_by_id_fkey"
  FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "schedule_recalculations" ADD CONSTRAINT "schedule_recalculations_calendar_revision_id_fkey"
  FOREIGN KEY ("calendar_revision_id") REFERENCES "project_calendar_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_schedule_states" ADD CONSTRAINT "project_schedule_states_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_schedule_states" ADD CONSTRAINT "project_schedule_states_latest_published_recalculation_id_fkey"
  FOREIGN KEY ("latest_published_recalculation_id") REFERENCES "schedule_recalculations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "schedule_task_forecasts" ADD CONSTRAINT "schedule_task_forecasts_recalculation_id_project_id_fkey"
  FOREIGN KEY ("recalculation_id", "project_id") REFERENCES "schedule_recalculations"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "schedule_task_forecasts" ADD CONSTRAINT "schedule_task_forecasts_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "schedule_task_forecasts" ADD CONSTRAINT "schedule_task_forecasts_task_id_project_id_fkey"
  FOREIGN KEY ("task_id", "project_id") REFERENCES "planning_tasks"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_project_schedule_state_update() RETURNS trigger AS $$
BEGIN
  IF OLD."project_id" IS DISTINCT FROM NEW."project_id" THEN
    RAISE EXCEPTION 'project schedule state identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."input_version" NOT IN (OLD."input_version", OLD."input_version" + 1) THEN
    RAISE EXCEPTION 'project schedule input version must remain or advance once' USING ERRCODE = '23514';
  END IF;
  IF NEW."input_version" = OLD."input_version" + 1
    AND (
      NEW."latest_published_input_version" IS DISTINCT FROM OLD."latest_published_input_version"
      OR NEW."latest_published_recalculation_id" IS DISTINCT FROM OLD."latest_published_recalculation_id"
    ) THEN
    RAISE EXCEPTION 'schedule input advance cannot publish a result' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_project_schedule_publication() RETURNS trigger AS $$
DECLARE
  published_project_id TEXT;
  published_input_version INTEGER;
  published_status "ScheduleRecalculationStatus";
BEGIN
  IF NEW."latest_published_recalculation_id" IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT "project_id", "input_version", "status"
    INTO published_project_id, published_input_version, published_status
    FROM "schedule_recalculations"
    WHERE "id" = NEW."latest_published_recalculation_id";
  IF published_project_id IS DISTINCT FROM NEW."project_id"
    OR published_input_version IS DISTINCT FROM NEW."latest_published_input_version"
    OR published_status IS DISTINCT FROM 'SUCCEEDED' THEN
    RAISE EXCEPTION 'published schedule result must be a successful version of the same project' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_schedule_recalculation_update() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."input_version" IS DISTINCT FROM NEW."input_version"
    OR OLD."algorithm_version" IS DISTINCT FROM NEW."algorithm_version"
    OR OLD."source_action" IS DISTINCT FROM NEW."source_action"
    OR OLD."reason" IS DISTINCT FROM NEW."reason"
    OR OLD."requested_by_id" IS DISTINCT FROM NEW."requested_by_id"
    OR OLD."requested_at" IS DISTINCT FROM NEW."requested_at" THEN
    RAISE EXCEPTION 'schedule recalculation request identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('SUCCEEDED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'terminal schedule recalculation is immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('RUNNING', 'FAILED', 'SUPERSEDED'))
    OR (OLD."status" = 'RUNNING' AND NEW."status" IN ('SUCCEEDED', 'FAILED', 'SUPERSEDED'))
    OR (OLD."status" = 'FAILED' AND NEW."status" IN ('RUNNING', 'FAILED', 'SUPERSEDED'))
  ) THEN
    RAISE EXCEPTION 'invalid schedule recalculation status transition' USING ERRCODE = '23514';
  END IF;
  IF OLD."input_checksum" IS NOT NULL AND (
    OLD."calendar_revision_id" IS DISTINCT FROM NEW."calendar_revision_id"
    OR OLD."input_checksum" IS DISTINCT FROM NEW."input_checksum"
    OR OLD."input_snapshot" IS DISTINCT FROM NEW."input_snapshot"
    OR OLD."task_count" IS DISTINCT FROM NEW."task_count"
    OR OLD."dependency_count" IS DISTINCT FROM NEW."dependency_count"
  ) THEN
    RAISE EXCEPTION 'schedule recalculation input snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'RUNNING' AND (
    NEW."started_at" IS NULL
    OR NEW."calendar_revision_id" IS NULL
    OR NEW."input_checksum" IS NULL
    OR NEW."input_snapshot" IS NULL
    OR NEW."task_count" IS NULL
    OR NEW."dependency_count" IS NULL
    OR NEW."completed_at" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'running schedule recalculation requires a complete input snapshot' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'SUCCEEDED' AND (
    NEW."completed_at" IS NULL
    OR NEW."result_checksum" IS NULL
    OR NEW."error_code" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'successful schedule recalculation requires a result' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'FAILED' AND (
    NEW."completed_at" IS NULL
    OR NEW."error_code" IS NULL
    OR NEW."result_checksum" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'failed schedule recalculation requires an error' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'SUPERSEDED' AND NEW."completed_at" IS NULL THEN
    RAISE EXCEPTION 'superseded schedule recalculation requires completion time' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_schedule_task_forecast_insert() RETURNS trigger AS $$
DECLARE
  recalculation_status "ScheduleRecalculationStatus";
BEGIN
  SELECT "status" INTO recalculation_status
    FROM "schedule_recalculations"
    WHERE "id" = NEW."recalculation_id" AND "project_id" = NEW."project_id";
  IF recalculation_status IS DISTINCT FROM 'RUNNING' THEN
    RAISE EXCEPTION 'schedule forecasts can only be written by a running recalculation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_schedule_fact_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_schedule_states_update_check
  BEFORE UPDATE ON "project_schedule_states" FOR EACH ROW EXECUTE FUNCTION enforce_project_schedule_state_update();
CREATE CONSTRAINT TRIGGER project_schedule_states_publication_check
  AFTER INSERT OR UPDATE OF "latest_published_input_version", "latest_published_recalculation_id"
  ON "project_schedule_states" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_project_schedule_publication();
CREATE TRIGGER project_schedule_states_reject_delete
  BEFORE DELETE ON "project_schedule_states" FOR EACH STATEMENT EXECUTE FUNCTION reject_schedule_fact_removal();
CREATE TRIGGER project_schedule_states_reject_truncate
  BEFORE TRUNCATE ON "project_schedule_states" FOR EACH STATEMENT EXECUTE FUNCTION reject_schedule_fact_removal();
CREATE TRIGGER schedule_recalculations_update_check
  BEFORE UPDATE ON "schedule_recalculations" FOR EACH ROW EXECUTE FUNCTION enforce_schedule_recalculation_update();
CREATE TRIGGER schedule_recalculations_reject_delete
  BEFORE DELETE ON "schedule_recalculations" FOR EACH STATEMENT EXECUTE FUNCTION reject_schedule_fact_removal();
CREATE TRIGGER schedule_recalculations_reject_truncate
  BEFORE TRUNCATE ON "schedule_recalculations" FOR EACH STATEMENT EXECUTE FUNCTION reject_schedule_fact_removal();
CREATE TRIGGER schedule_task_forecasts_insert_check
  BEFORE INSERT ON "schedule_task_forecasts" FOR EACH ROW EXECUTE FUNCTION validate_schedule_task_forecast_insert();
CREATE TRIGGER schedule_task_forecasts_reject_update
  BEFORE UPDATE ON "schedule_task_forecasts" FOR EACH STATEMENT EXECUTE FUNCTION reject_schedule_fact_removal();
CREATE TRIGGER schedule_task_forecasts_reject_delete
  BEFORE DELETE ON "schedule_task_forecasts" FOR EACH STATEMENT EXECUTE FUNCTION reject_schedule_fact_removal();
CREATE TRIGGER schedule_task_forecasts_reject_truncate
  BEFORE TRUNCATE ON "schedule_task_forecasts" FOR EACH STATEMENT EXECUTE FUNCTION reject_schedule_fact_removal();
