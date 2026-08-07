-- APM-091B: immutable procurement readiness policy versions and calculation snapshots.
ALTER TYPE "AlertSourceType" ADD VALUE 'PROCUREMENT_NOT_ORDERED';
ALTER TYPE "AlertSourceType" ADD VALUE 'PROCUREMENT_LATE';
ALTER TYPE "AlertSourceType" ADD VALUE 'PROCUREMENT_PENDING_ACCEPTANCE';
ALTER TYPE "AlertSourceType" ADD VALUE 'PROCUREMENT_CRITICAL_SHORTAGE';
ALTER TYPE "AlertSourceType" ADD VALUE 'PROCUREMENT_CHANGE_BLOCKED';
ALTER TYPE "AlertSourceType" ADD VALUE 'PROCUREMENT_DATA_STALE';

CREATE TYPE "ProcurementReadinessScopeType" AS ENUM (
  'PROJECT',
  'DELIVERY_UNIT',
  'MACHINE',
  'MODULE',
  'REQUIREMENT'
);

CREATE TYPE "ProcurementReadinessStatus" AS ENUM (
  'READY',
  'BLOCKED',
  'EMPTY',
  'INVALID_INPUT',
  'STALE',
  'FAILED'
);

CREATE TABLE "procurement_readiness_policy_versions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "inspection_required" BOOLEAN NOT NULL,
  "arrival_auto_usable" BOOLEAN NOT NULL,
  "critical_rule_json" JSONB NOT NULL,
  "due_grace_days" INTEGER NOT NULL,
  "gate_threshold_json" JSONB NOT NULL,
  "formula_version" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "procurement_readiness_policy_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "procurement_readiness_policy_versions_project_version_key"
    UNIQUE ("project_id", "version")
);

CREATE UNIQUE INDEX "procurement_readiness_policy_versions_id_project_id_key"
  ON "procurement_readiness_policy_versions"("id", "project_id");
CREATE INDEX "procurement_readiness_policy_versions_project_created_at_idx"
  ON "procurement_readiness_policy_versions"("project_id", "created_at");
CREATE INDEX "procurement_readiness_policy_versions_created_by_created_at_idx"
  ON "procurement_readiness_policy_versions"("created_by_id", "created_at");

ALTER TABLE "procurement_readiness_policy_versions"
  ADD CONSTRAINT "procurement_readiness_policy_versions_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_readiness_policy_versions_created_by_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_readiness_policy_versions_version_check"
    CHECK ("version" > 0),
  ADD CONSTRAINT "procurement_readiness_policy_versions_arrival_auto_usable_check"
    CHECK (NOT "inspection_required" OR NOT "arrival_auto_usable"),
  ADD CONSTRAINT "procurement_readiness_policy_versions_due_grace_days_check"
    CHECK ("due_grace_days" >= 0),
  ADD CONSTRAINT "procurement_readiness_policy_versions_critical_rule_check"
    CHECK (jsonb_typeof("critical_rule_json") = 'object'),
  ADD CONSTRAINT "procurement_readiness_policy_versions_gate_threshold_check"
    CHECK (jsonb_typeof("gate_threshold_json") = 'object'),
  ADD CONSTRAINT "procurement_readiness_policy_versions_formula_version_check"
    CHECK (length(btrim("formula_version")) BETWEEN 1 AND 64),
  ADD CONSTRAINT "procurement_readiness_policy_versions_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 1 AND 1024);

ALTER TABLE "project_procurement_settings"
  ADD COLUMN "current_readiness_policy_version_id" TEXT;

CREATE UNIQUE INDEX "project_procurement_settings_current_readiness_policy_project_key"
  ON "project_procurement_settings"("current_readiness_policy_version_id", "project_id");

ALTER TABLE "project_procurement_settings"
  ADD CONSTRAINT "project_procurement_settings_current_readiness_policy_fkey"
    FOREIGN KEY ("current_readiness_policy_version_id", "project_id") REFERENCES "procurement_readiness_policy_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "procurement_readiness_results" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "scope_type" "ProcurementReadinessScopeType" NOT NULL,
  "scope_id" TEXT NOT NULL,
  "policy_version_id" TEXT NOT NULL,
  "formula_version" TEXT NOT NULL,
  "input_watermark" TEXT NOT NULL,
  "status" "ProcurementReadinessStatus" NOT NULL,
  "total_lines" INTEGER NOT NULL,
  "ready_lines" INTEGER NOT NULL,
  "readiness_rate" DECIMAL(18,6) NOT NULL,
  "critical_total_lines" INTEGER NOT NULL,
  "critical_ready_lines" INTEGER NOT NULL,
  "critical_readiness_rate" DECIMAL(18,6) NOT NULL,
  "gap_lines" INTEGER NOT NULL,
  "overdue_lines" INTEGER NOT NULL,
  "pending_acceptance_lines" INTEGER NOT NULL,
  "blocking_critical_lines" INTEGER NOT NULL,
  "source_mode" "ProcurementMode" NOT NULL,
  "source_synced_at" TIMESTAMP(3),
  "calculated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "procurement_readiness_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "procurement_readiness_results_project_scope_watermark_formula_key"
    UNIQUE ("project_id", "scope_type", "scope_id", "input_watermark", "formula_version")
);

