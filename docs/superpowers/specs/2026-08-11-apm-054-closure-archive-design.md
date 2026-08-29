# APM-054 结项归档设计

## 目标

APM-054 为一个项目建立可重复验证、不可变且可审计的结项归档事实。它冻结结项时可用的受控文档、机械图纸、评审/审批、Gate、FAT/SAT 批次、受控报告和客户确认的确切版本；它不实现外部供应商包、备份系统、长期介质迁移或 APM-104 复盘知识库。

## 范围与边界

- 项目仅有一个稳定的 `ProjectArchive` 聚合；它拥有多个 `ProjectArchiveVersion`。
- 每个版本拥有自己的 `ProjectArchiveManifestItem` 集合。任何项目文档、图纸、Gate、审批、FAT/SAT 或文件引用均以其确切 ID、版本、校验和和快照保存，绝不通过“当前已发布版本”读取历史。
- APM-053 的 `DrawingSelectionSet` 是内部选图分包，不是 `EXT` 外部发布事实，归档不会把它创建为外发清单项。
- 当前没有外部供应商包/门户/外部下载事实。版本顶层快照明确保存 `externalPublicationApplicability: NOT_APPLICABLE` 与原因，而不是伪造外部发布记录。
- 已关闭项目仍可读取、经既有文件下载授权下载，以及追加完整性检查；所有历史业务事实和归档版本/清单均不可修改、删除或重开。

## 数据模型

`ProjectArchive` 以 `projectId` 唯一，保存聚合身份和最终归档版本引用。`ProjectArchiveVersion` 使用单项目递增 `version`，保存 `manifestChecksum`、`sourceWatermark`、规范化 `snapshotJson`、外发适用性、状态和生成者。`Project` 保存 `finalArchiveVersionId`，使关闭后的固定版本能在单个项目读取中得到。

`ProjectArchiveManifestItem` 使用公共结构化列保存：来源类型、来源稳定 ID、确切版本、可选 FileObject ID、冻结 SHA-256、MIME、字节数、位置和来源校验和。没有二进制文件的审批、Gate、批次或确认项使用空文件列；其来源专有事实保存到不可变的 `snapshotJson`。清单项始终有确切来源 ID 与版本，且不会保存可变的“最新”指针。

`ProjectArchiveIntegrityCheck` 追加保存一次完整检查的时间、结果、输入校验和及作业关系；`ProjectArchiveIntegrityItemResult` 逐清单项保存实际对象哈希、结果和结构化失败码。检查结果不回写或重写清单。

迁移将为归档表增加项目级复合外键、单版本序列唯一性、单检查序列唯一性、文件/项目同属关系、索引与 PostgreSQL 不可变触发器。Project 的最终版本引用受项目同属约束，避免跨项目结项绑定。

## 不可变与状态机

归档内容在创建后不可变；允许更新的仅是归档版本由完整性检查驱动的状态和最终化引用。

```text
VERIFYING -> READY | FAILED
READY -> VERIFYING       (授权的再次完整性检查)
FAILED -> VERIFYING      (授权的重试检查，创建新的检查记录)
READY -> FINALIZED       (项目关闭事务)
```

新的归档生成永远创建新的 `ProjectArchiveVersion`，不会覆盖已失败、就绪或已最终化版本。每次完整性复核创建新的 `ProjectArchiveIntegrityCheck` 和逐项结果；重复的命令只重放同一作业或同一结果，不追加第二份业务事实。

## 快照、校验和与文件完整性

生成服务在一个事务中读取当前项目的确切来源关系，构造规范化 JSON，并以稳定字段顺序计算：

- `manifestChecksum`：归档版本头、排序后的清单项和各自 `snapshotJson` 的 SHA-256。
- `sourceWatermark`：每个来源 `(type, id, version, checksum)` 的排序元组 SHA-256，用于关闭前重校验来源没有漂移。

