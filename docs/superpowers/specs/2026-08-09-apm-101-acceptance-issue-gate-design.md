# APM-101 FAT/SAT 失败项、统一问题与 Gate 遗留项联动设计

## 目标与边界

APM-101 把 APM-100 的 `AcceptanceTestResultRevision` 作为失败事实来源，接入现有
`Issue`、`IssueRelation`、Gate 检查快照和条件放行遗留项。Issue 仍是唯一问题主记录；
本包不创建 FAT/SAT 缺陷台账，不实现报告、客户确认、法律签名或 SAT 离线草稿。

## 失败结果关系

`TEST_RESULT` 关系的 `targetId` 固定为失败结果修订 ID。应用服务在一个 Prisma 事务中
锁定项目、批次、结果和修订，确认修订属于当前项目及批次、测试项，且有效判定为 `FAIL`。
创建问题时同时写 Issue、IssueRelation、审计和 Outbox；关联已有问题时校验问题同属项目、
状态可写和关系唯一性。数据库通过部分唯一索引阻止同一 Issue/失败修订的重复活动关系。

## Gate 检查

注册稳定检查器 `ACCEPTANCE.FAT.ISSUES@1` 和 `ACCEPTANCE.SAT.ISSUES@1`，只按冻结的
`AcceptanceType` 选择，不根据阶段名称猜测类型。Gate 检查在同一事务读取当前范围最近的
LOCKED 批次及 retest 链、模板版本/校验和、每个测试项最新有效修订及活动关系、Issue
分类/严重度/状态/责任与截止事实，然后将输入、结果和校验和写入不可变
`GateCheckSnapshot`。事实读取失败默认 HARD_FAILED。

安全/功能问题、HIGH/CRITICAL、未关联 FAIL 或事实不完整返回 HARD_FAILED。仅
PERFORMANCE、APPEARANCE、DELIVERY_COMPLETENESS 且 LOW/MEDIUM、具备 Owner/截止日/验证
安排的问题返回 WARNING。无活动失败问题、必测项满足且需要复测的问题存在 LOCKED 重测
PASS 后才 PASSED。

## 条件放行与遗留项

复用现有 `GateConditionalRelease` 和 `ResidualItem` 状态机。条件放行只接受 WARNING，
并在同一事务为每个问题建立一个 ResidualItem，保存 `issueId` 与失败修订 ID。遗留项验证
关闭前必须确认 Issue 已关闭且有对应 LOCKED 重测 PASS；关闭问题本身不能替代复测。Issue
重开时，查询层重新判定相关遗留项为未满足，不覆盖历史事件。

## 页面与 API

在现有 FAT/SAT 页面中消费服务器返回的批次、结果和关联问题事实。FAIL 行显示创建/关联
入口及问题摘要；锁定前展示未关联 FAIL 清单；Gate/遗留状态和 409 冲突使用现有页面状态
合同。所有 Route Handler 只负责授权、严格 DTO、幂等包装、调用应用服务和错误映射。

## 验证

先写领域和 API 红灯测试，再实现。覆盖项目/对象授权、IDOR、PASS/NA 拒绝、重复/并发、
锁定门禁、Gate 严重度矩阵、快照不可变、条件放行与重测闭环、事务回滚、页面状态、键盘
操作和 1440×900/390×844 浏览器验收。数据库迁移同时在 CI 验证空库及 APM-100 升级回放；
本机 PostgreSQL 不可用时如实记录。
