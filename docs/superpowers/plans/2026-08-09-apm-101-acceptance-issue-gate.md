# APM-101 实施计划

## 阶段 1：精确失败关系（TDD）

1. 新增领域测试，证明 PASS/NA、跨项目、错误批次、非 FAIL 修订和重复活动关系被拒绝。
2. 新增失败结果关系服务合同测试，先确认导入/服务不存在导致红灯。
3. 增加 Prisma 关系字段、部分唯一索引和迁移；实现创建问题、关联问题、关系查询的事务
   服务与薄路由，复用现有授权、幂等、审计和 Outbox。
4. 运行聚焦单元、API 与可用数据库集成测试。

## 阶段 2：版本化验收 Gate 检查

1. 先为 FAT/SAT checker 写红灯测试，覆盖严重度、类别、缺少关系、重测 PASS 和事实不可用。
2. 实现锁定批次/retest 链读取、问题快照和两个稳定 checker 注册。
3. 将 checker facts 接入既有 Gate 快照写入，不修改旧 checker 语义。
4. 运行 Gate 单元、快照集成和并发/回滚测试。

## 阶段 3：条件放行遗留关联

1. 先写 WARNING 条件放行和遗留项来源约束的红灯测试。
2. 为 ResidualItem 增加 `issueId`、`acceptanceResultRevisionId` 的同项目复合关系；
   条件放行自动按问题创建遗留项。
3. 在验证关闭时检查 Issue CLOSED 与 LOCKED 重测 PASS；问题重开查询返回未满足。
4. 运行条件放行领域、API 和 PostgreSQL 事务测试。

## 阶段 4：FAT/SAT 页面闭环

1. 先写页面交互/状态测试，覆盖创建、关联、锁定前提示与 409。
2. 扩展 APM-100 页面和路由，保持 `allowedActions`、项目隔离、无横向溢出和键盘可用。
3. 使用真实开发态 fixture 仅作受控展示，禁止生产启用。
4. 浏览器验收 1440×900、390×844 及 normal/loading/empty/error/denied/stale。

## 阶段 5：门禁与发布

依次运行 `db:generate`、`format:check`、`lint`、`typecheck`、`test`、`db:validate`、
`build`、`npm audit --audit-level=high`、`git diff --check`。确认 PostgreSQL 限制，
提交并推送 `codex/apm-101`，创建 base=`codex/apm-100` 的 Draft PR，等待 CI 全绿后才更新
进度表 v1.33；不合并 PR，不启动 APM-102。
