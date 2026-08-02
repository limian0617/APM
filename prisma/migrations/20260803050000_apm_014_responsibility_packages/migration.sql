CREATE TYPE "ResponsibilityPackageStatus" AS ENUM (
  'OPEN',
  'ACCEPTANCE_PENDING',
  'ACCEPTED',
  'CLOSED'
);

CREATE TYPE "ResponsibilityPackageEventType" AS ENUM (
  'CREATED',
  'ACCEPTANCE_SUBMITTED',
  'ACCEPTED',
  'REOPENED',
  'CLOSED'
);

ALTER TYPE "AuditAction" ADD VALUE 'RESPONSIBILITY_PACKAGE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'RESPONSIBILITY_PACKAGE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'RESPONSIBILITY_PACKAGE_ACCEPTANCE_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE 'RESPONSIBILITY_PACKAGE_ACCEPTED';
ALTER TYPE "AuditAction" ADD VALUE 'RESPONSIBILITY_PACKAGE_REOPENED';
ALTER TYPE "AuditAction" ADD VALUE 'RESPONSIBILITY_PACKAGE_CLOSED';
ALTER TYPE "AuditObjectType" ADD VALUE 'RESPONSIBILITY_PACKAGE';

CREATE UNIQUE INDEX "project_modules_id_project_id_key"
  ON "project_modules"("id", "project_id");

CREATE TABLE "responsibility_packages" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "delivery_unit_id" TEXT,
  "module_id" TEXT,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "owner_membership_id" TEXT NOT NULL,
  "inputs_json" JSONB NOT NULL,
  "outputs_json" JSONB NOT NULL,
  "acceptance_criteria_json" JSONB NOT NULL,
  "value_weight" INTEGER NOT NULL,
  "status" "ResponsibilityPackageStatus" NOT NULL DEFAULT 'OPEN',
  "acceptance_cycle" INTEGER NOT NULL DEFAULT 0,
  "transition_sequence" INTEGER NOT NULL DEFAULT 1,
  "accepted_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "responsibility_packages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "responsibility_packages_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_.-]{1,99}$'),
  CONSTRAINT "responsibility_packages_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "responsibility_packages_description_check" CHECK ("description" IS NULL OR length(btrim("description")) BETWEEN 1 AND 2000),
  CONSTRAINT "responsibility_packages_inputs_check" CHECK (jsonb_typeof("inputs_json") = 'array' AND jsonb_array_length("inputs_json") BETWEEN 1 AND 100),
  CONSTRAINT "responsibility_packages_outputs_check" CHECK (jsonb_typeof("outputs_json") = 'array' AND jsonb_array_length("outputs_json") BETWEEN 1 AND 100),
  CONSTRAINT "responsibility_packages_acceptance_check" CHECK (jsonb_typeof("acceptance_criteria_json") = 'array' AND jsonb_array_length("acceptance_criteria_json") BETWEEN 1 AND 100),
  CONSTRAINT "responsibility_packages_weight_check" CHECK ("value_weight" BETWEEN 1 AND 1000000),
  CONSTRAINT "responsibility_packages_version_check" CHECK ("version" > 0),
  CONSTRAINT "responsibility_packages_cycle_check" CHECK ("acceptance_cycle" >= 0),
  CONSTRAINT "responsibility_packages_sequence_check" CHECK ("transition_sequence" > 0),
  CONSTRAINT "responsibility_packages_time_check" CHECK (
    ("status" <> 'ACCEPTED' OR "accepted_at" IS NOT NULL)
    AND ("status" <> 'CLOSED' OR "closed_at" IS NOT NULL)
    AND ("status" = 'CLOSED' OR "closed_at" IS NULL)
  )
);

CREATE TABLE "responsibility_package_events" (
  "id" TEXT NOT NULL,
  "package_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "acceptance_cycle" INTEGER NOT NULL,
  "event_type" "ResponsibilityPackageEventType" NOT NULL,
  "from_status" "ResponsibilityPackageStatus",
  "to_status" "ResponsibilityPackageStatus" NOT NULL,
  "resource_version" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "responsibility_package_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "responsibility_package_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "responsibility_package_events_cycle_check" CHECK ("acceptance_cycle" >= 0),
  CONSTRAINT "responsibility_package_events_version_check" CHECK ("resource_version" > 0),
  CONSTRAINT "responsibility_package_events_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "responsibility_package_events_snapshot_check" CHECK (jsonb_typeof("snapshot_json") = 'object'),
  CONSTRAINT "responsibility_package_events_transition_check" CHECK (
    ("event_type" = 'CREATED' AND "from_status" IS NULL AND "to_status" = 'OPEN' AND "acceptance_cycle" = 0)
    OR ("event_type" = 'ACCEPTANCE_SUBMITTED' AND "from_status" = 'OPEN' AND "to_status" = 'ACCEPTANCE_PENDING' AND "acceptance_cycle" > 0)
    OR ("event_type" = 'ACCEPTED' AND "from_status" = 'ACCEPTANCE_PENDING' AND "to_status" = 'ACCEPTED' AND "acceptance_cycle" > 0)
    OR ("event_type" = 'REOPENED' AND "from_status" = 'ACCEPTED' AND "to_status" = 'OPEN' AND "acceptance_cycle" > 0)
    OR ("event_type" = 'CLOSED' AND "from_status" IN ('OPEN', 'ACCEPTED') AND "to_status" = 'CLOSED')
  )
);