CREATE UNIQUE INDEX "procurement_readiness_results_id_project_id_key"
  ON "procurement_readiness_results"("id", "project_id");
CREATE INDEX "procurement_readiness_results_project_scope_calculated_at_idx"
  ON "procurement_readiness_results"("project_id", "scope_type", "scope_id", "calculated_at");
CREATE INDEX "procurement_readiness_results_policy_project_idx"
  ON "procurement_readiness_results"("policy_version_id", "project_id");

ALTER TABLE "procurement_readiness_results"
  ADD CONSTRAINT "procurement_readiness_results_project_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_readiness_results_policy_version_fkey"
    FOREIGN KEY ("policy_version_id", "project_id") REFERENCES "procurement_readiness_policy_versions"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "procurement_readiness_results_scope_id_check"
    CHECK (length(btrim("scope_id")) BETWEEN 1 AND 191),
  ADD CONSTRAINT "procurement_readiness_results_formula_version_check"
    CHECK (length(btrim("formula_version")) BETWEEN 1 AND 64),
  ADD CONSTRAINT "procurement_readiness_results_input_watermark_check"
    CHECK (length(btrim("input_watermark")) BETWEEN 1 AND 191),
  ADD CONSTRAINT "procurement_readiness_results_line_counts_check"
    CHECK (
      "total_lines" >= 0
      AND "ready_lines" >= 0
      AND "ready_lines" <= "total_lines"
      AND "critical_total_lines" >= 0
      AND "critical_total_lines" <= "total_lines"
      AND "critical_ready_lines" >= 0
      AND "critical_ready_lines" <= "critical_total_lines"
      AND "critical_ready_lines" <= "ready_lines"
      AND "gap_lines" >= 0
      AND "gap_lines" <= "total_lines"
      AND "overdue_lines" >= 0
      AND "overdue_lines" <= "total_lines"
      AND "pending_acceptance_lines" >= 0
      AND "pending_acceptance_lines" <= "total_lines"
      AND "blocking_critical_lines" >= 0
      AND "blocking_critical_lines" <= "critical_total_lines"
    ),
  ADD CONSTRAINT "procurement_readiness_results_rates_check"
    CHECK (
      "readiness_rate" >= 0 AND "readiness_rate" <= 1
      AND (CASE WHEN "total_lines" = 0 THEN "readiness_rate" = 0
        ELSE "readiness_rate" = trunc("ready_lines"::NUMERIC / "total_lines", 6) END)
      AND "critical_readiness_rate" >= 0 AND "critical_readiness_rate" <= 1
      AND (CASE WHEN "critical_total_lines" = 0 THEN "critical_readiness_rate" = 0
        ELSE "critical_readiness_rate" = trunc("critical_ready_lines"::NUMERIC / "critical_total_lines", 6) END)
    ),
  ADD CONSTRAINT "procurement_readiness_results_empty_status_check"
    CHECK (
      "status" <> 'EMPTY'
      OR (
        "total_lines" = 0
        AND "ready_lines" = 0
        AND "readiness_rate" = 0
        AND "critical_total_lines" = 0
        AND "critical_ready_lines" = 0
        AND "critical_readiness_rate" = 0
        AND "gap_lines" = 0
        AND "overdue_lines" = 0
        AND "pending_acceptance_lines" = 0
        AND "blocking_critical_lines" = 0
      )
    ),
  ADD CONSTRAINT "procurement_readiness_results_ready_status_check"
    CHECK (
      "status" <> 'READY'
      OR (
        "total_lines" > 0
        AND "ready_lines" = "total_lines"
        AND "critical_ready_lines" = "critical_total_lines"
        AND "gap_lines" = 0
        AND "blocking_critical_lines" = 0
      )
    );

CREATE FUNCTION prevent_procurement_readiness_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% are immutable readiness facts', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER procurement_readiness_policy_versions_immutable
  BEFORE UPDATE OR DELETE ON "procurement_readiness_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION prevent_procurement_readiness_mutation();

CREATE TRIGGER procurement_readiness_policy_versions_no_truncate
  BEFORE TRUNCATE ON "procurement_readiness_policy_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_procurement_readiness_mutation();

CREATE TRIGGER procurement_readiness_results_immutable
  BEFORE UPDATE OR DELETE ON "procurement_readiness_results"
  FOR EACH ROW EXECUTE FUNCTION prevent_procurement_readiness_mutation();

CREATE TRIGGER procurement_readiness_results_no_truncate
  BEFORE TRUNCATE ON "procurement_readiness_results"
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_procurement_readiness_mutation();
