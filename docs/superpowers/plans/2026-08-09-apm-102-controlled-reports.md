# APM-102 实施计划

## 阶段 1：领域合同与红灯测试

1. 检查 APM-050/100/101 的真实 DTO、权限和事务模式。
2. 新增报告/确认领域测试，先确认模型和服务尚不存在导致预期红灯。
3. 固定规范化快照、SHA-256、PDF renderer、报告/确认状态和敏感凭证规则。

## 阶段 2：Schema 与持久化

1. 增加 AcceptanceReport、AcceptanceConfirmation 及追加式凭证关系、Gate快照引用所需
   字段和复合外键；不修改已有迁移历史。
2. 创建单个 APM-102 迁移，保留 APM-100/101 迁移原样。
3. 增加空库约束/不可变/项目归属集成测试。

## 阶段 3：报告应用服务与 API

1. 在同一事务冻结 LOCKED 批次及重测链、结果证据哈希、问题/Gate事实。
2. 规范化 snapshot 并服务端计算 SHA-256；版本化 renderer 生成 PDF；以最终 PDF 完整字节
   SHA-256 写入并校验 AcceptanceReport.pdfSha256 与 FileObject.sha256，PDF仅展示快照哈希和
   受控文档业务版本标识；创建受控文档版本和 FileObject 元数据，使用幂等、乐观锁、审计和 Outbox。
3. 增加列表、详情、生成、下载 Route Handler；下载复用 APM-050 并追加报告归属校验。

## 阶段 4：客户确认与敏感下载

1. 新增严格确认 DTO 和创建/更正服务，校验确切 READY 报告与 RESTRICTED 受控凭证。
2. 增加脱敏/敏感查询和确认凭证下载审计；通用文件下载遇确认引用时追加敏感权限。
3. 增加幂等、409、IDOR、回滚、追加 supersedes 集成测试。

## 阶段 5：Gate 与页面

1. 注册 FAT/SAT confirmation checker，不修改 APM-101 issue checker。
2. 扩展 FAT/SAT 页面状态合同、报告生成/重试、PDF查看/下载、确认历史和敏感提示。
3. 运行组件测试、类型检查、Prettier、git diff --check 及 1440×900/390px 浏览器验收。

## 阶段 6：发布门禁

依次运行 `npm run db:generate`、`format:check`、`lint`、`typecheck`、`test`、`db:validate`、
`build`、`npm audit --audit-level=high`、`git diff --check`。确认本地 PostgreSQL 限制；经
用户授权后提交/推送 `codex/apm-102`，创建 base=`codex/apm-101` 的 Draft PR，等待 CI
空库/升级迁移和集成测试全绿后更新进度表 v1.34；不合并 PR、不启动 APM-103。
