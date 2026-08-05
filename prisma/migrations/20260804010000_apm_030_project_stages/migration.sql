CREATE TYPE "ProjectStageExecutionStatus" AS ENUM (
  'NOT_STARTED',
  'AUTHORIZED',
  'IN_PROGRESS',
  'AWAITING_GATE',
  'COMPLETED',
  'CONDITIONALLY_RELEASED',
  'SKIPPED'
);

CREATE TYPE "ProjectStageEventType" AS ENUM (
  'CREATED',
  'AUTHORIZED',
  'STARTED',
  'AWAITING_GATE',
  'COMPLETED',
  'CONDITIONALLY_RELEASED',
  'SKIPPED'
);

CREATE TYPE "StageReleaseAuthorizationScope" AS ENUM ('PROJECT', 'DELIVERY_UNIT');
CREATE TYPE "StageReleaseAuthorizationStatus" AS ENUM ('ACTIVE', 'REVOKED');

ALTER TABLE "projects"
  ADD COLUMN "main_control_stage_id" TEXT,
  ADD COLUMN "main_control_stage_project_id" TEXT,
  ADD COLUMN "main_control_stage_code" TEXT,
  ADD COLUMN "main_control_stage_status" "ProjectStageExecutionStatus",
  ADD COLUMN "main_control_stage_sequence" INTEGER,
  ADD COLUMN "main_control_stage_updated_at" TIMESTAMP(3),
  ADD CONSTRAINT "projects_main_control_stage_summary_check" CHECK (
    (
      "main_control_stage_id" IS NULL
      AND "main_control_stage_project_id" IS NULL
      AND "main_control_stage_code" IS NULL
      AND "main_control_stage_status" IS NULL
      AND "main_control_stage_sequence" IS NULL
      AND "main_control_stage_updated_at" IS NULL
    ) OR (
      "main_control_stage_id" IS NOT NULL
      AND "main_control_stage_project_id" = "id"
      AND "main_control_stage_code" IS NOT NULL
      AND "main_control_stage_status" IS NOT NULL
      AND "main_control_stage_sequence" IS NOT NULL
      AND "main_control_stage_sequence" >= 0
      AND "main_control_stage_updated_at" IS NOT NULL
    )
  );

CREATE UNIQUE INDEX "projects_main_control_stage_id_main_control_stage_project_id_key"
  ON "projects"("main_control_stage_id", "main_control_stage_project_id");

CREATE TABLE "project_stages" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_snapshot_component_id" TEXT,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "sequence" INTEGER NOT NULL,
  "status" "ProjectStageExecutionStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "exceptional_reason" TEXT,
  "status_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_stages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_stages_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_.-]{1,99}$'),
  CONSTRAINT "project_stages_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "project_stages_description_check" CHECK ("description" IS NULL OR length(btrim("description")) BETWEEN 1 AND 2000),
  CONSTRAINT "project_stages_sequence_check" CHECK ("sequence" BETWEEN 0 AND 1000000),
  CONSTRAINT "project_stages_version_check" CHECK ("version" > 0),
  CONSTRAINT "project_stages_exception_reason_check" CHECK (
    (
      "status" IN ('CONDITIONALLY_RELEASED', 'SKIPPED')
      AND "exceptional_reason" IS NOT NULL
      AND length(btrim("exceptional_reason")) BETWEEN 1 AND 1024
    ) OR (
      "status" NOT IN ('CONDITIONALLY_RELEASED', 'SKIPPED')
      AND "exceptional_reason" IS NULL
    )
  )
);

CREATE TABLE "delivery_unit_stages" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "delivery_unit_id" TEXT NOT NULL,
  "project_stage_id" TEXT NOT NULL,
  "status" "ProjectStageExecutionStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "exceptional_reason" TEXT,
  "status_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "delivery_unit_stages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "delivery_unit_stages_version_check" CHECK ("version" > 0),
  CONSTRAINT "delivery_unit_stages_exception_reason_check" CHECK (
    (
      "status" IN ('CONDITIONALLY_RELEASED', 'SKIPPED')
      AND "exceptional_reason" IS NOT NULL
      AND length(btrim("exceptional_reason")) BETWEEN 1 AND 1024
    ) OR (
      "status" NOT IN ('CONDITIONALLY_RELEASED', 'SKIPPED')
      AND "exceptional_reason" IS NULL
    )
  )
);

