-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "PermissionScope" AS ENUM ('ALL', 'DEPARTMENT', 'PROJECT', 'SELF', 'ASSIGNED');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'GATE_REVIEW', 'SUSPENDED', 'CLOSED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ProjectRole" AS ENUM ('PROJECT_MANAGER', 'DEPARTMENT_LEAD', 'ENGINEER', 'PROCUREMENT', 'QUALITY', 'VIEWER');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "employee_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "department_id" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "scope" "PermissionScope" NOT NULL,
    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "assigned_by_id" TEXT,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "department_id" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_members" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_role" "ProjectRole" NOT NULL,
    "department_id" TEXT,
    "assigned_by_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    "left_by_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "object_id" TEXT,
    "before_json" JSONB,
    "after_json" JSONB,
    "source" TEXT NOT NULL,
    "source_ip" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_no_key" ON "users"("employee_no");
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_department_id_idx" ON "users"("department_id");
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");
CREATE INDEX "user_roles_user_id_revoked_at_idx" ON "user_roles"("user_id", "revoked_at");
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");
CREATE UNIQUE INDEX "user_roles_active_key" ON "user_roles"("user_id", "role_id") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX "projects_code_key" ON "projects"("code");
CREATE INDEX "projects_department_id_idx" ON "projects"("department_id");
CREATE INDEX "project_members_project_id_left_at_idx" ON "project_members"("project_id", "left_at");
CREATE INDEX "project_members_user_id_left_at_idx" ON "project_members"("user_id", "left_at");
CREATE UNIQUE INDEX "project_members_active_role_key" ON "project_members"("project_id", "user_id", "project_role") WHERE "left_at" IS NULL;
CREATE INDEX "audit_logs_actor_id_occurred_at_idx" ON "audit_logs"("actor_id", "occurred_at");
CREATE INDEX "audit_logs_object_type_object_id_occurred_at_idx" ON "audit_logs"("object_type", "object_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_left_by_id_fkey" FOREIGN KEY ("left_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed fixed MVP system roles.
INSERT INTO "roles" ("id", "code", "name", "description", "is_system", "updated_at") VALUES
('role-project-manager', 'PROJECT_MANAGER', '项目经理', '项目交付、计划、门禁发起与项目成员管理', true, CURRENT_TIMESTAMP),
('role-department-lead', 'DEPARTMENT_LEAD', '部门负责人', '本部门资源、任务和模板指定的门禁审批', true, CURRENT_TIMESTAMP),
('role-engineer', 'ENGINEER', '工程师', '参与项目的任务与本人验收记录', true, CURRENT_TIMESTAMP),
('role-procurement', 'PROCUREMENT', '采购', '参与项目的采购与任务进度', true, CURRENT_TIMESTAMP),
('role-quality', 'QUALITY', '质量', '验收、质量复核与模板指定的门禁审批', true, CURRENT_TIMESTAMP),
('role-executive', 'EXECUTIVE', '管理层', '全公司只读看板与指定审批', true, CURRENT_TIMESTAMP),
('role-admin', 'ADMIN', '系统管理员', '系统配置、权限代管和审计', true, CURRENT_TIMESTAMP);

-- Seed stable permission vocabulary used by service-side authorization.
INSERT INTO "permissions" ("id", "code", "description") VALUES
('permission-project-create', 'PROJECT_CREATE', '创建项目'),
('permission-project-read', 'PROJECT_READ', '读取项目'),
('permission-project-plan-update', 'PROJECT_PLAN_UPDATE', '编辑项目计划与基线'),
('permission-task-progress-update', 'TASK_PROGRESS_UPDATE', '更新任务进度'),
('permission-gate-submit', 'GATE_SUBMIT', '发起门禁申请'),
('permission-gate-approve', 'GATE_APPROVE', '按模板分配审批门禁'),
('permission-acceptance-read', 'ACCEPTANCE_READ', '读取验收数据'),
('permission-acceptance-result-update', 'ACCEPTANCE_RESULT_UPDATE', '录入 FAT/SAT 结果'),
('permission-acceptance-evidence-manage', 'ACCEPTANCE_EVIDENCE_MANAGE', '管理验收确认和签名证据'),
('permission-acceptance-review', 'ACCEPTANCE_REVIEW', '质量复核验收记录'),
('permission-portfolio-read', 'PORTFOLIO_READ', '查看项目组合看板'),
('permission-project-member-read', 'PROJECT_MEMBER_READ', '查看项目成员'),
('permission-project-member-manage', 'PROJECT_MEMBER_MANAGE', '管理项目成员'),
('permission-configuration-read', 'CONFIGURATION_READ', '查看系统配置'),
('permission-configuration-write', 'CONFIGURATION_WRITE', '编辑系统配置'),
('permission-sensitive-contract-read', 'SENSITIVE_CONTRACT_READ', '查看合同金额等敏感字段'),
('permission-sensitive-confirmation-read', 'SENSITIVE_CONFIRMATION_READ', '查看客户联系与签名证据'),
('permission-audit-read', 'AUDIT_READ', '查看审计记录');

-- The scope is the maximum reach granted by the system role. Project-role and
-- resource-owner checks are still enforced by the application authorization core.
INSERT INTO "role_permissions" ("role_id", "permission_id", "scope") VALUES
('role-project-manager', 'permission-project-create', 'ALL'),
('role-project-manager', 'permission-project-read', 'PROJECT'),
('role-project-manager', 'permission-project-plan-update', 'PROJECT'),
('role-project-manager', 'permission-task-progress-update', 'PROJECT'),
('role-project-manager', 'permission-gate-submit', 'PROJECT'),
('role-project-manager', 'permission-acceptance-read', 'PROJECT'),
('role-project-manager', 'permission-acceptance-result-update', 'SELF'),
('role-project-manager', 'permission-acceptance-evidence-manage', 'PROJECT'),
('role-project-manager', 'permission-portfolio-read', 'PROJECT'),
('role-project-manager', 'permission-project-member-read', 'PROJECT'),
('role-project-manager', 'permission-project-member-manage', 'PROJECT'),
('role-project-manager', 'permission-sensitive-contract-read', 'PROJECT'),
('role-project-manager', 'permission-sensitive-confirmation-read', 'PROJECT'),

('role-department-lead', 'permission-project-read', 'DEPARTMENT'),
('role-department-lead', 'permission-project-plan-update', 'DEPARTMENT'),
('role-department-lead', 'permission-task-progress-update', 'DEPARTMENT'),
('role-department-lead', 'permission-gate-approve', 'ASSIGNED'),
('role-department-lead', 'permission-acceptance-read', 'DEPARTMENT'),
('role-department-lead', 'permission-portfolio-read', 'DEPARTMENT'),
('role-department-lead', 'permission-project-member-read', 'DEPARTMENT'),

('role-engineer', 'permission-project-read', 'PROJECT'),
('role-engineer', 'permission-task-progress-update', 'SELF'),
('role-engineer', 'permission-acceptance-read', 'PROJECT'),
('role-engineer', 'permission-acceptance-result-update', 'SELF'),
('role-engineer', 'permission-portfolio-read', 'PROJECT'),
('role-engineer', 'permission-project-member-read', 'PROJECT'),

('role-procurement', 'permission-project-read', 'PROJECT'),
('role-procurement', 'permission-task-progress-update', 'SELF'),
('role-procurement', 'permission-portfolio-read', 'PROJECT'),
('role-procurement', 'permission-project-member-read', 'PROJECT'),

('role-quality', 'permission-project-read', 'PROJECT'),
('role-quality', 'permission-task-progress-update', 'SELF'),
('role-quality', 'permission-gate-approve', 'ASSIGNED'),
('role-quality', 'permission-acceptance-read', 'PROJECT'),
('role-quality', 'permission-acceptance-result-update', 'PROJECT'),
('role-quality', 'permission-acceptance-evidence-manage', 'PROJECT'),
('role-quality', 'permission-acceptance-review', 'PROJECT'),
('role-quality', 'permission-portfolio-read', 'PROJECT'),
('role-quality', 'permission-project-member-read', 'PROJECT'),
('role-quality', 'permission-sensitive-confirmation-read', 'PROJECT'),

('role-executive', 'permission-project-read', 'ALL'),
('role-executive', 'permission-gate-approve', 'ASSIGNED'),
('role-executive', 'permission-acceptance-read', 'ALL'),
('role-executive', 'permission-portfolio-read', 'ALL'),
('role-executive', 'permission-project-member-read', 'ALL'),
('role-executive', 'permission-configuration-read', 'ALL'),
('role-executive', 'permission-sensitive-contract-read', 'ALL'),

('role-admin', 'permission-project-create', 'ALL'),
('role-admin', 'permission-project-read', 'ALL'),
('role-admin', 'permission-project-plan-update', 'ALL'),
('role-admin', 'permission-task-progress-update', 'ALL'),
('role-admin', 'permission-acceptance-read', 'ALL'),
('role-admin', 'permission-acceptance-result-update', 'ALL'),
('role-admin', 'permission-portfolio-read', 'ALL'),
('role-admin', 'permission-project-member-read', 'ALL'),
('role-admin', 'permission-project-member-manage', 'ALL'),
('role-admin', 'permission-configuration-read', 'ALL'),
('role-admin', 'permission-configuration-write', 'ALL'),
('role-admin', 'permission-sensitive-contract-read', 'ALL'),
('role-admin', 'permission-sensitive-confirmation-read', 'ALL'),
('role-admin', 'permission-audit-read', 'ALL');
