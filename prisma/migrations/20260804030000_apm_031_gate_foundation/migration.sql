CREATE TYPE "GateScope" AS ENUM ('PROJECT', 'DELIVERY_UNIT', 'MODULE');
CREATE TYPE "GateCheckStatus" AS ENUM ('PASSED', 'WARNING', 'HARD_FAILED');

ALTER TYPE "AuditAction" ADD VALUE 'GATE_DEFINITION_MATERIALIZED';
ALTER TYPE "AuditAction" ADD VALUE 'GATE_INSTANCE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'GATE_CHECK_RUN_COMPLETED';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_GATE_DEFINITION';
ALTER TYPE "AuditObjectType" ADD VALUE 'PROJECT_GATE_INSTANCE';
ALTER TYPE "AuditObjectType" ADD VALUE 'GATE_CHECK_SNAPSHOT';

CREATE TABLE "project_gate_definitions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_snapshot_component_id" TEXT NOT NULL,
  "project_stage_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "scope" "GateScope" NOT NULL,
  "definition_json" JSONB NOT NULL,
  "checker_bindings_json" JSONB NOT NULL,
  "definition_checksum" TEXT NOT NULL,
  "materialized_by_id" TEXT NOT NULL,
  "materialized_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_gate_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_gate_definitions_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_.-]{1,99}$'),
  CONSTRAINT "project_gate_definitions_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "project_gate_definitions_checksum_check" CHECK ("definition_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_gate_definitions_bindings_check" CHECK (jsonb_typeof("checker_bindings_json") = 'array')
);

CREATE TABLE "project_gate_instances" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "gate_definition_id" TEXT NOT NULL,
  "project_stage_id" TEXT NOT NULL,
  "scope" "GateScope" NOT NULL,
  "delivery_unit_id" TEXT,
  "module_id" TEXT,
  "check_run_sequence" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "project_gate_instances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_gate_instances_sequence_check" CHECK ("check_run_sequence" >= 0),
  CONSTRAINT "project_gate_instances_version_check" CHECK ("version" > 0),
  CONSTRAINT "project_gate_instances_scope_check" CHECK (("scope" = 'PROJECT' AND "delivery_unit_id" IS NULL AND "module_id" IS NULL) OR ("scope" = 'DELIVERY_UNIT' AND "delivery_unit_id" IS NOT NULL AND "module_id" IS NULL) OR ("scope" = 'MODULE' AND "delivery_unit_id" IS NOT NULL AND "module_id" IS NOT NULL))
);

CREATE TABLE "gate_check_snapshots" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "gate_instance_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "status" "GateCheckStatus" NOT NULL,
  "definition_snapshot" JSONB NOT NULL,
  "scope_snapshot" JSONB NOT NULL,
  "checker_bindings_json" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "input_checksum" TEXT NOT NULL,
  "result_checksum" TEXT NOT NULL,
  "checked_by_id" TEXT NOT NULL,
  "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gate_check_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gate_check_snapshots_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "gate_check_snapshots_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "gate_check_snapshots_checksum_check" CHECK ("input_checksum" ~ '^[0-9a-f]{64}$' AND "result_checksum" ~ '^[0-9a-f]{64}$')
);

CREATE TABLE "gate_check_results" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "gate_check_snapshot_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "checker_code" TEXT NOT NULL,
  "checker_version" INTEGER NOT NULL,
  "status" "GateCheckStatus" NOT NULL,
  "failure_code" TEXT,
  "message" TEXT NOT NULL,
  "evidence_json" JSONB NOT NULL,
  "evidence_checksum" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gate_check_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gate_check_results_position_check" CHECK ("position" >= 0),
  CONSTRAINT "gate_check_results_checker_check" CHECK ("checker_code" ~ '^[A-Z][A-Z0-9_.-]{1,99}$' AND "checker_version" > 0),
  CONSTRAINT "gate_check_results_message_check" CHECK (length(btrim("message")) BETWEEN 1 AND 2000),
  CONSTRAINT "gate_check_results_evidence_check" CHECK (jsonb_typeof("evidence_json") = 'object' AND "evidence_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "gate_check_results_failure_check" CHECK (("status" = 'HARD_FAILED' AND "failure_code" IS NOT NULL AND "failure_code" ~ '^[A-Z][A-Z0-9_.-]{1,99}$') OR ("status" <> 'HARD_FAILED' AND "failure_code" IS NULL))
);

