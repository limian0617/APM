BEGIN;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_DEFINITION_DRAFT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_DEFINITION_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_COMMISSIONING_SIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_DEFINITION_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPH_DRAFT_REPLACED';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'UPH_TOPOLOGY';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'UPH_TOPOLOGY_VERSION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'UPH_TOPOLOGY_NODE';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'UPH_CT_DEFINITION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'UPH_CT_DEFINITION_VERSION';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'UPH_FORMULA';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'UPH_FORMULA_VERSION';

CREATE TYPE "UphVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');
CREATE TYPE "UphTopologyNodeRelation" AS ENUM ('ROOT', 'MANDATORY', 'PARALLEL');
CREATE TYPE "UphTopologySourceType" AS ENUM ('DELIVERY_UNIT', 'PROJECT_MODULE');

CREATE TABLE "project_uph_topologies" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "current_work_version_id" TEXT,
  "current_published_version_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "project_uph_topologies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_topologies_version_check" CHECK ("version" > 0)
);

CREATE TABLE "project_uph_topology_versions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "topology_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" "UphVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "supersedes_version_id" TEXT,
  "resource_version" INTEGER NOT NULL DEFAULT 1,
  "snapshot_json" JSONB NOT NULL,
  "snapshot_checksum" TEXT NOT NULL,
  "source_watermark" TEXT NOT NULL,
  "root_list_json" JSONB NOT NULL,
  "process_owner_membership_id" TEXT NOT NULL,
  "process_owner_user_id" TEXT NOT NULL,
  "process_owner_role" "ProjectRole" NOT NULL,
  "process_owner_snapshot_json" JSONB NOT NULL,
  "process_owner_checksum" TEXT NOT NULL,
  "commissioning_membership_id" TEXT,
  "commissioning_user_id" TEXT,
  "commissioning_role" "ProjectRole",
  "commissioning_snapshot_json" JSONB,
  "commissioning_checksum" TEXT,
  "commissioning_signed_at" TIMESTAMP(3),
  "quality_publisher_membership_id" TEXT,
  "quality_publisher_user_id" TEXT,
  "quality_publisher_role" "ProjectRole",
  "quality_publisher_snapshot_json" JSONB,
  "quality_publisher_checksum" TEXT,
  "published_at" TIMESTAMP(3),
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "project_uph_topology_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_topology_versions_revision_check" CHECK ("revision" > 0 AND "resource_version" > 0 AND "snapshot_checksum" ~ '^[0-9a-f]{64}$' AND "source_watermark" <> '' AND "process_owner_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_uph_topology_versions_process_role_check" CHECK ("process_owner_role" = 'ENGINEER'),
  CONSTRAINT "project_uph_topology_versions_commissioning_role_check" CHECK (
    ("commissioning_membership_id" IS NULL AND "commissioning_user_id" IS NULL AND "commissioning_role" IS NULL AND "commissioning_snapshot_json" IS NULL AND "commissioning_checksum" IS NULL AND "commissioning_signed_at" IS NULL)
    OR ("commissioning_membership_id" IS NOT NULL AND "commissioning_user_id" IS NOT NULL AND "commissioning_role" = 'ENGINEER' AND "commissioning_snapshot_json" IS NOT NULL AND "commissioning_checksum" IS NOT NULL AND "commissioning_signed_at" IS NOT NULL)
  ),
  CONSTRAINT "project_uph_topology_versions_quality_check" CHECK (
    ("quality_publisher_membership_id" IS NULL AND "quality_publisher_user_id" IS NULL AND "quality_publisher_role" IS NULL AND "quality_publisher_snapshot_json" IS NULL AND "quality_publisher_checksum" IS NULL AND "published_at" IS NULL)
    OR ("quality_publisher_membership_id" IS NOT NULL AND "quality_publisher_user_id" IS NOT NULL AND "quality_publisher_role" = 'QUALITY' AND "quality_publisher_snapshot_json" IS NOT NULL AND "quality_publisher_checksum" IS NOT NULL AND "published_at" IS NOT NULL)
  )
);

CREATE TABLE "project_uph_topology_nodes" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "topology_version_id" TEXT NOT NULL,
  "source_type" "UphTopologySourceType" NOT NULL,
  "delivery_unit_id" TEXT,
  "project_module_id" TEXT,
  "parent_node_id" TEXT,
  "parent_relation" "UphTopologyNodeRelation" NOT NULL,
  "capacity" DOUBLE PRECISION,
  "source_version" INTEGER NOT NULL,
  "source_status" "ProjectStructureNodeStatus" NOT NULL,
  "source_snapshot_json" JSONB NOT NULL,
  "source_checksum" TEXT NOT NULL,
  "source_watermark" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "project_uph_topology_nodes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_topology_nodes_source_xor_check" CHECK (("delivery_unit_id" IS NOT NULL) <> ("project_module_id" IS NOT NULL)),
  CONSTRAINT "project_uph_topology_nodes_relation_check" CHECK (("parent_relation" = 'ROOT' AND "parent_node_id" IS NULL) OR ("parent_relation" <> 'ROOT' AND "parent_node_id" IS NOT NULL)),
  CONSTRAINT "project_uph_topology_nodes_capacity_check" CHECK ("capacity" IS NULL OR "capacity" > 0),
  CONSTRAINT "project_uph_topology_nodes_source_check" CHECK ("source_version" > 0 AND "source_status" = 'ACTIVE')
);

CREATE TABLE "project_uph_ct_definitions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "project_module_id" TEXT NOT NULL,
  "current_work_version_id" TEXT,
  "current_published_version_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "project_uph_ct_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_ct_definitions_version_check" CHECK ("version" > 0)
);

CREATE TABLE "project_uph_ct_definition_versions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "ct_definition_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" "UphVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "supersedes_version_id" TEXT,
  "resource_version" INTEGER NOT NULL DEFAULT 1,
  "intrinsic_ct_seconds" DECIMAL(20, 6) NOT NULL,
  "output_per_cycle_total" INTEGER NOT NULL,
  "parallel_channel_count" INTEGER NOT NULL,
  "cavity_count" INTEGER NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "snapshot_checksum" TEXT NOT NULL,
  "source_watermark" TEXT NOT NULL,
  "process_owner_membership_id" TEXT NOT NULL,
  "process_owner_user_id" TEXT NOT NULL,
  "process_owner_role" "ProjectRole" NOT NULL,
  "process_owner_snapshot_json" JSONB NOT NULL,
  "process_owner_checksum" TEXT NOT NULL,
  "commissioning_membership_id" TEXT,
  "commissioning_user_id" TEXT,
  "commissioning_role" "ProjectRole",
  "commissioning_snapshot_json" JSONB,
  "commissioning_checksum" TEXT,
  "commissioning_signed_at" TIMESTAMP(3),
  "quality_publisher_membership_id" TEXT,
  "quality_publisher_user_id" TEXT,
  "quality_publisher_role" "ProjectRole",
  "quality_publisher_snapshot_json" JSONB,
  "quality_publisher_checksum" TEXT,
  "published_at" TIMESTAMP(3),
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "project_uph_ct_definition_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_ct_definition_versions_positive_check" CHECK ("revision" > 0 AND "resource_version" > 0 AND "intrinsic_ct_seconds" > 0 AND "output_per_cycle_total" > 0 AND "parallel_channel_count" > 0 AND "cavity_count" > 0 AND "snapshot_checksum" ~ '^[0-9a-f]{64}$' AND "source_watermark" <> '' AND "process_owner_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_uph_ct_definition_versions_process_role_check" CHECK ("process_owner_role" = 'ENGINEER'),
  CONSTRAINT "project_uph_ct_definition_versions_commissioning_role_check" CHECK (("commissioning_membership_id" IS NULL AND "commissioning_user_id" IS NULL AND "commissioning_role" IS NULL AND "commissioning_snapshot_json" IS NULL AND "commissioning_checksum" IS NULL AND "commissioning_signed_at" IS NULL) OR ("commissioning_membership_id" IS NOT NULL AND "commissioning_user_id" IS NOT NULL AND "commissioning_role" = 'ENGINEER' AND "commissioning_snapshot_json" IS NOT NULL AND "commissioning_checksum" IS NOT NULL AND "commissioning_signed_at" IS NOT NULL)),
  CONSTRAINT "project_uph_ct_definition_versions_quality_check" CHECK (("quality_publisher_membership_id" IS NULL AND "quality_publisher_user_id" IS NULL AND "quality_publisher_role" IS NULL AND "quality_publisher_snapshot_json" IS NULL AND "quality_publisher_checksum" IS NULL AND "published_at" IS NULL) OR ("quality_publisher_membership_id" IS NOT NULL AND "quality_publisher_user_id" IS NOT NULL AND "quality_publisher_role" = 'QUALITY' AND "quality_publisher_snapshot_json" IS NOT NULL AND "quality_publisher_checksum" IS NOT NULL AND "published_at" IS NOT NULL))
);

