BEGIN;

CREATE TABLE "project_uph_performance_targets" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "topology_root_node_id" TEXT NOT NULL,
  "current_published_version_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_uph_performance_targets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_performance_targets_scope_key" UNIQUE ("project_id", "topology_root_node_id"),
  CONSTRAINT "project_uph_performance_targets_id_project_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "project_uph_performance_targets_current_project_key" UNIQUE ("current_published_version_id", "project_id"),
  CONSTRAINT "project_uph_performance_targets_version_check" CHECK ("version" > 0)
);

CREATE TABLE "project_uph_performance_target_versions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" "UphVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "target_uph" DECIMAL(20, 6) NOT NULL,
  "reason" TEXT NOT NULL,
  "checksum" TEXT NOT NULL,
  "effective_at" TIMESTAMPTZ(3) NOT NULL,
  "resource_version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "published_by_id" TEXT,
  "published_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_uph_performance_target_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_performance_target_versions_id_project_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "project_uph_performance_target_versions_revision_key" UNIQUE ("target_id", "revision"),
  CONSTRAINT "project_uph_performance_target_versions_base_check" CHECK (
    "revision" > 0 AND "resource_version" > 0 AND "target_uph" > 0
    AND length(btrim("reason")) BETWEEN 1 AND 1024
    AND "checksum" ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX "project_uph_performance_target_versions_scope_idx"
  ON "project_uph_performance_target_versions" ("project_id", "target_id", "effective_at");
CREATE INDEX "project_uph_performance_target_versions_status_idx"
  ON "project_uph_performance_target_versions" ("project_id", "status", "effective_at");

ALTER TABLE "project_uph_performance_targets"
  ADD CONSTRAINT "project_uph_performance_targets_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_performance_targets_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_performance_targets_root_fkey"
    FOREIGN KEY ("topology_root_node_id", "project_id") REFERENCES "project_uph_topology_nodes"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_performance_targets_current_fkey"
    FOREIGN KEY ("current_published_version_id", "project_id") REFERENCES "project_uph_performance_target_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_uph_performance_target_versions"
  ADD CONSTRAINT "project_uph_performance_target_versions_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_performance_target_versions_target_fkey"
    FOREIGN KEY ("target_id", "project_id") REFERENCES "project_uph_performance_targets"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_performance_target_versions_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_performance_target_versions_published_by_fkey"
    FOREIGN KEY ("published_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "issue_relations_uph_historical_target_key"
  ON "issue_relations" ("project_id", "relation_type", "target_id")
  WHERE "relation_type" IN ('UPH_SOURCE_BATCH', 'UPH_ANALYSIS', 'UPH_RETEST_BATCH');

CREATE OR REPLACE FUNCTION "project_uph_performance_target_root_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "project_uph_topology_nodes" node
    WHERE node."id" = NEW."topology_root_node_id"
      AND node."project_id" = NEW."project_id"
      AND node."parent_relation" = 'ROOT'
  ) THEN
    RAISE EXCEPTION 'UPH performance target requires an exact topology root' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_uph_performance_target_root_guard"
  BEFORE INSERT OR UPDATE ON "project_uph_performance_targets"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_performance_target_root_guard"();

CREATE OR REPLACE FUNCTION "project_uph_performance_target_version_immutable_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'UPH performance target versions are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'superseded UPH performance target versions are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'UPH performance target versions must be published before superseding' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('PUBLISHED', 'SUPERSEDED') AND (
    NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."target_id" IS DISTINCT FROM OLD."target_id"
    OR NEW."revision" IS DISTINCT FROM OLD."revision"
    OR NEW."target_uph" IS DISTINCT FROM OLD."target_uph"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."checksum" IS DISTINCT FROM OLD."checksum"
    OR NEW."effective_at" IS DISTINCT FROM OLD."effective_at"
    OR NEW."resource_version" IS DISTINCT FROM OLD."resource_version"
    OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
    OR NEW."published_by_id" IS DISTINCT FROM OLD."published_by_id"
    OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
  ) THEN
    RAISE EXCEPTION 'UPH performance target version facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'PUBLISHED' AND NEW."status" <> 'SUPERSEDED' THEN
    RAISE EXCEPTION 'published UPH performance target versions are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_uph_performance_target_version_immutable_guard"
  BEFORE UPDATE OR DELETE ON "project_uph_performance_target_versions"
  FOR EACH ROW EXECUTE FUNCTION "project_uph_performance_target_version_immutable_guard"();

CREATE OR REPLACE FUNCTION "project_uph_performance_target_current_guard"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."current_published_version_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "project_uph_performance_target_versions" version
    WHERE version."id" = NEW."current_published_version_id"
      AND version."project_id" = NEW."project_id"
      AND version."target_id" = NEW."id"
      AND version."status" = 'PUBLISHED'
  ) THEN
    RAISE EXCEPTION 'current UPH performance target must reference a published version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "project_uph_performance_target_current_guard"
  AFTER INSERT OR UPDATE ON "project_uph_performance_targets"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "project_uph_performance_target_current_guard"();

INSERT INTO "permissions" ("id", "code", "description") VALUES
  ('permission-project-uph-performance-target-manage', 'PROJECT_UPH_DEFINITION_MANAGE', '管理项目UPH性能目标版本')
ON CONFLICT ("code") DO NOTHING;

COMMIT;
