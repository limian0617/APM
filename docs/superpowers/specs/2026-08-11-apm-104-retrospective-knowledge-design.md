# APM-104 项目结项复盘与可追溯知识设计

## 1. 目标和已冻结决策

APM-104 为客户交付项目建立项目级结项复盘，并将已完成项目中可公开复用的经验转化为受控、可审核、可撤销的内部知识条目。它不把客户项目的原始问题、文件、图纸、验收证据或归档清单公开给其他项目；跨项目使用只消费经人工脱敏和发布的知识版本。

已确认的范围决策如下：

- `ProjectRetrospective` 是项目级唯一复盘聚合，也是 G9 的唯一复盘事实。
- 整线项目可追加交付单元贡献条目，但贡献条目不构成独立 G9，且单机/交付单元项目不被要求另建复盘聚合。
- 项目关闭前必须存在经独立审核批准的项目复盘版本；知识条目不要求在项目关闭前发布，避免知识产权审查阻塞归档与交付结项。
- 知识条目只在项目关闭后，基于 `Project.finalArchiveVersionId` 指向的最终归档版本创建。这样其来源不会引用可变的“当前归档”；APM-104 不为历史已关闭项目回填复盘或迁移知识。
- 本包不发布企业技术资产，不创建 `TechnicalAsset`、`AssetRelease` 或项目引用/派生关系；经验知识与 AST 域保持分离。

## 2. 领域模型方案比较

| 方案 | 模型                                                                 | 优点                                                                                        | 缺点                                                                                               | 结论     |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| A    | 一个项目复盘表，附加可编辑的知识卡片                                 | 表少、初期页面简单                                                                          | 无法冻结审核时的来源、难以处理撤销/替代，G9 与跨项目阅读会共用不相容的权限边界                     | 不采用   |
| B    | 项目复盘聚合与全局知识条目聚合分离，二者均采用内容版本和追加审核事实 | G9 可只依赖项目内复盘；知识可独立审核、发布、替代和记录实际复用；客户数据不会因知识检索泄露 | 需要两个清晰的授权边界和来源快照关系                                                               | **采用** |
| C    | 将知识条目直接作为 `ProjectArchiveManifestItem` 的一种可编辑来源     | 归档关联看似直接                                                                            | 把项目归档的不可变证据与可撤销的企业知识混在一起，知识修订会污染归档水位，且无法安全支持跨项目检索 | 不采用   |

推荐方案 B。APM-054 的 `archives` 模块继续拥有归档及最终关闭事实；新的 `retrospectives` 模块拥有项目复盘；新的 `knowledge` 模块拥有内部知识发布与复用记录；GOV 继续拥有版本化 Gate 检查与历史快照。

## 3. 项目复盘

### 3.1 聚合和版本

每个项目至多一个稳定的 `ProjectRetrospective`。它只保存项目归属、当前版本指针、最近批准版本指针、聚合乐观锁版本和审计元数据。所有可读内容都位于 `ProjectRetrospectiveVersion`，并按同一聚合递增版本号保存。

`ProjectRetrospectiveVersion` 冻结下列字段：

- `projectId`、`retrospectiveId`、`versionNo`、`supersedesVersionId`；
- 复盘输入归档 A 的 `retrospectiveInputArchiveVersionId`、`retrospectiveInputManifestChecksum`、`retrospectiveInputSourceWatermark`；该归档版本在提交时必须为同项目的 `READY`、`retrospectiveInputApplicability = APPLICABLE` 且 `retrospectiveInputWatermarkVersion = RETROSPECTIVE.INPUT@1` 版本；
- 从归档 A 的不可变 `retrospectiveInputSnapshotJson` 规范化计算的 `retrospectiveInputWatermark`。它只覆盖复盘实际依据的项目、交付单元、阶段、问题历史、验收/Gate、遗留项和归档来源事实，排除复盘自身、知识条目以及关项自引用来源；
- 项目名称、编号、类型、主控阶段、结束事实等有限项目快照；
- 结构化复盘内容、贡献条目、参与人快照、来源问题快照和 `contentChecksum`；
- 创建人、服务器创建时间、提交时间及版本状态。

内容字段在版本创建后不能原地覆盖。每次保存草稿、根据驳回修订或替代已批准复盘都会创建新版本；被后续草稿取代的草稿版本标记为 `SUPERSEDED`，但仍保留。状态变迁和审核决定是唯一允许的受控变更，且每次变迁都追加审计和审核记录。

### 3.2 归档 A → 复盘 → 归档 B

复盘必须严格遵循两次归档时序，不能把两个归档版本当成同一个事实：

```text
归档 A（复盘输入）
  -> 创建复盘版本并计算 retrospectiveInputWatermark
  -> 独立审核批准复盘版本
  -> 归档 B（包含批准复盘清单项）
  -> 运行新策略 G9 并关闭项目
```

归档版本中的现有 `manifestChecksum` 和 `sourceWatermark` 仍分别表示该版本的完整清单哈希和完整来源水位，但 A、B 的值预期不同。两者的来源读取、排序、规范化和哈希负载都必须由归档版本自身冻结的 `archiveSourceFormulaVersion` 解释，不能由运行时的最新读取器重新解释：