CREATE UNIQUE INDEX "responsibility_packages_project_id_code_key"
  ON "responsibility_packages"("project_id", "code");
CREATE UNIQUE INDEX "responsibility_packages_id_project_id_key"
  ON "responsibility_packages"("id", "project_id");
CREATE INDEX "responsibility_packages_project_id_status_code_idx"
  ON "responsibility_packages"("project_id", "status", "code");
CREATE INDEX "responsibility_packages_owner_membership_id_status_idx"
  ON "responsibility_packages"("owner_membership_id", "status");
CREATE INDEX "responsibility_packages_delivery_unit_id_status_idx"
  ON "responsibility_packages"("delivery_unit_id", "status");
CREATE INDEX "responsibility_packages_module_id_status_idx"
  ON "responsibility_packages"("module_id", "status");
CREATE UNIQUE INDEX "responsibility_package_events_package_id_sequence_key"
  ON "responsibility_package_events"("package_id", "sequence");
CREATE INDEX "responsibility_package_events_project_id_created_at_idx"
  ON "responsibility_package_events"("project_id", "created_at");
CREATE INDEX "responsibility_package_events_actor_id_created_at_idx"
  ON "responsibility_package_events"("actor_id", "created_at");

ALTER TABLE "responsibility_packages" ADD CONSTRAINT "responsibility_packages_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "responsibility_packages" ADD CONSTRAINT "responsibility_packages_delivery_unit_id_project_id_fkey"
  FOREIGN KEY ("delivery_unit_id", "project_id") REFERENCES "delivery_units"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "responsibility_packages" ADD CONSTRAINT "responsibility_packages_module_id_project_id_fkey"
  FOREIGN KEY ("module_id", "project_id") REFERENCES "project_modules"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "responsibility_packages" ADD CONSTRAINT "responsibility_packages_owner_membership_id_fkey"
  FOREIGN KEY ("owner_membership_id") REFERENCES "project_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "responsibility_packages" ADD CONSTRAINT "responsibility_packages_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "responsibility_packages" ADD CONSTRAINT "responsibility_packages_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "responsibility_package_events" ADD CONSTRAINT "responsibility_package_events_package_id_project_id_fkey"
  FOREIGN KEY ("package_id", "project_id") REFERENCES "responsibility_packages"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "responsibility_package_events" ADD CONSTRAINT "responsibility_package_events_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_responsibility_package_relations() RETURNS trigger AS $$
DECLARE
  owner_project_id TEXT;
  owner_left_at TIMESTAMP(3);
  owner_status "UserStatus";
  module_delivery_unit_id TEXT;
