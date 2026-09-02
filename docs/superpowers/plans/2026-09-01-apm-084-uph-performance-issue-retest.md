# APM-084 UPH 不达标性能问题与复测关联实施计划

## 目标与边界

在已发布的 APM-070、APM-081、APM-082、APM-083 之上实现 APM-084：为低于服务端版本化 UPH 目标的锁定分析创建一个 `PERFORMANCE/PROJECT` Issue，并从该 Issue 创建不覆盖历史事实的新 UPH 复测批次。

本计划只覆盖 APM-084。不得修改 APM-080/081/082 的拓扑、CT、样本、计数、锁定或分析公式事实；不得启动 APM-073、APM-024 或其他工作包；不得在验收和发布授权前更新 tracker、commit、push 或修改 PR。

## 现有代码锚点

- Prisma 主模型和枚举：`prisma/schema.prisma`。
- Issue 聚合、关系校验、事务、幂等、审计和 Outbox 模式：`src/modules/issues/application/issue-service.ts`、`src/modules/issues/contracts/issue-http.ts`、`src/modules/platform-api/contracts/internal-routes.ts`。
- FAT/SAT 创建统一 Issue 的跨模块事务参考：`src/modules/acceptance/application/acceptance-issue-service.ts`。
- UPH 批次创建/复测状态机和 strict DTO：`src/modules/uph/application/uph-test-batch-service.ts`、`src/modules/uph/contracts/uph-test-batch-http.ts`。
- UPH 分析读取与快照：`src/modules/uph/application/uph-analysis-service.ts`、`src/modules/uph/contracts/uph-analysis-http.ts`。
- 现有 Route Handler 测试和 migration contract 测试作为 API/数据库测试模板。

## 实施步骤

### 1. 目标 UPH 领域与迁移

**负责范围：** `prisma/schema.prisma`、新增 `src/modules/uph/domain/uph-performance-target.ts` 及单测、`src/modules/uph/application/uph-performance-target-service.ts`、`src/modules/uph/contracts/uph-performance-target-http.ts`、下一迁移目录（建议命名 `20260827010000_apm_084_uph_performance_issue_retest`）及 migration-contract 测试。

1. 新增 `ProjectUphPerformanceTarget` 主记录及 `ProjectUphPerformanceTargetVersion` 版本记录，按 exact `projectId + topologyRootNodeId` 绑定拓扑根；通过 project-scoped composite FK、根节点约束和唯一当前发布指针防止跨项目/非根节点/多当前发布版本。
2. 版本状态为 `DRAFT | PUBLISHED | SUPERSEDED`。`targetUph` 使用 `Decimal @db.Decimal(20, 6)`，只接受正值；原因、发布者、发布时间、checksum、`resourceVersion` 等事实由服务端生成/锁定。
3. 草稿创建和发布沿用 UPH 权限与 `Project -> target -> version -> topology root` 锁序；发布在一个事务内 supersede 旧 PUBLISHED、更新当前指针、写 SUCCESS Audit、Outbox 和幂等完成记录。已发布/已 superseded 版本拒绝 UPDATE/DELETE，数据库触发器与服务层双重保护。
4. 提供 `GET/POST /api/projects/:projectId/uph/targets` 和 `POST /api/projects/:projectId/uph/targets/:targetVersionId/publish`。Route 只认证、解析 strict DTO、调用服务和映射 401/403/404/409/422。
5. 目标选择函数按 `lockedAt < effectiveAt` 读取 exact 根在锁定前最新 PUBLISHED 版本；无适用版本返回 `UPH_TARGET_NOT_CONFIGURED`。对 decimal 字符串执行正数、6 位精度和 canonical checksum 检查，不使用 JavaScript `Number` 参与业务比较。

### 2. UPH 不达标判定与 Issue 关系扩展

**负责范围：** `src/modules/uph/domain/uph-performance-issue.ts` 及单测、Issue 枚举/关系服务、迁移约束。