- `ARCHIVE.SOURCE@1` 是 APM-054 的 legacy 公式，逐字节保留基线 `f036a0bc` 的 `archive-source-reader`、排序、规范化、`externalPublication`、`snapshotJson`、`sourceWatermark`、`manifestChecksum` 和每个既有 manifest item/source checksum 的哈希负载。它仍读取全部 Gate submission 及其文档引用。它只用于历史归档、历史 `CLOSURE.ARCHIVE.G9@1` 快照的兼容读取和按旧公式的当前性校验，绝不改写为排除规则或为新元数据重算历史哈希；
- `ARCHIVE.SOURCE@2` 是 APM-104 的新公式。它将 `archiveSourceFormulaVersion = ARCHIVE.SOURCE@2` 明确写入规范化 manifest snapshot、`sourceWatermark` 和 `manifestChecksum` 的哈希负载，并绑定 `CLOSURE.SELF_REFERENCE_EXCLUSION@1`：G1 至 G8 的 Gate 提交、审批和证据仍然纳入；属于项目级 G9、且其确切策略 binding 包含 `CLOSURE.ARCHIVE.G9@2` 的 submission、检查快照/结果、审批、submission document reference 和关闭事件一律从该归档的来源树排除。`ProjectClosureRecord` 也排除。该排除避免 Archive B 之后的 G9 或关闭事实反向改变 B；它不改变 `ARCHIVE.SOURCE@1` 的历史含义。

APM-104 为 `ProjectArchiveVersion` 增加下列受约束且不可变的字段：

- `archiveSourceFormulaVersion`：非空、不可变的完整归档来源公式版本。对 `ARCHIVE.SOURCE@1`，它仅是 APM-104 升级迁移补充的语义标签/分派元数据：不进入旧 `snapshotJson`、`manifestChecksum`、`sourceWatermark` 或任何既有 manifest item/source checksum 的哈希负载。对 `ARCHIVE.SOURCE@2`，它必须进入规范化 manifest snapshot、`manifestChecksum` 和 `sourceWatermark` 的哈希上下文。两种公式下，G9 evidence、当前性重算、关项重校验和 `ProjectClosureRecord` 都冻结并比对该元数据值。受支持的值仅为 `ARCHIVE.SOURCE@1`、`ARCHIVE.SOURCE@2`；缺失、未知或与提交策略/checker 不匹配时默认拒绝，禁止按“最新规则”猜测；

- `retrospectiveInputApplicability`：`APPLICABLE` 或 `NOT_APPLICABLE`；
- `retrospectiveInputWatermarkVersion`：仅 `APPLICABLE` 时为 `RETROSPECTIVE.INPUT@1`；
- `retrospectiveInputSnapshotJson`：仅 `APPLICABLE` 时保存规范化、不可变的复盘输入快照；
- `retrospectiveInputWatermark`：仅 `APPLICABLE` 时为对该快照及水位公式版本的 SHA-256。

数据库约束要求 `APPLICABLE` 的版本同时拥有复盘输入公式版本、输入快照和 64 位水位；`NOT_APPLICABLE` 的三个复盘输入字段必须为 `NULL`，不能用空串、零哈希或后算事实伪造历史水位。`archiveSourceFormulaVersion` 始终独立存在，不能因复盘输入为 `NOT_APPLICABLE` 而为空。归档 A、复盘和归档 B 的规则为：

- APM-104 新归档 A 必须为 `archiveSourceFormulaVersion = ARCHIVE.SOURCE@2`，在 `CLOSURE.SELF_REFERENCE_EXCLUSION@1` 过滤后，从不包含复盘、知识条目和关项自引用来源的 `RETROSPECTIVE.INPUT@1` 输入集合计算并冻结 `retrospectiveInputSnapshotJson` 与水位；
- 复盘版本冻结归档 A 的 ID、清单哈希、完整来源水位、输入快照公式版本和 `retrospectiveInputWatermark`；
- 归档 B 必须同为 `archiveSourceFormulaVersion = ARCHIVE.SOURCE@2`；在加入已批准复盘清单项后，使用完全相同的复盘输入筛选和自引用排除规则重新计算输入快照与 `retrospectiveInputWatermark`，同时以 `ARCHIVE.SOURCE@2` 正常计算 B 自己的完整 `manifestChecksum` 和完整 `sourceWatermark`；
- `CLOSURE.ARCHIVE.G9@2` 和 `CLOSURE.RETROSPECTIVE.G9@1` 必须比较 `retrospectiveInputArchiveVersionId` 对应的归档 A 与最终归档 B 的 `retrospectiveInputApplicability = APPLICABLE`、`archiveSourceFormulaVersion = ARCHIVE.SOURCE@2`、复盘输入公式版本及 `retrospectiveInputWatermark` 相等，并单独校验 B 的 `manifestChecksum`、`sourceWatermark`、完整性检查和最终化状态；不得比较 `archiveA === archiveB`；
- A 到 B 之间任一复盘依据事实变化，水位必然变化，必须创建新的复盘版本、重新审核并重新生成归档 B；旧复盘、旧归档和旧 G9 快照不被覆盖。

