# APM-103 SAT 离线草稿与质量复核实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 SAT 在执行中批次提供 IndexedDB 离线草稿、服务器端冲突保留和追加式质量复核，且只经既有正式结果服务改变验收事实。

**Architecture:** 浏览器草稿由独立 IndexedDB 适配器持久化，用户显式同步至不可变 `OfflineAcceptanceDraftSubmission`。复核服务比较基准结果和当前结果；接受时在同一 Prisma 事务中调用 `recordAcceptanceResultRevision`，而不是直接写正式结果。

**Tech Stack:** Next.js 16、React 19、TypeScript、Zod、Prisma/PostgreSQL、Vitest、浏览器 IndexedDB。

---

## 文件结构

- Create: `src/modules/acceptance/domain/sat-offline-draft-policy.ts` — 状态、规范化负载、冲突比较与复核转换规则。
- Create: `src/modules/acceptance/domain/sat-offline-draft-policy.test.ts` — 纯领域规则测试。
- Create: `src/modules/acceptance/application/sat-offline-draft-service.ts` — 同属、并发、事务、审计、Outbox 与正式结果复用。
- Create: `src/modules/acceptance/application/sat-offline-draft-service.{test,integration.test}.ts` — 应用与 PostgreSQL 测试。
- Create: `src/modules/acceptance/contracts/sat-offline-draft-http.{ts,test.ts}` — 严格 DTO 与错误映射。
- Create: `src/app/api/projects/[projectId]/acceptance/batches/[batchId]/offline-drafts/route.{ts,test.ts}` — 同步/批次读取。
- Create: `src/app/api/projects/[projectId]/acceptance/offline-drafts/route.{ts,test.ts}` — 项目复核队列。
- Create: `src/app/api/projects/[projectId]/acceptance/offline-drafts/[submissionId]/reviews/route.{ts,test.ts}` — 质量复核命令。
- Create: `src/app/projects/[projectId]/acceptance/sat-offline-draft-store.{ts,test.ts}` — IndexedDB 存储。
- Modify: `prisma/schema.prisma` 与新增 `prisma/migrations/20260810010000_apm_103_sat_offline_drafts/migration.sql`。
- Modify: `src/modules/audit/domain/vocabulary.ts`、`src/modules/acceptance/contracts/acceptance-page-state.{ts,test.ts}`、`src/app/projects/[projectId]/acceptance/acceptance-page-client.{tsx,test.ts}`、`src/app/globals.css`。
- Modify: `src/modules/procurement/domain/procurement-persistence.test.ts` — 仅修复 CRLF 下既有 enum 扫描测试，不改采购业务。

### Task 1: 固定范围和基线可移植性

**Files:**

- Modify: `src/modules/procurement/domain/procurement-persistence.test.ts:286-302`
- Create: 本设计与实施计划（已先行写入）

- [ ] **Step 1: 保留 RED 证据**

运行：`npm run test -- src/modules/procurement/domain/procurement-persistence.test.ts`

预期：Windows CRLF 工作树中，`"\n}\n"` 未找到 enum 结束而错误包含后续采购常量。

- [ ] **Step 2: 写最小跨平台读取修复**

将 enum 提取替换为：

```ts
const alertSourceDefinition =
  schema.match(/enum AlertSourceType\s*\{([\s\S]*?)\r?\n\}/u)?.[1] ?? "";
```

保留六个预警来源的精确断言。不得修改 schema、迁移或采购服务。

- [ ] **Step 3: 验证 GREEN**

运行同一命令；预期 9 项通过。

### Task 2: 领域合同先行

**Files:**

- Create: `src/modules/acceptance/domain/sat-offline-draft-policy.ts`
- Create: `src/modules/acceptance/domain/sat-offline-draft-policy.test.ts`

- [ ] **Step 1: 写 RED 测试**

测试 SAT 限制、稳定 client draft ID、规范化 payload checksum、基准 revision 的 `null`/精确 ID 比较、`PENDING_REVIEW`/`CONFLICT`、复核状态转换、同内容重放和异内容 409。