BEGIN
  SELECT member."project_id", member."left_at", actor."status"
    INTO owner_project_id, owner_left_at, owner_status
    FROM "project_members" member
    JOIN "users" actor ON actor."id" = member."user_id"
    WHERE member."id" = NEW."owner_membership_id";
  IF owner_project_id IS DISTINCT FROM NEW."project_id"
    OR owner_left_at IS NOT NULL
    OR owner_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'responsibility package owner must be an active member of the same project' USING ERRCODE = '23514';
  END IF;

  IF NEW."module_id" IS NOT NULL THEN
    SELECT "delivery_unit_id" INTO module_delivery_unit_id
      FROM "project_modules"
      WHERE "id" = NEW."module_id" AND "project_id" = NEW."project_id";
    IF module_delivery_unit_id IS NULL THEN
      RAISE EXCEPTION 'responsibility package module must belong to the same project' USING ERRCODE = '23514';
    END IF;
    IF NEW."delivery_unit_id" IS NOT NULL
      AND NEW."delivery_unit_id" IS DISTINCT FROM module_delivery_unit_id THEN
      RAISE EXCEPTION 'responsibility package module must belong to the selected delivery unit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_responsibility_package_transition() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
    OR OLD."code" IS DISTINCT FROM NEW."code"
    OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id"
    OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN
    RAISE EXCEPTION 'responsibility package stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'CLOSED' THEN
    RAISE EXCEPTION 'closed responsibility package is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'OPEN' AND (
    OLD."delivery_unit_id" IS DISTINCT FROM NEW."delivery_unit_id"
    OR OLD."module_id" IS DISTINCT FROM NEW."module_id"
    OR OLD."name" IS DISTINCT FROM NEW."name"
    OR OLD."description" IS DISTINCT FROM NEW."description"
    OR OLD."owner_membership_id" IS DISTINCT FROM NEW."owner_membership_id"
    OR OLD."inputs_json" IS DISTINCT FROM NEW."inputs_json"
    OR OLD."outputs_json" IS DISTINCT FROM NEW."outputs_json"
    OR OLD."acceptance_criteria_json" IS DISTINCT FROM NEW."acceptance_criteria_json"
    OR OLD."value_weight" IS DISTINCT FROM NEW."value_weight"
  ) THEN
    RAISE EXCEPTION 'responsibility package content is editable only while open' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IS DISTINCT FROM NEW."status" THEN
    IF NOT (
      (OLD."status" = 'OPEN' AND NEW."status" IN ('ACCEPTANCE_PENDING', 'CLOSED'))
      OR (OLD."status" = 'ACCEPTANCE_PENDING' AND NEW."status" = 'ACCEPTED')
      OR (OLD."status" = 'ACCEPTED' AND NEW."status" IN ('OPEN', 'CLOSED'))
    ) THEN
      RAISE EXCEPTION 'invalid responsibility package status transition' USING ERRCODE = '23514';
    END IF;
    IF NEW."transition_sequence" <> OLD."transition_sequence" + 1 THEN
      RAISE EXCEPTION 'responsibility package transition sequence must advance once' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."transition_sequence" IS DISTINCT FROM OLD."transition_sequence" THEN
    RAISE EXCEPTION 'responsibility package transition sequence requires a status change' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'ACCEPTANCE_PENDING' THEN
    IF NEW."acceptance_cycle" <> OLD."acceptance_cycle" + 1 THEN
      RAISE EXCEPTION 'acceptance submission must start the next cycle' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."acceptance_cycle" IS DISTINCT FROM OLD."acceptance_cycle" THEN
    RAISE EXCEPTION 'acceptance cycle can change only on submission' USING ERRCODE = '23514';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'responsibility package version must advance once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_responsibility_package_event() RETURNS trigger AS $$
DECLARE
  current_package "responsibility_packages"%ROWTYPE;
BEGIN
  SELECT * INTO current_package
    FROM "responsibility_packages"
    WHERE "id" = NEW."package_id" AND "project_id" = NEW."project_id";
  IF current_package."id" IS NULL
    OR current_package."status" IS DISTINCT FROM NEW."to_status"
    OR current_package."version" IS DISTINCT FROM NEW."resource_version"
    OR current_package."acceptance_cycle" IS DISTINCT FROM NEW."acceptance_cycle"
    OR current_package."transition_sequence" IS DISTINCT FROM NEW."sequence" THEN
    RAISE EXCEPTION 'responsibility package event must snapshot the current transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_responsibility_package_removal() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is durable and cannot be removed', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER responsibility_packages_relation_check
  BEFORE INSERT OR UPDATE OF "project_id", "delivery_unit_id", "module_id", "owner_membership_id"
  ON "responsibility_packages"
  FOR EACH ROW EXECUTE FUNCTION enforce_responsibility_package_relations();
CREATE TRIGGER responsibility_packages_transition_check
  BEFORE UPDATE ON "responsibility_packages"
  FOR EACH ROW EXECUTE FUNCTION enforce_responsibility_package_transition();
CREATE TRIGGER responsibility_packages_reject_delete
  BEFORE DELETE ON "responsibility_packages"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_responsibility_package_removal();
CREATE TRIGGER responsibility_packages_reject_truncate
  BEFORE TRUNCATE ON "responsibility_packages"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_responsibility_package_removal();
CREATE TRIGGER responsibility_package_events_snapshot_check
  BEFORE INSERT ON "responsibility_package_events"
  FOR EACH ROW EXECUTE FUNCTION enforce_responsibility_package_event();
CREATE TRIGGER responsibility_package_events_reject_mutation
  BEFORE UPDATE OR DELETE ON "responsibility_package_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_responsibility_package_removal();
CREATE TRIGGER responsibility_package_events_reject_truncate
  BEFORE TRUNCATE ON "responsibility_package_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_responsibility_package_removal();
