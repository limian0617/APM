# APM-100 Release-Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 FAT/SAT 验收基础域的发布前修补，使全局模板发布、项目内命令页面、追加证据集合和数据库约束能在 PostgreSQL CI 中安全验收。

**Architecture:** 模板发布转移到系统配置边界；项目页面只读取已发布模板和受权的项目批次。模板 SHA-256、批次状态/范围、结果修订、证据集合、审计与 Outbox 均在应用服务和同一 Prisma 事务中确定，数据库迁移继续保护不可变历史。

**Tech Stack:** Next.js App Router、TypeScript、React 19、Vitest、Prisma 6/PostgreSQL、现有授权/幂等/Audit/Outbox 边界。

---

### Task 1: 先扩展纯领域合同与失败测试

**Files:**

- Modify: `src/modules/acceptance/domain/acceptance-policy.ts`
- Modify: `src/modules/acceptance/domain/acceptance-policy.test.ts`

- [ ] 为规范化 SHA-256、内容篡改、同内容确定性、冻结单位和重测同范围写失败测试。
- [ ] 运行 `npm run test -- src/modules/acceptance/domain/acceptance-policy.test.ts`，确认测试因新函数/规则缺失而失败。
- [ ] 实现稳定字段序列化、`calculateAcceptanceTemplateChecksum`、实测单位和重测兼容性规则。
- [ ] 重跑该测试，预期通过且不修改 APM-101 边界。

### Task 2: 迁移为全局模板并支持追加式多证据

**Files:**

- Modify: `prisma/schema.prisma`
- Modify: `prisma/migrations/20260809020000_apm_100_acceptance_foundation/migration.sql`
- Modify: `src/modules/acceptance/infrastructure/acceptance-persistence.integration.test.ts`

- [ ] 写 PostgreSQL 失败测试：模板并发版本、同项目/可用受控文件、必需证据、证据历史不可改删、错误范围重测及冻结单位。
- [ ] 将模板主记录增加版本并发字段，结果修订的单文件外键替换为 `AcceptanceTestResultRevisionEvidence` 集合与不可变触发器。
- [ ] 为重测原批次写数据库检查，拒绝未锁定、跨项目、类型或范围不一致的引用。
- [ ] 执行 `npm run db:generate`、`npm run db:validate`；数据库不可用时保留集成测试跳过和 CI 回放限制。

### Task 3: 全局发布及项目命令应用服务

**Files:**

- Modify: `src/modules/acceptance/application/acceptance-service.ts`
- Modify: `src/modules/acceptance/application/acceptance-service.integration.test.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`
- Modify: `src/modules/audit/domain/vocabulary.test.ts`

- [ ] 先写发布竞争、P2002 映射、事务回滚、重测校验、单位拒绝、多证据审计/Outbox的失败测试。
- [ ] 用数据库行锁或带 `currentVersion` 的受保护更新发布全局模板，服务端计算 checksum；绝不读取客户端 checksum。
- [ ] 在创建批次、记录/修订结果和锁定批次中返回服务器派生 `allowedActions`、缺失必测项和摘要；每条命令保持事实、审计和 Outbox 原子提交。
- [ ] 重跑领域和应用服务测试。

### Task 4: 重新划分 HTTP 边界并补齐 API 合同

**Files:**

- Create: `src/app/api/acceptance/templates/route.ts`
- Create: `src/app/api/acceptance/templates/route.test.ts`
- Modify: `src/app/api/projects/[projectId]/acceptance/templates/route.ts`
- Modify: `src/app/api/projects/[projectId]/acceptance/batches/**/route.ts`
- Modify: `src/modules/acceptance/contracts/acceptance-http.ts`
- Modify: matching route tests

- [ ] 先写全局 `CONFIGURATION_WRITE` 发布、项目端口拒绝 POST、项目读权限、跨项目 IDOR、严格 DTO、Idempotency-Key、409 和多证据权限失败测试。
- [ ] 创建全局发布端口并让项目端口只读；从 DTO 移除 checksum 与 `measuredUnit`，改用 `evidenceFileIds: string[]`。
- [ ] 让每条命令路由基于服务返回的结构化错误映射 409，且只在存在证据时额外要求 `ACCEPTANCE_EVIDENCE_MANAGE`。
- [ ] 运行所有 acceptance API 路由测试。

### Task 5: 完整项目页面命令闭环

**Files:**

- Modify: `src/modules/acceptance/contracts/acceptance-page-state.ts`
- Modify: `src/modules/acceptance/contracts/acceptance-page-state.test.ts`
- Modify: `src/app/projects/[projectId]/acceptance/acceptance-page-client.tsx`
- Modify: `src/app/projects/[projectId]/acceptance/acceptance-page-client.test.ts`
- Modify: `src/app/projects/[projectId]/acceptance/page.tsx`
- Modify: `src/app/globals.css`

- [ ] 先写失败渲染/交互测试：template/scope 选择、创建、开始、PASS/FAIL/NA、修订原因、缺失必测项、通过率、锁定、allowedActions 隐藏和 409 提示。
- [ ] 页面只消费受权 DTO 的 `allowedActions` 和摘要；创建、结果和锁定命令使用稳定的 Idempotency-Key，并在命令成功后刷新当前项目状态。
- [ ] `normal/loading/empty/error/denied/stale` fixture 不允许生产启用，不伪造权限，不创建 APM-101 关联或 Gate 控件。
- [ ] 运行页面及状态合同测试，并用浏览器验证 1440×900 和 390px 命令流程。

### Task 6: 完整验收、提交与 CI

**Files:**

- Modify: `D:\GPT Prj\自动化设备项目管理\规划\APM-开发进度跟踪.html` only after CI passes

- [ ] 运行 `db:generate`、`format:check`、`lint`、`typecheck`、`test`、`db:validate`、`build`、`audit --audit-level=high` 和 `git diff --check`。
- [ ] 审阅差异、只暂存 APM-100 文件、提交并推送 `codex/apm-100`。
- [ ] 创建 head `codex/apm-100`、base `codex/apm-090` 的 Draft PR；等待 CI 完成空库迁移、升级回放和 PostgreSQL 集成测试。
- [ ] 仅在 CI 全绿后，把进度表升级到 v1.32 并把 APM-100 标为已完成，记录 SHA、PR、CI、迁移、测试和浏览器证据。