`CLOSURE.SELF_REFERENCE_EXCLUSION@1` 是 `ARCHIVE.SOURCE@2` 专属且唯一的纯领域规则，按 Gate 定义代码 `G9`、确切关项 checker binding 和关项策略/归档 B 引用识别自引用事实。`ArchiveSourceFormulaRegistry` 必须提供两个完全分离的 adapter：`@1` legacy adapter 固定委派给 APM-054 reader 与旧 hash payload，不应用该排除也不将分派元数据插入旧快照/哈希；`@2` adapter 使用新 reader/filter 与新 hash payload，并在其中调用该规则。归档生成、归档 B 当前性重算和 `project-close-service` 都先从归档行的 `archiveSourceFormulaVersion` 选择 adapter；未知或缺失版本默认拒绝，任何路径不得自行复制、扩展、降级或省略公式。`ProjectClosureRecord` 始终不属于 `ARCHIVE.SOURCE@2` 的来源，不能使已生成的归档 B 因成功关闭而过期。

项目复盘聚合的 G9 读取条件还包括 `currentVersionId === latestApprovedVersionId`。只要存在新建但未批准的草稿版本，旧批准版本不得用于结项；项目关闭事务必须在锁定后重新比对两个指针和复盘版本校验和。

### 3.3 内容、参与角色和最低完成条件

复盘提交的必填内容为：

1. 交付范围、目标与实际结果的事实性摘要；
2. 做得好的做法和可重复条件；
3. 未达预期事项、根因和影响范围；
4. 已采取或建议采取的预防/改进措施，包含责任角色、目标时间或明确的“不适用”理由；
5. 适合沉淀为知识的候选经验，或经过审核的“无可发布经验”说明；
6. 对客户知识产权、保密、敏感信息和脱敏范围的明确声明；
7. 至少一个确切的归档 A 引用，以及服务端计算的 `retrospectiveInputWatermark`。

`ProjectRetrospectiveContribution` 是版本内不可变条目。其 `scopeType` 为 `PROJECT` 或 `DELIVERY_UNIT`；后者必须以复合项目关系校验 `deliveryUnitId` 同属当前项目。贡献至少包含专业、贡献人、事实/经验、影响和是否可复用。项目可没有交付单元贡献；一旦某个贡献在提交版本中被标为必填，它必须完整才可提交。

参与人使用版本内 `ProjectRetrospectiveParticipant` 快照：

- 提交人：具有 `PROJECT_RETROSPECTIVE_MANAGE` 且为当前项目有效成员；默认项目经理可获该权限；
- 贡献人：当前项目有效成员，可提供项目级或交付单元级事实；
- 审核人：具有 `PROJECT_RETROSPECTIVE_REVIEW`、当前项目有效成员，且不得与提交人相同；默认由质量或部门负责人授予该权限；
- 知识审核人：不属于复盘批准的最低条件，使用全局 `KNOWLEDGE_REVIEW` 权限单独审核可发布知识。

G9 最低复盘完成条件是：项目级复盘存在、`currentVersionId === latestApprovedVersionId`、该版本为 `APPROVED`、版本内容和强制贡献完整、项目归属有效、归档 A 和 `retrospectiveInputWatermark` 完整，且该复盘版本已经被后续归档 B 的 READY 清单冻结。单纯保存草稿、提交待审、被驳回、仅有交付单元贡献或仅点击知识条目都不满足条件。

### 3.4 复盘状态机

```text
DRAFT -> IN_REVIEW -> APPROVED
                   -> REJECTED
REJECTED -> 新的 DRAFT 版本
APPROVED -> 新的 DRAFT 版本（形成新的复盘事实）
DRAFT -> SUPERSEDED（被后续草稿取代）
```

`APPROVED` 内容不可变。若项目事实、归档版本或复盘结论需要更新，只能创建下一版本并重新审核；旧批准版本不会被改写。`REJECTED` 版本保留审核理由。项目关闭后不得创建、提交或审核复盘版本。

## 4. 知识条目、审核和实际复用

### 4.1 知识条目边界

`KnowledgeEntry` 是全局稳定身份，保存编号、当前发布版本指针、撤销状态和聚合乐观锁版本。`KnowledgeEntryVersion` 是不可变内容快照，保存标题、脱敏摘要、经验类型、专业、关键词、适用项目类型/阶段、前置条件、推荐做法、反模式、限制条件、来源声明和规范化 `contentChecksum`。

第一阶段一个知识版本只允许引用一个源项目，但可引用该项目中多个问题事实。每个 `KnowledgeEntrySource` 均冻结：

- 源项目 ID 和归档 B 的确切 `finalArchiveVersionId`；
- 归档 B 的 `finalArchiveSourceFormulaVersion`、`finalArchiveManifestChecksum` 和 `finalArchiveSourceWatermark`；
- 归档 A 的 `retrospectiveInputArchiveVersionId`、`retrospectiveInputArchiveSourceFormulaVersion`、`retrospectiveInputManifestChecksum`、`retrospectiveInputSourceWatermark` 和 `retrospectiveInputWatermark`；
- 确切的 `ProjectRetrospectiveVersion` ID、版本号和 `contentChecksum`；
- 每个来源问题的 `issueId`、确切 `IssueHistory` 序号/ID、问题分类、严重度、状态和脱敏来源快照；
- 来源版本的 `sourceChecksum` 与创建时服务器时间。