CREATE UNIQUE INDEX "project_gate_definitions_project_id_code_key" ON "project_gate_definitions"("project_id", "code");
CREATE UNIQUE INDEX "project_gate_definitions_id_project_id_key" ON "project_gate_definitions"("id", "project_id");
CREATE UNIQUE INDEX "project_gate_instances_id_project_id_key" ON "project_gate_instances"("id", "project_id");
CREATE UNIQUE INDEX "project_gate_instances_project_definition_key" ON "project_gate_instances"("gate_definition_id") WHERE "scope" = 'PROJECT';
CREATE UNIQUE INDEX "project_gate_instances_delivery_unit_key" ON "project_gate_instances"("gate_definition_id", "delivery_unit_id") WHERE "scope" = 'DELIVERY_UNIT';
CREATE UNIQUE INDEX "project_gate_instances_module_key" ON "project_gate_instances"("gate_definition_id", "module_id") WHERE "scope" = 'MODULE';
CREATE UNIQUE INDEX "gate_check_snapshots_id_project_id_key" ON "gate_check_snapshots"("id", "project_id");
CREATE UNIQUE INDEX "gate_check_snapshots_instance_sequence_key" ON "gate_check_snapshots"("gate_instance_id", "sequence");
CREATE UNIQUE INDEX "gate_check_results_snapshot_position_key" ON "gate_check_results"("gate_check_snapshot_id", "position");

