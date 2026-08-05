-- APM-061 AST-001 internal R&D projects and enterprise technical-asset master records.
-- Asset releases, component snapshots, delivery-project usage/derivation, and upgrade/recall
-- relationships are intentionally deferred to APM-062 through APM-064.
CREATE TYPE "RndProjectStatus" AS ENUM (
  'PROPOSED', 'IN_DEVELOPMENT', 'VALIDATION', 'RELEASE_REVIEW', 'COMPLETED', 'CANCELED'
);
CREATE TYPE "RndProjectEventType" AS ENUM ('CREATED', 'STATUS_CHANGED');
CREATE TYPE "TechnicalAssetType" AS ENUM ('MECHANICAL', 'ELECTRICAL', 'SOFTWARE');
CREATE TYPE "TechnicalAssetStatus" AS ENUM (
  'DRAFT', 'VALIDATION_PENDING', 'VALIDATED', 'CANCELED'
);
CREATE TYPE "TechnicalAssetEventType" AS ENUM ('CREATED', 'STATUS_CHANGED', 'VALIDATED');
CREATE TYPE "TechnicalAssetValidationDecision" AS ENUM ('PASSED', 'FAILED');

ALTER TYPE "AuditAction" ADD VALUE 'RND_PROJECT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'RND_PROJECT_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'TECHNICAL_ASSET_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'TECHNICAL_ASSET_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'TECHNICAL_ASSET_VALIDATED';
ALTER TYPE "AuditObjectType" ADD VALUE 'RND_PROJECT';
ALTER TYPE "AuditObjectType" ADD VALUE 'RND_PROJECT_EVENT';
ALTER TYPE "AuditObjectType" ADD VALUE 'TECHNICAL_ASSET';
ALTER TYPE "AuditObjectType" ADD VALUE 'TECHNICAL_ASSET_EVENT';
ALTER TYPE "AuditObjectType" ADD VALUE 'TECHNICAL_ASSET_VALIDATION';

CREATE TABLE "rnd_projects" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "department_id" TEXT,
  "owner_id" TEXT NOT NULL,
  "status" "RndProjectStatus" NOT NULL DEFAULT 'PROPOSED',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "rnd_projects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rnd_projects_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9._-]{2,100}$'),
  CONSTRAINT "rnd_projects_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "rnd_projects_description_check" CHECK (
    "description" IS NULL OR length(btrim("description")) BETWEEN 1 AND 2000
  ),
  CONSTRAINT "rnd_projects_version_check" CHECK ("version" > 0)
);

CREATE TABLE "rnd_project_events" (
  "id" TEXT NOT NULL,
  "rnd_project_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_type" "RndProjectEventType" NOT NULL,
  "from_status" "RndProjectStatus",
  "to_status" "RndProjectStatus" NOT NULL,
  "reason" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rnd_project_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rnd_project_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "rnd_project_events_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "rnd_project_events_created_check" CHECK (
    ("event_type" = 'CREATED' AND "sequence" = 1 AND "from_status" IS NULL AND "to_status" = 'PROPOSED')
    OR ("event_type" = 'STATUS_CHANGED' AND "from_status" IS NOT NULL)
  )
);

CREATE TABLE "technical_assets" (
  "id" TEXT NOT NULL,
  "rnd_project_id" TEXT NOT NULL,
  "asset_number" TEXT NOT NULL,
  "asset_type" "TechnicalAssetType" NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "owner_id" TEXT NOT NULL,
  "status" "TechnicalAssetStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "technical_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "technical_assets_asset_number_check" CHECK (
    "asset_number" ~ '^[A-Z][A-Z0-9._-]{2,100}$'
  ),
  CONSTRAINT "technical_assets_name_check" CHECK (length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "technical_assets_description_check" CHECK (
    "description" IS NULL OR length(btrim("description")) BETWEEN 1 AND 2000
  ),
  CONSTRAINT "technical_assets_version_check" CHECK ("version" > 0)
);

CREATE TABLE "technical_asset_events" (
  "id" TEXT NOT NULL,
  "rnd_project_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_type" "TechnicalAssetEventType" NOT NULL,
  "from_status" "TechnicalAssetStatus",
  "to_status" "TechnicalAssetStatus" NOT NULL,
  "reason" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "technical_asset_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "technical_asset_events_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "technical_asset_events_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "technical_asset_events_created_check" CHECK (
    ("event_type" = 'CREATED' AND "sequence" = 1 AND "from_status" IS NULL AND "to_status" = 'DRAFT')
    OR ("event_type" = 'STATUS_CHANGED' AND "from_status" IS NOT NULL)
    OR ("event_type" = 'VALIDATED' AND "from_status" = 'VALIDATION_PENDING' AND "to_status" IN ('VALIDATED', 'DRAFT'))
  )
);