1. 新增纯函数，以 decimal 字符串比较：`underperforming = actualGoodUph < targetUph`，`shortfallUph = targetUph - actualGoodUph`；相等达标，`NO_OUTPUT` 的 actual-good-UPH 为 0。保留能力、A、FPY、瓶颈和 warnings 作为证据，禁止按比例自动推导 severity、root cause、owner 或 verifier。
2. 扩展 Prisma `IssueRelationType` 与服务端白名单：`UPH_SOURCE_BATCH`、`UPH_ANALYSIS`、`UPH_RETEST_BATCH`。保持 polymorphic `targetId`，但每次写入必须以 `projectId` 和精确对象关系重新校验。
3. 新增历史唯一约束：源批次在所有关系状态下最多一个 `UPH_SOURCE_BATCH` 问题；同一分析快照最多一个 `UPH_ANALYSIS` 问题；同一复测批次最多一个 `UPH_RETEST_BATCH` 问题。关系只能关闭，不能删除或改 target；关闭后仍不能绕过去重。
4. 回归现有关系行为（TASK、GATE_INSTANCE、DRAWING_VERSION、TEST_RESULT、BLOCKED_BY_ISSUE），确保新增枚举不会放宽通用关系 API 的权限或对象校验。

### 3. 从锁定分析创建性能 Issue

**负责范围：** `src/modules/uph/application/uph-performance-issue-service.ts`、UPH/Issue contracts、路由 `src/app/api/projects/[projectId]/uph/test-batches/[batchId]/revisions/[revisionId]/analyses/[analysisId]/performance-issue/route.ts` 及测试。

1. POST strict body 只接受 `title`、`confirmedText`、`severity`、`reason`；服务端固定 `category=PERFORMANCE`、`sourceType=PROJECT`、root cause 两字段为空，并要求 `Idempotency-Key`。读取时锁定 Project、源 batch、exact LOCKED revision/analysis、适用 target 和源批次历史关系，验证所有对象属于同一项目且路径一致。
2. 仅当 `actualGoodUph < targetUph` 时创建 Issue；相等或高于目标返回稳定 409。目标缺失返回 `UPH_TARGET_NOT_CONFIGURED`，任何失败不得留下 Issue、关系、Audit、Outbox 或幂等记录。
3. `sourceSnapshot` 冻结项目、batch/revision、topology root、analysis id、locked checksum、formula/engine、target version/checksum/targetUph、actual-good-UPH、capacity、A、status、warnings、瓶颈摘要和 shortfall。Issue history 及 Audit 不得依赖后续可变查询重建事实。
4. 已有源批次关系时返回原 Issue 和 `deduplicated=true`；分析未关联且问题仍可写入时只补 `UPH_ANALYSIS`。不同幂等键的并发请求依靠数据库唯一约束收敛；同幂等键按现有 request fingerprint 重放或 409。
5. 成功事务同时写 Issue、`UPH_SOURCE_BATCH`/`UPH_ANALYSIS` 关系、SUCCESS Audit、Outbox 和 idempotency completion；固定锁序为 `Project -> source batch -> exact analysis/revision -> target -> source relation -> Issue -> analysis relation`。
6. GET 返回当前问题、去重信息、精确关系和冻结 source snapshot；未认证/无权/跨项目按现有隐藏策略处理。

### 4. 从 Issue 创建物理复测批次

**负责范围：** `src/modules/uph/application/uph-retest-service.ts`、Issue contracts、路由 `src/app/api/projects/[projectId]/issues/[issueId]/uph-retests/route.ts` 及测试。