知识条目不能引用“当前问题”“当前归档”“当前复盘”或仅引用模糊问题编号。创建知识版本前，服务端必须校验源项目已经 `CLOSED`，引用的归档 B 等于 `Project.finalArchiveVersionId` 且为 `FINALIZED`，引用复盘版本为同项目 `APPROVED` 版本，并且所有问题历史事实同属该项目。归档 A 与归档 B 的 ID、哈希和水位都保留在来源快照中，不能用 B 的完整水位替代复盘输入水位。

### 4.2 知识状态机和审核记录

```text
DRAFT -> IN_REVIEW -> PUBLISHED
                   -> REJECTED
PUBLISHED -> SUPERSEDED（新版本发布后）
PUBLISHED | SUPERSEDED -> REVOKED（知识产权、敏感性或错误处理）
REJECTED -> 新的 DRAFT 版本
```

`KnowledgeEntryReview` 是追加式事实，记录审核人、决定、理由、服务器时间、所审版本和审核时的来源校验和。发布、拒绝、替代和撤销均不改变历史版本内容。新版本发布后旧已发布版本改为 `SUPERSEDED`；撤销不物理删除条目，检索结果明确标为不可采用并保留合规审计。

`KnowledgeReuseRecord` 只在目标项目的授权人员人工确认已经实际采用某个确切 `KnowledgeEntryVersion` 后创建。它冻结目标项目、可选同项目交付单元、知识版本、确认人、服务器确认时间、采用场景、采用证据摘要和命令幂等键。点击、搜索、预览、复制文本或自动推荐绝不创建复用记录。第一阶段同一目标项目与同一知识版本只能有一个有效确认记录；录入错误使用追加的 `KnowledgeReuseCorrection` 事实更正，不覆盖或删除原确认。

## 5. 来源保护、客户知识产权和检索授权

知识来源默认保密。项目归档、问题、问题历史、文件和证据链接继续使用原模块的项目同属与敏感性授权；知识模块不转授任何源项目读取权。

- 只有拥有源项目 `PROJECT_RETROSPECTIVE_READ` 与源对象读取权限的人员，才可创建知识草稿或查看来源 ID、问题快照及复盘原文；
- 知识审核人需要 `KNOWLEDGE_REVIEW`，同时需拥有来源项目的复盘读取授权，不能仅凭全局审核权限读取客户项目资料；
- 跨项目读者只可检索 `PUBLISHED`、标记为 `INTERNAL_REUSABLE`、且已通过人工脱敏审核的知识版本；返回的内容不包含源项目名称、客户标识、问题编号、文件 ID、文件下载地址、归档清单或未脱敏原文；
- 发布审核必须显式确认客户知识产权、合同保密和敏感数据处理。未确认、风险未知或来源事实不可读时，发布被拒绝而不是以空来源发布；
- 不复制二进制证据到知识库。知识正文只能保存人工审核后的脱敏文字；任何证据读取与下载仍通过既有受控文件、服务器授权和下载审计；
- `KnowledgeReuseRecord` 仅向目标项目授权人员、知识审核人和审计人员显示，不能反向泄露源项目原始事实。

第一阶段中文检索优先使用结构化筛选、规范化关键词和 `pg_trgm` + GIN 模糊检索，不引入向量数据库、嵌入、AI 自动摘要或 AI 自动发布。迁移采用可实际部署的能力分支，而不是把“扩展创建失败”误当作应用降级：

- 迁移在 `DO` 块中尝试 `CREATE EXTENSION IF NOT EXISTS pg_trgm`；只捕获并记录明确的 `insufficient_privilege` (`42501`)、扩展控制文件不可用的 `undefined_file` (`58P01`) 或数据库明确不支持扩展的 `feature_not_supported` (`0A000`)。任何其他 SQLSTATE 必须使迁移失败，避免掩盖损坏或语法问题；
- 同一迁移随后查询 `pg_extension`。仅当实际存在 `extname = 'pg_trgm'` 时，才以条件动态 SQL 创建覆盖已发布知识规范化标题、摘要和关键词的 trigram GIN 索引；不存在扩展时不创建该索引，但迁移必须成功完成；
- 服务器端 `KnowledgeSearchCapabilityPort` 在连接的数据库中探测 `pg_extension` 和必要索引，记录可观测日志/指标。探测失败时默认拒绝搜索并返回明确的能力不可用错误，绝不向客户端谎报为 `DEGRADED`；探测成功时，搜索响应明确返回 `searchMode = TRIGRAM` 或 `searchMode = DEGRADED`，后者同时返回 `SEARCH_DEGRADED`；
- `TRIGRAM` 模式使用索引检索。`DEGRADED` 模式只允许规范化关键词的前缀/包含 `ILIKE` 匹配，查询上限为 64 个 Unicode 字符、页面上限为 20 条、最大可检索窗口为 100 条，并以发布时间和稳定 ID 排序。超出任一边界返回可解释的受控错误，不能悄悄扩大为全表扫描。