CREATE TABLE "technical_asset_validations" (
  "id" TEXT NOT NULL,
  "rnd_project_id" TEXT NOT NULL,
  "technical_asset_id" TEXT NOT NULL,
  "asset_version" INTEGER NOT NULL,
  "decision" "TechnicalAssetValidationDecision" NOT NULL,
  "evidence" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "validator_id" TEXT NOT NULL,
  "validated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "technical_asset_validations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "technical_asset_validations_version_check" CHECK ("asset_version" > 0),
  CONSTRAINT "technical_asset_validations_evidence_check" CHECK (length(btrim("evidence")) BETWEEN 1 AND 4096),
  CONSTRAINT "technical_asset_validations_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024)
);

CREATE UNIQUE INDEX "rnd_projects_code_key" ON "rnd_projects"("code");
CREATE INDEX "rnd_projects_department_id_status_created_at_idx"
  ON "rnd_projects"("department_id", "status", "created_at");
CREATE INDEX "rnd_projects_owner_id_status_created_at_idx"
  ON "rnd_projects"("owner_id", "status", "created_at");
CREATE UNIQUE INDEX "rnd_project_events_rnd_project_id_sequence_key"
  ON "rnd_project_events"("rnd_project_id", "sequence");
CREATE INDEX "rnd_project_events_actor_id_created_at_idx"
  ON "rnd_project_events"("actor_id", "created_at");
CREATE INDEX "rnd_project_events_rnd_project_id_created_at_idx"
  ON "rnd_project_events"("rnd_project_id", "created_at");
CREATE UNIQUE INDEX "technical_assets_asset_number_key" ON "technical_assets"("asset_number");
CREATE UNIQUE INDEX "technical_assets_id_rnd_project_id_key"
  ON "technical_assets"("id", "rnd_project_id");
CREATE INDEX "technical_assets_rnd_project_id_status_asset_number_idx"
  ON "technical_assets"("rnd_project_id", "status", "asset_number");
CREATE INDEX "technical_assets_owner_id_status_created_at_idx"
  ON "technical_assets"("owner_id", "status", "created_at");
CREATE UNIQUE INDEX "technical_asset_events_technical_asset_id_sequence_key"
  ON "technical_asset_events"("technical_asset_id", "sequence");
CREATE INDEX "technical_asset_events_rnd_project_id_created_at_idx"
  ON "technical_asset_events"("rnd_project_id", "created_at");
CREATE INDEX "technical_asset_events_actor_id_created_at_idx"
  ON "technical_asset_events"("actor_id", "created_at");
CREATE UNIQUE INDEX "technical_asset_validations_technical_asset_id_asset_version_key"
  ON "technical_asset_validations"("technical_asset_id", "asset_version");
CREATE INDEX "technical_asset_validations_rnd_project_id_validated_at_idx"
  ON "technical_asset_validations"("rnd_project_id", "validated_at");
CREATE INDEX "technical_asset_validations_validator_id_validated_at_idx"
  ON "technical_asset_validations"("validator_id", "validated_at");