CREATE TABLE "project_uph_formulas" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "current_work_version_id" TEXT,
  "current_published_version_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "updated_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "project_uph_formulas_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_formulas_version_check" CHECK ("version" > 0)
);

CREATE TABLE "project_uph_formula_versions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "formula_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" "UphVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "supersedes_version_id" TEXT,
  "resource_version" INTEGER NOT NULL DEFAULT 1,
  "formula_code" TEXT NOT NULL,
  "formula_json" JSONB NOT NULL,
  "snapshot_checksum" TEXT NOT NULL,
  "process_owner_membership_id" TEXT NOT NULL,
  "process_owner_user_id" TEXT NOT NULL,
  "process_owner_role" "ProjectRole" NOT NULL,
  "process_owner_snapshot_json" JSONB NOT NULL,
  "process_owner_checksum" TEXT NOT NULL,
  "quality_publisher_membership_id" TEXT,
  "quality_publisher_user_id" TEXT,
  "quality_publisher_role" "ProjectRole",
  "quality_publisher_snapshot_json" JSONB,
  "quality_publisher_checksum" TEXT,
  "published_at" TIMESTAMP(3),
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
  CONSTRAINT "project_uph_formula_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_uph_formula_versions_check" CHECK ("revision" > 0 AND "resource_version" > 0 AND "process_owner_role" = 'ENGINEER' AND "formula_code" = 'CANONICAL_UPH_V1' AND "snapshot_checksum" ~ '^[0-9a-f]{64}$' AND "process_owner_checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "project_uph_formula_versions_quality_check" CHECK (("quality_publisher_membership_id" IS NULL AND "quality_publisher_user_id" IS NULL AND "quality_publisher_role" IS NULL AND "quality_publisher_snapshot_json" IS NULL AND "quality_publisher_checksum" IS NULL AND "published_at" IS NULL) OR ("quality_publisher_membership_id" IS NOT NULL AND "quality_publisher_user_id" IS NOT NULL AND "quality_publisher_role" = 'QUALITY' AND "quality_publisher_snapshot_json" IS NOT NULL AND "quality_publisher_checksum" IS NOT NULL AND "published_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "project_uph_topologies_project_id_key" ON "project_uph_topologies" ("project_id");
CREATE UNIQUE INDEX "project_uph_topologies_id_project_id_key" ON "project_uph_topologies" ("id", "project_id");
CREATE UNIQUE INDEX "project_uph_topologies_current_work_project_id_key" ON "project_uph_topologies" ("current_work_version_id", "project_id");
CREATE UNIQUE INDEX "project_uph_topologies_current_published_project_id_key" ON "project_uph_topologies" ("current_published_version_id", "project_id");
CREATE UNIQUE INDEX "project_uph_topology_versions_revision_key" ON "project_uph_topology_versions" ("topology_id", "revision");
CREATE UNIQUE INDEX "project_uph_topology_versions_id_project_id_key" ON "project_uph_topology_versions" ("id", "project_id");
CREATE UNIQUE INDEX "project_uph_topology_versions_draft_key" ON "project_uph_topology_versions" ("topology_id") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "project_uph_topology_versions_published_key" ON "project_uph_topology_versions" ("topology_id") WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX "project_uph_topology_nodes_id_project_id_key" ON "project_uph_topology_nodes" ("id", "project_id");
CREATE UNIQUE INDEX "project_uph_topology_nodes_id_version_key" ON "project_uph_topology_nodes" ("id", "topology_version_id");
CREATE UNIQUE INDEX "project_uph_topology_nodes_delivery_source_version_key" ON "project_uph_topology_nodes" ("topology_version_id", "delivery_unit_id");
CREATE UNIQUE INDEX "project_uph_topology_nodes_module_source_version_key" ON "project_uph_topology_nodes" ("topology_version_id", "project_module_id");
CREATE UNIQUE INDEX "project_uph_ct_definitions_project_module_key" ON "project_uph_ct_definitions" ("project_id", "project_module_id");
CREATE UNIQUE INDEX "project_uph_ct_definitions_id_project_id_key" ON "project_uph_ct_definitions" ("id", "project_id");
CREATE UNIQUE INDEX "project_uph_ct_definitions_current_work_project_id_key" ON "project_uph_ct_definitions" ("current_work_version_id", "project_id");
CREATE UNIQUE INDEX "project_uph_ct_definitions_current_published_project_id_key" ON "project_uph_ct_definitions" ("current_published_version_id", "project_id");
CREATE UNIQUE INDEX "project_uph_ct_definition_versions_revision_key" ON "project_uph_ct_definition_versions" ("ct_definition_id", "revision");
CREATE UNIQUE INDEX "project_uph_ct_definition_versions_id_project_id_key" ON "project_uph_ct_definition_versions" ("id", "project_id");
CREATE UNIQUE INDEX "project_uph_ct_definition_versions_draft_key" ON "project_uph_ct_definition_versions" ("ct_definition_id") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "project_uph_ct_definition_versions_published_key" ON "project_uph_ct_definition_versions" ("ct_definition_id") WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX "project_uph_formulas_project_id_key" ON "project_uph_formulas" ("project_id");
CREATE UNIQUE INDEX "project_uph_formulas_id_project_id_key" ON "project_uph_formulas" ("id", "project_id");
CREATE UNIQUE INDEX "project_uph_formulas_current_work_project_id_key" ON "project_uph_formulas" ("current_work_version_id", "project_id");
CREATE UNIQUE INDEX "project_uph_formulas_current_published_project_id_key" ON "project_uph_formulas" ("current_published_version_id", "project_id");
CREATE UNIQUE INDEX "project_uph_formula_versions_revision_key" ON "project_uph_formula_versions" ("formula_id", "revision");
CREATE UNIQUE INDEX "project_uph_formula_versions_id_project_id_key" ON "project_uph_formula_versions" ("id", "project_id");
CREATE UNIQUE INDEX "project_uph_formula_versions_draft_key" ON "project_uph_formula_versions" ("formula_id") WHERE "status" = 'DRAFT';
CREATE UNIQUE INDEX "project_uph_formula_versions_published_key" ON "project_uph_formula_versions" ("formula_id") WHERE "status" = 'PUBLISHED';

ALTER TABLE "project_uph_topologies"
  ADD CONSTRAINT "project_uph_topologies_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topologies_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topologies_updated_by_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_uph_topology_versions"
  ADD CONSTRAINT "project_uph_topology_versions_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topology_versions_topology_fkey" FOREIGN KEY ("topology_id", "project_id") REFERENCES "project_uph_topologies"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topology_versions_supersedes_fkey" FOREIGN KEY ("supersedes_version_id", "project_id") REFERENCES "project_uph_topology_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topology_versions_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topology_versions_process_member_fkey" FOREIGN KEY ("process_owner_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topology_versions_process_user_fkey" FOREIGN KEY ("process_owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topology_versions_commission_member_fkey" FOREIGN KEY ("commissioning_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topology_versions_commission_user_fkey" FOREIGN KEY ("commissioning_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topology_versions_quality_member_fkey" FOREIGN KEY ("quality_publisher_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topology_versions_quality_user_fkey" FOREIGN KEY ("quality_publisher_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_uph_topology_nodes"
  ADD CONSTRAINT "project_uph_topology_nodes_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topology_nodes_version_fkey" FOREIGN KEY ("topology_version_id", "project_id") REFERENCES "project_uph_topology_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topology_nodes_delivery_fkey" FOREIGN KEY ("delivery_unit_id", "project_id") REFERENCES "delivery_units"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topology_nodes_module_fkey" FOREIGN KEY ("project_module_id", "project_id") REFERENCES "project_modules"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_topology_nodes_parent_fkey" FOREIGN KEY ("parent_node_id", "topology_version_id") REFERENCES "project_uph_topology_nodes"("id", "topology_version_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_uph_ct_definitions"
  ADD CONSTRAINT "project_uph_ct_definitions_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_ct_definitions_module_fkey" FOREIGN KEY ("project_module_id", "project_id") REFERENCES "project_modules"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_uph_ct_definition_versions"
  ADD CONSTRAINT "project_uph_ct_versions_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_ct_versions_definition_fkey" FOREIGN KEY ("ct_definition_id", "project_id") REFERENCES "project_uph_ct_definitions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_ct_versions_supersedes_fkey" FOREIGN KEY ("supersedes_version_id", "project_id") REFERENCES "project_uph_ct_definition_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_ct_versions_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_ct_versions_process_member_fkey" FOREIGN KEY ("process_owner_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_ct_versions_process_user_fkey" FOREIGN KEY ("process_owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_ct_versions_commission_member_fkey" FOREIGN KEY ("commissioning_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_ct_versions_commission_user_fkey" FOREIGN KEY ("commissioning_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_ct_versions_quality_member_fkey" FOREIGN KEY ("quality_publisher_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_ct_versions_quality_user_fkey" FOREIGN KEY ("quality_publisher_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_uph_formulas"
  ADD CONSTRAINT "project_uph_formulas_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_formulas_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_formulas_updated_by_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_uph_formula_versions"
  ADD CONSTRAINT "project_uph_formula_versions_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_formula_versions_formula_fkey" FOREIGN KEY ("formula_id", "project_id") REFERENCES "project_uph_formulas"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_formula_versions_supersedes_fkey" FOREIGN KEY ("supersedes_version_id", "project_id") REFERENCES "project_uph_formula_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_formula_versions_created_by_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_formula_versions_process_member_fkey" FOREIGN KEY ("process_owner_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_formula_versions_process_user_fkey" FOREIGN KEY ("process_owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_formula_versions_quality_member_fkey" FOREIGN KEY ("quality_publisher_membership_id", "project_id") REFERENCES "project_members"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "project_uph_formula_versions_quality_user_fkey" FOREIGN KEY ("quality_publisher_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_uph_topologies"
  ADD CONSTRAINT "project_uph_topologies_current_work_fkey" FOREIGN KEY ("current_work_version_id", "project_id") REFERENCES "project_uph_topology_versions"("id", "project_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "project_uph_topologies_current_published_fkey" FOREIGN KEY ("current_published_version_id", "project_id") REFERENCES "project_uph_topology_versions"("id", "project_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_uph_ct_definitions"
  ADD CONSTRAINT "project_uph_ct_definitions_current_work_fkey" FOREIGN KEY ("current_work_version_id", "project_id") REFERENCES "project_uph_ct_definition_versions"("id", "project_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "project_uph_ct_definitions_current_published_fkey" FOREIGN KEY ("current_published_version_id", "project_id") REFERENCES "project_uph_ct_definition_versions"("id", "project_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_uph_formulas"
  ADD CONSTRAINT "project_uph_formulas_current_work_fkey" FOREIGN KEY ("current_work_version_id", "project_id") REFERENCES "project_uph_formula_versions"("id", "project_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "project_uph_formulas_current_published_fkey" FOREIGN KEY ("current_published_version_id", "project_id") REFERENCES "project_uph_formula_versions"("id", "project_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION "guard_uph_root_mutation"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'UPH roots are append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'UPH roots are append-only' USING ERRCODE = '23514';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW."version" <> 1 OR NEW."current_work_version_id" IS NOT NULL OR NEW."current_published_version_id" IS NOT NULL THEN
      RAISE EXCEPTION 'UPH root must start without current pointers' USING ERRCODE = '23514';
    END IF;
    NEW."created_at" := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
    NEW."updated_at" := NEW."created_at";
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
     OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'UPH root identity or resource version is immutable' USING ERRCODE = '23514';
  END IF;
  NEW."updated_at" := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "guard_uph_version_mutation"() RETURNS TRIGGER AS $$
DECLARE
  is_formula BOOLEAN := TG_TABLE_NAME = 'project_uph_formula_versions';
  version_table TEXT := TG_TABLE_NAME;
  root_table TEXT;
  root_column TEXT;
  expected_revision INTEGER;
  supersedes_revision INTEGER;
  supersedes_root TEXT;
  old_json JSONB;
  new_json JSONB;
  mutable_keys TEXT[] := ARRAY['status','resource_version','created_at','commissioning_membership_id','commissioning_user_id','commissioning_role','commissioning_snapshot_json','commissioning_checksum','commissioning_signed_at','quality_publisher_membership_id','quality_publisher_user_id','quality_publisher_role','quality_publisher_snapshot_json','quality_publisher_checksum','published_at'];
  quality_keys TEXT[] := ARRAY['quality_publisher_membership_id','quality_publisher_user_id','quality_publisher_role','quality_publisher_snapshot_json','quality_publisher_checksum','published_at'];
  signoff_keys TEXT[] := ARRAY['commissioning_membership_id','commissioning_user_id','commissioning_role','commissioning_snapshot_json','commissioning_checksum','commissioning_signed_at'];
  root_pointer TEXT;
  published_pointer TEXT;
  published_ancestor_found BOOLEAN;
  old_status TEXT;
  new_status TEXT;
  signed_at TEXT;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'UPH versions are append-only' USING ERRCODE = '23514';
  END IF;
  root_column := CASE
    WHEN is_formula THEN 'formula_id'
    WHEN TG_TABLE_NAME = 'project_uph_ct_definition_versions' THEN 'ct_definition_id'
    ELSE 'topology_id'
  END;
  root_table := CASE
    WHEN is_formula THEN 'project_uph_formulas'
    WHEN TG_TABLE_NAME = 'project_uph_ct_definition_versions' THEN 'project_uph_ct_definitions'
    ELSE 'project_uph_topologies'
  END;
  new_json := to_jsonb(NEW);
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'UPH versions are append-only' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN RAISE EXCEPTION 'UPH versions start as DRAFT' USING ERRCODE = '23514'; END IF;
    EXECUTE format('SELECT COALESCE(MAX("revision"), 0) + 1 FROM %I WHERE %I = $1 AND "project_id" = $2', version_table, root_column)
      INTO expected_revision USING new_json->>root_column, NEW."project_id";
    IF NEW."revision" <> expected_revision THEN
      RAISE EXCEPTION 'UPH revision must be the next exact revision' USING ERRCODE = '23514';
    END IF;
    IF NEW."supersedes_version_id" IS NOT NULL THEN
      EXECUTE format('SELECT "revision", %I FROM %I WHERE "id" = $1 AND "project_id" = $2', root_column, version_table)
        INTO supersedes_revision, supersedes_root USING NEW."supersedes_version_id", NEW."project_id";
      IF supersedes_revision IS NULL OR supersedes_revision <> NEW."revision" - 1 OR supersedes_root IS DISTINCT FROM new_json->>root_column THEN
        RAISE EXCEPTION 'UPH supersedes version must be the immediately previous version of the same root' USING ERRCODE = '23514';
      END IF;
    END IF;
    NEW."resource_version" := 1;
    NEW."created_at" := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
    RETURN NEW;
  END IF;
  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);
  old_status := old_json->>'status';
  new_status := new_json->>'status';
  signed_at := old_json->>'commissioning_signed_at';
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."project_id" IS DISTINCT FROM NEW."project_id"
     OR OLD."revision" IS DISTINCT FROM NEW."revision"
     OR OLD."created_at" IS DISTINCT FROM NEW."created_at"
     OR NEW."resource_version" <> OLD."resource_version" + 1 THEN
    RAISE EXCEPTION 'UPH version identity or resource version is immutable' USING ERRCODE = '23514';
  END IF;
  IF old_status = 'SUPERSEDED' THEN RAISE EXCEPTION 'SUPERSEDED UPH version is immutable' USING ERRCODE = '23514'; END IF;
  IF old_status = 'PUBLISHED' AND new_status <> 'SUPERSEDED' THEN RAISE EXCEPTION 'PUBLISHED UPH version is immutable' USING ERRCODE = '23514'; END IF;
  IF old_status = 'DRAFT' AND new_status = 'SUPERSEDED' THEN
    IF NOT is_formula AND signed_at IS NULL THEN RAISE EXCEPTION 'only signed UPH drafts may be superseded' USING ERRCODE = '23514'; END IF;
    IF (old_json - ARRAY['status','resource_version']) IS DISTINCT FROM (new_json - ARRAY['status','resource_version']) THEN RAISE EXCEPTION 'superseded UPH draft facts are immutable' USING ERRCODE = '23514'; END IF;
    EXECUTE format('SELECT current_work_version_id FROM %I WHERE id = $1 AND project_id = $2', root_table)
      INTO root_pointer USING old_json->>root_column, OLD."project_id";
    IF root_pointer IS DISTINCT FROM OLD."id" THEN RAISE EXCEPTION 'only the current work version may be superseded' USING ERRCODE = '23514'; END IF;
  ELSIF old_status = 'PUBLISHED' AND new_status = 'SUPERSEDED' THEN
    IF (old_json - ARRAY['status','resource_version']) IS DISTINCT FROM (new_json - ARRAY['status','resource_version']) THEN RAISE EXCEPTION 'published UPH facts are immutable' USING ERRCODE = '23514'; END IF;
    EXECUTE format('SELECT current_published_version_id FROM %I WHERE id = $1 AND project_id = $2', root_table)
      INTO root_pointer USING old_json->>root_column, OLD."project_id";
    IF root_pointer IS DISTINCT FROM OLD."id" THEN RAISE EXCEPTION 'only the current published version may be superseded' USING ERRCODE = '23514'; END IF;
  ELSIF old_status = 'DRAFT' AND new_status = 'PUBLISHED' THEN
    IF NOT is_formula AND new_json->>'commissioning_signed_at' IS NULL THEN RAISE EXCEPTION 'commissioning signoff is required' USING ERRCODE = '23514'; END IF;
    EXECUTE format('SELECT current_work_version_id, current_published_version_id FROM %I WHERE id = $1 AND project_id = $2', root_table)
      INTO root_pointer, published_pointer USING old_json->>root_column, OLD."project_id";
    IF root_pointer IS DISTINCT FROM OLD."id" THEN
      RAISE EXCEPTION 'only the current work version may be published' USING ERRCODE = '23514';
    END IF;
    IF published_pointer IS NULL AND NEW."supersedes_version_id" IS NOT NULL THEN
      RAISE EXCEPTION 'first published UPH version cannot supersede an earlier version' USING ERRCODE = '23514';
    END IF;
    IF published_pointer IS NOT NULL THEN
      IF NEW."supersedes_version_id" IS NULL THEN
        RAISE EXCEPTION 'published UPH version must trace to the current published version' USING ERRCODE = '23514';
      END IF;
      EXECUTE format(
        'WITH RECURSIVE lineage AS (
           SELECT "id", "supersedes_version_id" FROM %I
           WHERE "id" = $1 AND %I = $2 AND "project_id" = $3
           UNION ALL
           SELECT predecessor."id", predecessor."supersedes_version_id"
           FROM %I predecessor
           JOIN lineage ON predecessor."id" = lineage."supersedes_version_id"
             AND predecessor."project_id" = $3
           WHERE predecessor.%I = $2
         )
         SELECT EXISTS (SELECT 1 FROM lineage WHERE "id" = $4)',
        version_table, root_column, version_table, root_column
      ) INTO published_ancestor_found USING NEW."id", new_json->>root_column, NEW."project_id", published_pointer;
      IF NOT COALESCE(published_ancestor_found, FALSE) THEN
        RAISE EXCEPTION 'published UPH version must trace to the current published version' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF (old_json - (ARRAY['status','resource_version'] || quality_keys)) IS DISTINCT FROM (new_json - (ARRAY['status','resource_version'] || quality_keys)) THEN RAISE EXCEPTION 'UPH facts cannot change during publication' USING ERRCODE = '23514'; END IF;
    IF new_json->>'quality_publisher_membership_id' IS NULL OR new_json->>'quality_publisher_user_id' IS NULL OR new_json->>'quality_publisher_role' <> 'QUALITY' OR new_json->>'published_at' IS NULL THEN
      RAISE EXCEPTION 'quality publication facts are required' USING ERRCODE = '23514';
    END IF;
    NEW."published_at" := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
  ELSIF old_status = 'DRAFT' AND new_status = 'DRAFT' AND signed_at IS NOT NULL THEN
    IF (old_json - ARRAY['resource_version']) IS DISTINCT FROM (new_json - ARRAY['resource_version']) THEN
      RAISE EXCEPTION 'signed UPH draft is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF old_status = 'DRAFT' AND new_status = 'DRAFT' AND signed_at IS NULL AND new_json->>'commissioning_signed_at' IS NOT NULL THEN
    IF is_formula OR (old_json - (ARRAY['resource_version'] || signoff_keys)) IS DISTINCT FROM (new_json - (ARRAY['resource_version'] || signoff_keys)) THEN
      RAISE EXCEPTION 'UPH commissioning signoff cannot change business facts' USING ERRCODE = '23514';
    END IF;
    IF new_json->>'quality_publisher_membership_id' IS NOT NULL OR new_json->>'quality_publisher_user_id' IS NOT NULL OR new_json->>'published_at' IS NOT NULL THEN
      RAISE EXCEPTION 'quality facts cannot be set before publication' USING ERRCODE = '23514';
    END IF;
    NEW."commissioning_signed_at" := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
  ELSIF old_status = 'DRAFT' AND new_status = 'DRAFT' AND signed_at IS NULL THEN
    IF new_json->>'commissioning_membership_id' IS NOT NULL OR new_json->>'commissioning_user_id' IS NOT NULL OR new_json->>'commissioning_signed_at' IS NOT NULL OR new_json->>'quality_publisher_membership_id' IS NOT NULL OR new_json->>'quality_publisher_user_id' IS NOT NULL OR new_json->>'published_at' IS NOT NULL THEN
      RAISE EXCEPTION 'workflow facts require their controlled transition' USING ERRCODE = '23514';
    END IF;
    IF is_formula THEN
      IF (old_json - ARRAY['resource_version','formula_code','formula_json','snapshot_checksum']) IS DISTINCT FROM (new_json - ARRAY['resource_version','formula_code','formula_json','snapshot_checksum']) THEN
        RAISE EXCEPTION 'UPH formula identity and responsibility facts are immutable' USING ERRCODE = '23514';
      END IF;
    ELSIF TG_TABLE_NAME = 'project_uph_topology_versions' THEN
      IF (old_json - ARRAY['resource_version','snapshot_json','snapshot_checksum','source_watermark','root_list_json']) IS DISTINCT FROM (new_json - ARRAY['resource_version','snapshot_json','snapshot_checksum','source_watermark','root_list_json']) THEN
        RAISE EXCEPTION 'UPH topology identity and responsibility facts are immutable' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF (old_json - ARRAY['resource_version','snapshot_json','snapshot_checksum','source_watermark','intrinsic_ct_seconds','output_per_cycle_total','parallel_channel_count','cavity_count']) IS DISTINCT FROM (new_json - ARRAY['resource_version','snapshot_json','snapshot_checksum','source_watermark','intrinsic_ct_seconds','output_per_cycle_total','parallel_channel_count','cavity_count']) THEN
        RAISE EXCEPTION 'UPH CT identity and responsibility facts are immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF old_status = 'DRAFT' AND new_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'invalid UPH version transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "uph_responsibility_snapshot_checksum"(
  membership_id TEXT,
  user_id TEXT,
  role "ProjectRole"
) RETURNS TEXT AS $$
  SELECT encode(
    sha256(
      convert_to(
        '{"membershipId":' || to_jsonb(membership_id)::text ||
        ',"role":' || to_jsonb(role::text)::text ||
        ',"userId":' || to_jsonb(user_id)::text || '}',
        'UTF8'
      )
    ),
    'hex'
  );
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION "validate_uph_actor_facts"() RETURNS TRIGGER AS $$
DECLARE
  new_json JSONB;
  process_user TEXT;
  process_role "ProjectRole";
  process_left_at TIMESTAMP(3);
  commissioning_user TEXT;
  commissioning_role "ProjectRole";
  commissioning_left_at TIMESTAMP(3);
  quality_user TEXT;
  quality_role "ProjectRole";
  quality_left_at TIMESTAMP(3);
BEGIN
  new_json := to_jsonb(NEW);
  SELECT pm.user_id, pm.project_role, pm.left_at INTO process_user, process_role, process_left_at FROM project_members pm WHERE pm.id = NEW.process_owner_membership_id AND pm.project_id = NEW.project_id;
  IF process_user IS NULL OR process_user <> NEW.process_owner_user_id OR process_role <> 'ENGINEER' OR NEW.created_by_id <> process_user OR NEW.process_owner_snapshot_json IS DISTINCT FROM jsonb_build_object('membershipId', NEW.process_owner_membership_id, 'userId', NEW.process_owner_user_id, 'role', 'ENGINEER') OR NEW.process_owner_checksum IS DISTINCT FROM "uph_responsibility_snapshot_checksum"(NEW.process_owner_membership_id, NEW.process_owner_user_id, 'ENGINEER'::"ProjectRole") THEN
    RAISE EXCEPTION 'UPH process owner facts are inconsistent' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF process_left_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = process_user AND u.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'UPH process owner membership/user is not active' USING ERRCODE = '23514';
    END IF;
  ELSIF OLD.process_owner_membership_id IS DISTINCT FROM NEW.process_owner_membership_id OR OLD.process_owner_user_id IS DISTINCT FROM NEW.process_owner_user_id THEN
    IF process_left_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = process_user AND u.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'UPH process owner membership/user is not active' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME <> 'project_uph_formula_versions' AND new_json->>'commissioning_membership_id' IS NOT NULL THEN
    SELECT pm.user_id, pm.project_role, pm.left_at INTO commissioning_user, commissioning_role, commissioning_left_at FROM project_members pm WHERE pm.id = new_json->>'commissioning_membership_id' AND pm.project_id = NEW.project_id;
    IF commissioning_user IS NULL OR commissioning_user <> new_json->>'commissioning_user_id' OR commissioning_role <> 'ENGINEER' OR commissioning_user = process_user OR NEW.commissioning_snapshot_json IS DISTINCT FROM jsonb_build_object('membershipId', NEW.commissioning_membership_id, 'userId', NEW.commissioning_user_id, 'role', 'ENGINEER') OR NEW.commissioning_checksum IS DISTINCT FROM "uph_responsibility_snapshot_checksum"(NEW.commissioning_membership_id, NEW.commissioning_user_id, 'ENGINEER'::"ProjectRole") THEN
      RAISE EXCEPTION 'UPH commissioning membership/user/role facts are inconsistent' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF commissioning_left_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = commissioning_user AND u.status = 'ACTIVE') THEN
        RAISE EXCEPTION 'UPH commissioning membership/user is not active' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.commissioning_membership_id IS DISTINCT FROM NEW.commissioning_membership_id OR OLD.commissioning_user_id IS DISTINCT FROM NEW.commissioning_user_id THEN
      IF commissioning_left_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = commissioning_user AND u.status = 'ACTIVE') THEN
        RAISE EXCEPTION 'UPH commissioning membership/user is not active' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF new_json->>'quality_publisher_membership_id' IS NOT NULL THEN
    SELECT pm.user_id, pm.project_role, pm.left_at INTO quality_user, quality_role, quality_left_at FROM project_members pm WHERE pm.id = new_json->>'quality_publisher_membership_id' AND pm.project_id = NEW.project_id;
    IF quality_user IS NULL OR quality_user <> new_json->>'quality_publisher_user_id' OR quality_role <> 'QUALITY' OR quality_user = process_user OR quality_user = commissioning_user OR NEW.quality_publisher_snapshot_json IS DISTINCT FROM jsonb_build_object('membershipId', NEW.quality_publisher_membership_id, 'userId', NEW.quality_publisher_user_id, 'role', 'QUALITY') OR NEW.quality_publisher_checksum IS DISTINCT FROM "uph_responsibility_snapshot_checksum"(NEW.quality_publisher_membership_id, NEW.quality_publisher_user_id, 'QUALITY'::"ProjectRole") THEN
      RAISE EXCEPTION 'UPH quality publisher membership/user/role facts are inconsistent' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
      IF quality_left_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = quality_user AND u.status = 'ACTIVE') THEN
        RAISE EXCEPTION 'UPH quality publisher membership/user is not active' USING ERRCODE = '23514';
      END IF;
    ELSIF OLD.quality_publisher_membership_id IS DISTINCT FROM NEW.quality_publisher_membership_id OR OLD.quality_publisher_user_id IS DISTINCT FROM NEW.quality_publisher_user_id THEN
      IF quality_left_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = quality_user AND u.status = 'ACTIVE') THEN
        RAISE EXCEPTION 'UPH quality publisher membership/user is not active' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "validate_uph_root_pointers"() RETURNS TRIGGER AS $$
DECLARE
  root_id TEXT;
  root_project_id TEXT;
  work_pointer TEXT;
  published_pointer TEXT;
  work_count INTEGER;
  published_count INTEGER;
  work_status TEXT;
  published_status TEXT;
  version_table TEXT;
  root_column TEXT;
BEGIN
  IF TG_TABLE_NAME = 'project_uph_topologies' THEN
    root_id := NEW."id"; root_project_id := NEW."project_id"; work_pointer := NEW."current_work_version_id"; published_pointer := NEW."current_published_version_id";
    version_table := 'project_uph_topology_versions'; root_column := 'topology_id';
  ELSIF TG_TABLE_NAME = 'project_uph_ct_definitions' THEN
    root_id := NEW."id"; root_project_id := NEW."project_id"; work_pointer := NEW."current_work_version_id"; published_pointer := NEW."current_published_version_id";
    version_table := 'project_uph_ct_definition_versions'; root_column := 'ct_definition_id';
  ELSIF TG_TABLE_NAME = 'project_uph_formulas' THEN
    root_id := NEW."id"; root_project_id := NEW."project_id"; work_pointer := NEW."current_work_version_id"; published_pointer := NEW."current_published_version_id";
    version_table := 'project_uph_formula_versions'; root_column := 'formula_id';
  ELSIF TG_TABLE_NAME = 'project_uph_topology_versions' THEN
    root_id := NEW."topology_id"; root_project_id := NEW."project_id";
    SELECT "current_work_version_id", "current_published_version_id" INTO work_pointer, published_pointer FROM "project_uph_topologies" WHERE "id" = root_id AND "project_id" = root_project_id;
    version_table := 'project_uph_topology_versions'; root_column := 'topology_id';
  ELSIF TG_TABLE_NAME = 'project_uph_ct_definition_versions' THEN
    root_id := NEW."ct_definition_id"; root_project_id := NEW."project_id";
    SELECT "current_work_version_id", "current_published_version_id" INTO work_pointer, published_pointer FROM "project_uph_ct_definitions" WHERE "id" = root_id AND "project_id" = root_project_id;
    version_table := 'project_uph_ct_definition_versions'; root_column := 'ct_definition_id';
  ELSE
    root_id := NEW."formula_id"; root_project_id := NEW."project_id";
    SELECT "current_work_version_id", "current_published_version_id" INTO work_pointer, published_pointer FROM "project_uph_formulas" WHERE "id" = root_id AND "project_id" = root_project_id;
    version_table := 'project_uph_formula_versions'; root_column := 'formula_id';
  END IF;
  IF TG_TABLE_NAME = 'project_uph_topologies' THEN
    SELECT current_work_version_id, current_published_version_id INTO work_pointer, published_pointer FROM project_uph_topologies WHERE id = root_id AND project_id = root_project_id;
  ELSIF TG_TABLE_NAME = 'project_uph_ct_definitions' THEN
    SELECT current_work_version_id, current_published_version_id INTO work_pointer, published_pointer FROM project_uph_ct_definitions WHERE id = root_id AND project_id = root_project_id;
  ELSIF TG_TABLE_NAME = 'project_uph_formulas' THEN
    SELECT current_work_version_id, current_published_version_id INTO work_pointer, published_pointer FROM project_uph_formulas WHERE id = root_id AND project_id = root_project_id;
  END IF;
  EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1 AND project_id = $2 AND status = ''DRAFT''', version_table, root_column) INTO work_count USING root_id, root_project_id;
  EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1 AND project_id = $2 AND status = ''PUBLISHED''', version_table, root_column) INTO published_count USING root_id, root_project_id;
  IF (work_pointer IS NULL AND work_count <> 0) OR (work_pointer IS NOT NULL AND work_count <> 1) THEN RAISE EXCEPTION 'UPH current work pointer must target the only DRAFT' USING ERRCODE = '23514'; END IF;
  IF (published_pointer IS NULL AND published_count <> 0) OR (published_pointer IS NOT NULL AND published_count <> 1) THEN RAISE EXCEPTION 'UPH current published pointer must target the only PUBLISHED version' USING ERRCODE = '23514'; END IF;
  IF work_pointer IS NOT NULL THEN
    EXECUTE format('SELECT status::text FROM %I WHERE id = $1 AND %I = $2 AND project_id = $3', version_table, root_column) INTO work_status USING work_pointer, root_id, root_project_id;
    IF work_status IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'UPH current work pointer must target DRAFT' USING ERRCODE = '23514'; END IF;
  END IF;
  IF published_pointer IS NOT NULL THEN
    EXECUTE format('SELECT status::text FROM %I WHERE id = $1 AND %I = $2 AND project_id = $3', version_table, root_column) INTO published_status USING published_pointer, root_id, root_project_id;
    IF published_status IS DISTINCT FROM 'PUBLISHED' THEN RAISE EXCEPTION 'UPH current published pointer must target PUBLISHED' USING ERRCODE = '23514'; END IF;
  END IF;
  IF work_pointer IS NOT NULL AND work_pointer = published_pointer THEN RAISE EXCEPTION 'UPH pointers cannot alias' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "validate_uph_superseded_successor"() RETURNS TRIGGER AS $$
DECLARE
  root_id TEXT;
  root_project_id TEXT;
  work_pointer TEXT;
  published_pointer TEXT;
  version_table TEXT := TG_TABLE_NAME;
  root_table TEXT;
  root_column TEXT;
  successor_id TEXT;
  successor_status TEXT;
  published_lineage_exists BOOLEAN;
BEGIN
  IF OLD."status" NOT IN ('DRAFT', 'PUBLISHED') OR NEW."status" <> 'SUPERSEDED' THEN
    RETURN NULL;
  END IF;

  IF TG_TABLE_NAME = 'project_uph_topology_versions' THEN
    root_id := OLD."topology_id"; root_table := 'project_uph_topologies'; root_column := 'topology_id';
  ELSIF TG_TABLE_NAME = 'project_uph_ct_definition_versions' THEN
    root_id := OLD."ct_definition_id"; root_table := 'project_uph_ct_definitions'; root_column := 'ct_definition_id';
  ELSE
    root_id := OLD."formula_id"; root_table := 'project_uph_formulas'; root_column := 'formula_id';
  END IF;
  root_project_id := OLD."project_id";
  EXECUTE format('SELECT "current_work_version_id", "current_published_version_id" FROM %I WHERE "id" = $1 AND "project_id" = $2', root_table)
    INTO work_pointer, published_pointer USING root_id, root_project_id;

  IF OLD."status" = 'DRAFT' THEN
    EXECUTE format('SELECT "id", "status"::text FROM %I WHERE %I = $1 AND "project_id" = $2 AND "revision" = $3 AND "supersedes_version_id" = $4', version_table, root_column)
      INTO successor_id, successor_status USING root_id, root_project_id, OLD."revision" + 1, OLD."id";
    IF successor_id IS NULL OR successor_status <> 'DRAFT' OR work_pointer IS DISTINCT FROM successor_id THEN
      RAISE EXCEPTION 'superseded UPH draft requires its exact current DRAFT successor' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END IF;

  IF published_pointer IS NULL THEN
    RAISE EXCEPTION 'superseded published UPH version requires a current published successor' USING ERRCODE = '23514';
  END IF;
  EXECUTE format(
    'WITH RECURSIVE lineage AS (
       SELECT "id", "supersedes_version_id" FROM %I
       WHERE "id" = $1 AND %I = $2 AND "project_id" = $3
       UNION ALL
       SELECT predecessor."id", predecessor."supersedes_version_id"
       FROM %I predecessor
       JOIN lineage ON predecessor."id" = lineage."supersedes_version_id"
         AND predecessor."project_id" = $3
       WHERE predecessor.%I = $2
     )
     SELECT EXISTS (SELECT 1 FROM lineage WHERE "id" = $4)',
    version_table, root_column, version_table, root_column
  ) INTO published_lineage_exists USING published_pointer, root_id, root_project_id, OLD."id";
  IF NOT COALESCE(published_lineage_exists, FALSE) THEN
    RAISE EXCEPTION 'superseded published UPH version requires a linked current published successor' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "reject_uph_node_mutation"() RETURNS TRIGGER AS $$
DECLARE
  version_status "UphVersionStatus";
  signed_at TIMESTAMP(3);
  source_version INTEGER;
  source_status "ProjectStructureNodeStatus";
  source_project_id TEXT;
  source_parent_id TEXT;
  parent_source_type "UphTopologySourceType";
  parent_delivery_unit_id TEXT;
  parent_module_id TEXT;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'UPH topology nodes are append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT "status", "commissioning_signed_at"
      INTO version_status, signed_at
      FROM "project_uph_topology_versions"
      WHERE "id" = OLD."topology_version_id" AND "project_id" = OLD."project_id";
    IF version_status IS DISTINCT FROM 'DRAFT' OR signed_at IS NOT NULL THEN
      RAISE EXCEPTION 'sealed UPH topology cannot be changed' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  SELECT "status", "commissioning_signed_at"
    INTO version_status, signed_at
    FROM "project_uph_topology_versions"
    WHERE "id" = NEW."topology_version_id" AND "project_id" = NEW."project_id";
  IF version_status IS DISTINCT FROM 'DRAFT' OR signed_at IS NOT NULL THEN
    RAISE EXCEPTION 'sealed UPH topology cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT "commissioning_signed_at" INTO signed_at FROM "project_uph_topology_versions" WHERE "id" = OLD."topology_version_id" AND "project_id" = OLD."project_id";
    IF signed_at IS NOT NULL OR OLD."topology_version_id" IS DISTINCT FROM NEW."topology_version_id" OR OLD."project_id" IS DISTINCT FROM NEW."project_id" THEN RAISE EXCEPTION 'sealed UPH topology cannot be changed' USING ERRCODE = '23514'; END IF;
  ELSE
    NEW."created_at" := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
  END IF;
  IF NEW."source_version" <= 0 OR NEW."source_status" <> 'ACTIVE' OR NEW."source_checksum" !~ '^[0-9a-f]{64}$' OR NEW."source_watermark" = '' THEN
    RAISE EXCEPTION 'UPH topology source snapshot is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW."source_type" = 'DELIVERY_UNIT' THEN
    SELECT du.version, du.status, du.project_id, du.parent_id INTO source_version, source_status, source_project_id, source_parent_id FROM delivery_units du WHERE du.id = NEW."delivery_unit_id" AND du.project_id = NEW."project_id";
    IF source_project_id IS NULL OR source_version <> NEW."source_version" OR source_status <> NEW."source_status" THEN
      RAISE EXCEPTION 'UPH topology delivery source is not the frozen active object' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT pm.version, pm.status, pm.project_id, pm.delivery_unit_id INTO source_version, source_status, source_project_id, source_parent_id FROM project_modules pm WHERE pm.id = NEW."project_module_id" AND pm.project_id = NEW."project_id";
    IF source_project_id IS NULL OR source_version <> NEW."source_version" OR source_status <> NEW."source_status" THEN
      RAISE EXCEPTION 'UPH topology module source is not the frozen active object' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."parent_node_id" IS NOT NULL THEN
    IF NEW."parent_relation" = 'ROOT' THEN RAISE EXCEPTION 'UPH ROOT topology node cannot have a parent' USING ERRCODE = '23514'; END IF;
    SELECT n.source_type, n.delivery_unit_id, n.project_module_id INTO parent_source_type, parent_delivery_unit_id, parent_module_id FROM project_uph_topology_nodes n WHERE n.id = NEW."parent_node_id" AND n.topology_version_id = NEW."topology_version_id" AND n.project_id = NEW."project_id";
    IF parent_source_type IS NULL THEN RAISE EXCEPTION 'UPH topology parent is not in the same version' USING ERRCODE = '23514'; END IF;
    IF NEW."source_type" = 'DELIVERY_UNIT' THEN
      IF parent_source_type <> 'DELIVERY_UNIT' OR source_parent_id IS DISTINCT FROM parent_delivery_unit_id THEN
        RAISE EXCEPTION 'UPH topology delivery parent does not match APM-012 hierarchy' USING ERRCODE = '23514';
      END IF;
    ELSIF parent_source_type <> 'DELIVERY_UNIT' OR source_parent_id IS DISTINCT FROM parent_delivery_unit_id THEN
      RAISE EXCEPTION 'UPH topology module parent does not match APM-012 hierarchy' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."parent_relation" <> 'ROOT' THEN
    RAISE EXCEPTION 'UPH non-root topology node requires a parent' USING ERRCODE = '23514';
  ELSIF source_parent_id IS NOT NULL THEN
    RAISE EXCEPTION 'UPH ROOT topology source must be an actual physical root' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "validate_uph_topology_forest"() RETURNS TRIGGER AS $$
DECLARE
  shape TEXT;
  root_count INTEGER;
  listed_count INTEGER;
  distinct_listed_count INTEGER;
  invalid_root BOOLEAN;
  invalid_shape BOOLEAN;
BEGIN
  SELECT COALESCE(NEW."snapshot_json"->>'projectShape', NEW."snapshot_json"->>'equipmentShape') INTO shape;
  SELECT count(*) INTO root_count FROM project_uph_topology_nodes WHERE topology_version_id = NEW."id" AND project_id = NEW."project_id" AND parent_relation = 'ROOT';
  IF jsonb_typeof(NEW."root_list_json") <> 'array' THEN RAISE EXCEPTION 'UPH topology root list must be an array' USING ERRCODE = '23514'; END IF;
  IF NEW."root_list_json" IS DISTINCT FROM (
    SELECT to_jsonb(array_agg(item.value ORDER BY item.value))
    FROM jsonb_array_elements_text(NEW."root_list_json") AS item(value)
  ) THEN
    RAISE EXCEPTION 'UPH topology root list must be sorted by stable source id' USING ERRCODE = '23514';
  END IF;
  SELECT count(*), count(DISTINCT value) INTO listed_count, distinct_listed_count FROM jsonb_array_elements_text(NEW."root_list_json") AS item(value);
  IF root_count = 0 OR listed_count <> root_count OR distinct_listed_count <> listed_count THEN RAISE EXCEPTION 'UPH topology root list must equal the exact forest roots' USING ERRCODE = '23514'; END IF;
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW."root_list_json") item(value) WHERE NOT EXISTS (SELECT 1 FROM project_uph_topology_nodes n WHERE COALESCE(n.delivery_unit_id, n.project_module_id) = item.value AND n.topology_version_id = NEW."id" AND n.project_id = NEW."project_id" AND n.parent_relation = 'ROOT')) INTO invalid_root;
  IF invalid_root THEN RAISE EXCEPTION 'UPH topology root list contains a non-root or foreign node' USING ERRCODE = '23514'; END IF;
  IF NEW."status" <> 'SUPERSEDED' AND EXISTS (
    SELECT 1
    FROM delivery_units du
    WHERE du."project_id" = NEW."project_id"
      AND du."status" = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1
        FROM project_uph_topology_nodes n
        WHERE n."topology_version_id" = NEW."id"
          AND n."project_id" = NEW."project_id"
          AND n."source_type" = 'DELIVERY_UNIT'
          AND n."delivery_unit_id" = du."id"
      )
  ) THEN
    RAISE EXCEPTION 'UPH topology must cover every active delivery unit' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" <> 'SUPERSEDED' AND EXISTS (
    SELECT 1
    FROM project_modules pm
    WHERE pm."project_id" = NEW."project_id"
      AND pm."status" = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1
        FROM project_uph_topology_nodes n
        WHERE n."topology_version_id" = NEW."id"
          AND n."project_id" = NEW."project_id"
          AND n."source_type" = 'PROJECT_MODULE'
          AND n."project_module_id" = pm."id"
      )
  ) THEN
    RAISE EXCEPTION 'UPH topology must cover every active project module' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" <> 'SUPERSEDED' AND EXISTS (
    SELECT 1
    FROM project_uph_topology_nodes n
    LEFT JOIN delivery_units du
      ON n."source_type" = 'DELIVERY_UNIT'
     AND du."id" = n."delivery_unit_id"
     AND du."project_id" = n."project_id"
    LEFT JOIN project_modules pm
      ON n."source_type" = 'PROJECT_MODULE'
     AND pm."id" = n."project_module_id"
     AND pm."project_id" = n."project_id"
    WHERE n."topology_version_id" = NEW."id"
      AND n."project_id" = NEW."project_id"
      AND (
        (n."source_type" = 'DELIVERY_UNIT'
         AND (du."id" IS NULL OR du."status" <> 'ACTIVE' OR n."source_status" <> du."status" OR n."source_version" <> du."version"))
        OR
        (n."source_type" = 'PROJECT_MODULE'
         AND (pm."id" IS NULL OR pm."status" <> 'ACTIVE' OR n."source_status" <> pm."status" OR n."source_version" <> pm."version"))
      )
  ) THEN
    RAISE EXCEPTION 'UPH topology contains a stale or inactive source snapshot' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH RECURSIVE walk(node_id, parent_node_id, path, cycle) AS (
      SELECT n.id, n.parent_node_id, ARRAY[n.id], false
      FROM project_uph_topology_nodes n
      WHERE n.topology_version_id = NEW."id" AND n.project_id = NEW."project_id"
      UNION ALL
      SELECT child.id, child.parent_node_id, walk.path || child.id, child.id = ANY(walk.path)
      FROM project_uph_topology_nodes child
      JOIN walk ON child.parent_node_id = walk.node_id
      WHERE walk.cycle = false
    )
    SELECT 1 FROM walk WHERE cycle
  ) THEN
    RAISE EXCEPTION 'UPH topology cannot contain a cycle' USING ERRCODE = '23514';
  END IF;
  IF shape = 'SINGLE_MACHINE' THEN
    IF root_count <> 1 OR EXISTS (SELECT 1 FROM project_uph_topology_nodes n JOIN delivery_units du ON du.id = n.delivery_unit_id AND du.project_id = n.project_id WHERE n.topology_version_id = NEW."id" AND n.parent_relation = 'ROOT' AND (n.source_type <> 'DELIVERY_UNIT' OR du.unit_type <> 'MACHINE')) THEN
      RAISE EXCEPTION 'SINGLE_MACHINE UPH topology requires exactly one MACHINE root' USING ERRCODE = '23514';
    END IF;
  ELSIF shape = 'LINE' THEN
    IF EXISTS (SELECT 1 FROM project_uph_topology_nodes n JOIN delivery_units du ON du.id = n.delivery_unit_id AND du.project_id = n.project_id WHERE n.topology_version_id = NEW."id" AND n.parent_relation = 'ROOT' AND (n.source_type <> 'DELIVERY_UNIT' OR du.unit_type <> 'LINE')) THEN
      RAISE EXCEPTION 'LINE UPH topology roots must be LINE delivery units' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'UPH topology project shape is required' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_uph_topologies_mutation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "project_uph_topologies" FOR EACH ROW EXECUTE FUNCTION "guard_uph_root_mutation"();