CI 必须验证具有 `pg_trgm` 的空库和 APM-054→APM-104 升级路径。无扩展降级由能力适配器或受限数据库场景的单元/集成测试验证；迁移失败绝不能作为降级成功证据。筛选字段固定为文本查询、经验类型、专业、适用项目类型、适用阶段、问题分类、关键词、发布状态和发布时间；默认仅返回当前可采用的 `PUBLISHED` 版本。`SUPERSEDED`、`REVOKED`、草稿和审核中的版本只对授权维护/审核人员可检索。

## 6. G9 版本化接入和兼容规则

APM-054 既有 `CLOSURE.ARCHIVE.G9@1` 和 `ARCHIVE.SOURCE@1` 保持不变：它们只作为 legacy 历史快照和兼容读取语义，继续按 APM-054 公式校验当时的最终归档、完整性、完整来源水位和遗留项。APM-104 不将 `@1` 套用 `CLOSURE.SELF_REFERENCE_EXCLUSION@1`，也不允许 `@1` 新提交用于结项。

APM-104 新增 `CLOSURE.ARCHIVE.G9@2`，仅用于 APM-104 后新项目及完成策略升级的未关闭存量项目；它要求 Archive A/B 均为 `ARCHIVE.SOURCE@2`，并绑定 `CLOSURE.SELF_REFERENCE_EXCLUSION@1`。`CLOSURE.RETROSPECTIVE.G9@1` 同样只在这套 `ARCHIVE.SOURCE@2` / `CLOSURE.ARCHIVE.G9@2` 关项策略中运行，且只支持 `PROJECT` 范围。分离版本确保新增复盘和自引用规则不会追溯改变 `@1` 的历史语义。

冻结的版本分派如下；当前性重算、Gate evidence 和关项重校验都必须以归档/提交中保存的行选择这一行，禁止改按“当前最新”逻辑：

| 场景                                 | `archiveSourceFormulaVersion` | 允许的关项 checker binding                            | 处理                                                                                               |
| ------------------------------------ | ----------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| APM-054 历史归档、已完成的 `@1` 快照 | `ARCHIVE.SOURCE@1`            | `CLOSURE.ARCHIVE.G9@1`                                | 只按 APM-054 reader 与原 hash payload 兼容读取；不得以 `@2` 重算、重新解释或把公式标签加入旧哈希。 |
| APM-104 新项目归档 A/B               | `ARCHIVE.SOURCE@2`            | `CLOSURE.ARCHIVE.G9@2` + `CLOSURE.RETROSPECTIVE.G9@1` | 新关项的唯一合法路径。                                                                             |
| APM-104 部署时未关闭的 legacy 项目   | 旧版本为 `ARCHIVE.SOURCE@1`   | 旧 `@1` 可读                                          | 必须完成策略升级，再生成新的 `ARCHIVE.SOURCE@2` A/B；旧 `@1` 批准不得结项。                        |
| 缺失、未知或不匹配版本               | 任意/缺失                     | 任意                                                  | 默认拒绝；不得降级猜测。                                                                           |

`CLOSURE.RETROSPECTIVE.G9@1` 在同一事务快照中读取：项目、复盘两个版本指针、批准复盘版本、复盘内容校验和、提交/审核人、归档 A 的确切引用、归档 A 与 B 的 `retrospectiveInputWatermark`、A/B 的 `archiveSourceFormulaVersion`、B 的完整清单哈希/完整来源水位，以及 B 的 READY 完整性结果。它必须由 `CLOSURE.ARCHIVE.G9@2` 的同一确切 `ProjectClosurePolicyVersion` 调用；读取 B 的完整来源水位时按 `ARCHIVE.SOURCE@2` 分派并复用 `CLOSURE.SELF_REFERENCE_EXCLUSION@1`，因此 G9 自身的检查、提交、批准和关项记录不会改变 B。缺少任一事实、公式版本缺失/未知/不匹配、版本未批准、存在未批准草稿、参与人不合规、A/B 输入水位不一致、复盘未进入归档 B 清单或检查结果不可用，都返回 `HARD_FAILED`。

关闭项目命令在 APM-054 的可串行化事务中新增锁定和重校验：

1. 锁定 `Project`、归档 A、归档 B、批准的项目复盘版本、复盘聚合指针、G9 提交所引用的确切 `ProjectClosurePolicyVersion`、最新 G9 检查快照/批准提交及未关闭遗留项；
2. 根据提交冻结的策略 bindings 校验该提交同时含 `CLOSURE.ARCHIVE.G9@2` 与 `CLOSURE.RETROSPECTIVE.G9@1`，再根据 A/B 自身冻结的 `archiveSourceFormulaVersion` 通过 `ArchiveSourceFormulaRegistry` 重算当前性。仅 `ARCHIVE.SOURCE@2` 可用于这条新关项路径，且它调用 `CLOSURE.SELF_REFERENCE_EXCLUSION@1`；不识别的版本、`ARCHIVE.SOURCE@1` 或 checker/策略/归档公式不一致均默认拒绝；
3. 比对 G9 快照中的策略版本/策略校验和、复盘 ID、内容校验和、归档 A/B ID、A/B 公式版本和输入水位、B 的 `manifestChecksum` 和完整 `sourceWatermark` 与当前不可变事实；
4. 仅当 `CLOSURE.ARCHIVE.G9@2` 与 `CLOSURE.RETROSPECTIVE.G9@1` 都按提交时的同一确切策略版本通过且 G9 已批准时，才设置 `Project.status = CLOSED` 和 `finalArchiveVersionId = archiveB.id`；项目关闭、审计和 Outbox 保持同一事务。

