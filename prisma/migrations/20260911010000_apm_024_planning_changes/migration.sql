ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLANNING_CHANGE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLANNING_CHANGE_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLANNING_CHANGE_DECIDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLANNING_BASELINE_V2_FROZEN';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'PLANNING_CHANGE';
ALTER TYPE "AuditObjectType" ADD VALUE IF NOT EXISTS 'PLANNING_CHANGE_REVISION';

CREATE TYPE "PlanningChangeClassification" AS ENUM ('FORECAST_ONLY', 'FORMAL');
CREATE TYPE "PlanningChangeStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED');
CREATE TYPE "PlanningChangeApprovalMode" AS ENUM ('ALL', 'ANY');
CREATE TYPE "PlanningChangeApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

CREATE TABLE "planning_changes" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "previous_change_id" TEXT,
  "sequence" INTEGER NOT NULL,
  "classification" "PlanningChangeClassification" NOT NULL,
  "status" "PlanningChangeStatus" NOT NULL DEFAULT 'DRAFT',
  "approval_mode" "PlanningChangeApprovalMode",
  "approver_roles_json" JSONB,
  "current_revision_id" TEXT,
  "resulting_baseline_id" TEXT,
  "submitted_reason" TEXT,
  "submitted_by_id" TEXT,
  "submitted_at" TIMESTAMPTZ(3),
  "decided_at" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "planning_changes_id_project_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "planning_changes_project_code_key" UNIQUE ("project_id", "code"),
  CONSTRAINT "planning_changes_version_check" CHECK ("version" > 0),
  CONSTRAINT "planning_changes_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "planning_changes_code_check" CHECK (length(btrim("code")) BETWEEN 1 AND 100),
  CONSTRAINT "planning_changes_submitted_reason_check" CHECK (
    "submitted_reason" IS NULL OR length(btrim("submitted_reason")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "planning_changes_roles_check" CHECK (
    "approver_roles_json" IS NULL
    OR (
      jsonb_typeof("approver_roles_json") = 'array'
      AND jsonb_array_length("approver_roles_json") > 0
    )
  ),
  -- DRAFT 不得携带提交/决策事实；SUBMITTED 必须已提交且未决策；
  -- 终态必须同时具备提交与决策事实。
  CONSTRAINT "planning_changes_status_check" CHECK (
    ("status" = 'DRAFT' AND "submitted_at" IS NULL AND "decided_at" IS NULL)
    OR ("status" = 'SUBMITTED' AND "submitted_at" IS NOT NULL AND "decided_at" IS NULL)
    OR ("status" IN ('APPROVED', 'REJECTED') AND "submitted_at" IS NOT NULL AND "decided_at" IS NOT NULL)
  ),
  -- 非 DRAFT 状态必须冻结审批模式与角色，否则审批结果不可复算。
  CONSTRAINT "planning_changes_approval_binding_check" CHECK (
    "status" = 'DRAFT'
    OR ("approval_mode" IS NOT NULL AND "approver_roles_json" IS NOT NULL)
  ),
  -- 仅正式变更可以产出基线 V2；普通延期永远不得绑定基线。
  CONSTRAINT "planning_changes_baseline_binding_check" CHECK (
    "resulting_baseline_id" IS NULL OR "classification" = 'FORMAL'
  )
);

CREATE TABLE "planning_change_revisions" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "planning_change_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "classification" "PlanningChangeClassification" NOT NULL,
  "reason" TEXT NOT NULL,
  "planning_input_version" INTEGER NOT NULL,
  "resulting_planning_input_version" INTEGER NOT NULL,
  "delta_json" JSONB NOT NULL,
  "checksum" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_change_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "planning_change_revisions_id_project_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "planning_change_revisions_change_revision_key" UNIQUE ("planning_change_id", "revision"),
  CONSTRAINT "planning_change_revisions_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "planning_change_revisions_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024),
  CONSTRAINT "planning_change_revisions_checksum_check" CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "planning_change_revisions_delta_check" CHECK (jsonb_typeof("delta_json") = 'object'),
  CONSTRAINT "planning_change_revisions_input_version_check" CHECK (
    "planning_input_version" > 0
    AND "resulting_planning_input_version" >= "planning_input_version"
  )
);