CREATE TRIGGER "project_uph_topologies_truncate_guard" BEFORE TRUNCATE ON "project_uph_topologies" FOR EACH STATEMENT EXECUTE FUNCTION "guard_uph_root_mutation"();
CREATE TRIGGER "project_uph_topology_versions_mutation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "project_uph_topology_versions" FOR EACH ROW EXECUTE FUNCTION "guard_uph_version_mutation"();
CREATE TRIGGER "project_uph_topology_versions_truncate_guard" BEFORE TRUNCATE ON "project_uph_topology_versions" FOR EACH STATEMENT EXECUTE FUNCTION "guard_uph_version_mutation"();
CREATE TRIGGER "project_uph_topology_nodes_mutation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "project_uph_topology_nodes" FOR EACH ROW EXECUTE FUNCTION "reject_uph_node_mutation"();
CREATE TRIGGER "project_uph_topology_nodes_truncate_guard" BEFORE TRUNCATE ON "project_uph_topology_nodes" FOR EACH STATEMENT EXECUTE FUNCTION "reject_uph_node_mutation"();
CREATE TRIGGER "project_uph_ct_definitions_mutation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "project_uph_ct_definitions" FOR EACH ROW EXECUTE FUNCTION "guard_uph_root_mutation"();
CREATE TRIGGER "project_uph_ct_definitions_truncate_guard" BEFORE TRUNCATE ON "project_uph_ct_definitions" FOR EACH STATEMENT EXECUTE FUNCTION "guard_uph_root_mutation"();
CREATE TRIGGER "project_uph_ct_versions_mutation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "project_uph_ct_definition_versions" FOR EACH ROW EXECUTE FUNCTION "guard_uph_version_mutation"();
CREATE TRIGGER "project_uph_ct_versions_truncate_guard" BEFORE TRUNCATE ON "project_uph_ct_definition_versions" FOR EACH STATEMENT EXECUTE FUNCTION "guard_uph_version_mutation"();
CREATE TRIGGER "project_uph_formulas_mutation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "project_uph_formulas" FOR EACH ROW EXECUTE FUNCTION "guard_uph_root_mutation"();
CREATE TRIGGER "project_uph_formulas_truncate_guard" BEFORE TRUNCATE ON "project_uph_formulas" FOR EACH STATEMENT EXECUTE FUNCTION "guard_uph_root_mutation"();
CREATE TRIGGER "project_uph_formula_versions_mutation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "project_uph_formula_versions" FOR EACH ROW EXECUTE FUNCTION "guard_uph_version_mutation"();
CREATE TRIGGER "project_uph_formula_versions_truncate_guard" BEFORE TRUNCATE ON "project_uph_formula_versions" FOR EACH STATEMENT EXECUTE FUNCTION "guard_uph_version_mutation"();
CREATE TRIGGER "project_uph_topology_versions_actor_guard" BEFORE INSERT OR UPDATE ON "project_uph_topology_versions" FOR EACH ROW EXECUTE FUNCTION "validate_uph_actor_facts"();
CREATE TRIGGER "project_uph_ct_versions_actor_guard" BEFORE INSERT OR UPDATE ON "project_uph_ct_definition_versions" FOR EACH ROW EXECUTE FUNCTION "validate_uph_actor_facts"();
CREATE TRIGGER "project_uph_formula_versions_actor_guard" BEFORE INSERT OR UPDATE ON "project_uph_formula_versions" FOR EACH ROW EXECUTE FUNCTION "validate_uph_actor_facts"();