来源文件必须属于当前项目、状态为 `AVAILABLE`、完成扫描、位于既有受控存储区并具有 SHA-256、MIME 与实际大小。缺失、隔离、扫描未完成、跨项目或元数据不完整会产生结构化生成失败，不以空清单假装通过。

完整性 Worker 始终通过 `ObjectStoragePort.readObject` 读取 `FileObject.storageArea` 中的实际字节并重新计算 SHA-256；仅比较数据库列不构成检查。对象缺失、读取失败、实际哈希不一致、大小不一致或不再可用均记录到新的检查结果，版本进入 `FAILED`。只有每个需文件清单项验证通过的版本才是 `READY`。

## 作业、授权与事务

归档生成与完整性检查均通过现有 PostgreSQL Outbox 物化为持久作业。生成请求事务只保存幂等命令、审计与 `archive.generate` Outbox 事件；生成 Worker 在自己的事务中读取并冻结来源、创建下一个归档版本和不可变清单项，然后写入 `archive.integrity.check` Outbox 事件。生成键为 `projectId + archive-generation + normalized request`；检查键为 `archiveVersionId + integrity-check + requested retry sequence`。因此生成失败和重试由既有 PersistentJob/JobAttempt 历史保存，不会留下可修改的半成品版本；相同 actor/操作/幂等键复放已有命令结果，同键不同负载得到冲突。

归档读取要求项目归档读取权限；生成、重试和结项要求项目级治理/项目管理授权，并在应用服务内验证有效项目成员、项目关系、当前状态及乐观锁。Route Handler 仅解析严格 DTO、取得身份、调用服务及映射错误。所有成功的归档创建、重试请求和关闭命令都与审计、Outbox 在同一数据库事务提交。

## G9 与项目关闭

注册稳定的 `CLOSURE.ARCHIVE.G9@1` Gate 检查器。项目范围 G9 的冻结检查绑定会追加该稳定版本；它只接受确切 `ProjectArchiveVersion`、`manifestChecksum`、`sourceWatermark`、完整性结果及未关闭 `ResidualItem`。缺少事实、非 READY 版本、未闭环遗留项或非项目范围都为 `HARD_FAILED`。旧 G9 快照保持历史不可变；关闭命令仍会重新校验其批准状态和当前归档事实，因此旧快照不能绕过结项控制。

项目关闭命令在一个可串行化的数据库事务中锁定 Project、ProjectArchive、指定归档版本、G9 已批准提交及相关遗留项，并再次比对 G9 快照与当前版本的 ID、`manifestChecksum`、`sourceWatermark` 和 READY 状态。任一事实自检查或审批后变化即返回 409；不会以旧检查结果关闭项目。成功时一次性设置 `Project.finalArchiveVersionId`、归档版本为 `FINALIZED`、项目状态为 `CLOSED`，写入审计和 Outbox。

## 关闭后只读

APM-054 统一覆盖并回归测试 DOC、DWG、PLN、ISS、PROC 与 FAT/SAT 的写命令。它们在项目为 `CLOSED` 时在服务端返回 `PROJECT_READ_ONLY`，无论 UI 是否隐藏按钮。归档完整性检查是唯一允许的追加动作；文件读取与下载继续使用原有对象级授权和下载审计。

## UI 与可访问性

新增项目内归档页面，显示归档版本、来源版本、外发不适用状态、缺失项、每次检查结果、失败原因、检查时间、可用动作及最终归档版本。页面只消费服务端状态，呈现 normal、loading、empty、error、denied、stale 和 409 冲突状态。桌面使用紧凑清单/状态带；390px 将清单折为可扫描的单列，保留文本状态、键盘焦点和无横向溢出。

## 验收映射

本设计覆盖结项清单精确事实、不可变版本、对象实际 SHA-256 复核、持久重试、G9 结项约束、关闭原子性、关闭后只读、权限/IDOR、审计/Outbox、PostgreSQL 空库与 APM-053 升级回放及浏览器验收。APM-024 与 APM-130 保持阻塞；APM-104、外部供应商包、备份和长期介质迁移不进入本包。
