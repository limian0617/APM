# APM-103 SAT 离线草稿与质量复核设计

## 目标与边界

APM-103 为已在线打开的 **SAT** 验收批次提供轻量、本地优先的断网录入能力。浏览器把草稿保存到 IndexedDB；恢复联网后，草稿成为服务器端不可变的待复核提交。它不是正式验收结果，不会锁定批次、生成报告、形成客户确认、满足 Gate 或推进项目阶段。

本包不为 FAT 提供离线功能，不增加 Service Worker、离线启动、通用后台同步、二进制离线直传或任何 APM-104 范围。附件恢复联网后仍必须走既有私有对象存储、分片上传、病毒扫描和服务端文件授权；只有已扫描、可用、受控存储区文件才能在复核接受时成为正式结果证据。

## 数据与不可变性

新增服务器聚合 `OfflineAcceptanceDraftSubmission`：

- 固定 `clientDraftId`、`projectId`、SAT `batchId`、`itemId`、`baselineBatchVersion`、`baselineResultRevisionId`、录入的 PASS/FAIL/NA、实测值、单位、备注及客户端采集时间；
- 同一项目的 `clientDraftId` 唯一。相同规范化负载重放返回原提交；内容不同则返回 409，绝不覆盖草稿；
- 输入负载和提交校验和不可修改。状态仅可由 `PENDING_REVIEW` / `CONFLICT` 前进至 `ACCEPTED` 或 `REJECTED`；不物理删除；
- 提交时由数据库时间写入 `submittedAt`。客户端时间仅保留为采集元数据；
- 仅接受同项目、`SAT`、`IN_PROGRESS` 的批次及其冻结模板测试项。跨项目、FAT、锁定或不存在/失效批次拒绝；
- `baselineResultRevisionId` 必须为该项目、该批次、该测试项的修订。服务器比较其与当前正式修订：不一致（包括一方为空、另一方非空）时提交状态为 `CONFLICT`，同时保留离线草稿和当前服务器结果的可审计快照。

新增 append-only `OfflineAcceptanceDraftReview`：

- 动作为 `ACCEPT`、`ACCEPT_WITH_CORRECTION` 或 `REJECT`，含必填理由、复核人和数据库时间；
- `ACCEPT` 只允许无冲突提交；`ACCEPT_WITH_CORRECTION` 可显式解决冲突并带入复核后的值；`REJECT` 不影响正式结果；
- 每个提交只接受一个终态复核。相同请求可资源级幂等重放，不同内容返回 409；
- 接受路径在同一事务内调用既有 `recordAcceptanceResultRevision`，创建新的追加式 `AcceptanceTestResultRevision`，并写审核、Outbox 与复核事实。拒绝或冲突不能改变正式结果、报告、确认或 Gate。

数据库迁移加入同项目复合外键、唯一索引、SAT 批次/测试项完整性触发器，以及禁止修改/删除提交输入和复核记录的触发器。

## 授权、并发与 API

项目关系与权限均在服务端确定：

| 操作                   | 权限                       | 规则                                                         |
| ---------------------- | -------------------------- | ------------------------------------------------------------ |
| 同步本地草稿           | `ACCEPTANCE_RESULT_UPDATE` | 项目成员、同项目 SAT 在执行中批次、严格 DTO、Idempotency-Key |
| 查看复核队列/单项      | `ACCEPTANCE_READ`          | 只能读取当前项目，不显示跨项目数据                           |
| 接受、修正后接受、拒绝 | `ACCEPTANCE_REVIEW`        | 提交状态、批次版本与现有结果服务的乐观锁均校验               |

路由保持薄层：解析路径/DTO/幂等键，执行项目授权，调用应用服务，并将领域错误映射为 4xx。新增路由为：

- `POST` / `GET` `/api/projects/{projectId}/acceptance/batches/{batchId}/offline-drafts`
- `GET` `/api/projects/{projectId}/acceptance/offline-drafts`
- `POST` `/api/projects/{projectId}/acceptance/offline-drafts/{submissionId}/reviews`

同步及复核都使用现有事务型 `idempotentCommandResponse`。应用服务还执行资源级校验，确保不同 HTTP 幂等键不会把相同 `clientDraftId` 或同一提交的不同复核内容伪装为成功。

## 客户端与状态

`sat-offline-draft-store` 是浏览器 IndexedDB 适配器，键为 `clientDraftId`，且在每次编辑后原子保存草稿。它存储的状态为 `LOCAL_ONLY`、`PENDING_SYNC`、`SYNC_FAILED`、`PENDING_REVIEW`、`CONFLICT`、`ACCEPTED` 或 `REJECTED`；本地状态不等同于服务器业务状态。

页面只在已选 SAT、`IN_PROGRESS` 批次显示“保存离线草稿”和草稿状态。网络恢复后用户显式提交（本包没有后台同步）。同步失败保留原草稿；成功提交后显示服务器状态与冲突的两组值。复核队列仅为有 `ACCEPTANCE_REVIEW` 的用户显示，并提供接受、修正后接受和拒绝。所有状态均有文字，不只依赖颜色；桌面及 390px 窄屏采用无横向溢出的列表/表单和可见键盘焦点。

## 测试与验收

测试必须先 RED 后 GREEN，覆盖：IndexedDB 保存/恢复/编辑、断网和重试、严格 DTO、同属/IDOR、SAT/状态拒绝、clientDraftId 与 HTTP 幂等、冲突快照、不可变历史、接受/修正后接受/拒绝、审计/Outbox 事务回滚、待复核草稿不影响报告/确认/Gate、PostgreSQL约束、迁移空库及 APM-102→APM-103 升级。

浏览器验收使用 1440×900 与 390×844，检查草稿保存、刷新恢复、离线失败、恢复联网、冲突、复核三种决定、状态文字、焦点和无横向溢出。受控文件证据复用既有上传/扫描流程；本包不绕过该流程。

## 自检

- 没有 FAT、PWA、Service Worker、后台同步、离线二进制上传或 APM-104 功能。
- 没有第二套正式验收结果、问题、报告、确认或 Gate 状态机。
- 正式结果仍只由 APM-100 应用服务创建，FAIL 结果继续由 APM-101 统一问题与 Gate 规则处理。
- APM-102 报告/确认输入只读取正式锁定事实，因此待复核/冲突/拒绝草稿不能推进任何治理事实。