CREATE TABLE "stage_release_authorizations" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "scope" "StageReleaseAuthorizationScope" NOT NULL,
  "status" "StageReleaseAuthorizationStatus" NOT NULL DEFAULT 'ACTIVE',
  "from_project_stage_id" TEXT NOT NULL,
  "to_project_stage_id" TEXT NOT NULL,
  "delivery_unit_id" TEXT,
  "reason" TEXT NOT NULL,
  "authorized_by_id" TEXT NOT NULL,
  "authorized_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_by_id" TEXT,
  "revoked_at" TIMESTAMP(3),
  "revocation_reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stage_release_authorizations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stage_release_authorizations_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "stage_release_authorizations_version_check" CHECK ("version" > 0),
  CONSTRAINT "stage_release_authorizations_scope_check" CHECK (
    ("scope" = 'PROJECT' AND "delivery_unit_id" IS NULL)
    OR ("scope" = 'DELIVERY_UNIT' AND "delivery_unit_id" IS NOT NULL)
  ),
  CONSTRAINT "stage_release_authorizations_revocation_check" CHECK (
    ("status" = 'ACTIVE' AND "revoked_by_id" IS NULL AND "revoked_at" IS NULL AND "revocation_reason" IS NULL)
    OR (
      "status" = 'REVOKED'
      AND "revoked_by_id" IS NOT NULL
      AND "revoked_at" IS NOT NULL
      AND "revocation_reason" IS NOT NULL
      AND length(btrim("revocation_reason")) BETWEEN 1 AND 1024
    )
  )
);

CREATE TABLE "project_stage_events" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "project_stage_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_type" "ProjectStageEventType" NOT NULL,
  "from_status" "ProjectStageExecutionStatus",
  "to_status" "ProjectStageExecutionStatus" NOT NULL,
  "reason" TEXT,
  "snapshot_json" JSONB NOT NULL,
  "actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_stage_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_stage_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "project_stage_events_reason_check" CHECK (
    (
      "to_status" IN ('CONDITIONALLY_RELEASED', 'SKIPPED')
      AND "reason" IS NOT NULL
      AND length(btrim("reason")) BETWEEN 1 AND 1024
    ) OR (
      "to_status" NOT IN ('CONDITIONALLY_RELEASED', 'SKIPPED')
      AND ("reason" IS NULL OR length(btrim("reason")) BETWEEN 1 AND 1024)
    )
  ),
  CONSTRAINT "project_stage_events_snapshot_check" CHECK (jsonb_typeof("snapshot_json") = 'object'),
  CONSTRAINT "project_stage_events_created_check" CHECK (
    "event_type" <> 'CREATED'
    OR ("from_status" IS NULL AND "to_status" = 'NOT_STARTED' AND "sequence" = 1)
  )
);

CREATE UNIQUE INDEX "project_stages_project_id_code_key" ON "project_stages"("project_id", "code");
CREATE UNIQUE INDEX "project_stages_project_id_sequence_key" ON "project_stages"("project_id", "sequence");
CREATE UNIQUE INDEX "project_stages_id_project_id_key" ON "project_stages"("id", "project_id");
CREATE INDEX "project_stages_project_id_status_sequence_idx" ON "project_stages"("project_id", "status", "sequence");
CREATE INDEX "project_stages_source_snapshot_component_id_idx" ON "project_stages"("source_snapshot_component_id");
CREATE UNIQUE INDEX "delivery_unit_stages_delivery_unit_id_project_stage_id_key"
  ON "delivery_unit_stages"("delivery_unit_id", "project_stage_id");
CREATE UNIQUE INDEX "delivery_unit_stages_id_project_id_key" ON "delivery_unit_stages"("id", "project_id");
CREATE INDEX "delivery_unit_stages_project_id_status_delivery_unit_id_idx"
  ON "delivery_unit_stages"("project_id", "status", "delivery_unit_id");
CREATE INDEX "delivery_unit_stages_project_stage_id_status_idx"
  ON "delivery_unit_stages"("project_stage_id", "status");