CREATE TABLE "planning_change_approvers" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "planning_change_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "membership_ids_json" JSONB NOT NULL,
  "project_roles_json" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_change_approvers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "planning_change_approvers_id_project_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "planning_change_approvers_change_user_key" UNIQUE ("planning_change_id", "user_id"),
  CONSTRAINT "planning_change_approvers_memberships_check" CHECK (
    jsonb_typeof("membership_ids_json") = 'array' AND jsonb_array_length("membership_ids_json") > 0
  ),
  CONSTRAINT "planning_change_approvers_roles_check" CHECK (
    jsonb_typeof("project_roles_json") = 'array' AND jsonb_array_length("project_roles_json") > 0
  )
);

CREATE TABLE "planning_change_approvals" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "planning_change_id" TEXT NOT NULL,
  "planning_change_approver_id" TEXT NOT NULL,
  "decision" "PlanningChangeApprovalDecision" NOT NULL,
  "reason" TEXT NOT NULL,
  "decided_by_id" TEXT NOT NULL,
  "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "planning_change_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "planning_change_approvals_id_project_key" UNIQUE ("id", "project_id"),
  CONSTRAINT "planning_change_approvals_approver_key" UNIQUE ("planning_change_id", "planning_change_approver_id"),
  CONSTRAINT "planning_change_approvals_reason_check" CHECK (length(btrim("reason")) BETWEEN 1 AND 1024)
);

CREATE INDEX "planning_changes_project_id_created_at_idx"
  ON "planning_changes"("project_id", "created_at");
CREATE INDEX "planning_changes_project_id_status_idx"
  ON "planning_changes"("project_id", "status");
CREATE INDEX "planning_changes_previous_change_id_idx"
  ON "planning_changes"("previous_change_id");
CREATE INDEX "planning_change_revisions_project_id_created_at_idx"
  ON "planning_change_revisions"("project_id", "created_at");
CREATE INDEX "planning_change_approvers_project_id_user_id_idx"
  ON "planning_change_approvers"("project_id", "user_id");
CREATE INDEX "planning_change_approvals_project_id_change_decided_at_idx"
  ON "planning_change_approvals"("project_id", "planning_change_id", "decided_at");
CREATE INDEX "planning_change_approvals_decided_by_id_decided_at_idx"
  ON "planning_change_approvals"("decided_by_id", "decided_at");

ALTER TABLE "planning_changes"
  ADD CONSTRAINT "planning_changes_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "planning_changes_previous_change_project_fkey"
    FOREIGN KEY ("previous_change_id", "project_id") REFERENCES "planning_changes"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "planning_changes_resulting_baseline_project_fkey"
    FOREIGN KEY ("resulting_baseline_id", "project_id") REFERENCES "planning_baselines"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "planning_changes_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "planning_changes_submitted_by_id_fkey"
    FOREIGN KEY ("submitted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_change_revisions"
  ADD CONSTRAINT "planning_change_revisions_change_project_fkey"
    FOREIGN KEY ("planning_change_id", "project_id") REFERENCES "planning_changes"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "planning_change_revisions_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_change_approvers"
  ADD CONSTRAINT "planning_change_approvers_change_project_fkey"
    FOREIGN KEY ("planning_change_id", "project_id") REFERENCES "planning_changes"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "planning_change_approvers_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "planning_change_approvals"
  ADD CONSTRAINT "planning_change_approvals_change_project_fkey"
    FOREIGN KEY ("planning_change_id", "project_id") REFERENCES "planning_changes"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "planning_change_approvals_approver_project_fkey"
    FOREIGN KEY ("planning_change_approver_id", "project_id") REFERENCES "planning_change_approvers"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "planning_change_approvals_decided_by_id_fkey"
    FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 审批人与审批决策一经写入即冻结：冻结快照是可复算审批结果的前提。
CREATE FUNCTION reject_planning_change_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is immutable: % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER planning_change_revisions_reject_mutation
  BEFORE UPDATE OR DELETE ON "planning_change_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_change_history_mutation();
CREATE TRIGGER planning_change_revisions_reject_truncate
  BEFORE TRUNCATE ON "planning_change_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_change_history_mutation();
CREATE TRIGGER planning_change_approvers_reject_mutation
  BEFORE UPDATE OR DELETE ON "planning_change_approvers"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_change_history_mutation();
CREATE TRIGGER planning_change_approvers_reject_truncate
  BEFORE TRUNCATE ON "planning_change_approvers"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_change_history_mutation();
CREATE TRIGGER planning_change_approvals_reject_mutation
  BEFORE UPDATE OR DELETE ON "planning_change_approvals"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_change_history_mutation();
CREATE TRIGGER planning_change_approvals_reject_truncate
  BEFORE TRUNCATE ON "planning_change_approvals"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_change_history_mutation();
CREATE TRIGGER planning_changes_reject_delete
  BEFORE DELETE ON "planning_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_change_history_mutation();
CREATE TRIGGER planning_changes_reject_truncate
  BEFORE TRUNCATE ON "planning_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_planning_change_history_mutation();

-- 变更聚合根的状态机：只允许 DRAFT→SUBMITTED→终态，终态不可再流转。
CREATE FUNCTION enforce_planning_change_transition() RETURNS trigger AS $$
BEGIN
  IF OLD."status" <> NEW."status" THEN
    IF NOT (
      (OLD."status" = 'DRAFT' AND NEW."status" = 'SUBMITTED')
      OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('APPROVED', 'REJECTED'))
    ) THEN
      RAISE EXCEPTION 'illegal planning change transition: % -> %', OLD."status", NEW."status"
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- 提交后不得改写分类、审批模式与冻结审批角色，也不得更换关联的上一变更。
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."classification" IS DISTINCT FROM OLD."classification"
      OR NEW."approval_mode" IS DISTINCT FROM OLD."approval_mode"
      OR NEW."approver_roles_json" IS DISTINCT FROM OLD."approver_roles_json"
      OR NEW."previous_change_id" IS DISTINCT FROM OLD."previous_change_id"
      OR NEW."code" IS DISTINCT FROM OLD."code"
      OR NEW."sequence" IS DISTINCT FROM OLD."sequence" THEN
      RAISE EXCEPTION 'submitted planning change facts are frozen'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- 普通延期永远不得绑定基线（列级 CHECK 之外再防一次分类被改写后的绕过）。
  IF NEW."resulting_baseline_id" IS NOT NULL AND NEW."classification" = 'FORECAST_ONLY' THEN
    RAISE EXCEPTION 'forecast-only planning change must not bind a baseline'
      USING ERRCODE = '23514';
  END IF;

  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER planning_changes_transition_check
  BEFORE UPDATE ON "planning_changes"
  FOR EACH ROW EXECUTE FUNCTION enforce_planning_change_transition();

