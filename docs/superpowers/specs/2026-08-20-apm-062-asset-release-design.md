# APM-062 资产 Release 与组件版本快照设计

## 目标

在 APM-052 图纸事实和 APM-061 技术资产主记录之上，提供机械/软件资产的 Release 冻结、组件版本快照和可追溯读取。发布后的事实只能被新的 Release version 超越，不能被覆盖或物理删除。

## 基线与范围

- 实施 worktree：现有 `codex/apm-062`，不重新创建分支或 worktree。
- 设计确认后将 `codex/apm-062` 快进到 `codex/apm-054`；该提交同时包含 `origin/codex/apm-052` 和 `codex/apm-061`。
- PostgreSQL 是唯一业务事实源；审计和事务 Outbox 与业务写入使用同一 Prisma transaction。
- APM-052 的 `MechanicalDrawing`、`ControlledDocumentVersion`、`MechanicalDrawingVersionFile` 和 `FileObject` 继续作为图纸/文件来源事实，不复制主记录。
- APM-061 的 `TechnicalAsset` 继续作为资产主记录；APM-062 不改变其生命周期。
- APM-052 的 `Project` 与 APM-061 的 `RndProject` 没有直接外键。创建 Release 时接收精确来源 ID，由服务端验证来源项目、对象关系、权限和版本状态；不提前创建项目引用或派生关系。

## 方案选择

采用“Release master + immutable Release version + component snapshot”，复用现有受控文档/文件事实。暂不新增独立 software asset master 或 report asset master，也不接受只有 URI/Git 字符串而无法验证来源状态的自由引用。

## 数据事实

### AssetRelease

保存技术资产的稳定 Release 聚合：

- `technicalAssetId`
- 稳定的 release code/number
- 当前已发布 version 指针
- 聚合 `version`（乐观锁）
- 创建/更新元数据

同一技术资产的 release code 唯一。主记录不可物理删除；发布新版本时只更新当前指针和聚合版本。

### AssetReleaseVersion

每次修订都是独立版本事实：

- `releaseId`
- 单调递增的 revision/version
- `DRAFT`、`PUBLISHED`、`SUPERSEDED`
- release notes/description
- canonical snapshot checksum 和 source watermark
- 创建人、发布人、数据库时间

只有草稿可补充组件。发布后 payload 不可更新、删除或截断；唯一允许的历史状态变化是受控的 `PUBLISHED -> SUPERSEDED`，该变化不能改写组件、来源、checksum 或发布元数据。新修订必须创建新的 version fact。

### AssetComponentSnapshot

每条组件快照包含：

- release version、位置/顺序、组件类型：`MECHANICAL_DRAWING`、`SOFTWARE`、`VALIDATION_REPORT`
- 精确来源项目/文档/图纸/文档版本 ID（按类型使用）
- 冻结时来源版本和来源状态
- source checksum
- 文件 ID、SHA-256、MIME、大小的冻结快照
- 类型化 `snapshotJson`

机械组件必须验证已发布的 `ControlledDocumentVersion`，且 CAD source 与 PDF/STEP 等附件均为 `AVAILABLE`；软件和报告组件也必须引用已发布且文件可用的受控文档/文件事实。软件快照的类型化数据保存 Git ref、包 checksum、平台/硬件兼容性、配置模板、测试报告引用、发布说明和回退版本等 Release 所需信息。`snapshotJson` 是冻结投影，不是第二业务事实源。

## 用例和 API 边界

Route Handler 只做身份、DTO、用例调用和 HTTP 映射。最小命令/读取为：

```text
POST /api/technical-assets/:technicalAssetId/releases
POST /api/technical-assets/:technicalAssetId/releases/:releaseId/versions/:version/publish
GET  /api/technical-assets/:technicalAssetId/releases/:releaseId
```

创建草稿/版本时，服务端验证技术资产范围、actor 权限、来源对象关系、来源版本为 `PUBLISHED`、文件为 `AVAILABLE`、组件完整性和重复位置；发布时重新锁定并验证来源和版本，检查乐观锁，然后写当前指针、历史状态、审计、Outbox 和幂等结果。

重复幂等请求返回原结果；同一幂等键使用不同 payload 返回冲突；并发过期版本返回 `409`。未授权或跨对象访问默认 `403/404`，不得依赖前端隐藏。

## 事务与数据库约束

- 业务记录、成功审计、Outbox 和幂等结果必须同一事务提交。
- Release、version、component 的物理 DELETE/TRUNCATE 一律拒绝。
- 已发布 version/component 的业务 payload UPDATE 一律拒绝；仅允许受控 supersede 状态转移。
- 所有跨项目/跨聚合关系使用 `ON DELETE RESTRICT` 和复合关系校验。
- 发布状态、revision 唯一性、组件位置唯一性和来源版本完整性同时由应用层和数据库层保护。

## 验收边界

必须通过：

1. 空库迁移和 APM-061 正确累计基线升级迁移。
2. 有效图纸/软件/报告来源的草稿创建、发布、读取和新 revision。
3. 无效、未发布、已作废/已 superseded 或文件不可用来源的拒绝。
4. 跨项目、跨 R&D 范围、越权读取/写入和 IDOR 拒绝。
5. 草稿/发布状态机、乐观锁、重复请求重放和同 key 冲突。
6. 已发布内容 UPDATE/DELETE/TRUNCATE 拒绝，旧版本内容保持不变。
7. 审计和 Outbox 与业务事务的成功原子性及失败回滚。
8. 严格 DTO、401/403/404/409/422 映射和可追溯读取 DTO。
9. APM-052、APM-061 既有测试和全量质量门禁不回归。

## 明确不做

- APM-063 项目引用、项目派生、实际使用清单；
- APM-064 升级、停用、召回和受影响项目；
- APM-024；
- 外部供应商包、ERP、NUS-M9；
- 新的软件资产主库或独立报告资产主库；
- UI/browser 流程和其他工作包。
