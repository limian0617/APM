# APM-084 UPH 不达标性能问题与复测关联设计

## 目标

在 APM-070 统一问题、APM-081 测试批次和 APM-082 确定性分析快照之上，允许授权人员将低于目标的 UPH 分析记录为一个“性能”问题，并从该问题创建不可覆盖历史的新复测批次。问题必须保留精确的批次、分析、目标和锁定 checksum 事实；根因由人工后续分析，AI 不参与判定。

## 基线与范围

- 依赖 APM-070 和 APM-082；不重做 APM-080、081、082 或已发布的 APM-083。
- PostgreSQL 是业务事实源；问题、关系、目标版本、复测批次、成功 Audit、Outbox 和幂等响应在同一事务中提交。
- APM-081 的物理复测边界继续有效：复测必须创建新的 `ProjectUphTestBatch`，不能在原 batch 内覆盖或替换历史锁定事实。
- 本包允许对现有 UPH 页面和问题详情页增加最小操作入口，但不重做 APM-083 的树状布局和既有下钻。
- 不启动 APM-073、APM-024 或其他工作包；不修改 tracker，直到验收和发布授权完成。

## 核心决策

### 1. 目标 UPH 采用不可变目标版本

当前分析快照没有目标字段，不能由前端常量或调用方自由提交目标。新增项目/精确拓扑根作用域的 `ProjectUphPerformanceTarget` 主记录及 `ProjectUphPerformanceTargetVersion` 版本记录，复用 `DRAFT -> PUBLISHED -> SUPERSEDED` 生命周期和现有 UPH 权限：

- 目标范围是同项目的 exact `topologyRootNodeId`。该节点必须是拓扑根，跨项目或非根节点拒绝。
- `targetUph` 为正的 `numeric(20,6)`，单位固定为 UPH；版本发布后目标值、范围、原因和 checksum 不可更新或删除。
- 发布新版本时在同一事务中将旧的当前 `PUBLISHED` 版本标记为 `SUPERSEDED`，更新当前发布指针，并写 Audit/Outbox。
- 性能判定选择该拓扑根在分析 revision `lockedAt` 之前已发布的最新目标版本。目标版本后来被 supersede 不影响历史选择；锁定时尚未生效的目标不能用于该批次。
- 没有适用于该锁定时间的目标版本时，创建性能问题返回稳定的 `UPH_TARGET_NOT_CONFIGURED`，不创建任何 Issue 或关系。

目标版本管理复用 `PROJECT_UPH_DEFINITION_MANAGE`（草稿）和 `PROJECT_UPH_PUBLISH`（发布）；读取复用 `PROJECT_UPH_READ`。APM-084 只实现满足本包所需的最小目标版本读写，不引入通用策略脚本。

### 2. 不达标的确定性判定

只比较 APM-082 快照的 `actualGoodUph` 与 exact target `targetUph`，使用十进制精确值，不使用二进制浮点：

```text
underperforming = actualGoodUph < targetUph
shortfallUph = targetUph - actualGoodUph
```

相等视为达标；`NO_OUTPUT` 的 `actualGoodUph=0` 在目标为正时属于不达标。实测能力、A、FPY、瓶颈和 warning 作为证据保存，但不替代实际良品 UPH 判定。问题严重度不从差距比例自动推断，由授权人员在创建时明确选择；根因分类和根因描述创建时必须为空。

### 3. 统一 IssueRelation 承载 UPH 关系

扩展现有 `IssueRelationType`：

- `UPH_SOURCE_BATCH`：问题对应的源测试批次；同一项目批次在全部历史关系中最多对应一个问题，用于批次级去重。
- `UPH_ANALYSIS`：精确分析快照；一个问题可保留同一批次不同 revision 的分析证据，但同一分析快照不能关联多个问题。
- `UPH_RETEST_BATCH`：从问题创建的物理复测批次；一个问题可有多个复测批次，但同一复测批次不能关联多个问题。

三个 target 均通过服务端按 `projectId` 和精确对象关系验证；关系表现有的 polymorphic `targetId` 模式保持不变。新增历史唯一索引（不带 `status` 条件）防止关闭关系后再次绕过去重；现有关系不可变/只能关闭的数据库触发器继续适用。创建命令必须验证分析属于源批次、源批次属于问题项目，复测批次与源批次不同。

## 用例与 API 边界

Route Handler 只负责认证、严格 DTO、调用用例和 HTTP 错误映射。

### 目标版本

```text
GET  /api/projects/:projectId/uph/targets
POST /api/projects/:projectId/uph/targets
POST /api/projects/:projectId/uph/targets/:targetVersionId/publish
```

创建目标草稿的输入仅包含 exact `topologyRootNodeId`、正 `targetUph` 和原因；发布使用 `resourceVersion`、原因和既有幂等语义。客户端不能提交项目、发布人、checksum 或生效时间事实。

### 从分析创建性能问题

```text
POST /api/projects/:projectId/uph/test-batches/:batchId/revisions/:revisionId/analyses/:analysisId/performance-issue
GET  /api/projects/:projectId/uph/test-batches/:batchId/revisions/:revisionId/analyses/:analysisId/performance-issue
```

