/**
 * APM UPH 开发种子脚本（工单 W7-1）
 * ---------------------------------------------------------------------------
 * 目的：在“只建表、无业务数据”的本机开发库上，一次运行即可让 UPH 分析页面、
 * 性能问题创建、复测关联等 APM-080~084 功能拥有可供人工在界面上验证的完整数据。
 *
 * 安全边界（脚本设计必须始终满足，任何一条被破坏都视为缺陷）：
 *   1. 只新增数据，绝不 DROP / TRUNCATE / DELETE 任何已有数据，也不调用
 *      `prisma migrate reset` / `prisma db push`。
 *   2. 启动时校验 DATABASE_URL 的 host 必须是 localhost 或 127.0.0.1，
 *      不满足立即 exit(1)，且校验发生在任何 Prisma Client 构造之前
 *      （数据库相关模块全部使用运行期 `import()` 延迟加载），确保零写入。
 *   3. 不连接、不改动任何非本机数据库。
 *   4. 不修改 schema.prisma、不新增迁移、不改动任何业务源码——本文件是本工单
 *      唯一新增的源码文件。
 *   5. 不在仓库中留下报告 / 临时 / 散落文件；本脚本的全部输出只写到 stdout。
 *
 * 幂等设计：
 *   - 用户 / 项目 / 模板 / 交付单元 / 项目模块 / 项目成员等“非版本化”基础行，
 *     使用固定确定性 ID，通过 `INSERT ... ON CONFLICT (id) DO NOTHING`
 *     实现真正的 SQL 级 upsert，重复运行不产生重复行、不触碰已有行。
 *   - 公司级能力开关（company_capabilities.UPH_ANALYSIS）是脚本创建范围之外
 *     的全局配置行，只允许在当前为禁用状态时通过既有的
 *     `updateCompanyCapability` 应用服务翻转为启用（该服务本身会写一致的
 *     Audit + Outbox + CompanyCapabilityRevision 记录），已启用则跳过，绝不
 *     回退、绝不绕过应用层直接改状态。
 *   - UPH 拓扑 / CT / 公式 / 测试批次 / 性能目标等版本化聚合根，由既有应用服务
 *     以 randomUUID() 生成自己的行 ID（服务层不接受调用方指定 ID），因此无法
 *     用“固定 ID + upsert”在行级别做幂等。改为在调用任何创建流程之前，先按
 *     确定性业务键（projectId、projectModuleId、topologyRootNodeId、
 *     batchNumber 等，均已是 schema 上的 @@unique 约束）查询“当前是否已发布 /
 *     已存在”，已存在则整段跳过并直接复用已存在的 ID；不存在才执行一次完整的
 *     创建流程。效果上等价于“按业务键的 upsert”，且完全不触碰
 *     PUBLISHED 行的 UPDATE（不可变版本模式由数据库触发器强制，脚本也从不尝试
 *     UPDATE 一行已 PUBLISHED 的版本）。
 *   - `analyses.createUphAnalysis` 本身已经是幂等的（内部按
 *     (projectId, revisionId, lockedChecksum, engineCode) 查重，命中则直接
 *     返回既有快照），因此每次运行都可以放心调用，不需要额外包装。
 *   - 已知边界：如果第一次运行在测试批次创建到锁定之间的中途失败退出，脚本会
 *     在下一次运行时看到“批次行已存在”而整体跳过该阶段，不会尝试续跑到
 *     LOCKED。这是“只增不删”与“聚合根 ID 由服务层生成”两条约束下的固有取舍：
 *     成功完整跑完一次之后，任意次数的重复运行都是幂等的（这也是验收要求的
 *     场景）；一次失败的半成品运行需要人工核实后再决定是否重跑。
 *
 * 数值约定：UPH 相关的小数字段（周期秒数 / UPH 目标值等）一律以六位小数的
 * 十进制字符串传入应用服务（如 "101.000000"），交由服务层写入
 * `Decimal(20,6)` 定点列；不使用 JS 二进制浮点数表示这些值。整数计数字段
 * （良品数 / 毛产出数等）按各应用服务既有签名使用安全整数，由服务层内部转换为
 * 数据库 BigInt 列。
 */