ALTER TABLE "project_gate_definitions"
  ADD CONSTRAINT "project_gate_definitions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_gate_definitions_snapshot_component_fkey" FOREIGN KEY ("source_snapshot_component_id") REFERENCES "project_template_snapshot_components"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_gate_definitions_stage_project_fkey" FOREIGN KEY ("project_stage_id", "project_id") REFERENCES "project_stages"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_gate_definitions_actor_fkey" FOREIGN KEY ("materialized_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_gate_instances"
  ADD CONSTRAINT "project_gate_instances_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_gate_instances_definition_fkey" FOREIGN KEY ("gate_definition_id", "project_id") REFERENCES "project_gate_definitions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_gate_instances_stage_fkey" FOREIGN KEY ("project_stage_id", "project_id") REFERENCES "project_stages"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_gate_instances_delivery_unit_fkey" FOREIGN KEY ("delivery_unit_id", "project_id") REFERENCES "delivery_units"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_gate_instances_module_fkey" FOREIGN KEY ("module_id", "project_id") REFERENCES "project_modules"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_gate_instances_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_gate_instances_updated_by_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gate_check_snapshots"
  ADD CONSTRAINT "gate_check_snapshots_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_check_snapshots_instance_fkey" FOREIGN KEY ("gate_instance_id", "project_id") REFERENCES "project_gate_instances"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_check_snapshots_actor_fkey" FOREIGN KEY ("checked_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "gate_check_results"
  ADD CONSTRAINT "gate_check_results_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gate_check_results_snapshot_fkey" FOREIGN KEY ("gate_check_snapshot_id", "project_id") REFERENCES "gate_check_snapshots"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_project_gate_definition_source() RETURNS trigger AS $$
DECLARE source_project_id TEXT; source_component_type "TemplateComponentType";
BEGIN
  SELECT snapshot."project_id", component."component_type" INTO source_project_id, source_component_type
    FROM "project_template_snapshot_components" component
    JOIN "project_template_snapshots" snapshot ON snapshot."id" = component."snapshot_id"
    WHERE component."id" = NEW."source_snapshot_component_id";
  IF source_project_id IS DISTINCT FROM NEW."project_id" OR source_component_type IS DISTINCT FROM 'GATE'::"TemplateComponentType" THEN
    RAISE EXCEPTION 'project Gate definition must use a same-project GATE snapshot component' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION enforce_project_gate_instance_scope() RETURNS trigger AS $$
DECLARE definition_scope "GateScope"; definition_stage_id TEXT; module_delivery_unit_id TEXT;
BEGIN
  SELECT "scope", "project_stage_id" INTO definition_scope, definition_stage_id FROM "project_gate_definitions" WHERE "id" = NEW."gate_definition_id";
  IF definition_scope IS DISTINCT FROM NEW."scope" OR definition_stage_id IS DISTINCT FROM NEW."project_stage_id" THEN RAISE EXCEPTION 'Gate instance scope and stage must match its definition' USING ERRCODE = '23514'; END IF;
  IF NEW."module_id" IS NOT NULL THEN SELECT "delivery_unit_id" INTO module_delivery_unit_id FROM "project_modules" WHERE "id" = NEW."module_id"; IF module_delivery_unit_id IS DISTINCT FROM NEW."delivery_unit_id" THEN RAISE EXCEPTION 'Gate module scope must name its owning delivery unit' USING ERRCODE = '23514'; END IF; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_project_gate_immutable_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000'; END;
$$ LANGUAGE plpgsql;
CREATE FUNCTION enforce_project_gate_instance_stability() RETURNS trigger AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id" OR OLD."project_id" IS DISTINCT FROM NEW."project_id" OR OLD."gate_definition_id" IS DISTINCT FROM NEW."gate_definition_id" OR OLD."project_stage_id" IS DISTINCT FROM NEW."project_stage_id" OR OLD."scope" IS DISTINCT FROM NEW."scope" OR OLD."delivery_unit_id" IS DISTINCT FROM NEW."delivery_unit_id" OR OLD."module_id" IS DISTINCT FROM NEW."module_id" OR OLD."created_by_id" IS DISTINCT FROM NEW."created_by_id" OR OLD."created_at" IS DISTINCT FROM NEW."created_at" THEN RAISE EXCEPTION 'project Gate instance stable identity is immutable' USING ERRCODE = '55000'; END IF;
  IF NEW."check_run_sequence" < OLD."check_run_sequence" OR NEW."version" <= OLD."version" THEN RAISE EXCEPTION 'project Gate instance must advance its check sequence and version' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_gate_definitions_source_check BEFORE INSERT OR UPDATE ON "project_gate_definitions" FOR EACH ROW EXECUTE FUNCTION enforce_project_gate_definition_source();
CREATE TRIGGER project_gate_instances_scope_check BEFORE INSERT OR UPDATE ON "project_gate_instances" FOR EACH ROW EXECUTE FUNCTION enforce_project_gate_instance_scope();
CREATE TRIGGER project_gate_instances_stability BEFORE UPDATE ON "project_gate_instances" FOR EACH ROW EXECUTE FUNCTION enforce_project_gate_instance_stability();
CREATE TRIGGER project_gate_definitions_reject_mutation BEFORE UPDATE OR DELETE ON "project_gate_definitions" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_gate_immutable_mutation();
CREATE TRIGGER project_gate_instances_reject_delete BEFORE DELETE ON "project_gate_instances" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_gate_immutable_mutation();
CREATE TRIGGER gate_check_snapshots_reject_mutation BEFORE UPDATE OR DELETE ON "gate_check_snapshots" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_gate_immutable_mutation();
CREATE TRIGGER gate_check_results_reject_mutation BEFORE UPDATE OR DELETE ON "gate_check_results" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_gate_immutable_mutation();
CREATE TRIGGER project_gate_definitions_reject_truncate BEFORE TRUNCATE ON "project_gate_definitions" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_gate_immutable_mutation();
CREATE TRIGGER project_gate_instances_reject_truncate BEFORE TRUNCATE ON "project_gate_instances" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_gate_immutable_mutation();
CREATE TRIGGER gate_check_snapshots_reject_truncate BEFORE TRUNCATE ON "gate_check_snapshots" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_gate_immutable_mutation();
CREATE TRIGGER gate_check_results_reject_truncate BEFORE TRUNCATE ON "gate_check_results" FOR EACH STATEMENT EXECUTE FUNCTION reject_project_gate_immutable_mutation();