```ts
expect(compareOfflineDraftBaseline({ baselineRevisionId: "r1", currentRevisionId: "r2" })).toBe(
  "CONFLICT"
);
expect(() => assertOfflineDraftReviewTransition("CONFLICT", "ACCEPT")).toThrow(
  "ACCEPTANCE_OFFLINE_DRAFT_CONFLICT"
);
```

- [ ] **Step 2: 验证 RED**

运行：`npm run test -- src/modules/acceptance/domain/sat-offline-draft-policy.test.ts`

预期：模块不存在。

- [ ] **Step 3: 最小实现与 GREEN**

定义 `OfflineAcceptanceDraftStatus`、`OfflineAcceptanceDraftReviewDecision`、`canonicalOfflineDraftPayload`、`offlineDraftChecksum`、`compareOfflineDraftBaseline` 和状态断言，再运行同一测试至通过。

### Task 3: 追加式数据库事实

**Files:**

- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260810010000_apm_103_sat_offline_drafts/migration.sql`
- Modify: `src/modules/audit/domain/vocabulary.ts`
- Create: `src/modules/acceptance/application/sat-offline-draft-service.integration.test.ts`

- [ ] **Step 1: 写 PostgreSQL RED 测试**

覆盖 `[projectId, clientDraftId]` 唯一、跨项目基准修订拒绝、FAT/LOCKED 拒绝、提交输入及复核不可更新/删除、待复核事实不创建正式 revision。

- [ ] **Step 2: 验证 RED**

运行：`npm run test -- src/modules/acceptance/application/sat-offline-draft-service.integration.test.ts`

预期：本机无 PostgreSQL 时条件跳过；CI PostgreSQL 中先因模型/迁移缺失失败。

- [ ] **Step 3: 增加模型及约束**

新增 `OfflineAcceptanceDraftSubmission`、`OfflineAcceptanceDraftReview`、状态/决定枚举、同项目复合外键、唯一索引以及禁止改写提交输入和复核记录的触发器。新增审计动作、对象和 allow-list 字段，保留全部历史迁移。

- [ ] **Step 4: 生成验证**

运行：`npm run db:generate` 与 `npm run db:validate`；预期通过。

### Task 4: 同步与复核应用服务

**Files:**

- Create: `src/modules/acceptance/application/sat-offline-draft-service.ts`
- Create: `src/modules/acceptance/application/sat-offline-draft-service.test.ts`

- [ ] **Step 1: 写服务 RED 测试**

覆盖同草稿重放、相同 `clientDraftId` 异内容 409、项目/批次/测试项同属、服务器结果变化冲突、锁定拒绝、`ACCEPT` 无冲突、`ACCEPT_WITH_CORRECTION` 冲突、`REJECT` 不创建 revision、过期 batch version 409、审核/Outbox 回滚。

- [ ] **Step 2: 验证 RED**

运行：`npm run test -- src/modules/acceptance/application/sat-offline-draft-service.test.ts`

预期：服务不存在。

- [ ] **Step 3: 最小服务实现**

实现 `submitSatOfflineDraft`、`listSatOfflineDrafts`、`reviewSatOfflineDraft`。接受分支在同一 transaction 内调用 `recordAcceptanceResultRevision`，传入审核理由、`batchVersion` 和已扫描 `evidenceFileIds`；不得直接写 `AcceptanceTestResultRevision`。

- [ ] **Step 4: 验证 GREEN**

运行单元与集成测试。没有本地 PostgreSQL 时准确报告跳过。

### Task 5: HTTP 安全边界

**Files:**

- Create: `src/modules/acceptance/contracts/sat-offline-draft-http.{ts,test.ts}`
- Create: 三个 API route 及同路径 `route.test.ts`

- [ ] **Step 1: 写 DTO/路由 RED 测试**

测试未知字段、非法日期、缺 Idempotency-Key、跨项目、缺 `ACCEPTANCE_RESULT_UPDATE`、缺 `ACCEPTANCE_REVIEW`、409 和不同幂等键重放。

- [ ] **Step 2: 验证 RED**

运行：`npm run test -- src/modules/acceptance/contracts/sat-offline-draft-http.test.ts`

预期：模块/路由不存在。

- [ ] **Step 3: 实现 DTO 与薄路由**

同步 body 固定包含 `clientDraftId`、`baselineBatchVersion`、`baselineResultRevisionId`、`decision`、实测值/单位/备注、`capturedAt`；复核 body 固定包含 `submissionVersion`、决定、理由、可选修正值、`batchVersion`、`evidenceFileIds`。使用现有 `idempotentCommandResponse`，所有读取按路径 `projectId` 约束。

- [ ] **Step 4: 验证 GREEN**

运行合同及全部新增路由测试，预期通过。

### Task 6: IndexedDB 与页面状态

**Files:**

- Create: `src/app/projects/[projectId]/acceptance/sat-offline-draft-store.{ts,test.ts}`
- Modify: `src/modules/acceptance/contracts/acceptance-page-state.{ts,test.ts}`

- [ ] **Step 1: 写 RED 测试**

覆盖 IndexedDB 按 `clientDraftId` 保存、刷新恢复、编辑替换、网络失败留存、成功同步状态和 production fixture 禁用。

- [ ] **Step 2: 验证 RED**

运行：`npm run test -- src/app/projects/[projectId]/acceptance/sat-offline-draft-store.test.ts src/modules/acceptance/contracts/acceptance-page-state.test.ts`

预期：适配器/状态类型不存在。

- [ ] **Step 3: 最小实现与 GREEN**

建立 IndexedDB `apm-acceptance-offline-drafts-v1` / `sat-drafts`，仅客户端访问 `indexedDB`。定义 `LOCAL_ONLY`、`PENDING_SYNC`、`SYNC_FAILED`、`PENDING_REVIEW`、`CONFLICT`、`ACCEPTED`、`REJECTED`，且不把草稿混入正式结果摘要。

### Task 7: 页面、浏览器验收和发布

**Files:**

- Modify: `src/app/projects/[projectId]/acceptance/acceptance-page-client.{tsx,test.ts}`
- Modify: `src/app/globals.css`
- Modify: `D:\GPT Prj\自动化设备项目管理\规划\APM-开发进度跟踪.html`（仅 CI 全绿后）

- [ ] **Step 1: 写 UI RED 测试并实现**

仅 SAT IN_PROGRESS 显示草稿入口；FAT/LOCKED 不显示。增加 `acceptance-offline-drafts` 和 `acceptance-offline-review-queue` 语义区域，显示离线/服务器值、状态文字、复核三种决定、无权隐藏及 409；不得混入报告/确认/Gate。

- [ ] **Step 2: 聚焦验证与真实浏览器**

运行 UI/状态测试；启动服务，在 1440×900 和 390×844 检查保存/刷新恢复、offline、sync failed、pending review、conflict、accepted、rejected、loading、empty、error、denied、stale、焦点及无横向溢出。

- [ ] **Step 3: 全量门禁与发布**

运行：`npm run db:generate`、`npm run format:check`、`npm run lint`、`npm run typecheck`、`npm run test`、`npm run db:validate`、`npm run build`、`npm audit --audit-level=high`、`git diff --check`。

只暂存 APM-103 文件，推送 `codex/apm-103`，创建 base=`codex/apm-102` 的 Draft PR。CI 必须通过空库、APM-102→APM-103升级和 PostgreSQL 集成后才更新外部进度表；不启动 APM-104。

## 计划自检

- SAT-only、草稿不作为正式事实、冲突保留、追加复核、APM-100/101 复用、权限、IDOR、乐观锁、幂等、审计、Outbox、迁移、UI和浏览器验收均有对应任务。
- 未包含 FAT、PWA、Service Worker、后台同步、二进制离线上传、报告/确认/Gate 写路径或 APM-104。
- APM-090 改动限定为已有测试的 CRLF 可移植性；不改业务、模式或迁移。