POST body 为 strict DTO：`title`、`confirmedText`、`severity`、`reason`。服务端固定 `category=PERFORMANCE`、`sourceType=PROJECT`、根因为空，并从 exact analysis/revision/target 生成 `sourceSnapshot`，至少包括：

- 项目、批次、revision、拓扑根、分析 ID、`lockedChecksum`、engine/formula 事实；
- 目标版本 ID/checksum/target UPH；
- actual-good-UPH、实测能力、A、状态、warning、瓶颈摘要和 `shortfallUph`。

当源批次已有 `UPH_SOURCE_BATCH` 关系时，返回已有问题并标记 `deduplicated=true`，不创建第二个 Issue；若该分析尚未关联且已有问题仍可写入，则只追加 `UPH_ANALYSIS` 关系。不同幂等键的并发请求由历史唯一索引收敛到同一问题；同幂等键仍按既有指纹规则重放原响应。

### 创建复测批次

```text
POST /api/projects/:projectId/issues/:issueId/uph-retests
GET  /api/projects/:projectId/issues/:issueId/uph-retests
```

POST body 使用现有批次创建所需的 `batchNumber`、计划声明、观察窗口和 IANA timezone，并带问题 `issueVersion` 与原因。服务端从问题的 `UPH_SOURCE_BATCH` 关系派生源拓扑根，创建全新的 batch 和 DRAFT revision，重新读取当时有效的 PUBLISHED 拓扑/公式/CT 来源；不复制历史 samples、counts、analysis 或 checksum。随后追加 `UPH_RETEST_BATCH` 关系。任何一步失败都回滚新 batch、关系、Audit、Outbox 和幂等记录。已关闭 Issue 按现有关系策略需先重开后再新增复测关系。

## 权限、状态与错误

- 读取目标/分析/关联关系需要 `PROJECT_UPH_READ`；创建性能问题同时需要 `PROJECT_UPH_READ` 和 `PROJECT_ISSUE_CREATE`；创建复测需要 `PROJECT_UPH_BATCH_MANAGE` 和 `PROJECT_ISSUE_UPDATE`。
- 每个对象均重新校验有效项目成员、项目状态、对象同属和当前状态；前端隐藏不是安全边界。
- 未认证返回 401；无权返回 403；跨项目或不存在对象按现有隐藏策略返回 404；非不达标、closed Issue、资源版本冲突和重复关系返回 409；严格 DTO、非正目标和不一致路径返回 422。
- 根因只能通过现有 Issue 人工详情更新流程补充；APM-084 不调用 ASR/AI，不自动指定 Owner、Verifier、责任或质量损失。

## 事务、锁序与不可变性

- 性能问题命令锁序固定为：`Project -> source batch -> exact analysis snapshot/revision -> applicable target version -> historical source-batch relation -> Issue -> analysis relation`。
- 复测命令锁序固定为：`Project -> source batch/relation -> Issue -> new batch root/revision -> retest relation`；所有调用保持同一方向，避免与通用 IssueRelation 命令形成反向锁。
- Issue、关系、目标版本和复测 batch/revision 不物理删除；已发布目标、分析快照、已锁定批次和关系目标事实不可更新。
- 每个成功命令的业务写、SUCCESS Audit、Outbox 和幂等完成记录必须在同一 PostgreSQL transaction；失败不得留下孤立 Issue、关系或 batch。

## 验收边界

必须覆盖：

1. 目标版本草稿/发布/supersede、exact 根范围、正数与 checksum/不可变约束。
2. actual-good-UPH 精确比较、相等达标、NO_OUTPUT 不达标、目标未配置和 warning 保留。
3. 同一批次重复创建返回同一 Issue；不同分析可追加证据关系；跨项目和跨批次 IDOR 拒绝。
4. 同一分析/复测批次不能关联多个 Issue；关系关闭后仍不能绕过去重；并发创建只保留一个 Issue。
5. 复测一定生成新的 batch/revision，原 samples/counts/analysis/locked revision 不变；重复 batchNumber、已关闭 Issue、失败回滚有稳定错误。
6. 权限、strict DTO、If-Match/resourceVersion、幂等重放、Audit/Outbox 原子性和直接 SQL 不可变/唯一约束。
7. 目标、问题和复测 API 合同测试，UPH/Issue 单元测试，以及真实 PostgreSQL 空库和 60 之后升级迁移回放。
8. 现有 UPH 页面与问题详情页的最小入口在桌面和移动端可读，成功、已去重、未达标、目标缺失、权限拒绝、错误和加载状态无回归。

数据库不可用时只能报告环境阻塞；无数据库测试、CI 结果和浏览器验收必须分开记录。

## 明确不做

- 不修改 APM-080/081 的拓扑、CT、样本、计数、锁定状态机或历史 checksum 语义。
- 不修改 APM-082 分析公式、引擎、快照内容或数值判定；不将性能问题创建混入分析创建事务。
- 不覆盖或删除任何历史批次、revision、analysis snapshot、Issue 或 relation。
- 不实现 AI 根因、自动责任归属、质量损失或激励扣减；不启动 APM-073、APM-024、APM-084 之外的工作包。
