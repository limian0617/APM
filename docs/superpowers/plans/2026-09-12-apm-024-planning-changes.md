# APM-024 / PLN-CHG 计划变更 — 验收标准

- 制定日期：2026-09-12
- PM 会话：APM-PM2（本文件的验收条目即验收口径，来源见下）
- 实施分支：`codex/apm-024` @ `846bab9`（worktree `D:\GPT Prj\自动化设备项目管理\worktrees\apm-024`）
- PR：[#54](https://github.com/limian0617/APM/pull/54)（Draft，base `main`）

## 0. 依据来源

本工作包此前没有 plan/spec（`docs/superpowers/` 下零条目），验收依据由以下三处构成，
本文档把它们翻译成逐条可判定的条目，**不新增、不降低**任何既有口径：

| 来源                                     | 内容                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `.arch.txt:245`                          | `/projects/{projectId}/changes` 为 GOV 统一变更工作台；**APM-024 仅实现计划变更**，不自动扩展为全部跨域变更 |
| 用户当面裁决 ①（2026-09-12 交接单 §1.2） | 审批配置只从请求体显式提供，HTTP 层不提供默认值；缺省即 422                                                 |
| 用户当面裁决 ②（同上）                   | 允许自批，但仅限持有审批权限的人；审批资格来自提交时冻结的审批人快照，与「是否为提交人」无关                |

## 1. 交付物边界（本次验收判定的是「设计中的行为成立」，不是「文件已存在」）

包含：计划变更聚合与状态机、提交时审批人快照冻结、`ALL`/`ANY` 决策求值、`FORMAL` 变更产出基线 V2、
四个 HTTP 路由、变更审计字段、四张表的手写迁移。

**不包含**（不得因缺失而判不成立，也不得由 worker 顺手补）：APM-024 之外的跨域变更、审批人解析规则的
业务默认值、编号分配的取锁/重试重设计、UI、ERP/NUS-M9 接口。

## 2. 验收条目

| 编号  | 验收条目                                                                                                                                                                                 | 判定方式                                                                                   | 结论                                   | 证据                                                                                                                                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | 状态机为 `DRAFT → SUBMITTED → APPROVED / REJECTED`，非法迁移被拒                                                                                                                         | 领域单测 + 服务单测                                                                        | **成立**                               | `migration.sql:204-213`（非法迁移 RAISE 23514）、`planning-change-service.ts:509`                                                      |
| AC-02 | 提交时按**声明的审批项目角色**解析审批人并冻结快照；冻结后成员变更不改写历史                                                                                                             | 集成用例（`planning-change.integration.test.ts:409`）+ 读 `resolvePlanningChangeApprovers` | **成立**                               | `planning-change.ts:65-109`；集成用例 `:409`                                                                                           |
| AC-03 | `ALL` 会签：任一拒绝即拒绝，全部批准才批准；`ANY` 或签：任一拒绝即拒绝，任一批准即批准                                                                                                   | 读 `evaluatePlanningChangeDecision:115` + 单测                                             | **成立**                               | `planning-change.ts:115-131`（PM 实读）；单测 `planning-change.test.ts:145/155/168/179`                                                |
| AC-04 | `FORMAL` 批准后冻结基线 V2；`FORECAST_ONLY` 在任何批准情况下都不绑定基线                                                                                                                 | 集成用例 `:519`、`:565`                                                                    | **成立**                               | `requiredBaselineVersion:137-140`、`planning-change-service.ts:584`；集成用例 `:519`、`:549`、`:565`                                   |
| AC-05 | 审批配置只从请求体显式提供；`approvalMode` 或 `approverProjectRoles` 缺省即 422，不得回退默认值                                                                                          | 读 `parsePlanningChangeApprovalConfiguration:68` + HTTP 契约测试                           | **成立**                               | `planning-change-service.ts:68-103`；契约测试 `planning-change-http.test.ts:76-97`                                                     |
| AC-06 | 持有审批角色的提交人可自批；无审批角色的提交人自批被拒并返回 `PLANNING_CHANGE_APPROVAL_FORBIDDEN` 403                                                                                    | 集成用例 `:460`、`:492`                                                                    | **成立**                               | `planning-change-service.ts:515-522`（PM 实读：只看冻结快照，无提交人判断）；集成用例 `:460`、`:492`                                   |
| AC-07 | 四个路由存在且行为正确：`GET/POST /api/projects/[projectId]/planning-changes`、`GET /[changeId]`、`POST /[changeId]/submit`、`POST /[changeId]/decide`                                   | 读路由文件 + HTTP 契约测试                                                                 | **成立**                               | 四个 route.ts 齐备且各自带权限守卫；契约测试 `planning-change-http.test.ts` 全绿                                                       |
| AC-08 | 所有读写严格按项目隔离，跨项目访问默认拒绝                                                                                                                                               | 集成用例 `:620` + 读路由取参                                                               | **成立**                               | `authorizeProjectRequest` + 服务层所有读写带 projectId 过滤；集成用例 `:620` 覆盖四种路径                                              |
| AC-09 | 变更审计事实落地：`PLANNING_CHANGE_CREATED/SUBMITTED/DECIDED`、`PLANNING_BASELINE_V2_FROZEN` 与对应对象类型可写入审计与 outbox，且变更 `id` 能通过 `sanitizeAuditValue`                  | 读 `audit/domain/vocabulary.ts` diff + 单测                                                | **成立**                               | `vocabulary.ts` 新增 4 动作 + 2 对象类型 + 3 组 allowedFields；`write-audit.ts:15` 经 `sanitizeAuditValue`，`id` 在白名单内            |
| AC-10 | 迁移为**手写 SQL**、追加式（无 `DROP`），建 4 表：`planning_changes`、`planning_change_revisions`、`planning_change_approvers`、`planning_change_approvals`；修订表一经写入不可改写/删除 | 读 `prisma/migrations/20260911010000_apm_024_planning_changes/migration.sql`               | **成立**（含 1 处已披露偏差，见 §4.4） | 300 行仅新增：4 表 + 8 索引 + 14 外键 + 6 触发器；`migration.sql:178-183` 修订表禁改写/截断                                            |
| AC-11 | 并发创建变更单：不取锁，冲突由唯一约束兜底并报 `PLANNING_CHANGE_CONFLICT`，**不自动重试**（既有行为，本轮不重设计）                                                                      | 集成用例 `:359`                                                                            | **成立**                               | `nextChangeSequence:224-234`（PM 实读：仅 `max(sequence)+1`）、`mapDatabaseError:242-247`（P2002 → CONFLICT，无重试）；集成用例 `:359` |
| AC-12 | 七道闸门在 `codex/apm-024` 全绿，且有落盘证据                                                                                                                                            | 复算，见 §3                                                                                | **成立**                               | 见 §3 闸门表                                                                                                                           |
| AC-13 | PR/CI 事实与分支头一致                                                                                                                                                                   | `gh` 实读，见 §3                                                                           | **成立**                               | 见 §3 事实表                                                                                                                           |

## 3. 闸门与事实核对结果（2026-09-12 实测）

执行方：W1（独立验收 worker，worktree 内未提交、未改动任何文件）。
全部输出落盘 `worktrees/apm-024/.tmp/out/verify-*.txt`，PM 已复算。

| 闸门           | 退出码 | 备注                                                                                                                |
| -------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `format:check` | 0      | 首轮曾报 1，唯一红点是 PM 本人留在 worktree 的未跟踪计划文件（不在分支内）；PM 用 `prettier --write` 修好后复检为 0 |
| `lint`         | 0      |                                                                                                                     |
| `typecheck`    | 0      | 含 `typecheck:scripts`                                                                                              |
| `test`         | 0      | Test Files 321 passed / 53 skipped（374）；Tests 1484 passed / 327 skipped（1811）                                  |
| `db:generate`  | 0      | Prisma Client v6.19.3                                                                                               |
| `db:validate`  | 0      |                                                                                                                     |
| `build`        | 0      | **未复现**交接单所述的 Turbopack 符号链接坑——worktree 的 `node_modules` 实为实体目录                                |

- **数据库集成测试**（`RUN_DATABASE_INTEGRATION=1`）：11/11 passed，退出码 0。
  本机 `127.0.0.1:5432` 可用（`apm-postgres` healthy），`prisma migrate status` 报
  "Database schema is up to date!"（迁移 `20260911010000` 已应用）。**本轮为本地实测证据，非 CI 替代。**

### 3.1 事实核对（PM 实读）

| 项                                 | 事实                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 本地 HEAD / `origin/codex/apm-024` | `846bab9d40e3d0053f3898f9fae4b08e0f4aec55`，两者一致                                                      |
| PR #54                             | state OPEN / isDraft **true** / base `main` / mergeable MERGEABLE / mergeStateStatus CLEAN                |
| CI                                 | run `34688405413`（event pull_request，headSha 与分支头一致）success；job `verify / 103539329535` success |
| 验收期间 worktree                  | 保持干净，无提交、无 `schema.prisma` 改动、无数据库写操作                                                 |

## 4. 遗留缺口与已披露偏差

### 4.1 业务 Owner 待确认项

**审批人解析规则、审批模式及生效条件的业务 Owner 正式确认仍未落定。** 当前实现按「显式传入、默认拒绝」
处理，是刻意设计，不是缺口，不判 AC 不成立。

### 4.2 编号分配不取锁

见 AC-11。若后续要改成取锁或重试，是**新工作包**，不塞进 APM-024。

### 4.3 测试断言强度

测试以 `toMatchObject` 与具体错误码断言实现，未做变异测试，无法声称断言不可绕过；
`:492` 用例的拒绝原因无法与「非审批人」路径完全区分（两者落入同一 403 分支）。精度有限，可接受，记录备查。

### 4.4 AC-10 的 `DROP` 偏差（已披露，判成立）

迁移末段 `migration.sql:297-300` 对 `planning_baselines` 先 `DROP CONSTRAINT "planning_baselines_version_check"`
再重建为 `CHECK ("version" BETWEEN 1 AND 2)`，以放开 APM-023 的 `version = 1` 限制、允许正式变更产出基线 V2。

- 性质：**约束放宽，不是删数据、不是删表**；V1 仍由 `(project_id, version)` 唯一约束与不可变触发器保护，
  历史不会被覆盖。同文件 `:295-296` 有注释说明。
- PM 判定：AC-10 的「无 `DROP`」按**追加式迁移、不改写既有事实**的意图解释，本项**成立**。
  Postgres 无法原地修改 CHECK 约束，重建是唯一手段。

### 4.5 证据来源

本机对象存储未涉及；数据库证据为本机实测。其余环境若不可用，相应证据须标注来自 CI。

---

## 5. 验收记录

- **验收结论：AC-01 ~ AC-13 全部成立**，含 §4.4 一处已披露偏差（判定成立）。
- 验收日期：2026-09-12
- 验收执行：W1（worker 会话）；核对与回填：APM-PM2（PM 会话）
- 分支 / 提交：`codex/apm-024` @ `846bab9d40e3d0053f3898f9fae4b08e0f4aec55`
- PR：limian0617/APM #54（Draft，OPEN，MERGEABLE / CLEAN）
- CI：run `34688405413` / job `103539329535`，success
- 闸门：七道全绿（见 §3）；数据库集成 11/11
- 遗留缺口：§4.1（业务 Owner 待确认，非缺口）、§4.2（取锁/重试属新工作包）、§4.3（断言强度，备查）
- 未发现实现缺陷。

**状态标注：`codex/apm-024` 的实现与验收均已通过，但 PR #54 仍为 Draft 且未合并，因此工作包状态记
「已验收待合并」，不计入「已验收工作包」计数，直至 PR 合并。**