该事务还原子创建唯一、追加式且不可变的 `ProjectClosureRecord`。它冻结 `projectId`、`archiveBId`、B 的 `archiveSourceFormulaVersion`、`manifestChecksum`/完整 `sourceWatermark`、`closurePolicyVersionId`/策略校验和、G9 `gateInstanceId`/`gateCheckSnapshotId`/`gateSubmissionId`/批准事实、`retrospectiveVersionId`/内容校验和、关闭人和数据库关闭时间。该记录以 `projectId` 唯一，不可更新或删除；它只证明已经完成的关项，不反向写入归档 B、归档清单或复盘输入水位，也不进入 B 的 `ARCHIVE.SOURCE@2` 水位。

兼容策略：

- 所有 APM-104 之后可关项的项目都必须有一个 `ProjectClosurePolicy` 聚合和确切的 `ProjectClosurePolicyVersion`。新项目必须使用包含 `CLOSURE.ARCHIVE.G9@2`、`CLOSURE.RETROSPECTIVE.G9@1` 与 `archiveSourceFormulaVersion = ARCHIVE.SOURCE@2` 的已发布模板/组件版本；在项目模板快照、G9 `ProjectGateDefinition` 物化的同一业务事务中，基于确切模板快照/组件版本原子创建初始策略版本。初始版本冻结 `sourceTemplateSnapshotId`、`sourceGateDefinitionId`、两个 checker binding、`ARCHIVE.SOURCE@2`、binding 校验和、策略校验和和服务器生效时间；运行时绝不修改 `checkerBindingsJson`；
- APM-104 部署时尚未 `CLOSED` 的存量项目通过显式的 `ProjectClosurePolicy` 聚合升级。每个项目只有一个稳定策略聚合，`ProjectClosurePolicyVersion` 以 `(projectId, versionNo)` 唯一递增，冻结 `sourceGateDefinitionId`、`CLOSURE.ARCHIVE.G9@2`、`CLOSURE.RETROSPECTIVE.G9@1`、`ARCHIVE.SOURCE@2`、策略校验和、升级原因、操作者和服务器生效时间；同一项目只能有一个 ACTIVE 版本（迁移使用部分唯一索引）。升级命令幂等，成功审计和 Outbox 在同一事务中创建，不回写旧 Gate 定义；
- 新项目和升级项目的 G9 `ProjectGateInstance` 都必须保存 `closurePolicyVersionId`，`GateCheckSnapshot` 和 `GateSubmission` 都必须保存该确切策略版本 ID、checker binding 快照、`archiveSourceFormulaVersion` 和策略校验和。`ProjectClosurePolicyVersion` 是 G9 执行与关项的权威来源；它与 `ProjectGateDefinition` 的 binding/校验和或归档公式不一致时默认拒绝。`runGateChecks` 只读取调用方明确传入的 Gate 实例/策略版本，不在运行时隐式附加 checker；
- 项目关闭服务锁定并比较 G9 提交、Gate 实例、Gate 检查快照中的同一个 `closurePolicyVersionId`、策略校验和和 `archiveSourceFormulaVersion`；它不会仅依赖当前 ACTIVE 指针。若提交引用的版本已被新策略替代或任一 binding/公式不一致，返回 `CLOSURE_POLICY_STALE`，要求按新版本重新检查、提交和批准；
- 存量旧 G9 实例和旧批准提交保留为 `LEGACY` 历史事实，若没有 `closurePolicyVersionId`，项目关闭服务直接返回 `CLOSURE_POLICY_VERSION_REQUIRED`。升级后必须生成 `ARCHIVE.SOURCE@2` 的适用归档 A、批准复盘、生成归档 B，再用新的 G9 实例按确切 `@2` 策略重新检查、提交和批准；旧 `@1` 快照/批准只能历史读取，不能绕过这套流程结项。所有尚未关闭的 APM-054 归档版本均按 `NOT_APPLICABLE` 处理，必须先生成新的可适用归档 A，不能直接作为复盘输入；
- 迁移为 `ProjectClosurePolicy`、`ProjectClosurePolicyVersion` 增加项目同属复合外键、`(projectId, versionNo)` 唯一约束、策略校验和和归档公式非空约束、ACTIVE 部分唯一索引，并为 Gate 实例/快照/提交增加策略版本及归档公式的复合关系。历史旧实例不删除、不改写，只接受兼容读取；
- APM-104 部署前已经 `CLOSED` 且没有批准复盘的项目不创建知识条目，不回填或伪造复盘。历史知识迁移、补录和任何 legacy 适配列均列为后续独立工作包，不在 APM-104 API、迁移、G9 或 UI 中实现。

