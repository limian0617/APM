# APM-100 FAT/SAT Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在采购基线上建立安全、不可变、可审计的 FAT/SAT 验收基础域和项目内页面。

**Architecture:** 新增 `src/modules/acceptance`，按 domain/contracts/application/infrastructure 分层。模板版本与测试项快照不可变；批次是项目内状态聚合；结果采用追加式 revision。Route Handler 保持薄层，所有命令通过项目授权、乐观锁、幂等和 Prisma 事务，同时写 AuditLog 与 OutboxEvent。

**Tech Stack:** Next.js 16 App Router、TypeScript、Prisma/PostgreSQL、Vitest、React 19、现有文件授权与对象存储服务。

---

### Task 1: 领域词汇和纯规则

**Files:**
- Create: `src/modules/acceptance/domain/acceptance-policy.ts`
- Create: `src/modules/acceptance/domain/acceptance-policy.test.ts`
- Modify: `src/lib/auth/permissions.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`

- [ ] 写失败测试：FAT/SAT、scope、DRAFT→IN_PROGRESS→LOCKED、锁定拒绝、PASS/FAIL/NA 通过率、必测项缺失和不可变模板快照校验。
- [ ] 运行聚焦测试确认因实现缺失失败。
- [ ] 实现最小纯函数和错误码。
- [ ] 运行聚焦测试并保留领域边界。

### Task 2: Prisma 模型、迁移和数据库约束

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_apm_100_acceptance_foundation/migration.sql`
- Create: `src/modules/acceptance/infrastructure/acceptance-persistence.integration.test.ts`

- [ ] 写失败集成测试：跨项目 scope/FK、模板版本修改、批次锁定后修改/删除、结果 revision 更新/删除必须被数据库拒绝。
- [ ] 运行测试确认数据库模型不存在而失败（无数据库时记录连接限制）。
- [ ] 增加模板、模板项、批次、结果和结果修订模型及复合关系；锁定和追加历史用触发器保护。
- [ ] 运行 `npm run db:generate`、`npm run db:validate` 和可用的 PostgreSQL 回放。

### Task 3: 模板和批次应用服务

**Files:**
- Create: `src/modules/acceptance/application/acceptance-template-service.ts`
- Create: `src/modules/acceptance/application/acceptance-batch-service.ts`
- Create: matching unit/integration tests

- [ ] 先写跨项目、权限、幂等、版本冲突和事务回滚失败测试。
- [ ] 实现发布模板快照、列出模板版本、创建批次、开始和锁定。
- [ ] 每个命令在单事务中写业务事实、审计和 Outbox。

### Task 4: 结果和证据应用服务

**Files:**
- Create: `src/modules/acceptance/application/acceptance-result-service.ts`
- Create: `src/modules/acceptance/application/acceptance-evidence-service.ts`
- Create: matching tests

- [ ] 先写结果追加修订、锁定拒绝、证据文件状态/项目/权限失败测试。
- [ ] 实现结果稳定身份、revisionNo/supersedes、通过率摘要和证据引用；复用 `file-download-service` 的授权目标和审计方法。
- [ ] 保持 APM-101 只读 `resultRevisionId` 端口，不创建 Issue/Gate。

### Task 5: Route Handler 和合同测试

**Files:**
- Create: `src/app/api/projects/[projectId]/acceptance/.../route.ts`
- Create: `src/modules/acceptance/contracts/acceptance-http.ts`
- Create: route contract tests

- [ ] 先写 DTO、IDOR、401/403、409 version/idempotency 和错误映射失败测试。
- [ ] 实现模板、批次、状态、结果、摘要和证据路由；Route Handler 只做解析、调用和映射。

### Task 6: 页面状态合同和 FAT/SAT 页面

**Files:**
- Create: `src/modules/acceptance/contracts/acceptance-page-state.ts` and tests
- Create: `src/app/projects/[projectId]/acceptance/page.tsx`
- Create: `src/app/projects/[projectId]/acceptance/acceptance-page-client.tsx` and tests
- Modify: project navigation only to publish the implemented FAT/SAT entry

- [ ] 先写页面状态和视图交互失败测试。
- [ ] 实现 FAT/SAT 模板、批次、测试项和结果页面，覆盖 normal/loading/empty/error/denied/stale，不生成后续工作包空壳。
- [ ] 验证当前 projectId、键盘焦点和移动端无横向溢出。

### Task 7: 全量质量门禁和进度证据

- [ ] 运行 `npm run db:generate`、`format:check`、`lint`、`typecheck`、`test`、`db:validate`、`build`、`npm audit --audit-level=high`、`git diff --check`。
- [ ] 检查 PostgreSQL 可用性；分别记录空库和升级迁移结果，不能以 schema 校验替代。
- [ ] 仅在本地与 CI 证据完整后把进度表 APM-100 更新为已完成，否则记录进行中并保留限制。