-- 审批人必须是该项目的有效成员，且与冻结角色一致。
CREATE FUNCTION enforce_planning_change_approver_relation() RETURNS trigger AS $$
DECLARE
  member_found BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM "project_members" member
      JOIN "users" actor ON actor."id" = member."user_id"
     WHERE member."id" = ANY (
             SELECT jsonb_array_elements_text(NEW."membership_ids_json")
           )
       AND member."user_id" = NEW."user_id"
       AND member."project_id" = NEW."project_id"
       AND member."left_at" IS NULL
       AND actor."status" = 'ACTIVE'::"UserStatus"
  ) INTO member_found;
  IF NOT member_found THEN
    RAISE EXCEPTION 'planning change approver must be an active project member'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER planning_change_approvers_relation_check
  BEFORE INSERT ON "planning_change_approvers"
  FOR EACH ROW EXECUTE FUNCTION enforce_planning_change_approver_relation();

-- 审批决策必须来自该变更的冻结审批人。
CREATE FUNCTION enforce_planning_change_approval_relation() RETURNS trigger AS $$
DECLARE
  approver_user_id TEXT;
BEGIN
  SELECT "user_id" INTO approver_user_id
    FROM "planning_change_approvers"
   WHERE "id" = NEW."planning_change_approver_id"
     AND "planning_change_id" = NEW."planning_change_id"
     AND "project_id" = NEW."project_id";
  IF approver_user_id IS NULL OR approver_user_id <> NEW."decided_by_id" THEN
    RAISE EXCEPTION 'planning change approval must come from a frozen approver'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER planning_change_approvals_relation_check
  BEFORE INSERT ON "planning_change_approvals"
  FOR EACH ROW EXECUTE FUNCTION enforce_planning_change_approval_relation();

-- 放开 APM-023 的 version = 1 限制，允许正式变更产出基线 V2。
-- V1 仍由 (project_id, version) 唯一约束与不可变触发器保护，历史不会被覆盖。
ALTER TABLE "planning_baselines"
  DROP CONSTRAINT "planning_baselines_version_check";
ALTER TABLE "planning_baselines"
  ADD CONSTRAINT "planning_baselines_version_check" CHECK ("version" BETWEEN 1 AND 2);