ALTER TABLE "rnd_projects"
  ADD CONSTRAINT "rnd_projects_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "rnd_projects_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rnd_project_events"
  ADD CONSTRAINT "rnd_project_events_rnd_project_id_fkey"
    FOREIGN KEY ("rnd_project_id") REFERENCES "rnd_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "rnd_project_events_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "technical_assets"
  ADD CONSTRAINT "technical_assets_rnd_project_id_fkey"
    FOREIGN KEY ("rnd_project_id") REFERENCES "rnd_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "technical_assets_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "technical_assets_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "technical_asset_events"
  ADD CONSTRAINT "technical_asset_events_asset_rnd_project_fkey"
    FOREIGN KEY ("technical_asset_id", "rnd_project_id") REFERENCES "technical_assets"("id", "rnd_project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "technical_asset_events_actor_id_fkey"
    FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "technical_asset_validations"
  ADD CONSTRAINT "technical_asset_validations_asset_rnd_project_fkey"
    FOREIGN KEY ("technical_asset_id", "rnd_project_id") REFERENCES "technical_assets"("id", "rnd_project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "technical_asset_validations_validator_id_fkey"
    FOREIGN KEY ("validator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_rnd_project_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'R&D projects cannot be deleted; cancel them instead' USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."code" IS DISTINCT FROM OLD."code"
    OR NEW."owner_id" IS DISTINCT FROM OLD."owner_id"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'R&D project stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('COMPLETED', 'CANCELED') THEN
    RAISE EXCEPTION 'completed or canceled R&D projects are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'R&D project commands must advance resource version exactly once' USING ERRCODE = '23514';
  END IF;
  IF (OLD."status" = 'PROPOSED' AND NEW."status" IN ('IN_DEVELOPMENT', 'CANCELED'))
    OR (OLD."status" = 'IN_DEVELOPMENT' AND NEW."status" IN ('VALIDATION', 'CANCELED'))
    OR (OLD."status" = 'VALIDATION' AND NEW."status" IN ('IN_DEVELOPMENT', 'RELEASE_REVIEW', 'CANCELED'))
    OR (OLD."status" = 'RELEASE_REVIEW' AND NEW."status" IN ('IN_DEVELOPMENT', 'COMPLETED', 'CANCELED')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid R&D project transition: % -> %', OLD."status", NEW."status" USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_technical_asset_mutation() RETURNS trigger AS $$
DECLARE
  rnd_status "RndProjectStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'technical assets cannot be deleted; cancel them instead' USING ERRCODE = '55000';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."rnd_project_id" IS DISTINCT FROM OLD."rnd_project_id"
    OR NEW."asset_number" IS DISTINCT FROM OLD."asset_number"
    OR NEW."asset_type" IS DISTINCT FROM OLD."asset_type"
    OR NEW."owner_id" IS DISTINCT FROM OLD."owner_id"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'technical asset stable identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('VALIDATED', 'CANCELED') THEN
    RAISE EXCEPTION 'validated or canceled technical assets are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'technical asset commands must advance resource version exactly once' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'VALIDATION_PENDING' THEN
    SELECT "status" INTO rnd_status FROM "rnd_projects" WHERE "id" = NEW."rnd_project_id";
    IF rnd_status IS DISTINCT FROM 'VALIDATION' THEN
      RAISE EXCEPTION 'technical asset validation requires its R&D project to be in VALIDATION' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF (OLD."status" = 'DRAFT' AND NEW."status" IN ('VALIDATION_PENDING', 'CANCELED'))
    OR (OLD."status" = 'VALIDATION_PENDING' AND NEW."status" IN ('DRAFT', 'VALIDATED', 'CANCELED')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid technical asset transition: % -> %', OLD."status", NEW."status" USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_technical_asset_validation() RETURNS trigger AS $$
DECLARE
  asset_status "TechnicalAssetStatus";
  asset_owner_id TEXT;
  asset_version INTEGER;
  validator_status "UserStatus";
BEGIN
  SELECT "status", "owner_id", "version"
    INTO asset_status, asset_owner_id, asset_version
    FROM "technical_assets"
    WHERE "id" = NEW."technical_asset_id" AND "rnd_project_id" = NEW."rnd_project_id";
  SELECT "status" INTO validator_status FROM "users" WHERE "id" = NEW."validator_id";
  IF asset_status IS DISTINCT FROM 'VALIDATION_PENDING'
    OR NEW."asset_version" IS DISTINCT FROM asset_version THEN
    RAISE EXCEPTION 'technical asset validation requires the current validation-pending asset version' USING ERRCODE = '23514';
  END IF;
  IF asset_owner_id IS NOT DISTINCT FROM NEW."validator_id" THEN
    RAISE EXCEPTION 'technical asset validation requires an independent validator' USING ERRCODE = '23514';
  END IF;
  IF validator_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'technical asset validation requires an active validator' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION validate_technical_asset_event() RETURNS trigger AS $$
DECLARE
  asset_status "TechnicalAssetStatus";
BEGIN
  SELECT "status" INTO asset_status
    FROM "technical_assets"
    WHERE "id" = NEW."technical_asset_id" AND "rnd_project_id" = NEW."rnd_project_id";
  IF asset_status IS DISTINCT FROM NEW."to_status" THEN
    RAISE EXCEPTION 'technical asset event status must match its asset master' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_rnd_project_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION reject_technical_asset_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'technical asset facts cannot be truncated' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rnd_projects_validate_mutation
  BEFORE UPDATE OR DELETE ON "rnd_projects"
  FOR EACH ROW EXECUTE FUNCTION validate_rnd_project_mutation();
CREATE TRIGGER technical_assets_validate_mutation
  BEFORE UPDATE OR DELETE ON "technical_assets"
  FOR EACH ROW EXECUTE FUNCTION validate_technical_asset_mutation();
CREATE TRIGGER technical_asset_validations_validate
  BEFORE INSERT ON "technical_asset_validations"
  FOR EACH ROW EXECUTE FUNCTION validate_technical_asset_validation();
CREATE TRIGGER technical_asset_events_validate
  BEFORE INSERT ON "technical_asset_events"
  FOR EACH ROW EXECUTE FUNCTION validate_technical_asset_event();
CREATE TRIGGER rnd_project_events_reject_mutation
  BEFORE UPDATE OR DELETE ON "rnd_project_events"
  FOR EACH ROW EXECUTE FUNCTION reject_rnd_project_history_mutation();
CREATE TRIGGER technical_asset_events_reject_mutation
  BEFORE UPDATE OR DELETE ON "technical_asset_events"
  FOR EACH ROW EXECUTE FUNCTION reject_rnd_project_history_mutation();
CREATE TRIGGER technical_asset_validations_reject_mutation
  BEFORE UPDATE OR DELETE ON "technical_asset_validations"
  FOR EACH ROW EXECUTE FUNCTION reject_rnd_project_history_mutation();
CREATE TRIGGER rnd_projects_reject_truncate
  BEFORE TRUNCATE ON "rnd_projects"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_technical_asset_truncate();
CREATE TRIGGER rnd_project_events_reject_truncate
  BEFORE TRUNCATE ON "rnd_project_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_technical_asset_truncate();
CREATE TRIGGER technical_assets_reject_truncate
  BEFORE TRUNCATE ON "technical_assets"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_technical_asset_truncate();
CREATE TRIGGER technical_asset_events_reject_truncate
  BEFORE TRUNCATE ON "technical_asset_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_technical_asset_truncate();
CREATE TRIGGER technical_asset_validations_reject_truncate
  BEFORE TRUNCATE ON "technical_asset_validations"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_technical_asset_truncate();

INSERT INTO "roles" ("id", "code", "name", "description", "is_system") VALUES
('role-technical-asset-maintainer', 'TECHNICAL_ASSET_MAINTAINER', '技术资产维护人', '维护企业技术资产主记录和独立验证流程', true);

INSERT INTO "permissions" ("id", "code", "description") VALUES
('permission-technical-asset-read', 'TECHNICAL_ASSET_READ', '读取企业技术资产主记录和验证历史'),
('permission-technical-asset-manage', 'TECHNICAL_ASSET_MANAGE', '创建并推进内部研发项目和企业技术资产主记录'),
('permission-technical-asset-validate', 'TECHNICAL_ASSET_VALIDATE', '对待验证企业技术资产提交独立验证结论');

INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
('role-technical-asset-maintainer', 'permission-technical-asset-read', 'ALL'),
('role-technical-asset-maintainer', 'permission-technical-asset-manage', 'ALL'),
('role-technical-asset-maintainer', 'permission-technical-asset-validate', 'ALL'),
('role-quality', 'permission-technical-asset-read', 'ALL'),
('role-quality', 'permission-technical-asset-validate', 'ALL'),
('role-engineer', 'permission-technical-asset-read', 'ALL'),
('role-executive', 'permission-technical-asset-read', 'ALL'),
('role-admin', 'permission-technical-asset-read', 'ALL'),
('role-admin', 'permission-technical-asset-manage', 'ALL'),
('role-admin', 'permission-technical-asset-validate', 'ALL');
