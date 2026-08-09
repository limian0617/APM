# APM-100 FAT/SAT 验收基础域设计

## 范围

APM-100 建立项目内 FAT/SAT 验收的只读与记录基础能力：不可变验收模板版本、验收批次、版本内测试项定义、追加式测试结果修订、通过率/批次摘要，以及受控文件证据引用。APM-101/102/103 的问题关联、Gate 阻塞、报告/客户确认/法律签名和离线草稿不在本包。

## 数据边界

- `AcceptanceTemplate` 是稳定身份；`AcceptanceTemplateVersion` 是不可变发布版本。
- `AcceptanceTemplateVersion` 冻结完整快照：测试项编码、名称、顺序、测试方法、合格标准、单位、是否必测、是否需要证据、适用范围、默认责任专业和版本校验和。模板版本不复用通用 `TemplateVersion` 的异构 JSON。
- `AcceptanceTestItemDefinition` 归属于一个模板版本，发布后不可更新/删除。
- `AcceptanceBatch` 归属于项目，包含 `acceptanceType`（FAT/SAT）、`scopeType`（PROJECT/DELIVERY_UNIT/MACHINE）、`scopeId`、模板版本、状态和 `retestOfBatchId`。创建时服务端校验 scope 对象与项目同属；不能用客户端声明替代关系校验。
- 批次状态严格为 `DRAFT -> IN_PROGRESS -> LOCKED`。锁定后批次范围、模板引用、测试项集合和结果都不可更新、删除或重新打开。需要重测时创建新批次并设置 `retestOfBatchId`。
- `AcceptanceTestResult` 是测试项稳定身份；`AcceptanceTestResultRevision` 是追加式历史。每次修订保存 revisionNo、supersedesRevisionId、判定、实测值及单位、备注、修订原因、操作者、数据库时间和审计关联。当前有效结果是最高修订号；任何历史行不得更新/删除。锁定批次不允许新增修订。
- 通过率只按有效结果计算：分母 = PASS + FAIL，分子 = PASS；NA 不进入分子/分母。分母为 0 返回 `null`/`NOT_CALCULABLE`，不得显示 100%。必测项缺结果或存在 FAIL 时批次不得判定通过。
- 证据引用只保存 `FileObject` ID。服务端在同一项目内查询并校验文件状态 AVAILABLE、扫描完成、受控存储且未隔离/作废，并检查当前操作者的文件引用权限；引用和下载均写审计。APM-100 不复制文件下载实现。

## 权限与事务

创建批次、录入/修订结果、锁定批次均要求项目成员、角色和对象关系通过服务端授权，并携带幂等键和乐观锁版本。业务事实、成功审计和本地 Outbox 事件在同一个 Prisma 事务内提交；失败全部回滚。Route Handler 只负责身份读取、DTO 解析和错误映射。

## API 形状

提供项目内薄路由：

- 模板版本列表/详情（只读）；
- 批次列表、创建、详情；
- 批次状态推进（`start`、`lock`）；
- 测试结果当前视图和追加修订；
- 证据引用和受控下载入口复用现有文件服务；
- 只读批次摘要/通过率端口。

所有响应都带 `projectId`、资源 `version`/时间戳和结构化错误码。APM-101 只依赖稳定的 `resultRevisionId` 查询端口，不创建 Issue 或 Gate 写入。

## 页面

在项目 FAT/SAT 入口实现工作型只读/记录页面，消费服务端 DTO，明确展示 normal、loading、empty、error、denied、stale 状态。页面不渲染伪造成功数据，不实现问题关联、Gate 阻塞、报告、客户确认、法律签名或离线草稿。

## 一致性与安全测试

- 纯领域测试覆盖模板不可变快照、scope 同属、批次状态转移、锁定拒绝、追加修订、通过率和必测项规则。
- PostgreSQL 测试覆盖 FK/复合 FK、唯一性、不可变触发器、批次锁定和事务回滚；本地数据库不可用时标明跳过，CI 负责空库与升级回放。
- API 测试覆盖 401/403、跨项目 IDOR、非法状态、过期 version、重复/复用幂等键、审计和 Outbox 原子性。
- 证据测试覆盖跨项目、未扫描、隔离/作废和无权限文件拒绝，以及引用/下载审计。