CREATE CONSTRAINT TRIGGER "project_uph_topologies_pointer_guard" AFTER INSERT OR UPDATE ON "project_uph_topologies" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_uph_root_pointers"();
CREATE CONSTRAINT TRIGGER "project_uph_topology_versions_pointer_guard" AFTER INSERT OR UPDATE ON "project_uph_topology_versions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_uph_root_pointers"();
CREATE CONSTRAINT TRIGGER "project_uph_ct_definitions_pointer_guard" AFTER INSERT OR UPDATE ON "project_uph_ct_definitions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_uph_root_pointers"();
CREATE CONSTRAINT TRIGGER "project_uph_ct_versions_pointer_guard" AFTER INSERT OR UPDATE ON "project_uph_ct_definition_versions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_uph_root_pointers"();
CREATE CONSTRAINT TRIGGER "project_uph_formulas_pointer_guard" AFTER INSERT OR UPDATE ON "project_uph_formulas" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_uph_root_pointers"();
CREATE CONSTRAINT TRIGGER "project_uph_formula_versions_pointer_guard" AFTER INSERT OR UPDATE ON "project_uph_formula_versions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_uph_root_pointers"();
CREATE CONSTRAINT TRIGGER "project_uph_topology_versions_successor_guard" AFTER UPDATE ON "project_uph_topology_versions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_uph_superseded_successor"();
CREATE CONSTRAINT TRIGGER "project_uph_ct_versions_successor_guard" AFTER UPDATE ON "project_uph_ct_definition_versions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_uph_superseded_successor"();
CREATE CONSTRAINT TRIGGER "project_uph_formula_versions_successor_guard" AFTER UPDATE ON "project_uph_formula_versions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_uph_superseded_successor"();
CREATE CONSTRAINT TRIGGER "project_uph_topology_forest_guard" AFTER INSERT OR UPDATE ON "project_uph_topology_versions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "validate_uph_topology_forest"();