## 7. 预计持久化、模块和接口范围

后续实施会新增一个 APM-104 迁移，包含下列枚举和表：

- `ProjectRetrospective`、`ProjectRetrospectiveVersion`、`ProjectRetrospectiveContribution`、`ProjectRetrospectiveParticipant`、`ProjectRetrospectiveIssueSource`、`ProjectRetrospectiveReview`；`ProjectArchiveVersion` 增加不可空、不可变的 `archiveSourceFormulaVersion`，以及 `retrospectiveInputApplicability`、`retrospectiveInputWatermarkVersion`、`retrospectiveInputSnapshotJson` 和 `retrospectiveInputWatermark`，并以数据库约束保证 `APPLICABLE`/`NOT_APPLICABLE` 组合有效。升级迁移把 APM-054 既有归档精确标记为 `archiveSourceFormulaVersion = ARCHIVE.SOURCE@1` 和 `NOT_APPLICABLE`，三个复盘输入字段均为 `NULL`。该回填是语义标签/分派元数据迁移，不是历史归档内容再生成：迁移不得 `UPDATE` 旧 `snapshotJson`、`manifestChecksum`、`sourceWatermark`、manifest items、item/source checksum 或完整性检查事实；标签来源由迁移记录和审计证明，而不是通过改写历史哈希补做密码学绑定；
- `KnowledgeEntry`、`KnowledgeEntryVersion`、`KnowledgeEntrySource`、`KnowledgeEntryReview`、`KnowledgeReuseRecord`、`KnowledgeReuseCorrection`；
- `ProjectClosurePolicy`、`ProjectClosurePolicyVersion` 与唯一、不可变的 `ProjectClosureRecord`，以及 Gate 实例、检查快照和提交的确切策略版本、checker binding、归档公式版本和策略校验和引用；
- 复盘和知识版本的单聚合序号唯一约束、项目/交付单元/归档/问题/策略版本的同属复合约束、每项目每知识版本单一有效复用记录、策略 ACTIVE 部分唯一索引、归档公式版本的受支持值约束、`pg_trgm` 可选扩展与条件 GIN 索引（含无扩展的受控关键词/`ILIKE` 降级），以及冻结已提交/审核/发布内容的 PostgreSQL 触发器；
- 新权限、审计动作/对象类型与 Outbox 事件词汇。不会修改 Prisma 既有迁移。

模块边界如下：

- `src/modules/retrospectives/{domain,application,contracts,infrastructure}`：项目复盘、来源冻结、审核和 G9 事实读取；
- `src/modules/knowledge/{domain,application,contracts,infrastructure}`：知识条目、版本审核、受限检索和人工复用记录；
- `src/modules/governance`：注册 `CLOSURE.ARCHIVE.G9@2` 与 `CLOSURE.RETROSPECTIVE.G9@1`，保留 `CLOSURE.ARCHIVE.G9@1` 的兼容读取；管理 `ProjectClosurePolicyVersion` 的新项目物化和存量升级，并在 Gate 实例/快照/提交中冻结确切策略、binding 和归档公式事实；
- `src/modules/projects/application/project-close-service.ts`：按提交冻结的策略和归档自身的来源公式版本分派重校验复盘/归档，拒绝 `@1` 新关项或未知公式，并原子创建 `ProjectClosureRecord`；PRJ 仍独占项目状态变迁；
- `src/modules/archives`：拥有 `ArchiveSourceFormulaRegistry`。`ARCHIVE.SOURCE@1` adapter 委派给不变的 APM-054 reader 和旧 hash payload；仅 `ARCHIVE.SOURCE@2` adapter 使用唯一的 `CLOSURE.SELF_REFERENCE_EXCLUSION@1` 纯规则并把公式版本写入新 hash payload。归档生成、归档 B 当前性重算和关项服务都按归档冻结版本分派，绝不无条件套用新规则；它冻结已批准复盘的确切版本，不让知识发布反向修改归档；
- 项目复盘页面、全局内部知识检索页和目标项目的复用确认表单只消费服务端页面状态，不在客户端计算授权、脱敏、Gate 或历史来源规则。

预期薄 Route Handler 为项目复盘的读取、草稿版本创建、提交、审核，知识的检索、草稿版本创建、提交、审核/发布、撤销/替代，及目标项目的复用确认/更正。每个写命令使用严格 DTO、项目或全局授权、对象同属、当前状态、`If-Match` 乐观锁和 `Idempotency-Key`；业务事实、成功审计和 Outbox 事件在同一 Prisma 事务提交。

UI 将把项目复盘置于项目“审批与记录”范围内，显示草稿、审核、G9 阻塞和精确归档来源；知识检索为内部全局工作区，默认不展示来源项目或原始证据。页面须支持 normal、loading、empty、error、denied、stale 与 409 冲突，并在 1440×900 和 390×844 保持键盘焦点、文本状态和无横向溢出。

## 8. 后续实施测试范围

后续 TDD 和集成验收至少覆盖：