CREATE UNIQUE INDEX "stage_release_authorizations_id_project_id_key"
  ON "stage_release_authorizations"("id", "project_id");
CREATE UNIQUE INDEX "stage_release_authorizations_active_project_key"
  ON "stage_release_authorizations"("project_id", "from_project_stage_id", "to_project_stage_id")
  WHERE "scope" = 'PROJECT' AND "status" = 'ACTIVE';
CREATE UNIQUE INDEX "stage_release_authorizations_active_delivery_unit_key"
  ON "stage_release_authorizations"("delivery_unit_id", "from_project_stage_id", "to_project_stage_id")
  WHERE "scope" = 'DELIVERY_UNIT' AND "status" = 'ACTIVE';
CREATE INDEX "stage_release_authorizations_project_scope_status_idx"
  ON "stage_release_authorizations"("project_id", "scope", "status", "from_project_stage_id", "to_project_stage_id");
CREATE INDEX "stage_release_authorizations_delivery_unit_id_status_idx"
  ON "stage_release_authorizations"("delivery_unit_id", "status");
CREATE INDEX "stage_release_authorizations_authorized_by_id_authorized_at_idx"
  ON "stage_release_authorizations"("authorized_by_id", "authorized_at");
CREATE UNIQUE INDEX "project_stage_events_project_stage_id_sequence_key"
  ON "project_stage_events"("project_stage_id", "sequence");
CREATE INDEX "project_stage_events_project_id_created_at_idx"
  ON "project_stage_events"("project_id", "created_at");