/**
 * 返修记录（工单 APM-W7-1-FIX，三处缺陷修复）：
 *   - 缺陷1（阻塞级）：新增 ensureUserRoles()，为四个种子用户写入 user_roles，
 *     修复 HTTP / 页面级鉴权（authorizeProjectRequest -> loadAuthorizationActor）
 *     读不到角色导致的 403——buildActors() 构造的内存 grants 只服务于本文件
 *     内部直接调用应用服务的路径，从未写库，两条路径互不相通。
 *   - 缺陷2：新增 loadDotEnvIfPresent()，用 Node 原生 process.loadEnvFile
 *     （非 dotenv 三方依赖）在 assertLocalDatabaseOrExit() 之前加载 .env，
 *     修复全新终端窗口（无会话级 DATABASE_URL）下 npm run db:seed 必然失败的问题。
 *   - 缺陷3：prisma/schema.prisma 的 generator client 增加
 *     binaryTargets = ["native", "windows", "debian-openssl-3.0.x"]，修复
 *     Windows / Linux 沙箱共用同一份 node_modules 时互相覆盖查询引擎的问题。
 *     该项是本工单在 seed.ts 之外唯一改动的文件，属生成器配置，不触发新迁移。
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

// ---------------------------------------------------------------------------
// -1. 加载 .env —— 必须先于本机数据库校验执行；只使用 Node 原生
//     process.loadEnvFile（Node >= 20.12.0），不引入 dotenv 第三方依赖。语义与
//     dotenv 一致：只补全 process.env 中尚未设置的键，不会覆盖已存在的同名
//     变量（包括 Windows 用户 / 系统级环境变量——历史上真实出现过某个 User
//     级 DATABASE_URL 静默盖过 .env 的坑）。
// ---------------------------------------------------------------------------
function loadDotEnvIfPresent(): void {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");
  try {
    process.loadEnvFile(envPath);
  } catch (error: unknown) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      console.error(`[seed] 加载 .env 失败（${envPath}）：`, error);
      process.exit(1);
    }
    // .env 文件不存在不视为致命错误：部分真实部署场景直接用环境变量而不落地
    // .env 文件，是否可继续交由下面的 DATABASE_URL 校验统一判断与报错。
  }
}

// ---------------------------------------------------------------------------
// 0. 本机数据库校验：必须在加载 .env 之后、且先于任何 Prisma Client 构造执行。
// ---------------------------------------------------------------------------
function assertLocalDatabaseOrExit(): void {
  const raw = process.env.DATABASE_URL;
  if (!raw || !raw.trim()) {
    console.error(
      "[seed] 未设置 DATABASE_URL，拒绝执行任何写入。\n" +
        "  请检查：(1) 仓库根目录是否存在 .env 且其中写了 DATABASE_URL；\n" +
        "  (2) Windows 环境变量的三个作用域——进程 / 用户 / 系统——是否有同名\n" +
        "  变量覆盖了 .env（.env 不会覆盖已存在的环境变量，可用\n" +
        "  `[Environment]::GetEnvironmentVariable('DATABASE_URL','User')` 与\n" +
        "  `...('DATABASE_URL','Machine')` 分别排查用户与系统作用域）。"
    );
    process.exit(1);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.error(`[seed] DATABASE_URL 不是合法连接串，拒绝执行任何写入：${raw}`);
    process.exit(1);
  }
  const host = parsed.hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    console.error(
      `[seed] DATABASE_URL 指向 "${host}"，不是本机（localhost / 127.0.0.1），拒绝执行任何写入。`
    );
    process.exit(1);
  }
}

loadDotEnvIfPresent();
assertLocalDatabaseOrExit();

// ---------------------------------------------------------------------------
// 1. 固定确定性 ID —— 全部是字面量常量，不使用 randomUUID，保证幂等可复现。
// ---------------------------------------------------------------------------
const IDS = {
  project: "seed-uph-w7-project",
  userProcess: "seed-uph-w7-user-process",
  userCommission: "seed-uph-w7-user-commission",
  userPm: "seed-uph-w7-user-pm",
  userQuality: "seed-uph-w7-user-quality",
  template: "seed-uph-w7-template",
  templateVersion: "seed-uph-w7-template-version",
  component: "seed-uph-w7-component",
  componentVersion: "seed-uph-w7-component-version",
  snapshot: "seed-uph-w7-snapshot",
  snapshotComponent: "seed-uph-w7-snapshot-component",
  line: "seed-uph-w7-line",
  machine: "seed-uph-w7-machine",
  moduleFeed: "seed-uph-w7-module-feed",
  modulePress: "seed-uph-w7-module-press",
  memberProcess: "seed-uph-w7-member-process",
  memberCommission: "seed-uph-w7-member-commission",
  memberPm: "seed-uph-w7-member-pm",
  memberQuality: "seed-uph-w7-member-quality",
  userRolePm: "seed-uph-w7-user-role-pm",
  userRoleProcess: "seed-uph-w7-user-role-process",
  userRoleCommission: "seed-uph-w7-user-role-commission",
  userRoleQuality: "seed-uph-w7-user-role-quality"
} as const;

const PROJECT_CODE = "P-SEED-UPH-W7";
const BATCH_NUMBER = "SEED-UPH-W7-BATCH-001";

const REPORT_TABLES = [
  "users",
  "projects",
  "project_members",
  "delivery_units",
  "project_modules",
  "project_capabilities",
  "project_uph_topologies",
  "project_uph_topology_versions",
  "project_uph_topology_nodes",
  "project_uph_ct_definitions",
  "project_uph_ct_definition_versions",
  "project_uph_formulas",
  "project_uph_formula_versions",
  "project_uph_test_batches",
  "project_uph_test_batch_revisions",
  "project_uph_test_batch_revision_module_bindings",
  "project_uph_module_cycle_samples",
  "project_uph_test_batch_revision_production_counts",
  "project_uph_analysis_snapshots",
  "project_uph_performance_targets",
  "project_uph_performance_target_versions"
] as const;

async function main(): Promise<void> {
  // 数据库相关模块延迟到这里才 import：0 节的校验已经通过，此后才允许触碰任何
  // 会构造 PrismaClient 的模块。
  const { db } = await import("@/lib/db");
  const { Prisma } = await import("@prisma/client");
  const definitions = await import("@/modules/uph/application/uph-definition-service");
  const batches = await import("@/modules/uph/application/uph-test-batch-service");
  const analyses = await import("@/modules/uph/application/uph-analysis-service");
  const { createUphPerformanceTarget, publishUphPerformanceTarget } =
    await import("@/modules/uph/application/uph-performance-target-service");
  const { updateCompanyCapability } =
    await import("@/modules/configuration/application/configuration-service");
  const { default: authorizeModule } = await import("@/lib/auth/authorize").then((mod) => ({
    default: mod
  }));
  void authorizeModule;
  type AuthorizationActor =
    Awaited<typeof import("@/lib/auth/authorize")> extends infer _M
      ? import("@/lib/auth/authorize").AuthorizationActor
      : never;
  type AuditContext = import("@/modules/audit/contracts/audit").AuditContext;

  async function rowCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of REPORT_TABLES) {
      let sql;
      if (table === "users") {
        sql = Prisma.sql`SELECT count(*)::int AS count FROM ${Prisma.raw(table)} WHERE id IN (${Prisma.join(
          [IDS.userProcess, IDS.userCommission, IDS.userPm, IDS.userQuality]
        )})`;
      } else if (table === "projects") {
        // projects 表本身没有 project_id 列（自身即是主体），用 id 过滤。
        sql = Prisma.sql`SELECT count(*)::int AS count FROM ${Prisma.raw(table)} WHERE id = ${IDS.project}`;
      } else {
        sql = Prisma.sql`SELECT count(*)::int AS count FROM ${Prisma.raw(table)} WHERE project_id = ${IDS.project}`;
      }
      const rows = await db.$queryRaw<Array<{ count: number }>>(sql);
      out[table] = rows[0]?.count ?? 0;
    }
    return out;
  }

  async function currentProjectVersion(): Promise<number> {
    const rows = await db.$queryRaw<Array<{ version: number }>>(
      Prisma.sql`SELECT version FROM projects WHERE id = ${IDS.project}`
    );
    if (!rows[0]) throw new Error("[seed] 种子项目缺失，基础行阶段未正确执行。");
    return rows[0].version;
  }

  function auditCtx(actorId: string, reason: string, operationSuffix: string): AuditContext {
    return {
      actorId,
      requestId: `seed-uph-w7-${operationSuffix}`,
      traceId: null,
      source: "API",
      sourceIp: null,
      userAgent: "apm-uph-seed-w7-1",
      reason,
      projectId: IDS.project,
      departmentId: null,
      operationId: `seed-uph-w7-${operationSuffix}`
    };
  }

  function buildActors(): {
    processActor: AuthorizationActor;
    commissionActor: AuthorizationActor;
    pmActor: AuthorizationActor;
    qualityActor: AuthorizationActor;
  } {
    const processActor: AuthorizationActor = {
      id: IDS.userProcess,
      name: "Seed Process Engineer",
      status: "ACTIVE",
      departmentId: null,
      systemRoles: [],
      grants: [
        { permission: "PROJECT_UPH_BATCH_MANAGE", scope: "PROJECT", systemRole: "ENGINEER" },
        { permission: "PROJECT_UPH_ANALYZE", scope: "PROJECT", systemRole: "ENGINEER" },
        { permission: "PROJECT_UPH_READ", scope: "PROJECT", systemRole: "ENGINEER" },
        { permission: "PROJECT_UPH_DEFINITION_MANAGE", scope: "PROJECT", systemRole: "ENGINEER" }
      ]
    };
    const commissionActor: AuthorizationActor = {
      ...processActor,
      id: IDS.userCommission,
      name: "Seed Commissioning Engineer"
    };
    const pmActor: AuthorizationActor = {
      id: IDS.userPm,
      name: "Seed Project Manager",
      status: "ACTIVE",
      departmentId: null,
      systemRoles: [],
      grants: [
        {
          permission: "PROJECT_UPH_BATCH_CONFIRM",
          scope: "PROJECT",
          systemRole: "PROJECT_MANAGER"
        },
        { permission: "PROJECT_UPH_ANALYZE", scope: "PROJECT", systemRole: "PROJECT_MANAGER" },
        { permission: "PROJECT_UPH_READ", scope: "PROJECT", systemRole: "PROJECT_MANAGER" }
      ]
    };
    const qualityActor: AuthorizationActor = {
      id: IDS.userQuality,
      name: "Seed Quality Engineer",
      status: "ACTIVE",
      departmentId: null,
      systemRoles: [],
      grants: [
        { permission: "PROJECT_UPH_BATCH_LOCK", scope: "PROJECT", systemRole: "QUALITY" },
        { permission: "PROJECT_UPH_ANALYZE", scope: "PROJECT", systemRole: "QUALITY" },
        { permission: "PROJECT_UPH_READ", scope: "PROJECT", systemRole: "QUALITY" },
        { permission: "PROJECT_UPH_PUBLISH", scope: "PROJECT", systemRole: "QUALITY" }
      ]
    };
    return { processActor, commissionActor, pmActor, qualityActor };
  }

  // ---------------------------------------------------------------------------
  // 阶段一：非版本化基础行——用户 / 模板发布链 / 项目 / 交付单元 / 项目模块 /
  // 项目成员 / 项目能力选型。全部使用固定 ID + ON CONFLICT DO NOTHING。
  // ---------------------------------------------------------------------------
  async function ensureBaseRows(): Promise<void> {
    await db.$transaction(async (tx) => {
      const now = "CURRENT_TIMESTAMP";
      for (const [id, employeeNo, name] of [
        [IDS.userProcess, "SEED-UPH-W7-PROCESS", "Seed Process Engineer"],
        [IDS.userCommission, "SEED-UPH-W7-COMMISSION", "Seed Commissioning Engineer"],
        [IDS.userPm, "SEED-UPH-W7-PM", "Seed Project Manager"],
        [IDS.userQuality, "SEED-UPH-W7-QUALITY", "Seed Quality Engineer"]
      ]) {
        await tx.$executeRaw`
          INSERT INTO users(id, employee_no, name, status, version, created_at, updated_at)
          VALUES (${id}, ${employeeNo}, ${name}, 'ACTIVE', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT (id) DO NOTHING`;
      }

      await tx.$executeRaw`
        INSERT INTO templates(id, code, name, status, current_version, version, created_by_id, updated_by_id, created_at, updated_at)
        VALUES (${IDS.template}, 'UPH.SEED.W7', 'UPH Seed W7-1', 'ACTIVE', 1, 1, ${IDS.userProcess}, ${IDS.userProcess}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO NOTHING`;
      await tx.$executeRaw`
        INSERT INTO template_versions(id, template_id, version, status, name, checksum, published_by_id, published_at)
        VALUES (${IDS.templateVersion}, ${IDS.template}, 1, 'PUBLISHED', 'UPH Seed W7-1', repeat('0', 64), ${IDS.userProcess}, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO NOTHING`;
      await tx.$executeRaw`
        INSERT INTO template_components(id, code, component_type, name, draft_content, status, current_version, version, created_by_id, updated_by_id, created_at, updated_at)
        VALUES (${IDS.component}, 'UPH.SEED.W7.CAPABILITY', 'CAPABILITY_RULE'::"TemplateComponentType", 'UPH seed capability',
          '{"capabilities":[{"code":"UPH_ANALYSIS","required":false}]}'::jsonb,
          'ACTIVE'::"TemplateMasterStatus", 1, 1, ${IDS.userProcess}, ${IDS.userProcess}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO NOTHING`;
      await tx.$executeRaw`
        INSERT INTO template_component_versions(id, component_id, version, status, component_type, name, content_json, checksum, published_by_id, published_at)
        VALUES (${IDS.componentVersion}, ${IDS.component}, 1, 'PUBLISHED'::"TemplateVersionStatus", 'CAPABILITY_RULE'::"TemplateComponentType", 'UPH seed capability',
          '{"capabilities":[{"code":"UPH_ANALYSIS","required":false}]}'::jsonb, repeat('0', 64), ${IDS.userProcess}, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO NOTHING`;

      await tx.$executeRaw`
        INSERT INTO projects(id, code, name, status, version, initialization_status, source_template_version_id,
          source_template_checksum, initialized_at, project_type, equipment_shape, structure_status,
          capability_configuration_status, capabilities_configured_at, created_by_id, created_at, updated_at)
        VALUES (${IDS.project}, ${PROJECT_CODE}, 'UPH Seed W7-1', 'DRAFT', 1, 'READY', ${IDS.templateVersion},
          repeat('0', 64), CURRENT_TIMESTAMP, 'CUSTOMER_DELIVERY', 'LINE', 'READY', 'READY', CURRENT_TIMESTAMP,
          ${IDS.userProcess}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO NOTHING`;

      await tx.$executeRaw`
        INSERT INTO project_template_snapshots(id, project_id, source_template_version_id, source_template_checksum,
          snapshot_checksum, template_code, template_name, template_version, template_published_at)
        SELECT ${IDS.snapshot}, ${IDS.project}, template_version.id, template_version.checksum, repeat('0', 64),
          template.code, template_version.name, template_version.version, template_version.published_at
        FROM template_versions template_version
        JOIN templates template ON template.id = template_version.template_id
        WHERE template_version.id = ${IDS.templateVersion}
        ON CONFLICT (id) DO NOTHING`;
      await tx.$executeRaw`
        INSERT INTO project_template_snapshot_components(id, snapshot_id, source_component_version_id, component_type,
          slot, position, source_checksum, component_code, component_name, component_version, description, content_json)
        SELECT ${IDS.snapshotComponent}, ${IDS.snapshot}, component_version.id, component_version.component_type, 'CAPABILITY_RULE', 0,
          component_version.checksum, component.code, component_version.name, component_version.version,
          component_version.description, component_version.content_json
        FROM template_component_versions component_version
        JOIN template_components component ON component.id = component_version.component_id
        WHERE component_version.id = ${IDS.componentVersion}
        ON CONFLICT (id) DO NOTHING`;
      await tx.$executeRaw`
        INSERT INTO project_capabilities(project_id, capability_code, template_allowed, template_required,
          selected_enabled, source_snapshot_component_id, version, created_by_id, updated_by_id, created_at, updated_at)
        VALUES (${IDS.project}, 'UPH_ANALYSIS', true, false, true, ${IDS.snapshotComponent}, 1, ${IDS.userProcess}, ${IDS.userProcess}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (project_id, capability_code) DO NOTHING`;

      await tx.$executeRaw`
        INSERT INTO delivery_units(id, project_id, parent_id, unit_type, code, name, status, position, version, created_by_id, updated_by_id, created_at, updated_at)
        VALUES
          (${IDS.line}, ${IDS.project}, NULL, 'LINE', 'LINE-SEED-W7', 'Seed Line', 'ACTIVE', 0, 1, ${IDS.userProcess}, ${IDS.userProcess}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          (${IDS.machine}, ${IDS.project}, ${IDS.line}, 'MACHINE', 'MACHINE-SEED-W7', 'Seed Machine', 'ACTIVE', 0, 1, ${IDS.userProcess}, ${IDS.userProcess}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO NOTHING`;
      await tx.$executeRaw`
        INSERT INTO project_modules(id, project_id, delivery_unit_id, code, name, status, position, version, created_by_id, updated_by_id, created_at, updated_at)
        VALUES
          (${IDS.moduleFeed}, ${IDS.project}, ${IDS.machine}, 'MOD-SEED-W7-FEED', 'Seed Feed Module', 'ACTIVE', 0, 1, ${IDS.userProcess}, ${IDS.userProcess}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          (${IDS.modulePress}, ${IDS.project}, ${IDS.machine}, 'MOD-SEED-W7-PRESS', 'Seed Press Module', 'ACTIVE', 1, 1, ${IDS.userProcess}, ${IDS.userProcess}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (id) DO NOTHING`;

      await tx.$executeRaw`
        INSERT INTO project_members(id, project_id, user_id, project_role, assigned_by_id, joined_at, version)
        VALUES
          (${IDS.memberProcess}, ${IDS.project}, ${IDS.userProcess}, 'ENGINEER', ${IDS.userProcess}, CURRENT_TIMESTAMP, 1),
          (${IDS.memberCommission}, ${IDS.project}, ${IDS.userCommission}, 'ENGINEER', ${IDS.userProcess}, CURRENT_TIMESTAMP, 1),
          (${IDS.memberPm}, ${IDS.project}, ${IDS.userPm}, 'PROJECT_MANAGER', ${IDS.userProcess}, CURRENT_TIMESTAMP, 1),
          (${IDS.memberQuality}, ${IDS.project}, ${IDS.userQuality}, 'QUALITY', ${IDS.userProcess}, CURRENT_TIMESTAMP, 1)
        ON CONFLICT (id) DO NOTHING`;
    });
  }

  // ---------------------------------------------------------------------------
  // 阶段一 b（工单 APM-W7-1-FIX 缺陷1）：写入 user_roles。HTTP / 页面级鉴权走
  // authorizeProjectRequest -> loadAuthorizationActor -> user_roles -> roles ->
  // role_permissions -> permissions 这条纯数据库链路，buildActors() 构造的
  // 内存 grants 只服务于本文件内部直接调用应用服务的路径，不会被这条链路
  // 读取，这也是此前页面级验收结构性不可达（403）的根因。角色 id 必须从
  // 目录表 roles 里查实存在，缺失则立即报错退出，不静默跳过、不插入空关联。
  // user_roles 没有 (user_id, role_id) 唯一约束，只能用固定 id +
  // ON CONFLICT (id) DO NOTHING 做幂等；严格限定四个 seed-uph-w7-* 用户，
  // 不触碰任何其他用户的授权数据。
  // ---------------------------------------------------------------------------
  async function ensureUserRoles(): Promise<void> {
    const mapping: Array<{ userRoleId: string; userId: string; roleId: string }> = [
      { userRoleId: IDS.userRolePm, userId: IDS.userPm, roleId: "role-project-manager" },
      { userRoleId: IDS.userRoleProcess, userId: IDS.userProcess, roleId: "role-engineer" },
      { userRoleId: IDS.userRoleCommission, userId: IDS.userCommission, roleId: "role-engineer" },
      { userRoleId: IDS.userRoleQuality, userId: IDS.userQuality, roleId: "role-quality" }
    ];

    const requiredRoleIds = [...new Set(mapping.map((m) => m.roleId))];
    const found = await db.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM roles WHERE id IN (${Prisma.join(requiredRoleIds)})`
    );
    const foundIds = new Set(found.map((r) => r.id));
    const missing = requiredRoleIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      console.error(
        `[seed] 角色目录表 roles 中找不到以下角色 id：${missing.join(", ")}。` +
          "该目录应由迁移 20260802010000_apm_002_authorization 预先写入，" +
          "请确认迁移已完整执行（npm run db:migrate:deploy）。拒绝插入 user_roles 空/错误关联，退出。"
      );
      process.exit(1);
    }

    await db.$transaction(async (tx) => {
      for (const m of mapping) {
        await tx.$executeRaw`
          INSERT INTO user_roles(id, user_id, role_id, assigned_by_id, assigned_at)
          VALUES (${m.userRoleId}, ${m.userId}, ${m.roleId}, NULL, CURRENT_TIMESTAMP)
          ON CONFLICT (id) DO NOTHING`;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 阶段二：公司级 UPH_ANALYSIS 能力开关——已启用则跳过，禁用才通过既有配置
  // 应用服务翻转（保持 Audit / Outbox / CompanyCapabilityRevision 一致）。
  // ---------------------------------------------------------------------------
  async function ensureCompanyCapabilityEnabled(): Promise<"already-enabled" | "enabled"> {
    const rows = await db.$queryRaw<Array<{ enabled: boolean; version: number }>>(
      Prisma.sql`SELECT enabled, version FROM company_capabilities WHERE code = 'UPH_ANALYSIS'`
    );
    if (!rows[0])
      throw new Error("[seed] company_capabilities 缺少 UPH_ANALYSIS 行，迁移未正确执行。");
    if (rows[0].enabled) return "already-enabled";
    await updateCompanyCapability({
      code: "UPH_ANALYSIS",
      enabled: true,
      version: rows[0].version,
      reason: "APM UPH 种子脚本（工单 W7-1）：启用 UPH_ANALYSIS 能力开关以便本机手工验证。",
      actorId: IDS.userProcess,
      auditContext: auditCtx(
        IDS.userProcess,
        "APM UPH 种子脚本（工单 W7-1）：启用 UPH_ANALYSIS 能力开关以便本机手工验证。",
        "company-capability"
      )
    });
    return "enabled";
  }

  // ---------------------------------------------------------------------------
  // 阶段三：拓扑定义——ROOT(LINE) -> MANDATORY(MACHINE) -> {MANDATORY(MODULE 多穴),
  // PARALLEL(MODULE)}，覆盖必经 / 并联 / 无环。
  // ---------------------------------------------------------------------------
  async function ensureTopologyPublished(actors: ReturnType<typeof buildActors>): Promise<string> {
    const existing = await db.$queryRaw<Array<{ currentPublishedVersionId: string | null }>>(
      Prisma.sql`SELECT current_published_version_id AS "currentPublishedVersionId" FROM project_uph_topologies WHERE project_id = ${IDS.project}`
    );
    if (!existing[0]?.currentPublishedVersionId) {
      const reason = "APM UPH 种子脚本（工单 W7-1）：发布拓扑定义。";
      const topology = await definitions.createUphDefinition({
        projectId: IDS.project,
        actorId: actors.processActor.id,
        authorizationActor: actors.processActor,
        body: {
          kind: "TOPOLOGY",
          projectVersion: await currentProjectVersion(),
          content: {
            projectShape: "LINE",
            roots: [
              {
                sourceId: IDS.line,
                sourceType: "LINE",
                parentSourceId: null,
                relation: "ROOT",
                capacity: 100,
                children: [
                  {
                    sourceId: IDS.machine,
                    sourceType: "MACHINE",
                    parentSourceId: IDS.line,
                    relation: "MANDATORY",
                    capacity: 100,
                    children: [
                      {
                        sourceId: IDS.moduleFeed,
                        sourceType: "MODULE",
                        parentSourceId: IDS.machine,
                        relation: "MANDATORY",
                        capacity: 100
                      },
                      {
                        sourceId: IDS.modulePress,
                        sourceType: "MODULE",
                        parentSourceId: IDS.machine,
                        relation: "PARALLEL",
                        capacity: 60
                      }
                    ]
                  }
                ]
              }
            ]
          }
        },
        auditContext: auditCtx(actors.processActor.id, reason, "topology-create")
      });
      const signed = await definitions.signoffUphDefinition({
        projectId: IDS.project,
        kind: "TOPOLOGY",
        versionId: topology.id,
        resourceVersion: topology.resourceVersion,
        actorId: actors.commissionActor.id,
        authorizationActor: actors.commissionActor,
        auditContext: auditCtx(actors.commissionActor.id, reason, "topology-signoff")
      });
      await definitions.publishUphDefinition({
        projectId: IDS.project,
        kind: "TOPOLOGY",
        versionId: topology.id,
        resourceVersion: signed.resourceVersion,
        actorId: actors.qualityActor.id,
        authorizationActor: actors.qualityActor,
        auditContext: auditCtx(actors.qualityActor.id, reason, "topology-publish")
      });
      console.log("[seed] 拓扑定义已发布（TOPOLOGY）。");
    } else {
      console.log("[seed] 拓扑定义已存在且为 PUBLISHED，跳过创建。");
    }
    const rootRows = await db.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT node.id FROM project_uph_topology_nodes node
        JOIN project_uph_topologies root ON root.current_published_version_id = node.topology_version_id
        WHERE root.project_id = ${IDS.project} AND node.delivery_unit_id = ${IDS.line} AND node.parent_relation = 'ROOT'`
    );
    if (!rootRows[0]) throw new Error("[seed] 未能定位已发布拓扑的 ROOT 节点。");
    return rootRows[0].id;
  }

  // ---------------------------------------------------------------------------
  // 阶段四：CT 定义——ROOT 范围内的每个模块都必须有已发布 CT（应用服务的硬约束），
  // 其中 Feed 模块 cavityCount=2 覆盖“多穴”。
  // ---------------------------------------------------------------------------
  async function ensureCtPublished(
    actors: ReturnType<typeof buildActors>,
    moduleId: string,
    content: {
      intrinsicCtSeconds: number;
      outputPerCycleTotal: number;
      parallelChannelCount: number;
      cavityCount: number;
    },
    label: string
  ): Promise<void> {
    const existing = await db.$queryRaw<Array<{ currentPublishedVersionId: string | null }>>(
      Prisma.sql`SELECT current_published_version_id AS "currentPublishedVersionId" FROM project_uph_ct_definitions WHERE project_id = ${IDS.project} AND project_module_id = ${moduleId}`
    );
    if (existing[0]?.currentPublishedVersionId) {
      console.log(`[seed] CT 定义（${label}）已存在且为 PUBLISHED，跳过创建。`);
      return;
    }
    const reason = `APM UPH 种子脚本（工单 W7-1）：发布 CT 定义（${label}）。`;
    const ct = await definitions.createUphDefinition({
      projectId: IDS.project,
      actorId: actors.processActor.id,
      authorizationActor: actors.processActor,
      body: {
        kind: "CT",
        projectVersion: await currentProjectVersion(),
        content: { projectModuleId: moduleId, ...content }
      },
      auditContext: auditCtx(actors.processActor.id, reason, `ct-${label}-create`)
    });
    const signed = await definitions.signoffUphDefinition({
      projectId: IDS.project,
      kind: "CT",
      versionId: ct.id,
      resourceVersion: ct.resourceVersion,
      actorId: actors.commissionActor.id,
      authorizationActor: actors.commissionActor,
      auditContext: auditCtx(actors.commissionActor.id, reason, `ct-${label}-signoff`)
    });
    await definitions.publishUphDefinition({
      projectId: IDS.project,
      kind: "CT",
      versionId: ct.id,
      resourceVersion: signed.resourceVersion,
      actorId: actors.qualityActor.id,
      authorizationActor: actors.qualityActor,
      auditContext: auditCtx(actors.qualityActor.id, reason, `ct-${label}-publish`)
    });
    console.log(`[seed] CT 定义（${label}）已发布。`);
  }

  // ---------------------------------------------------------------------------
  // 阶段五：确定性公式版本——CANONICAL_UPH_V1，create -> publish（公式无需签收）。
  // ---------------------------------------------------------------------------
  async function ensureFormulaPublished(actors: ReturnType<typeof buildActors>): Promise<void> {
    const existing = await db.$queryRaw<Array<{ currentPublishedVersionId: string | null }>>(
      Prisma.sql`SELECT current_published_version_id AS "currentPublishedVersionId" FROM project_uph_formulas WHERE project_id = ${IDS.project}`
    );
    if (existing[0]?.currentPublishedVersionId) {
      console.log("[seed] 公式版本已存在且为 PUBLISHED，跳过创建。");
      return;
    }
    const reason = "APM UPH 种子脚本（工单 W7-1）：发布确定性公式版本。";
    const formula = await definitions.createUphDefinition({
      projectId: IDS.project,
      actorId: actors.processActor.id,
      authorizationActor: actors.processActor,
      body: {
        kind: "FORMULA",
        projectVersion: await currentProjectVersion(),
        content: {
          formulaCode: "CANONICAL_UPH_V1",
          formulaJson: {
            numerator: "3600*outputPerCycleTotal*parallelChannelCount",
            denominator: "intrinsicCtSeconds"
          }
        }
      },
      auditContext: auditCtx(actors.processActor.id, reason, "formula-create")
    });
    await definitions.publishUphDefinition({
      projectId: IDS.project,
      kind: "FORMULA",
      versionId: formula.id,
      resourceVersion: formula.resourceVersion,
      actorId: actors.qualityActor.id,
      authorizationActor: actors.qualityActor,
      auditContext: auditCtx(actors.qualityActor.id, reason, "formula-publish")
    });
    console.log("[seed] 公式版本已发布。");
  }

  // ---------------------------------------------------------------------------
  // 阶段六：UPH 性能目标——必须先于批次锁定完成发布，使 published_at /
  // effective_at 天然早于批次的 lockedAt（真实墙钟时间顺序，而非伪造字段）。
  // ---------------------------------------------------------------------------
  async function ensurePerformanceTargetPublished(
    actors: ReturnType<typeof buildActors>,
    topologyRootNodeId: string
  ): Promise<void> {
    const existing = await db.$queryRaw<Array<{ currentPublishedVersionId: string | null }>>(
      Prisma.sql`SELECT current_published_version_id AS "currentPublishedVersionId" FROM project_uph_performance_targets WHERE project_id = ${IDS.project} AND topology_root_node_id = ${topologyRootNodeId}`
    );
    if (existing[0]?.currentPublishedVersionId) {
      console.log("[seed] UPH 性能目标版本已存在且为 PUBLISHED，跳过创建。");
      return;
    }
    const reason = "APM UPH 种子脚本（工单 W7-1）：发布 UPH 性能目标，供批次锁定后判定适用性。";
    const draft = await createUphPerformanceTarget({
      projectId: IDS.project,
      actorId: actors.processActor.id,
      authorizationActor: actors.processActor,
      projectMemberRoles: ["ENGINEER"],
      topologyRootNodeId,
      targetUph: "120.000000",
      reason,
      auditContext: auditCtx(actors.processActor.id, reason, "target-create")
    });
    await publishUphPerformanceTarget({
      projectId: IDS.project,
      actorId: actors.qualityActor.id,
      authorizationActor: actors.qualityActor,
      projectMemberRoles: ["QUALITY"],
      targetVersionId: String(draft.id),
      resourceVersion: Number(draft.resourceVersion),
      reason,
      auditContext: auditCtx(actors.qualityActor.id, reason, "target-publish")
    });
    console.log("[seed] UPH 性能目标版本已发布（targetUph = 120.000000）。");
  }

  // ---------------------------------------------------------------------------
  // 阶段七：LOCKED 测试批次——两个模块各 10 条周期样本 + 分层质量计数，
  // DRAFT -> PM_CONFIRMED -> LOCKED。
  // ---------------------------------------------------------------------------
  async function ensureLockedBatch(
    actors: ReturnType<typeof buildActors>,
    topologyRootNodeId: string
  ): Promise<{ batchId: string; revisionId: string }> {
    const existing = await db.$queryRaw<
      Array<{ id: string; currentLockedRevisionId: string | null }>
    >(
      Prisma.sql`SELECT id, current_locked_revision_id AS "currentLockedRevisionId" FROM project_uph_test_batches WHERE project_id = ${IDS.project} AND batch_number = ${BATCH_NUMBER}`
    );
    if (existing[0]) {
      if (!existing[0].currentLockedRevisionId) {
        throw new Error(
          "[seed] 测试批次已存在但未锁定（疑似上一次运行中途失败），需人工核实后再决定是否重跑。"
        );
      }
      console.log("[seed] 测试批次已存在且为 LOCKED，跳过创建。");
      return { batchId: existing[0].id, revisionId: existing[0].currentLockedRevisionId };
    }

    const reason = "APM UPH 种子脚本（工单 W7-1）：创建并锁定测试批次。";
    const created = await batches.createUphTestBatch({
      projectId: IDS.project,
      actorId: actors.processActor.id,
      authorizationActor: actors.processActor,
      body: {
        batchNumber: BATCH_NUMBER,
        topologyRootNodeId,
        plannedProductionSeconds: 3600,
        planDeclarationReason: reason,
        observationStartedAt: "2026-09-01T08:00:00.000Z",
        observationEndedAt: "2026-09-01T09:00:00.000Z",
        timezone: "Asia/Shanghai"
      },
      auditContext: auditCtx(actors.processActor.id, reason, "batch-create")
    });

    let resourceVersion = created.resourceVersion;
    for (const moduleId of [IDS.moduleFeed, IDS.modulePress]) {
      const tag = moduleId === IDS.moduleFeed ? "feed" : "press";
      for (let ordinal = 1; ordinal <= 10; ordinal += 1) {
        const sample = await batches.appendUphCycleSample({
          projectId: IDS.project,
          batchId: created.batchId,
          revisionId: created.revisionId,
          actorId: actors.processActor.id,
          authorizationActor: actors.processActor,
          resourceVersion,
          body: {
            projectModuleId: moduleId,
            ordinal,
            sourceEventId: `seed-uph-w7-device-${tag}-${ordinal}`,
            cycleDurationSeconds: `${ordinal}.000000`,
            observedAt: `2026-09-01T08:${String(ordinal).padStart(2, "0")}:00.000Z`,
            captureMethod: "DEVICE_EVENT",
            disposition: "INCLUDED"
          },
          auditContext: auditCtx(actors.processActor.id, reason, `batch-sample-${tag}-${ordinal}`)
        });
        resourceVersion = sample.resourceVersion;
      }
    }

    const afterSamples = await batches.getUphTestBatchRevision({
      projectId: IDS.project,
      batchId: created.batchId,
      revisionId: created.revisionId,
      authorizationActor: actors.processActor,
      projectMemberRoles: ["ENGINEER"]
    });
    const production = await batches.updateUphTestBatchProductionCount({
      projectId: IDS.project,
      batchId: created.batchId,
      revisionId: created.revisionId,
      actorId: actors.processActor.id,
      authorizationActor: actors.processActor,
      resourceVersion: afterSamples.resourceVersion,
      body: { actualGrossOutputCount: 100, finalGoodOutputCount: 90 },
      auditContext: auditCtx(actors.processActor.id, reason, "batch-production-count")
    });

    let qualityResourceVersion = production.resourceVersion;
    const qualityCounts: Array<{
      moduleId: string;
      tag: string;
      body: {
        qualityInputCount: number;
        firstPassGoodCount: number;
        firstPassNonconformingCount: number;
        reworkInputCount: number;
        reworkRecoveredGoodCount: number;
      };
    }> = [
      {
        moduleId: IDS.moduleFeed,
        tag: "feed",
        body: {
          qualityInputCount: 10,
          firstPassGoodCount: 8,
          firstPassNonconformingCount: 2,
          reworkInputCount: 2,
          reworkRecoveredGoodCount: 1
        }
      },
      {
        moduleId: IDS.modulePress,
        tag: "press",
        body: {
          qualityInputCount: 10,
          firstPassGoodCount: 9,
          firstPassNonconformingCount: 1,
          reworkInputCount: 1,
          reworkRecoveredGoodCount: 1
        }
      }
    ];
    for (const entry of qualityCounts) {
      const quality = await batches.updateUphTestBatchModuleQualityCount({
        projectId: IDS.project,
        batchId: created.batchId,
        revisionId: created.revisionId,
        moduleId: entry.moduleId,
        actorId: actors.processActor.id,
        authorizationActor: actors.processActor,
        resourceVersion: qualityResourceVersion,
        body: entry.body,
        auditContext: auditCtx(actors.processActor.id, reason, `batch-quality-${entry.tag}`)
      });
      qualityResourceVersion = quality.resourceVersion;
    }

    const confirmed = await batches.confirmUphTestBatch({
      projectId: IDS.project,
      batchId: created.batchId,
      revisionId: created.revisionId,
      actorId: actors.pmActor.id,
      authorizationActor: actors.pmActor,
      resourceVersion: qualityResourceVersion,
      auditContext: auditCtx(actors.pmActor.id, reason, "batch-pm-confirm")
    });
    const locked = await batches.lockUphTestBatch({
      projectId: IDS.project,
      batchId: created.batchId,
      revisionId: created.revisionId,
      actorId: actors.qualityActor.id,
      authorizationActor: actors.qualityActor,
      resourceVersion: confirmed.resourceVersion,
      auditContext: auditCtx(actors.qualityActor.id, reason, "batch-lock")
    });
    void locked;
    console.log("[seed] 测试批次已创建并锁定（LOCKED）。");
    return { batchId: created.batchId, revisionId: created.revisionId };
  }

  // ---------------------------------------------------------------------------
  // 阶段八：分析快照——createUphAnalysis 内部已按锁定 checksum 查重，天然幂等。
  // ---------------------------------------------------------------------------
  async function ensureAnalysisSnapshot(
    actors: ReturnType<typeof buildActors>,
    batchId: string,
    revisionId: string
  ): Promise<string> {
    const reason = "APM UPH 种子脚本（工单 W7-1）：生成分析快照。";
    const analysis = await analyses.createUphAnalysis({
      projectId: IDS.project,
      batchId,
      revisionId,
      actorId: actors.processActor.id,
      authorizationActor: actors.processActor,
      auditContext: auditCtx(actors.processActor.id, reason, "analysis-create")
    });
    console.log(
      `[seed] 分析快照就绪：analysisId=${analysis.analysisId} actualGoodUph=${analysis.actualGoodUph}`
    );
    return analysis.analysisId;
  }

  // ---------------------------------------------------------------------------
  // 编排：严格按依赖与真实时间顺序执行——性能目标必须先于批次锁定发布。
  // ---------------------------------------------------------------------------
  console.log("[seed] === APM UPH 种子脚本（工单 W7-1）开始 ===");
  const before = await rowCounts();
  console.log(`[seed] row-counts (before) => ${JSON.stringify(before)}`);

  await ensureBaseRows();
  await ensureUserRoles();
  await ensureCompanyCapabilityEnabled();
  const actors = buildActors();
  const topologyRootNodeId = await ensureTopologyPublished(actors);
  await ensureCtPublished(
    actors,
    IDS.moduleFeed,
    { intrinsicCtSeconds: 12, outputPerCycleTotal: 1, parallelChannelCount: 1, cavityCount: 2 },
    "feed"
  );
  await ensureCtPublished(
    actors,
    IDS.modulePress,
    { intrinsicCtSeconds: 10, outputPerCycleTotal: 1, parallelChannelCount: 2, cavityCount: 1 },
    "press"
  );
  await ensureFormulaPublished(actors);
  await ensurePerformanceTargetPublished(actors, topologyRootNodeId);
  const { batchId, revisionId } = await ensureLockedBatch(actors, topologyRootNodeId);
  await ensureAnalysisSnapshot(actors, batchId, revisionId);

  const after = await rowCounts();
  console.log(`[seed] row-counts (after)  => ${JSON.stringify(after)}`);
  console.log("[seed] === APM UPH 种子脚本（工单 W7-1）完成 ===");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("[seed] 种子脚本执行失败：", error);
    process.exit(1);
  });