- 复盘项目唯一性、版本内容不可变、提交/审核状态机、独立审核人和交付单元同属；
- 必填复盘字段、确切归档/问题历史来源和来源校验和确定性；
- 知识发布、驳回、替代、撤销和旧版本不可修改；
- 归档 A→批准复盘→归档 B 的双水位一致性、`ARCHIVE.SOURCE@2` 的完整清单/来源水位校验和，以及未批准草稿阻断；
- 使用真实或固定的 APM-054 archive fixture，记录迁移前的 `snapshotJson`、`manifestChecksum`、`sourceWatermark`、每个 manifest item 及其 source checksum；APM-054→APM-104 迁移后这些值逐字节/逐值完全相同，仅新增 `ARCHIVE.SOURCE@1` 分派元数据与 `NOT_APPLICABLE`/三个 `NULL` 复盘输入字段；
- `CLOSURE.ARCHIVE.G9@1` / `ARCHIVE.SOURCE@1` 历史归档和快照按 APM-054 reader 与原 hash payload 保持不变，不被 `@2` reader、自引用规则或公式标签重新解释；迁移后以 `@1` legacy adapter 重算仍与原 `sourceWatermark`、`manifestChecksum` 匹配；同一来源按 `@2` 生成可以产生不同哈希，且不得用于验证 `@1`；
- `CLOSURE.ARCHIVE.G9@2` 下，归档 B 生成后新增 G9 检查、提交、批准和 `ProjectClosureRecord` 不使 B 过期；任一非 G9 归档来源变化仍必须使 B 过期；
- APM-054 旧归档的 `ARCHIVE.SOURCE@1`、`NOT_APPLICABLE`/空复盘输入字段约束、旧归档不能作归档 A，以及新归档的 `ARCHIVE.SOURCE@2` / `RETROSPECTIVE.INPUT@1` 快照、水位和 manifest 哈希确定性；
- 新项目初始化时原子物化 `CLOSURE.ARCHIVE.G9@2`、`CLOSURE.RETROSPECTIVE.G9@1` 和 `ARCHIVE.SOURCE@2` 策略；存量项目策略版本升级、重复幂等、并发升级、策略校验和不一致、legacy 未关闭项目不能绕过 A/B 重生成和新 G9、新实例重新检查/提交/批准；
- Gate 实例、检查快照和提交均引用同一确切策略版本、binding 和归档公式版本；公式版本缺失、未知或与策略/checker 不匹配时默认拒绝；关闭记录原子写入、不可变且不属于 Archive B 来源；
- 项目关闭前禁止以未完成复盘通过 G9，复盘或归档事实漂移后禁止用旧 G9 关闭；
- 已关闭项目不回填伪复盘且禁止创建知识条目，历史知识迁移明确留待后续工作包；
- `pg_trgm` 空库/升级回放/CI 正常路径、扩展不可用时迁移仍成功的受控降级、能力探测失败默认拒绝和 `SEARCH_DEGRADED` 有界检索；
- 跨项目、无成员、无来源读取权、敏感来源、错误文件/问题/归档版本、权限不足、IDOR、幂等键冲突和乐观锁冲突；
- 手工确认复用才生成一份追加记录，搜索/点击不生成记录，修正不删除历史；
- 审计/Outbox 与业务写入原子回滚，空库迁移和 APM-054→APM-104 升级回放；
- API、页面状态、关键提交/审核/复用交互以及桌面和移动端浏览器验收。

## 9. 明确不包含

本包不包含企业技术资产发布或技术资产升级影响、AI 知识生成或自动发布、向量数据库、外部供应商知识库、客户共享知识库、外部下载、备份/长期归档介质迁移、APM-024 计划变更、APM-110 外部身份、APM-111 供应商包或任何后续工作包。

## 10. 自检结果

本设计没有占位项。完整归档来源语义现由不可变的 `archiveSourceFormulaVersion` 冻结，但哈希兼容明确按公式分支：`CLOSURE.ARCHIVE.G9@1` / `ARCHIVE.SOURCE@1` 使用逐字节不变的 APM-054 reader 与原 hash payload，公式标签只是迁移审计支持的分派元数据；只有 `CLOSURE.ARCHIVE.G9@2` / `ARCHIVE.SOURCE@2` 将公式版本纳入新 manifest、`manifestChecksum` 和 `sourceWatermark` 哈希，并使用 `CLOSURE.SELF_REFERENCE_EXCLUSION@1`。因此生成 B 后新增的 G9/关项事实不改变 `@2` B，但任一非 G9 来源变化仍会使 B 过期；当前性重算不会用新 reader 或新哈希负载重写 legacy 归档。APM-054 旧归档全部为 `ARCHIVE.SOURCE@1` 和 `NOT_APPLICABLE`，不回填任何虚构复盘水位或历史哈希；新项目和升级后的存量项目都必须物化确切的 `ProjectClosurePolicyVersion`、新 A/B 和 `@2` G9。中文检索的 `pg_trgm` 路径与无扩展的有界降级均可部署、可观测、可测试。复盘批准与知识发布被拆开，以消除“先结项还是先发布知识”的循环依赖；关闭后无批准复盘的历史项目不产生知识条目，历史迁移明确留待后续工作包。范围仅覆盖项目复盘、受控内部知识和 G9 接入。