CREATE INDEX "project_stage_events_actor_id_created_at_idx"
  ON "project_stage_events"("actor_id", "created_at");

ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_source_snapshot_component_id_fkey"
  FOREIGN KEY ("source_snapshot_component_id") REFERENCES "project_template_snapshot_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_unit_stages" ADD CONSTRAINT "delivery_unit_stages_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_unit_stages" ADD CONSTRAINT "delivery_unit_stages_delivery_unit_id_project_id_fkey"
  FOREIGN KEY ("delivery_unit_id", "project_id") REFERENCES "delivery_units"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_unit_stages" ADD CONSTRAINT "delivery_unit_stages_project_stage_id_project_id_fkey"
  FOREIGN KEY ("project_stage_id", "project_id") REFERENCES "project_stages"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_unit_stages" ADD CONSTRAINT "delivery_unit_stages_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_unit_stages" ADD CONSTRAINT "delivery_unit_stages_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stage_release_authorizations" ADD CONSTRAINT "stage_release_authorizations_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stage_release_authorizations" ADD CONSTRAINT "stage_release_authorizations_from_project_stage_id_project_id_fkey"
  FOREIGN KEY ("from_project_stage_id", "project_id") REFERENCES "project_stages"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stage_release_authorizations" ADD CONSTRAINT "stage_release_authorizations_to_project_stage_id_project_id_fkey"
  FOREIGN KEY ("to_project_stage_id", "project_id") REFERENCES "project_stages"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stage_release_authorizations" ADD CONSTRAINT "stage_release_authorizations_delivery_unit_id_project_id_fkey"
  FOREIGN KEY ("delivery_unit_id", "project_id") REFERENCES "delivery_units"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stage_release_authorizations" ADD CONSTRAINT "stage_release_authorizations_authorized_by_id_fkey"
  FOREIGN KEY ("authorized_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stage_release_authorizations" ADD CONSTRAINT "stage_release_authorizations_revoked_by_id_fkey"
  FOREIGN KEY ("revoked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_stage_events" ADD CONSTRAINT "project_stage_events_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_stage_events" ADD CONSTRAINT "project_stage_events_project_stage_id_project_id_fkey"
  FOREIGN KEY ("project_stage_id", "project_id") REFERENCES "project_stages"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_stage_events" ADD CONSTRAINT "project_stage_events_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_main_control_stage_id_project_id_fkey"
  FOREIGN KEY ("main_control_stage_id", "main_control_stage_project_id")
  REFERENCES "project_stages"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_project_stage_source_component() RETURNS trigger AS $$
DECLARE
  source_project_id TEXT;
  source_component_type "TemplateComponentType";
BEGIN
  IF NEW."source_snapshot_component_id" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT snapshot."project_id", component."component_type"
    INTO source_project_id, source_component_type
    FROM "project_template_snapshot_components" component
    JOIN "project_template_snapshots" snapshot ON snapshot."id" = component."snapshot_id"
    WHERE component."id" = NEW."source_snapshot_component_id";
  IF source_project_id IS NULL
    OR source_project_id IS DISTINCT FROM NEW."project_id"
    OR source_component_type IS DISTINCT FROM 'STAGE' THEN
    RAISE EXCEPTION 'project stage source must be a stage component from the same project'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_stage_release_authorization() RETURNS trigger AS $$
DECLARE
  from_project_id TEXT;
  next_project_id TEXT;
  from_sequence INTEGER;
  next_sequence INTEGER;
  delivery_unit_project_id TEXT;
BEGIN
  SELECT "project_id", "sequence" INTO from_project_id, from_sequence
    FROM "project_stages" WHERE "id" = NEW."from_project_stage_id";
  SELECT "project_id", "sequence" INTO next_project_id, next_sequence
    FROM "project_stages" WHERE "id" = NEW."to_project_stage_id";
  IF from_project_id IS NULL
    OR next_project_id IS NULL
    OR from_project_id IS DISTINCT FROM next_project_id
    OR from_project_id IS DISTINCT FROM NEW."project_id"
    OR next_sequence IS DISTINCT FROM from_sequence + 1 THEN
    RAISE EXCEPTION 'stage release authorization requires adjacent stages from the same project'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."delivery_unit_id" IS NOT NULL THEN
    SELECT "project_id" INTO delivery_unit_project_id
      FROM "delivery_units" WHERE "id" = NEW."delivery_unit_id";
    IF delivery_unit_project_id IS NULL
      OR delivery_unit_project_id IS DISTINCT FROM NEW."project_id" THEN
      RAISE EXCEPTION 'delivery-unit stage release authorization requires the same project'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_project_main_control_stage_summary() RETURNS trigger AS $$
DECLARE
  stage_code TEXT;
  stage_status "ProjectStageExecutionStatus";
  stage_sequence INTEGER;
  stage_project_id TEXT;
  stage_changed_at TIMESTAMP(3);
BEGIN
  IF NEW."main_control_stage_id" IS NULL THEN
    IF NEW."main_control_stage_project_id" IS NOT NULL
      OR NEW."main_control_stage_code" IS NOT NULL
      OR NEW."main_control_stage_status" IS NOT NULL
      OR NEW."main_control_stage_sequence" IS NOT NULL
      OR NEW."main_control_stage_updated_at" IS NOT NULL THEN
      RAISE EXCEPTION 'project main-control stage summary must be complete or empty' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."main_control_stage_project_id" IS DISTINCT FROM NEW."id" THEN
    RAISE EXCEPTION 'project main-control stage must belong to the same project' USING ERRCODE = '23514';
  END IF;
  SELECT "project_id", "code", "status", "sequence", "status_changed_at"
    INTO stage_project_id, stage_code, stage_status, stage_sequence, stage_changed_at
    FROM "project_stages"
    WHERE "id" = NEW."main_control_stage_id";
  IF stage_project_id IS NULL
    OR stage_project_id IS DISTINCT FROM NEW."id"
    OR stage_code IS DISTINCT FROM NEW."main_control_stage_code"
    OR stage_status IS DISTINCT FROM NEW."main_control_stage_status"
    OR stage_sequence IS DISTINCT FROM NEW."main_control_stage_sequence"
    OR stage_changed_at IS DISTINCT FROM NEW."main_control_stage_updated_at" THEN
    RAISE EXCEPTION 'project main-control stage summary does not match the referenced stage' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_project_stage_stable_identity() RETURNS trigger AS $$
BEGIN
  IF OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."source_snapshot_component_id" IS DISTINCT FROM NEW."source_snapshot_component_id"
    OR OLD."code" IS DISTINCT FROM NEW."code"
    OR OLD."name" IS DISTINCT FROM NEW."name"
    OR OLD."description" IS DISTINCT FROM NEW."description"
    OR OLD."sequence" IS DISTINCT FROM NEW."sequence"
    OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'project stage stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_delivery_unit_stage_stable_identity() RETURNS trigger AS $$
BEGIN
  IF OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."delivery_unit_id" IS DISTINCT FROM NEW."delivery_unit_id"
    OR OLD."project_stage_id" IS DISTINCT FROM NEW."project_stage_id"
    OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'delivery unit stage stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_stage_release_authorization_stability() RETURNS trigger AS $$
BEGIN
  IF OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."scope" IS DISTINCT FROM NEW."scope"
    OR OLD."from_project_stage_id" IS DISTINCT FROM NEW."from_project_stage_id"
    OR OLD."to_project_stage_id" IS DISTINCT FROM NEW."to_project_stage_id"
    OR OLD."delivery_unit_id" IS DISTINCT FROM NEW."delivery_unit_id"
    OR OLD."reason" IS DISTINCT FROM NEW."reason"
    OR OLD."authorized_by_id" IS DISTINCT FROM NEW."authorized_by_id"
    OR OLD."authorized_at" IS DISTINCT FROM NEW."authorized_at"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'stage release authorization stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'REVOKED' OR NEW."status" = 'ACTIVE' THEN
    RAISE EXCEPTION 'stage release authorization can only be revoked once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_project_stage_fact_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% must be closed, skipped, or revoked instead of removed', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_project_stage_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'project_stage_events is append-only: % is forbidden', TG_OP
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_stages_source_component_check
  BEFORE INSERT OR UPDATE OF "project_id", "source_snapshot_component_id"
  ON "project_stages" FOR EACH ROW EXECUTE FUNCTION enforce_project_stage_source_component();
CREATE TRIGGER projects_main_control_stage_summary_check
  BEFORE INSERT OR UPDATE OF "main_control_stage_id", "main_control_stage_project_id", "main_control_stage_code", "main_control_stage_status", "main_control_stage_sequence", "main_control_stage_updated_at"
  ON "projects" FOR EACH ROW EXECUTE FUNCTION enforce_project_main_control_stage_summary();
CREATE TRIGGER project_stages_stable_identity
  BEFORE UPDATE ON "project_stages" FOR EACH ROW EXECUTE FUNCTION enforce_project_stage_stable_identity();
CREATE TRIGGER delivery_unit_stages_stable_identity
  BEFORE UPDATE ON "delivery_unit_stages" FOR EACH ROW EXECUTE FUNCTION enforce_delivery_unit_stage_stable_identity();
CREATE TRIGGER stage_release_authorizations_validate
  BEFORE INSERT OR UPDATE OF "project_id", "scope", "from_project_stage_id", "to_project_stage_id", "delivery_unit_id"
  ON "stage_release_authorizations" FOR EACH ROW EXECUTE FUNCTION enforce_stage_release_authorization();
CREATE TRIGGER stage_release_authorizations_stable_identity
  BEFORE UPDATE ON "stage_release_authorizations" FOR EACH ROW EXECUTE FUNCTION enforce_stage_release_authorization_stability();
CREATE TRIGGER project_stage_events_reject_mutation
  BEFORE UPDATE OR DELETE ON "project_stage_events" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_stage_event_mutation();
CREATE TRIGGER project_stage_events_reject_truncate
  BEFORE TRUNCATE ON "project_stage_events" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_stage_event_mutation();
CREATE TRIGGER project_stages_reject_delete
  BEFORE DELETE ON "project_stages" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_stage_fact_removal();
CREATE TRIGGER project_stages_reject_truncate
  BEFORE TRUNCATE ON "project_stages" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_stage_fact_removal();
CREATE TRIGGER delivery_unit_stages_reject_delete
  BEFORE DELETE ON "delivery_unit_stages" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_stage_fact_removal();
CREATE TRIGGER delivery_unit_stages_reject_truncate
  BEFORE TRUNCATE ON "delivery_unit_stages" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_stage_fact_removal();
CREATE TRIGGER stage_release_authorizations_reject_delete
  BEFORE DELETE ON "stage_release_authorizations" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_stage_fact_removal();
CREATE TRIGGER stage_release_authorizations_reject_truncate
  BEFORE TRUNCATE ON "stage_release_authorizations" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_stage_fact_removal();