INSERT INTO "permissions" ("id", "code", "description") VALUES
('permission-project-uph-read', 'PROJECT_UPH_READ', '读取项目UPH拓扑、CT和公式版本'),
('permission-project-uph-definition-manage', 'PROJECT_UPH_DEFINITION_MANAGE', '创建和修订UPH定义草稿'),
('permission-project-uph-commissioning-signoff', 'PROJECT_UPH_COMMISSIONING_SIGNOFF', '会签UPH拓扑和CT草稿'),
('permission-project-uph-publish', 'PROJECT_UPH_PUBLISH', '批准并发布UPH定义版本')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
('role-project-manager', 'permission-project-uph-read', 'PROJECT'),
('role-department-lead', 'permission-project-uph-read', 'DEPARTMENT'),
('role-engineer', 'permission-project-uph-read', 'PROJECT'),
('role-quality', 'permission-project-uph-read', 'PROJECT'),
('role-admin', 'permission-project-uph-read', 'ALL'),
('role-engineer', 'permission-project-uph-definition-manage', 'PROJECT'),
('role-admin', 'permission-project-uph-definition-manage', 'ALL'),
('role-engineer', 'permission-project-uph-commissioning-signoff', 'PROJECT'),
('role-admin', 'permission-project-uph-commissioning-signoff', 'ALL'),
('role-quality', 'permission-project-uph-publish', 'PROJECT'),
('role-admin', 'permission-project-uph-publish', 'ALL')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

COMMIT;
