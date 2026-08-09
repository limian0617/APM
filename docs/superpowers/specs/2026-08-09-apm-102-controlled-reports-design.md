# APM-102 受控 FAT/SAT 报告、客户确认、签名证据与哈希设计

## 目标与边界

APM-102 将 APM-100 的 LOCKED 验收批次和 APM-101 的问题/Gate事实冻结为不可变
`AcceptanceReport` 快照，生成受控 PDF 并复用 APM-050 的 `ControlledDocument`、
`ControlledDocumentVersion`、`FileObject`、受控对象存储、下载授权和审计能力。本包不
实现法律电子签名、客户门户、OTP、第三方签署平台或 APM-103 SAT 离线草稿。

## 报告聚合

`AcceptanceReport` 保存项目、FAT/SAT类型、验收范围、报告编号/版本、来源 LOCKED 批次、
重测链、模板版本及 checksum、规范化 snapshot 及 snapshotChecksum、rendererVersion、
PDF FileObject 及哈希、确切 ControlledDocumentVersion、生成状态和 supersedes 关系。
只有 LOCKED 批次可生成正式报告。服务端在同一 Repeatable Read 事务中读取批次、最新结果
修订、证据文件哈希、问题和 Gate快照，规范化 JSON 后计算 SHA-256；客户端不能提供报告
编号、快照哈希或 PDF 哈希。READY/PUBLISHED 报告和文档版本只读；变化追加新版本，不覆盖
旧报告。生成失败必须回滚业务、审计和 Outbox 成功事实，失败请求可以安全重试。

受控 PDF 由版本化服务端 renderer 从冻结 snapshot 生成，保存为 AVAILABLE、CONTROLLED
FileObject 并创建/引用精确 ControlledDocumentVersion。`snapshotChecksum` 是规范化报告输入
快照（项目/范围、锁定批次、模板、结果、问题、Gate和遗留项等）的 SHA-256；`pdfSha256` 与
FileObject.sha256 均是最终完整 PDF 字节的 SHA-256，发布前必须相等。PDF 内只显示报告编号/版本、
受控文档业务版本标识、生成/冻结时间、rendererVersion和报告快照 SHA-256，并明确说明最终 PDF
完整 SHA-256 以 APM 受控文档元数据和下载审计为准；绝不把快照哈希标注为文件哈希，也不采用
“排除 PDF 摘要字段”的自引用哈希。确认凭证仅作为项目验收证据，不等同于法律电子签名。

## 客户确认与敏感证据

`AcceptanceConfirmation` 是追加式不可变事实，只能引用确切 READY/PUBLISHED reportId 和
reportChecksum，决定 `ACCEPTED`、`ACCEPTED_WITH_RESERVATIONS` 或 `REJECTED`。每条确认
至少引用一个同项目、已扫描、AVAILABLE、CONTROLLED、RESTRICTED 的 FileObject，并保存
文件哈希；原记录只能通过 supersedesConfirmationId 追加更正。普通 ACCEPTANCE_READ 只
能看到脱敏状态；完整确认和凭证下载同时要求 ACCEPTANCE_READ 与
SENSITIVE_CONFIRMATION_READ，并写敏感读取/下载审计。通用文件下载不能绕过该检查。

## Gate 兼容性

不修改 APM-101 的 `ACCEPTANCE.*.ISSUES@1` 语义。新增
`ACCEPTANCE.FAT.CONFIRMATION@1` 与 `ACCEPTANCE.SAT.CONFIRMATION@1` 检查器时，缺报告、
缺确认或拒绝为 HARD_FAILED；附条件确认只有有效 ResidualItem 才为 WARNING；接受且无
未闭环硬问题才 PASSED。Gate snapshot 冻结报告/确认 ID 与 checksum，历史不随之后更正
而变化。

## 页面与 API

FAT/SAT 页面在 LOCKED 批次显示生成、重试、查看/下载报告和记录确认入口，显示报告版本
历史、确认状态、supersedes 关系和非法律签名提示。页面消费服务端状态合同，覆盖
normal/loading/empty/error/denied/stale/generating/failed/409，桌面 1440×900 与移动
390px 无横向溢出并保留键盘焦点。Route Handler 仅负责授权、严格 DTO、幂等包装、服务
调用与错误映射。

## 验证

按 TDD 先写红灯测试，覆盖 LOCKED 门禁、确定性快照/PDF哈希、受控文档引用、不可变/追加
版本、幂等/并发/回滚、凭证状态和敏感权限、Gate判定、IDOR/乐观锁/审计/Outbox、页面
交互和浏览器响应式验收。PostgreSQL 空库和 APM-101 升级回放以 GitHub CI 为最终证据；
本机 PostgreSQL 不可用时明确标记，不能用 `db:validate` 代替迁移回放。