1. POST strict body 复用批次创建输入（`batchNumber`、计划声明、观察窗口、IANA timezone），增加 `issueVersion` 和 `reason`；要求 `PROJECT_UPH_BATCH_MANAGE` 与 `PROJECT_ISSUE_UPDATE`、`Idempotency-Key`，并使用 If-Match/resourceVersion 语义。
2. 锁序固定为 `Project -> UPH_SOURCE_BATCH relation/source batch -> Issue -> new batch root/revision -> UPH_RETEST_BATCH relation`。验证 Issue 属于项目、关系有效、源 batch 与问题一致、Issue 未 CLOSED、batchNumber 未占用、当前项目状态允许创建。
3. 调用现有批次 draft 创建规则，重新读取当时有效的 PUBLISHED topology/formula/完整 CT 来源；必须生成新的 `ProjectUphTestBatch` 和 DRAFT revision，不复制历史 samples、counts、analysis、locked revision 或 checksum，不改变源 batch 指针。
4. 成功事务同时写新 batch/revision、`UPH_RETEST_BATCH` 关系、Issue history/version、SUCCESS Audit、Outbox 和幂等完成；失败回滚全部事实。返回新 batch、revision、关系和 source linkage。
5. GET 列出问题的复测批次关系及状态；关闭 Issue、重复复测关系、跨项目/跨问题 batch、资源版本冲突返回稳定 409/404/422，禁止通过直接 targetId 绕过服务。

### 5. 最小 UI 入口

**负责范围：** 仅修改现有 UPH 页面、Issue 详情页及其测试/样式文件，不重做 APM-083 布局。

1. 在锁定且不达标分析详情中显示目标、短缺和“创建性能问题”入口；显示目标缺失、已达标、已去重、权限拒绝、加载和错误状态，长 ID/checksum 使用换行或受控截断。
2. 在性能 Issue 详情中显示源批次/分析证据与“创建复测批次”入口；复测成功后提供新的 DRAFT batch 链接，保留历史快照可读性。
3. 使用现有 `details/summary` 下钻，保证焦点顺序、Enter/Space 键盘操作、语义按钮和移动端 390px 宽度无页面级横向溢出；模块 CT 表仍只能在自身容器内滚动。
4. 页面只消费服务端返回的目标/判定，不能包含目标常量、自动根因或自动 severity 推断。

### 6. 验证与证据

**测试必须分层记录：** 本地无数据库测试、真实 PostgreSQL 测试、GitHub CI、浏览器验收分别记录，数据库凭据不可用时标记环境阻塞，不能宣称业务通过。

1. 领域单测：decimal 精确比较、相等达标、NO_OUTPUT、短缺、target 生命周期、根范围和不可变性。
2. Contract/Route 单测：strict DTO、认证/权限/项目成员、IDOR、错误码、Idempotency-Key、If-Match/resourceVersion、路径不一致、去重响应。
3. PostgreSQL 集成测试：迁移空库与 `60 -> 61` 升级回放、composite FK、exact 根、target supersede、历史唯一约束、并发创建、直接 SQL UPDATE/DELETE 拒绝、事务失败无孤儿、Audit/Outbox/idempotency 原子性、复测不覆盖源数据。
4. 运行并回传：

   ```text
   npm run format:check
   npm run lint
   npm run typecheck
   npm run test
   npm run db:generate
   npm run db:validate
   npm run build
   git diff --check
   ```

   另行列出 APM-084 相关 UI/契约/领域/PostgreSQL 测试命令和结果；依赖未改变时不运行 `npm audit`，若实现确需改依赖则必须增加高危审计。

5. 浏览器验收至少覆盖 1440x900 与 390x844：无页面级横向溢出、CT 内部滚动仍可用、核心指标/异常可读、候选/CT/归约/瓶颈转移和 details/summary 可点击并可用键盘 Enter、loading/empty/no-locked/no-analysis/error/denied 无回归。
6. 计划完成后只回传修改文件、测试命令/结果、数据库与 CI 分层、浏览器尺寸/关键结果、残余风险和建议提交内容；未经单独发布授权不得 commit、push、改 PR 或更新 tracker。

## 验收完成定义

- 目标版本、性能 Issue、三类 UPH 关系和复测批次均有服务端授权、精确项目关系、不可变/唯一约束、审计、Outbox、幂等和事务回滚证据。
- 所有既有 APM-080/081/082/083 事实和页面行为保持不变。
- 全仓门禁与 APM-084 专项测试结果明确；数据库不可用时如实标注环境阻塞。
- 1440x900 和 390x844 浏览器验收通过且无页面级横向溢出。
- 在用户另行授权前不产生新的 commit、push、PR 操作或 tracker 完成记录。
