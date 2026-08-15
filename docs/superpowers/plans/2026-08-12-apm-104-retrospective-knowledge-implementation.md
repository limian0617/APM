# APM-104 项目结项复盘与可追溯知识 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 在不改变 APM-054 历史归档哈希语义的前提下，实现项目级结项复盘、受控内部知识、人工确认复用，以及使用新版 G9 策略的可追溯项目关闭闭环。

**Architecture:** 归档版本冻结 archiveSourceFormulaVersion，由 ArchiveSourceFormulaRegistry 选择逐字节兼容的 ARCHIVE.SOURCE@1 legacy adapter 或带关项自引用排除的 ARCHIVE.SOURCE@2 adapter。治理域以不可变 ProjectClosurePolicyVersion 物化新版 G9，Gate definition revision 只追加不改写；复盘在 Archive A 与 Archive B 之间完成独立审核；项目关闭事务按提交冻结的策略和归档公式重校验并写入不可变 ProjectClosureRecord。知识域只发布人工脱敏、精确引用已关闭项目 Archive B、复盘版本和 IssueHistory 的版本。

**Tech Stack:** Next.js 16 App Router、React 19、TypeScript、Zod、Prisma 6.19、PostgreSQL 16、Vitest、现有 project/system guard、idempotentCommandResponse、Audit、事务 Outbox、PersistentJob 和私有对象存储。

---

## 执行约束与唯一顺序

本计划只供后续实现执行。本轮只修改本文件，不执行 TDD、Schema、migration、业务代码、测试实现、CI、提交、推送、PR 或进度表更新。执行开始时必须先使用 superpowers:test-driven-development，所有任务按 Red -> 确认失败 -> 最小实现 -> 通过 -> 阶段回归 -> 本地提交执行。

唯一依赖拓扑如下，任何任务的 RED/GREEN 只能引用本任务或此前任务已经创建的文件：

    1 legacy fixture
    -> 2 complete schema/migration/persistence contract
    -> 3 archive formula registry and retrospective input
    -> 4 retrospective core/review and V2 archive source
    -> 5 V2 template publication and closure policy
    -> 6 G9@2 and active/legacy Gate lifecycle
    -> 7 serializable close and ProjectClosureRecord
    -> 8 retrospective API/page-state and browser fixture
    -> 9 knowledge domain/search/reuse
    -> 10 knowledge API
    -> 11 UI and browser acceptance
    -> 12 database replay/CI/final gates

| Phase               | Tasks | Gate                                                           |
| ------------------- | ----- | -------------------------------------------------------------- |
| A 基线与持久化      | 1-2   | legacy 哈希逐值不变；完整 schema/migration contract 可验证。   |
| B 归档与复盘        | 3-4   | V1/V2 分派明确；批准复盘可冻结进 Archive B。                   |
| C 策略、Gate 与关闭 | 5-7   | V2 模板/策略闭环；旧 G9 只读；V2 G9 可执行；关项记录原子唯一。 |
| D API 与知识        | 8-10  | 薄 API、权限、IDOR、幂等、审计、Outbox、检索/复用合同通过。    |
| E UI 与发布验收     | 11-12 | 真实浏览器流程、空库/升级/受限数据库、全量门禁和 CI 准备通过。 |

所有写命令复用现有 idempotentCommandResponse：相同 actor、operation、key 和请求哈希返回原响应；同 key 不同请求返回 IDEMPOTENCY_KEY_REUSED/409。业务事实、成功 Audit 和 Outbox 位于同一个 Prisma 事务。客户端不得计算授权、脱敏、Gate 判定、来源水位或 checksum。

### 已核对的仓库事实

- ProjectGateDefinition 当前只有 projectId+code 唯一；createGateInstance、listProjectGates、runGateChecks 和 submission service 没有 active/legacy G9 防线。
- 模板发布已有 CONFIGURATION_WRITE 路径：template-policy.ts、template-service.ts、templates integration test 和 /api/templates/[code]/versions。
- create-project.ts 在同一事务物化模板快照、阶段、Gate definitions/instances；初始 closure policy 必须加入这个事务。
- development/test 身份读取 x-apm-user-id；production 还校验 x-apm-auth-secret。
- archive generation 使用 archive-generation-handler.ts，并由 archive-job-handlers.ts 注册。
- project-close-service.test.ts 已存在，必须 Modify；apm-054-to-apm-104-upgrade.integration.test.ts 与 project-close-service.integration.test.ts 当前不存在，必须 Create。

## Phase A - 基线与持久化

### Task 1: 固定 APM-054 legacy archive fixture

**Files:**

- Create: src/modules/archives/fixtures/apm-054-archive-v1.fixture.ts
- Modify/Test: src/modules/archives/application/archive-manifest-service.test.ts
- Modify/Test: src/modules/archives/application/archive-source-reader.test.ts

- [ ] Step 1: 先写导入不存在 fixture 的 RED 测试，比较 snapshotJson、manifestChecksum、sourceWatermark、每项 sourceChecksum 和 G9 submission source。
- [ ] Step 2: 运行 npm run test -- src/modules/archives/application/archive-manifest-service.test.ts src/modules/archives/application/archive-source-reader.test.ts。预期 fixture import 失败。
- [ ] Step 3: 创建固定 fixture。常量必须保持：
  - manifestChecksum: 8318fcc9f74d07e7294f50c8f804f35ed90d7a17791faf9c5dc9bdb0018c3796
  - sourceWatermark: 409c8d330a9d12ed3ca1cfefa6f48329984382f304a7937b1c37608736e635e6
  - item checksums: c09953d01f6858cb49cd562a28be25f551cbf9bd10d41fe13c4b1380e07bb3cd、0b6f36e85a9508f283e4cbc64aa38cbef96f241ccafbd2c3296ff6d69b8951eb
- [ ] Step 4: 重跑聚焦测试，预期 PASS；提交 fixture 和两个测试，commit message 为 test: lock APM-054 archive hash compatibility。

The RED assertion must compare raw serialized values, not parsed/re-serialized JSON:

```ts
expect(actual.snapshotJsonText).toBe(APM_054_ARCHIVE_V1.snapshotJsonText);
expect(actual.manifestChecksum).toBe(APM_054_ARCHIVE_V1.manifestChecksum);
expect(actual.sourceWatermark).toBe(APM_054_ARCHIVE_V1.sourceWatermark);
expect(actual.items.map((item) => item.sourceChecksum)).toEqual(APM_054_ARCHIVE_V1.itemChecksums);
```

### Task 2: 完整 Prisma/migration contract

**Files:**

- Modify: prisma/schema.prisma
- Create: prisma/migrations/20260812010000_apm_104_retrospectives_knowledge_closure_policy/migration.sql
- Create/Test: src/modules/archives/infrastructure/apm-054-to-apm-104-upgrade.integration.test.ts
- Create/Test: src/modules/retrospectives/domain/retrospective-persistence.test.ts
- Create/Test: src/modules/knowledge/domain/knowledge-persistence.test.ts
- Modify/Test: src/modules/archives/domain/project-archive-persistence.test.ts
- Modify/Test: src/modules/governance/domain/project-archive-gate.test.ts
- Modify: src/modules/audit/domain/vocabulary.ts, src/lib/auth/permissions.ts, src/lib/auth/authorize.ts
- Modify/Test: src/lib/auth/authorize.test.ts

- [ ] Step 1: schema/migration RED 测试逐项断言附录 A 的 enum、字段、relation、unique/index、composite FK、check、partial unique 和 trigger 名称。
- [ ] Step 2: 运行 npm run test -- src/modules/archives/domain/project-archive-persistence.test.ts src/modules/retrospectives/domain/retrospective-persistence.test.ts src/modules/knowledge/domain/knowledge-persistence.test.ts src/modules/archives/infrastructure/apm-054-to-apm-104-upgrade.integration.test.ts。预期新模型和 migration 缺失。
- [ ] Step 3: 按附录 A 修改 schema，ProjectGateDefinition 唯一由 projectId+code 改为 projectId+code+revision；Gate instance/snapshot/submission 增加 legacy nullable policy tuple；新增模型固定为 15 个，新增 enum 固定为 11 个（其余状态复用现有 `ProjectType`、`Issue*`、`ResidualItemStatus` 等 enum），并在既有 `ArchiveManifestSourceType` 追加 `PROJECT_RETROSPECTIVE_VERSION`，不允许实施者自行补充异构 JSON 状态。
- [ ] Step 4: 创建唯一 APM-104 migration。先执行可重复的 `ALTER TYPE "ArchiveManifestSourceType" ADD VALUE IF NOT EXISTS 'PROJECT_RETROSPECTIVE_VERSION'`（该 enum 成员只供 ARCHIVE.SOURCE@2；本仓库支持 PostgreSQL 16，`IF NOT EXISTS` 和事务内 `ALTER TYPE ... ADD VALUE` 均受支持，Prisma migration 以单一事务执行并在重复 deploy 时保持成功）。旧 ProjectArchiveVersion 只回填 archiveSourceFormulaVersion=ARCHIVE.SOURCE@1、retrospectiveInputApplicability=NOT_APPLICABLE 和三个 NULL；绝不更新旧 snapshot/hash/items/integrity facts。
- [ ] Step 4a: migration 对每个既有对象只允许一个机器可读标记 `-- APM104_LEGACY_DDL <TABLE|TYPE|FUNCTION> <name>`，且 marker 紧邻的下一行必须是与 kind/name 精确匹配的唯一 DDL header：TABLE 对应 `ALTER TABLE [public.]"name"`、TYPE 对应 `ALTER TYPE [public.]"name"`、FUNCTION 对应 `CREATE OR REPLACE FUNCTION [public.]"name"`。每个 legacy table 的所有 column/constraint 动作合并进该 marker 绑定的一个 `ALTER TABLE` statement；marker 与语句之间不得插入空行、注释或第二个 marker。冻结的完整集合是 TABLE `project_template_snapshots, project_archive_versions, project_gate_definitions, project_gate_instances, gate_check_snapshots, gate_submissions, issue_histories`，TYPE `ArchiveManifestSourceType`，FUNCTION `validate_project_archive_version_mutation`；其余既有表只作为新 FK 的 REFERENCES 父表，新建 APM-104 表的 `ALTER TABLE` 永远不加 legacy marker。附录 B 的共享 parser 只解析 marker 绑定的下一条语句，逐条校验 kind/object 后再与 expected set 双向 exact equality，既不会扫描所有 `ALTER TABLE`，也不会把新表 DDL 误报成 legacy。
- [ ] Step 5: 条件创建 pg_trgm，只捕获 42501、58P01、0A000；只有扩展存在时动态创建 knowledge_entry_versions_search_trgm_idx。其它 SQLSTATE 必须失败。
- [ ] Step 6: 有 PostgreSQL 时执行 db:generate、db:validate、空库 deploy 和升级 test；迁移后 fixture 的旧值逐值相同，V1 adapter 重算匹配。
- [ ] Step 7: 提交 schema、唯一 migration、persistence tests、auth/audit vocabulary。

Migration capability branch is fixed to this SQL shape; the handler must not catch the outer table/index DDL:

```sql
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION
    WHEN SQLSTATE '42501' OR SQLSTATE '58P01' OR SQLSTATE '0A000' THEN
      RAISE NOTICE 'pg_trgm unavailable: %', SQLSTATE;
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX knowledge_entry_versions_search_trgm_idx ON knowledge_entry_versions USING gin (normalized_keywords_text gin_trgm_ops)';
  END IF;
END $$;
```

The migration also contains this exact idempotent enum extension before any new `PROJECT_RETROSPECTIVE_VERSION` manifest item is inserted:

```sql
ALTER TYPE "ArchiveManifestSourceType"
  ADD VALUE IF NOT EXISTS 'PROJECT_RETROSPECTIVE_VERSION';
```

`ArchiveManifestSourceType` is therefore an explicitly modified existing enum, not a newly-created enum. The APM-054 reader and hash payload remain byte-for-byte unchanged and never emit the new value; only the ARCHIVE.SOURCE@2 adapter may write `PROJECT_RETROSPECTIVE_VERSION`. Empty-database, APM-054 upgrade, and restricted-role replay all assert the value exists and that the legacy fixture values remain unchanged.

## Phase B - 归档与复盘

### Task 3: ArchiveSourceFormulaRegistry 与 retrospective input

**Files:**

- Create/Test: src/modules/archives/domain/archive-source-formula.ts, src/modules/archives/domain/archive-source-formula.test.ts
- Create/Test: src/modules/archives/application/archive-source-formula-registry.ts, src/modules/archives/application/archive-source-formula-registry.test.ts
- Create/Test: src/modules/archives/application/archive-source-reader-v2.ts, src/modules/archives/application/archive-source-reader-v2.test.ts
- Create/Test: src/modules/archives/application/retrospective-input-reader.ts, src/modules/archives/application/retrospective-input-reader.test.ts
- Modify/Test: src/modules/archives/application/archive-manifest-service.ts, src/modules/archives/application/archive-manifest-service.test.ts
- Modify/Test: src/modules/archives/application/archive-generation-handler.ts, src/modules/archives/application/archive-generation-handler.test.ts
- Modify: src/modules/archives/application/archive-service.ts, src/workers/archive-job-handlers.ts

- [ ] Step 1: RED 覆盖 unknown/missing formula default deny；V1 调用旧 reader/hash payload 并匹配 Task 1；V2 把 formula 写入新 hash context 并使用 CLOSURE.SELF_REFERENCE_EXCLUSION@1。
- [ ] Step 2: 运行 npm run test -- src/modules/archives/domain/archive-source-formula.test.ts src/modules/archives/application/archive-source-formula-registry.test.ts src/modules/archives/application/archive-source-reader-v2.test.ts src/modules/archives/application/retrospective-input-reader.test.ts。
- [ ] Step 3: 实现两个完全独立 adapter。V1 不把 formula 放入旧 snapshot/hash；V2 排除引用 Archive B/closure policy 的 G9 check/submission/approval、submission document reference、ProjectClosureRecord。
- [ ] Step 4: `RETROSPECTIVE.INPUT@1` 的规范化对象固定为 `{ formulaVersion, project:{id,code,name,type,status,mainControlStageCode}, deliveryUnits:[{id,code,type,status,version}], projectStages:[{id,code,status,version}], issues:[{id,category,severity,status,version,latestHistory:{id,sequence,snapshotChecksum}}], acceptance:[{type,batchId,status,version,summaryChecksum}], nonClosureGates:[{code,revision,latestSubmissionId,status,resultChecksum}], residuals:[{id,status,version}] }`；各数组按稳定 ID/sequence 排序，排除 retrospective/knowledge/G9/closure self facts；失败抛 `ARCHIVE_SOURCE_FACTS_UNAVAILABLE`，不能返回空数组。
- [ ] Step 5: archive generation/currentness/list service 按 archive 行冻结 formula dispatch；V1 历史读不变，APM-104 A/B 使用 V2。
- [ ] Step 6: GREEN 要求同源 V1/V2 可产生不同 hash；V2 不能验证 V1；G9/self facts 不使 B stale，非 G9 source change 必 stale。
- [ ] Step 7: 提交 archives formula layer。

The registry contract implemented in this task is exact:

```ts
export type ArchiveSourceFormulaAdapter = {
  readonly version: "ARCHIVE.SOURCE@1" | "ARCHIVE.SOURCE@2";
  read(input: { client: Prisma.TransactionClient; projectId: string }): Promise<ArchiveSourceFacts>;
  buildManifest(input: ArchiveSourceFacts): ArchiveManifestBuild;
};

export function getArchiveSourceFormulaAdapter(
  version: string | null | undefined
): ArchiveSourceFormulaAdapter;
```

`getArchiveSourceFormulaAdapter` throws `ARCHIVE_SOURCE_FORMULA_UNSUPPORTED` for null/unknown input; it never chooses V2 as a default.

### Task 4: ProjectRetrospective 核心、审核和 Archive B source

**Files:**

- Create/Test: src/modules/retrospectives/domain/project-retrospective.ts, src/modules/retrospectives/domain/project-retrospective.test.ts
- Create/Test: src/modules/retrospectives/application/project-retrospective-service.ts, src/modules/retrospectives/application/project-retrospective-service.test.ts
- Create/Test: src/modules/retrospectives/application/project-retrospective-query-service.ts, src/modules/retrospectives/application/project-retrospective-query-service.test.ts
- Create/Test: src/modules/retrospectives/application/project-retrospective-service.integration.test.ts
- Extend/Test (created in Task 3): src/modules/archives/application/archive-source-reader-v2.ts, src/modules/archives/application/archive-source-reader-v2.test.ts
- Extend/Test (created in Task 3): src/modules/archives/application/retrospective-input-reader.ts, src/modules/archives/application/retrospective-input-reader.test.ts

- [ ] Step 1: RED 覆盖七个必填内容组、Archive A exact source、delivery-unit/project membership、independent reviewer、DRAFT->IN_REVIEW->APPROVED/REJECTED、SUPERSEDED、CLOSED write denial。
- [ ] Step 2: 运行 npm run test -- src/modules/retrospectives/domain/project-retrospective.test.ts src/modules/retrospectives/application/project-retrospective-service.test.ts src/modules/retrospectives/application/project-retrospective-query-service.test.ts。
- [ ] Step 3: 每次保存创建新 immutable version；规范化内容固定为附录 A 的 `projectSnapshotJson`、六个内容 JSON、按 `(scopeType,deliveryUnitId,discipline,membershipId)` 排序的 contributions、按 `(roleCode,membershipId)` 排序的 participants，以及按 `(issueId,issueHistorySequence)` 排序的 issue sources；`contentChecksum=sha256(canonicalJson(...))`。客户端只传 IDs，服务器读取并冻结 exact snapshot/checksum；version、children、Audit 和 Outbox 同事务。
- [ ] Step 4: submit 和 independent review 锁定聚合，校验 expected version、成员/权限、idempotency；Audit/Outbox 同事务。创建新草稿后 currentVersionId != latestApprovedVersionId，G9 必须失败。
- [ ] Step 5: V2 reader 只在 currentVersionId == latestApprovedVersionId 且 APPROVED 时加入一个确切 PROJECT_RETROSPECTIVE_VERSION source；draft/rejected/superseded 不进入 B。
- [ ] Step 6: 聚焦和 PostgreSQL integration GREEN 证明 Archive A -> approve -> Archive B input watermark 相等、跨项目拒绝、rollback 无 audit/outbox。
- [ ] Step 7: 提交 retrospective core 和 V2 source changes。

The application surface is frozen before implementation:

```ts
createRetrospectiveVersion(input: {
  projectId: string;
  retrospectiveInputArchiveVersionId: string;
  expectedAggregateVersion: number | null;
  content: RetrospectiveContentInput;
  contributionInputs: RetrospectiveContributionInput[];
  participantMembershipIds: string[];
  issueHistoryIds: string[];
  actorId: string;
  idempotencyKey: string;
}): Promise<ProjectRetrospectiveVersionResult>;

submitRetrospectiveVersion(input: { projectId: string; versionId: string; expectedAggregateVersion: number; actorId: string; idempotencyKey: string }): Promise<ProjectRetrospectiveVersionResult>;
reviewRetrospectiveVersion(input: { projectId: string; versionId: string; decision: "APPROVED" | "REJECTED"; reason: string; expectedAggregateVersion: number; actorId: string; idempotencyKey: string }): Promise<ProjectRetrospectiveVersionResult>;
```

## Phase C - 策略、Gate 与关闭

### Task 5: 发布 V2 模板并物化 ProjectClosurePolicy

**Files:**

- Modify/Test: src/modules/configuration/domain/template-policy.ts, src/modules/configuration/domain/template-policy.test.ts
- Modify: src/modules/configuration/application/template-service.ts
- Modify/Test: src/modules/configuration/infrastructure/templates.integration.test.ts
- Modify: src/app/api/templates/[code]/versions/route.ts
- Modify/Test: src/modules/projects/application/create-project.ts, src/modules/projects/infrastructure/project-creation.integration.test.ts
- Modify/Test: src/modules/projects/application/project-structure.ts, src/modules/projects/infrastructure/project-structure.integration.test.ts
- Create/Test: src/modules/governance/domain/project-closure-policy.ts, src/modules/governance/domain/project-closure-policy.test.ts
- Create/Test: src/modules/governance/application/project-closure-policy-service.ts, src/modules/governance/application/project-closure-policy-service.test.ts
- Create/Test: src/modules/governance/infrastructure/project-closure-policy.integration.test.ts

- [ ] Step 1: validator RED 要求 closure-capable customer-delivery template 的 project G9 精确绑定 CLOSURE.ARCHIVE.G9@2 和 CLOSURE.RETROSPECTIVE.G9@1；旧 @1、缺失、重复返回 CLOSURE_POLICY_TEMPLATE_BINDINGS_INVALID。
- [ ] Step 2: 运行 `npm run test -- src/modules/configuration/domain/template-policy.test.ts src/modules/governance/domain/project-closure-policy.test.ts src/modules/governance/application/project-closure-policy-service.test.ts`，预期 validator/service 导入或 V2 binding 断言失败。
- [ ] Step 3: publishProjectTemplate 在 CONFIGURATION_WRITE 路径调用 validator。已发布旧模板只历史可读；用户必须发布新 component/template version，不能运行时改模板。
- [ ] Step 4: eligibility 固定：CUSTOMER_DELIVERY 且模板含 project G9/可走 closeProject 必须 V2；无 project G9 的辅助模板和 INTERNAL_RND 不物化 closure policy，close 命令拒绝。
- [ ] Step 4a: 由于 `createProjectBodySchema` 尚不含 `projectType`，模板发布时把“存在 project-scope G9”作为 closure-capable 的确定性信号；任意 closure-capable 模板发布都必须使用 V2 bindings。后续 `initializeProjectStructure` 若选择 `INTERNAL_RND` 且项目已经物化 closure policy，返回 `INTERNAL_RND_CLOSURE_POLICY_FORBIDDEN`；选择 `CUSTOMER_DELIVERY` 时，含 project G9 的模板快照必须已有 exact policy version。无 project G9 的辅助模板可创建项目，但 `closeProject` 始终返回 `CLOSURE_POLICY_VERSION_REQUIRED`。
- [ ] Step 5: `instantiateProjectGateDefinitions` 返回 `{ code, definitionId, instanceId? }[]`；`create-project.ts` 在同一事务中从 `code === "G9"` 精确选择 definition/instance，原子创建 initial policy version，冻结 `ProjectTemplateSnapshot.id`、sourceGateDefinitionId、两项 bindings、ARCHIVE.SOURCE@2 和 checksums；没有或重复 G9 立即回滚整个项目。
- [ ] Step 6: 存量未关闭项目 upgrade 追加新 G9 revision/instance 和 policy version；旧 definition/instance/snapshot/submission 不改写。覆盖 idempotency、stale version、concurrent one-active。
- [ ] Step 7: PostgreSQL integration 执行 V2 template publish -> create project -> exact policy/G9 materialization；旧模板 409 且无半成品项目。
- [ ] Step 8: 提交 configuration/project creation/policy changes。

Template validation test data must use the exact binding payload:

```ts
expect(() =>
  validateClosureTemplateBindings({
    scope: "PROJECT",
    code: "G9",
    checkerBindings: [
      { code: "CLOSURE.ARCHIVE.G9", version: 2 },
      { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
    ]
  })
).not.toThrow();
```

The same test replaces either version with the legacy/missing value and expects `CLOSURE_POLICY_TEMPLATE_BINDINGS_INVALID`.

### Task 6: G9@2 与 active/legacy Gate lifecycle

**Files:**

- Create/Test: src/modules/governance/domain/project-archive-gate-v2.ts, src/modules/governance/domain/project-archive-gate-v2.test.ts
- Create/Test: src/modules/governance/domain/project-retrospective-gate.ts, src/modules/governance/domain/project-retrospective-gate.test.ts
- Create/Test: src/modules/governance/application/closure-gate-facts-reader.ts, src/modules/governance/application/closure-gate-facts-reader.test.ts
- Modify/Test: src/modules/governance/domain/gate-checker-registry.ts, src/modules/governance/domain/gate-checker-registry.test.ts
- Modify/Test: src/modules/governance/application/gate-service.ts, src/modules/governance/application/gate-service.test.ts
- Modify/Test: src/modules/governance/application/gate-submission-service.ts, src/modules/governance/application/gate-submission-service.test.ts
- Modify/Test: src/modules/governance/application/project-gate-definition-service.ts, src/modules/governance/application/project-gate-definition-service.test.ts
- Modify/Test: src/modules/governance/contracts/gate-http.ts, src/modules/governance/contracts/gate-http.test.ts
- Modify: src/modules/platform-api/contracts/internal-routes.ts
- Modify/Test: src/modules/governance/infrastructure/gates.integration.test.ts
- Modify/Test: src/modules/projects/infrastructure/project-creation.integration.test.ts
- Modify: src/app/api/projects/[projectId]/gates/route.ts
- Modify: src/app/api/projects/[projectId]/gate-instances/route.ts
- Modify: src/app/api/projects/[projectId]/gate-instances/[instanceId]/checks/route.ts
- Modify: src/app/api/projects/[projectId]/gate-instances/[instanceId]/submissions/route.ts
- Modify: src/app/api/projects/[projectId]/gate-submissions/[submissionId]/approve/route.ts
- Modify: src/app/api/projects/[projectId]/gate-submissions/[submissionId]/resubmit/route.ts

- [ ] Step 1: checker RED 覆盖 Archive A/B input watermark、B manifest/source/current integrity、current/latest retrospective pointer、missing facts HARD_FAILED。
- [ ] Step 2: active/legacy RED：升级后旧 G9 可读但 create instance/run checks/submit/resubmit/approve 均 409；V2 可操作；listProjectGates 返回 active 和 legacy history，不能出现两个 executable G9。G9 checker 同时断言 Archive B `status=READY`、latest integrity `status=PASSED`；FAILED 或缺失检查均 HARD_FAILED，且测试不得发明第三种完整性检查状态。
- [ ] Step 2a: 冻结列表 DTO 为 `{ activeDefinitions, legacyDefinitions }`。非 G9 definitions 继续进入 `activeDefinitions`；G9 只有 `ProjectClosurePolicyVersion.sourceGateDefinitionId` 指向的 definition 进入 `activeDefinitions`，其它同项目 G9 revisions 全部进入 `legacyDefinitions`，每项返回 `executionState: "ACTIVE" | "LEGACY_HISTORY"` 和服务器计算的 `allowedActions`。客户端不得从 revision 最大值猜 active。
- [ ] Step 3: 更新所有 projectId_code lookup 为 projectId_code_revision；禁止任何 G9 unordered findFirst(projectId,code=G9)。
- [ ] Step 4: register CLOSURE.ARCHIVE.G9@2 和 CLOSURE.RETROSPECTIVE.G9@1；V1 checker 保持历史语义，不在内部 branch 成 V2。Archive checker @2 只有在 Archive B `ProjectArchiveVersion.status=READY` 且 latest `ArchiveIntegrityCheck.status=PASSED` 时才评估其余证据；FAILED/缺失检查或非 READY version 均 HARD_FAILED。
- [ ] Step 5: ProjectClosurePolicyVersion.sourceGateDefinitionId 是唯一 executable G9 authority；instance/snapshot/submission 冻结同一 policy ID/checksum/bindings/formula。legacy tuple 全 null，只读。
- [ ] Step 5a: `createGateInstance`, `runGateChecks`, `createSubmission`, `resubmitGateSubmission`, `recordGateApproval` 共用 `assertExecutableGateDefinition(client,{projectId,definitionId,instanceId?})`。对 G9，它必须锁定 exact policy version 并比对 sourceGateDefinitionId；对非 G9 保持现有行为。任何 G9 `findFirst` 必须同时限定 exact ID/revision/policy，不允许只按 `{projectId,code:"G9"}`。
- [ ] Step 6: gate-service、submission service 和 HTTP mapper 拒绝 legacy/stale/mismatch，返回 CLOSURE_POLICY_VERSION_REQUIRED、CLOSURE_POLICY_STALE 或 CLOSURE_POLICY_BINDING_MISMATCH；不泄漏 P2002/500。
- [ ] Step 7: 运行 `npm run test -- src/modules/governance/domain/project-archive-gate-v2.test.ts src/modules/governance/domain/project-retrospective-gate.test.ts src/modules/governance/application/closure-gate-facts-reader.test.ts src/modules/governance/application/gate-service.test.ts src/modules/governance/application/gate-submission-service.test.ts src/modules/governance/application/project-gate-definition-service.test.ts src/modules/governance/contracts/gate-http.test.ts src/modules/governance/infrastructure/gates.integration.test.ts`；预期全部 PASS 且旧 G9 409/V2 G9 可执行断言存在，提交 governance/Gate route changes。

The shared executable guard returns the frozen authority tuple:

```ts
assertExecutableGateDefinition(client, {
  projectId,
  definitionId,
  instanceId
}): Promise<{
  definitionId: string;
  closurePolicyVersionId: string | null;
  closurePolicyChecksum: string | null;
  archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2" | null;
}>;
```

For `code === "G9"`, all three nullable values must be non-null and match the active policy's exact source definition; for other gates they remain null and existing behavior continues.

### Task 7: Serializable close 与 ProjectClosureRecord

**Files:**

- Modify/Test: src/modules/projects/application/project-close-service.ts, src/modules/projects/application/project-close-service.test.ts
- Create/Test: src/modules/projects/application/project-close-service.integration.test.ts
- Modify/Test: src/modules/archives/contracts/archive-http.ts, src/modules/archives/contracts/archive-http.test.ts
- Modify: src/app/api/projects/[projectId]/close/route.ts
- Modify/Test: src/modules/projects/application/project-close-http.test.ts
- Modify: src/modules/archives/application/archive-service.ts

- [ ] Step 1: RED 覆盖 legacy approval、stale policy/formula/B、open residuals、current/latest mismatch、B 非 READY、latest integrity 非 PASSED、already closed idempotent replay、transaction rollback 和 concurrent close once；伪造 `closurePolicyVersionId` 和跨项目 `g9SubmissionId` 必须在 HTTP 与 service 层 409。
- [ ] Step 2: 运行 `npm run test -- src/modules/projects/application/project-close-service.test.ts src/modules/projects/application/project-close-service.integration.test.ts src/modules/projects/application/project-close-http.test.ts src/modules/archives/contracts/archive-http.test.ts`，预期现有 V1-only service 失败。
- [ ] Step 3: Serializable transaction 使用全系统关项写操作的 canonical lock order：Project → Archive B/A → retrospective aggregate/version → G9 instance/snapshot/submission → exact ClosurePolicy/Version → residuals → closure record。既有 Gate submission/resubmit/approve 已遵循 G9 → policy；Task 7 不重排 Task 6 Gate 写路径，也不使用 policy-before-G9。
- [ ] Step 3a: 事务仅对 Prisma P2034、PostgreSQL SQLSTATE 40001 或 40P01 做最多 3 次有限重试；耗尽统一返回 `CLOSURE_TRANSACTION_CONFLICT`/HTTP 409，其他错误原样失败，不吞错、不无限重试。并发 close 与 submit/approve 交错不得形成未处理死锁；重试耗尽不得写入 closure record、Audit 或 Outbox。
- [ ] Step 4: 只接受由 `g9SubmissionId` 解析出的 exact policy 的 G9@2 + retrospective@1 PASS，A/B formula=ARCHIVE.SOURCE@2，input watermarks equal，B full hashes/currentness match，B 达到 `ProjectArchiveVersion.status=READY` 且 latest `ArchiveIntegrityCheck.status=PASSED`，然后才允许 READY -> FINALIZED，`current==latest approved`，B contains exact retrospective。`ArchiveIntegrityCheckStatus` 仍只有 PASSED/FAILED，不新增 READY 状态。
- [ ] Step 5: 同一事务 finalize B、set project CLOSED/finalArchiveVersionId、insert one immutable ProjectClosureRecord、Audit 和 Outbox；conflict/rollback 不留下部分事实。
- [ ] Step 6: 真实 integration 顺序为 A -> approved retrospective -> B -> G9 run/submit/approve -> close；G9/closure facts 不使 B stale，非 G9 change 使 B stale。
- [ ] Step 7: 提交 close/archive HTTP changes。

Close input and error contract becomes:

```ts
type CloseProjectInput = {
  projectId: string;
  archiveVersionId: string;
  g9SubmissionId: string;
  expectedProjectVersion: number;
  actorId: string;
  operationId: string;
  client: Prisma.TransactionClient;
};
```

The HTTP body is exactly `{ archiveVersionId, g9SubmissionId, expectedProjectVersion, operationId }`; `projectId` comes from the route and `actorId` from the trusted authorization context. The public application command has the same fields plus server-injected `client` and `actorId`; it has no caller-controlled policy/formula/checksum field. In the serializable transaction, `g9SubmissionId` resolves `GateSubmission -> GateCheckSnapshot -> ProjectGateInstance -> exact ProjectClosurePolicyVersion`; that chain is the sole policy authority. The service locks and compares the submission/snapshot/instance frozen tuple (`closurePolicyVersionId`, `closurePolicyChecksum`, checker bindings, `archiveSourceFormulaVersion`) against the policy and the selected archive. Missing, cross-project, forged-policy, mismatched, or stale tuples return `CLOSURE_POLICY_VERSION_REQUIRED`, `CLOSURE_POLICY_BINDING_MISMATCH`, `CLOSURE_SUBMISSION_PROJECT_MISMATCH`, or `CLOSURE_POLICY_STALE`, each HTTP 409. HTTP and service regression tests pass a forged policy ID and a submission from another project and assert no close record, audit, or Outbox is written; there is no API parameter through which a client can choose a different policy.

## Phase D - API 与知识

### Task 8: Retrospective API/page-state 与可执行浏览器 fixture

**Files:**

- Create/Test: src/modules/retrospectives/contracts/project-retrospective-http.ts, src/modules/retrospectives/contracts/project-retrospective-http.test.ts
- Create/Test: src/modules/retrospectives/contracts/project-retrospective-page-state.ts, src/modules/retrospectives/contracts/project-retrospective-page-state.test.ts
- Create/Test: src/app/api/projects/[projectId]/retrospectives/route.ts, src/app/api/projects/[projectId]/retrospectives/route.test.ts
- Create/Test: src/app/api/projects/[projectId]/retrospectives/[versionId]/submit/route.ts, src/app/api/projects/[projectId]/retrospectives/[versionId]/submit/route.test.ts
- Create/Test: src/app/api/projects/[projectId]/retrospectives/[versionId]/reviews/route.ts, src/app/api/projects/[projectId]/retrospectives/[versionId]/reviews/route.test.ts
- Create/Test: src/modules/retrospectives/infrastructure/apm-104-browser-fixture-loader.ts, src/modules/retrospectives/infrastructure/apm-104-browser-fixture-loader.test.ts
- Create/Test: src/app/api/dev/apm-104/browser-fixture/route.ts, src/app/api/dev/apm-104/browser-fixture/route.test.ts
- Create/Test: src/app/api/dev/apm-104/identity/route.ts, src/app/api/dev/apm-104/identity/route.test.ts
- Modify/Test: src/lib/auth/request-identity.ts, src/lib/auth/request-identity.test.ts

- [ ] Step 1: strict DTO/page-state RED：no client checksum/snapshot；exact Archive A、content、participant/contribution/IssueHistory IDs、expected version；normal/loading/empty/error/denied/stale/conflict and allowedActions。
- [ ] Step 2: 路由 authenticate/guard/parse DTO/call service/map error；route 不写 Prisma。
- [ ] Step 3: loader 使用真实配置发布、project creation、archive、issue/residual 和 retrospective services，创建 disposable V2 project、Archive A、target project 和四个用户，不返回静态 page-state。由于 G9 run/submit/approve/close 已在 Task 6/7 实现，fixture 可返回其路由入口但不得预先把源项目关闭。
- [ ] Step 4: dev/test-only fixture and identity routes；production 返回 404。development/test 可使用一次性 apm-dev-user-id cookie；production 忽略 cookie 并保持 trusted header secret。
- [ ] Step 5: Task 8 的 GREEN 只要求 fixture provision 创建 V2 模板、源项目、Archive A、四个用户和目标项目，并返回后续流程所需 exact IDs；它不调用尚未实现的 knowledge service。Task 11 在 Task 9/10 已完成后使用这些 IDs 真实执行 create -> submit -> review -> B -> G9 -> close -> knowledge publish -> reuse/correction。cleanup 只 drop named disposable DB 或 docker volume。
- [ ] Step 6: 运行 `npm run test -- src/modules/retrospectives/contracts/project-retrospective-http.test.ts src/modules/retrospectives/contracts/project-retrospective-page-state.test.ts src/app/api/projects/[projectId]/retrospectives/route.test.ts src/app/api/projects/[projectId]/retrospectives/[versionId]/submit/route.test.ts src/app/api/projects/[projectId]/retrospectives/[versionId]/reviews/route.test.ts src/modules/retrospectives/infrastructure/apm-104-browser-fixture-loader.test.ts src/app/api/dev/apm-104/browser-fixture/route.test.ts src/app/api/dev/apm-104/identity/route.test.ts src/lib/auth/request-identity.test.ts`；预期 DTO、权限、fixture 和 production 404 全部 PASS 后提交。

The page-state builder returns only server-computed actions:

```ts
type ProjectRetrospectivePageState = {
  status: "NORMAL" | "EMPTY" | "DENIED" | "STALE";
  archiveA: ArchiveReferenceDto | null;
  currentVersion: RetrospectiveVersionDto | null;
  latestApprovedVersion: RetrospectiveVersionDto | null;
  archiveB: ArchiveReferenceDto | null;
  closurePolicy: ClosurePolicyDto | null;
  allowedActions: Array<
    "CREATE" | "SUBMIT" | "REVIEW" | "GENERATE_ARCHIVE_B" | "RUN_G9" | "CLOSE_PROJECT"
  >;
};
```

### Task 9: Knowledge domain/search/reuse

**Files:**

- Create/Test: src/modules/knowledge/domain/knowledge-policy.ts, src/modules/knowledge/domain/knowledge-policy.test.ts
- Create/Test: src/modules/knowledge/application/knowledge-entry-service.ts, src/modules/knowledge/application/knowledge-entry-service.test.ts
- Create/Test: src/modules/knowledge/application/knowledge-search-service.ts, src/modules/knowledge/application/knowledge-search-service.test.ts
- Create/Test: src/modules/knowledge/application/knowledge-reuse-service.ts, src/modules/knowledge/application/knowledge-reuse-service.test.ts
- Create/Test: src/modules/knowledge/application/knowledge-search-capability.ts, src/modules/knowledge/application/knowledge-search-capability.test.ts
- Create/Test: src/modules/knowledge/infrastructure/knowledge-search-capability.integration.test.ts
- Create: src/modules/knowledge/infrastructure/knowledge-repository.ts
- Modify: src/lib/auth/permissions.ts, src/lib/auth/authorize.ts, src/modules/audit/domain/vocabulary.ts

- [ ] Step 1: RED 覆盖 source project CLOSED/final Archive A/Archive B/exact approved retrospective/IssueHistory、IP/sanitization、state transitions、source privacy、historical CLOSED without approved retrospective rejection；PostgreSQL persistence 直接插入 Archive A/B/retrospective/IssueHistory 不同 sourceProject 的来源行、KnowledgeEntryReview(entry A + version B) 和 KnowledgeReuseRecord(entry A + version B)，均必须由 composite FK 拒绝。
- [ ] Step 2: 实现 immutable versions/sources/reviews，server computes normalizedKeywordsText/contentChecksum；source read 要求 global permission 和 source project read；不复制二进制证据。
- [ ] Step 3: capability probe 只有 extension+GIN index 都存在时 TRIGRAM；probe error default deny。无扩展 bounded ILIKE：query<=64 Unicode、page<=20、window<=100、stable publishedAt/id order，返回 SEARCH_DEGRADED。
- [ ] Step 4: confirm reuse 只在人工确认时创建 target project+knowledge version 唯一 record；correction append-only；search/click 不创建。
- [ ] Step 5: 运行 `npm run test -- src/modules/knowledge/domain/knowledge-policy.test.ts src/modules/knowledge/application/knowledge-entry-service.test.ts src/modules/knowledge/application/knowledge-search-service.test.ts src/modules/knowledge/application/knowledge-reuse-service.test.ts src/modules/knowledge/application/knowledge-search-capability.test.ts src/modules/knowledge/infrastructure/knowledge-search-capability.integration.test.ts`；预期来源权限、状态、脱敏、TRIGRAM/DEGRADED 和人工复用全部 PASS 后提交 knowledge domain。

Search capability and result metadata are fixed:

```ts
type KnowledgeSearchCapability = "TRIGRAM" | "DEGRADED";
type KnowledgeSearchResult = {
  capability: KnowledgeSearchCapability;
  warningCode: "SEARCH_DEGRADED" | null;
  items: PublicKnowledgeVersionDto[];
  nextCursor: string | null;
};
```

Capability probe errors throw `KNOWLEDGE_SEARCH_CAPABILITY_UNAVAILABLE`; only a confirmed absence of extension/index selects `DEGRADED`.

### Task 10: Knowledge API/page-state

**Files:**

- Create/Test: src/modules/knowledge/contracts/knowledge-http.ts, src/modules/knowledge/contracts/knowledge-http.test.ts
- Create/Test: src/modules/knowledge/contracts/knowledge-page-state.ts, src/modules/knowledge/contracts/knowledge-page-state.test.ts
- Create/Test: src/app/api/knowledge/route.ts, src/app/api/knowledge/route.test.ts
- Create/Test: src/app/api/knowledge/[entryId]/versions/route.ts, src/app/api/knowledge/[entryId]/versions/route.test.ts
- Create/Test: src/app/api/knowledge/[entryId]/versions/[versionId]/submit/route.ts, src/app/api/knowledge/[entryId]/versions/[versionId]/submit/route.test.ts
- Create/Test: src/app/api/knowledge/[entryId]/versions/[versionId]/reviews/route.ts, src/app/api/knowledge/[entryId]/versions/[versionId]/reviews/route.test.ts
- Create/Test: src/app/api/knowledge/[entryId]/revoke/route.ts, src/app/api/knowledge/[entryId]/revoke/route.test.ts
- Create/Test: src/app/api/projects/[projectId]/knowledge-reuse/route.ts, src/app/api/projects/[projectId]/knowledge-reuse/route.test.ts
- Create/Test: src/app/api/projects/[projectId]/knowledge-reuse/[reuseId]/corrections/route.ts, src/app/api/projects/[projectId]/knowledge-reuse/[reuseId]/corrections/route.test.ts

- [ ] Step 1: strict DTO RED：bounded search filters；sanitized create data + exact source IDs；review/revoke/reuse/correction expectedVersion/reason/idempotency。覆盖 400/403/404 IDOR/409。
- [ ] Step 2: 实现薄 route，global source create/review 同时检查 global permission 和 source project read；public search DTO 不包含 source project/customer/issue/file/archive identifiers。
- [ ] Step 3: route/service 409 和 IDEMPOTENCY_KEY_REUSED 原样映射；route 不直接写 Prisma。
- [ ] Step 4: 运行 `npm run test -- src/modules/knowledge/contracts/knowledge-http.test.ts src/modules/knowledge/contracts/knowledge-page-state.test.ts src/app/api/knowledge/route.test.ts src/app/api/knowledge/[entryId]/versions/route.test.ts src/app/api/knowledge/[entryId]/versions/[versionId]/submit/route.test.ts src/app/api/knowledge/[entryId]/versions/[versionId]/reviews/route.test.ts src/app/api/knowledge/[entryId]/revoke/route.test.ts src/app/api/projects/[projectId]/knowledge-reuse/route.test.ts src/app/api/projects/[projectId]/knowledge-reuse/[reuseId]/corrections/route.test.ts`；预期每个路由只做 DTO/授权/服务映射，400/403/404/409 断言全部 PASS 后提交。

The public search item deliberately excludes all source identifiers:

```ts
type PublicKnowledgeVersionDto = {
  entryCode: string;
  version: number;
  title: string;
  sanitizedSummary: string;
  experienceType: string;
  discipline: string;
  keywords: string[];
  applicableProjectTypes: string[];
  applicableStageCodes: string[];
  status: "PUBLISHED" | "SUPERSEDED" | "REVOKED";
};
```

## Phase E - UI 与发布验收

### Task 11: Project governance/knowledge UI 与浏览器验收

**Files:**

- Create: src/app/projects/[projectId]/governance/page.tsx
- Create: src/app/projects/[projectId]/governance/retrospective-page-client.tsx
- Create/Test: src/app/projects/[projectId]/governance/retrospective-page-client.test.ts
- Create: src/app/knowledge/page.tsx
- Create: src/app/knowledge/knowledge-page-client.tsx
- Create/Test: src/app/knowledge/knowledge-page-client.test.ts
- Modify/Test: src/modules/projects/contracts/project-navigation.ts, src/modules/projects/contracts/project-navigation.test.ts, src/app/projects/[projectId]/project-navigation-client.tsx, src/app/projects/[projectId]/project-navigation-client.test.ts
- Modify: src/app/globals.css

- [ ] Step 1: UI RED 覆盖 normal/loading/empty/error/denied/stale/409、allowedActions、A/B watermarks、current/latest mismatch、CLOSED no-write、TRIGRAM/DEGRADED、privacy、reuse/correction、focus。
- [ ] Step 2: 启用现有“审批与记录”入口；页面只消费 Task 8/10 DTO，命令后刷新真实 state，不从 fixture query 合成成功事实。
- [ ] Step 3: responsive CSS 使用 min-width:0、overflow-wrap:anywhere、visible focus、mobile single column，不用页面级 overflow-x 隐藏问题。
- [ ] Step 4: 启动 disposable PostgreSQL、migrate、npm run dev；POST /api/dev/apm-104/browser-fixture，切换四个身份，真实执行 create->submit->review->B->G9->close->knowledge publish->reuse->correction。
- [ ] Step 5: 在 1440x900 和 390x844 验收各状态、键盘、scrollWidth<=innerWidth、Console/Network 无未处理异常/404/敏感字段。production fixture route 必须 404。
- [ ] Step 6: 运行 `npm run test -- src/app/projects/[projectId]/governance/retrospective-page-client.test.ts src/app/knowledge/knowledge-page-client.test.ts src/modules/projects/contracts/project-navigation.test.ts src/app/projects/[projectId]/project-navigation-client.test.ts`；预期状态矩阵、allowedActions、焦点和导航断言全部 PASS 后提交；实现时测试文件必须与对应 `.tsx` 组件在本任务同一 RED/GREEN 批次创建。

Browser acceptance uses these executable assertions after every identity switch:

```ts
expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
  true
);
expect(page.locator('[data-state="stale"]')).toContainText(/已过期|重新生成/);
expect(page.locator("button:focus-visible")).toBeVisible();
```

## Task 11 Collector Recovery（2026-08-15）

Task 11 初始 RED 严格按已批准的 `.test.tsx` 路径创建，但 `vitest.config.ts` 固定只收集 `src/**/*.test.ts`，命令退出 1 且报告 `No test files found`；这证明的是收集器冲突，不能作为组件尚不存在的有效 RED。经 APM-规划裁决，两个测试不使用 JSX，因此改为仓库既有约定的 `.test.ts`，同步修订 Task 11 文件清单和聚焦命令，且不修改全局 Vitest 配置。恢复后的第一步必须重新运行聚焦命令，确认失败原因是两个尚不存在的生产组件；仅在这一有效 RED 后开始本 Task 的最小 UI 实现。若以后确实需要 JSX 测试，必须先单独获得配置范围授权。

## Task 11 Contract Recovery（2026-08-15）

Task 8 的 `findCurrentV2Archive` / `findReadyApplicableV2Archive` 已在服务端选择 V2、READY、APPLICABLE、完整性 PASSED 且在需要时重算当前 manifest 的精确归档候选，但 `archiveView()` 先前只保留 `{ id, status }`。Task 11 不能在 Route 或客户端重算、补造或推导 `manifestChecksum`、`sourceWatermark`、`retrospectiveInputWatermark`，故经 APM-规划批准扩展此一服务端 DTO：仅对已经通过原有候选校验的 Archive A/B 透传这三项事实；候选不存在或不可用仍返回 `null`，不泄露 manifest items、源对象或内部关联。RED 断言候选字段最初缺失，GREEN 后 query、page-state 与 GET Route 测试确认其精确透传。Route 继续只把 query facts 送入 page-state，不查询 Prisma、不重新选择归档。此 Recovery 还精确恢复 Next 自动修改的 `next-env.d.ts` 为基线 `./.next/types/routes.d.ts`，提交前该文件不得有 diff。

### Task 12: Database replay、受限 pg_trgm CI 和最终门禁

**Files:**

- Modify: .github/workflows/ci.yml
- Create: .github/scripts/apm-104-restricted-pg-trgm-replay.sh
- Create/Test: .github/scripts/apm-104-restricted-pg-trgm-replay.test.sh
- Create: .github/scripts/apm-104-legacy-ddl-markers.awk
- Modify: README.md
- Extend/Test (created in Task 2): src/modules/archives/infrastructure/apm-054-to-apm-104-upgrade.integration.test.ts
- Extend/Test (created in Task 7): src/modules/projects/application/project-close-service.integration.test.ts
- Extend/Test (created in Task 4): src/modules/retrospectives/application/project-retrospective-service.integration.test.ts
- Create/Test: src/modules/knowledge/application/knowledge-entry-service.integration.test.ts
- Create/Test: src/modules/knowledge/application/knowledge-reuse-service.integration.test.ts
- Extend/Test (created in Task 9): src/modules/knowledge/infrastructure/knowledge-search-capability.integration.test.ts

- [ ] Step 1: workflow inspection RED 要求 empty-db、normal pg_trgm、APM-054->104 replay、restricted-role no-extension 四个 named steps；创建 `.github/scripts/apm-104-restricted-pg-trgm-replay.test.sh`，先运行 `bash -n .github/scripts/apm-104-restricted-pg-trgm-replay.sh` 与 `bash -n .github/scripts/apm-104-restricted-pg-trgm-replay.test.sh` 并因文件不存在失败，再用 shell fixture wrappers 断言唯一命名、显式 host/port/admin、trap cleanup、unknown-SQLSTATE 状态捕获和 marker parser 正负例。
- [ ] Step 2: 正常 owner 路径断言 extension、GIN index、TRIGRAM；空库完整 migrate；升级路径保存/比较 legacy fixture。
- [ ] Step 3: 创建附录 B 的 exact script 和共享 `.github/scripts/apm-104-legacy-ddl-markers.awk`，依次运行 `bash -n .github/scripts/apm-104-restricted-pg-trgm-replay.sh`、`bash -n .github/scripts/apm-104-restricted-pg-trgm-replay.test.sh`、`bash .github/scripts/apm-104-restricted-pg-trgm-replay.test.sh`；restricted role 真实路径只部署 APM-104 migration，断言 migration success、业务表/约束/新增 enum 值存在、extension/index 不存在、DEGRADED、bounded ILIKE 返回数据。当前 Windows 开发机没有 Bash 时这三个 Bash gate 明确记录为 local SKIPPED，不能写成通过；GitHub CI 必须实际执行并通过，不能跳过。
- [ ] Step 4: 单独 psql DO block raise XX000，命令必须非零，证明 unexpected SQLSTATE 不被捕获；不能把该块放入 migration。
- [ ] Step 5: README 记录 V2 template 发布前置、fixture 用户/命令/清理、迁移 replay、search degraded 边界。
- [ ] Step 6: 依次运行 db:generate、format:check、lint、typecheck、test、db:validate、build、npm audit --audit-level=high、git diff --check、git status -sb。
- [ ] Step 7: PostgreSQL unavailable 时 schema validation 可记录，但 empty/upgrade/integration 明确 skipped，不能声称通过；Windows 本地无 Bash 时两个 `bash -n` 和 shell contract test 也明确记录 SKIPPED，只有 Linux CI 的实际 exit 0 才能作为 Bash gate 通过证据。
- [ ] Step 8: 未来另获发布授权才 commit/push/create Draft PR/wait CI/update progress tracker；不 merge、不启动其他 package。

## 附录 A - 完整持久化契约

### A.1 Enums

| Prisma enum                     | Exact members / database values                                        |
| ------------------------------- | ---------------------------------------------------------------------- |
| ArchiveSourceFormulaVersion     | `V1 @map("ARCHIVE.SOURCE@1")`, `V2 @map("ARCHIVE.SOURCE@2")`           |
| RetrospectiveInputApplicability | `APPLICABLE`, `NOT_APPLICABLE`                                         |
| RetrospectiveScopeType          | `PROJECT`, `DELIVERY_UNIT`                                             |
| ProjectRetrospectiveStatus      | `DRAFT`, `IN_REVIEW`, `APPROVED`, `REJECTED`, `SUPERSEDED`             |
| RetrospectiveReviewDecision     | `APPROVED`, `REJECTED`                                                 |
| ClosurePolicyStatus             | `ACTIVE`, `SUPERSEDED`                                                 |
| ClosurePolicyVersionStatus      | `DRAFT`, `ACTIVE`, `SUPERSEDED`                                        |
| KnowledgeEntryStatus            | `ACTIVE`, `REVOKED`                                                    |
| KnowledgeEntryVersionStatus     | `DRAFT`, `IN_REVIEW`, `PUBLISHED`, `REJECTED`, `SUPERSEDED`, `REVOKED` |
| KnowledgeReviewDecision         | `PUBLISH`, `REJECT`                                                    |
| KnowledgeReuseCorrectionType    | `TEXT_CORRECTION`, `USAGE_WITHDRAWN`, `SCOPE_CORRECTION`               |

The migration creates exactly these eleven new enum types, with the shown database values, and explicitly appends one member to the existing `ArchiveManifestSourceType`: `PROJECT_RETROSPECTIVE_VERSION`. `ProjectType`, `IssueCategory`, `IssueSeverity`, `IssueStatus`, `ResidualItemStatus`, and `ProjectRole` are reused where the approved design calls for them; `GateScope` is not reused for retrospective scope because it also permits `MODULE`. `ArchiveSourceFormulaVersion` is the only formula column type; legacy APM-054 rows are labelled V1 by metadata-only backfill. This enum alteration is the only intentional change to an existing enum. It does not alter any APM-054 row, snapshot, manifest item, source checksum, or integrity fact. The new member is emitted only by the ARCHIVE.SOURCE@2 adapter; the ARCHIVE.SOURCE@1 reader and hash payload remain byte-for-byte compatible.

### A.2 Existing model modifications

The following are exact additions or replacements in the existing models. Every field uses the stated Prisma type and `@map`; every relation name is fixed and must be mirrored on the reverse side.

| Model                     | Fields and constraints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Relations / reverse relation names                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProjectArchiveVersion`   | `archiveSourceFormulaVersion ArchiveSourceFormulaVersion @map("archive_source_formula_version")`; `retrospectiveInputApplicability RetrospectiveInputApplicability @map("retrospective_input_applicability")`; `retrospectiveInputWatermarkVersion String? @map("retrospective_input_watermark_version")`; `retrospectiveInputSnapshotJson Json? @map("retrospective_input_snapshot_json")`; `retrospectiveInputWatermark String? @map("retrospective_input_watermark")`. Existing `snapshotJson`, `manifestChecksum`, `sourceWatermark`, `manifestItems`, and integrity facts are untouched by the legacy backfill. Add `@@unique([id,projectId])` if not already present and check: APPLICABLE requires non-null version/snapshot/64 lowercase hex watermark; NOT_APPLICABLE requires all three null. | Add `retrospectiveInputVersions ProjectRetrospectiveVersion[] @relation("RetrospectiveInputArchive")`, `knowledgeSourcesAsArchiveA KnowledgeEntrySource[] @relation("KnowledgeSourceArchiveA")`, and `knowledgeSourcesAsArchiveB KnowledgeEntrySource[] @relation("KnowledgeSourceArchiveB")`; existing archive/project/manifest/integrity relations unchanged. |
| `ProjectGateDefinition`   | `revision Int @default(1)`; replace `@@unique([projectId, code])` with `@@unique([projectId, code, revision])`; add `closurePolicySources ProjectClosurePolicyVersion[] @relation("ClosurePolicySourceGateDefinition")`. `revision`, all definition JSON/checksum fields, and source IDs are immutable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Existing project/template/stage/instances relations unchanged; reverse policy relation name is exact.                                                                                                                                                                                                                                                           |
| `ProjectGateInstance`     | Add `closurePolicyVersionId String? @map("closure_policy_version_id")`, `archiveSourceFormulaVersion ArchiveSourceFormulaVersion? @map("archive_source_formula_version")`, `closurePolicyChecksum String? @map("closure_policy_checksum")`; add composite FK `(closurePolicyVersionId, projectId)` when non-null.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `closurePolicyVersion ProjectClosurePolicyVersion? @relation("ClosurePolicyGateInstances", fields: [closurePolicyVersionId, projectId], references: [id, projectId], onDelete: Restrict)`. Existing gate relations unchanged.                                                                                                                                   |
| `GateCheckSnapshot`       | Add the same three nullable policy tuple fields and composite FK; tuple is all-null for legacy records or all-non-null for V2 records.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `closurePolicyVersion ProjectClosurePolicyVersion? @relation("ClosurePolicyGateSnapshots", fields: [closurePolicyVersionId, projectId], references: [id, projectId], onDelete: Restrict)`.                                                                                                                                                                      |
| `GateSubmission`          | Add the same three nullable policy tuple fields and composite FK; submission cannot be created for a legacy G9 instance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `closurePolicyVersion ProjectClosurePolicyVersion? @relation("ClosurePolicyGateSubmissions", fields: [closurePolicyVersionId, projectId], references: [id, projectId], onDelete: Restrict)`.                                                                                                                                                                    |
| `Project`                 | Add nullable one-to-one `retrospective ProjectRetrospective? @relation("ProjectRetrospectiveProject")`; `closurePolicy ProjectClosurePolicy? @relation("ProjectClosurePolicyProject")`; `closureRecord ProjectClosureRecord? @relation("ProjectClosureRecordProject")`; and one-to-many `retrospectiveVersions`, `retrospectiveReviews`, `closurePolicyVersions`, `knowledgeVersions @relation("KnowledgeVersionSourceProject")`, `knowledgeReviews @relation("KnowledgeReviewSourceProject")`, `knowledgeReuseRecords @relation("KnowledgeReuseTargetProject")`, `knowledgeReuseCorrections @relation("KnowledgeReuseCorrectionProject")`, `knowledgeSources @relation("KnowledgeSourceProject")`. No existing project status or closure fields are removed.                                           | All added relations carry the exact names shown; `Project.id` is the referenced source project key, while every fact-owned relation that has its own project column uses a composite ID/project FK.                                                                                                                                                             |
| `User`                    | Add reverse collections `retrospectivesCreated`, `retrospectivesUpdated`, `retrospectiveVersionsCreated`, `retrospectiveVersionsSubmitted`, `retrospectiveReviews`; `closurePoliciesCreated`, `closurePoliciesUpdated`, `closurePolicyVersionsCreated`, `closureRecordsClosed`; `knowledgeEntriesCreated`, `knowledgeEntriesUpdated`, `knowledgeVersionsCreated`, `knowledgeVersionsSubmitted`, `knowledgeVersionsPublished`, `knowledgeReviews`; `knowledgeReuseConfirmed`, `knowledgeCorrectionsCreated`.                                                                                                                                                                                                                                                                                             | Each collection is tied to the named relation in A.3; no generic unnamed relation is permitted.                                                                                                                                                                                                                                                                 |
| `IssueHistory`            | Add `@@unique([id, projectId])` and reverse collections `retrospectiveSources ProjectRetrospectiveIssueSource[] @relation("RetrospectiveIssueHistorySource")`, `knowledgeSources KnowledgeEntrySource[] @relation("KnowledgeIssueHistorySource")`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Source rows use `(issueHistoryId, projectId)` composite references.                                                                                                                                                                                                                                                                                             |
| `ProjectMember`           | Add `retrospectiveContributions ProjectRetrospectiveContribution[] @relation("RetrospectiveContributionMember")`, `retrospectiveParticipants ProjectRetrospectiveParticipant[] @relation("RetrospectiveParticipantMember")`, `knowledgeReuseConfirmations KnowledgeReuseRecord[] @relation("KnowledgeReuseConfirmedBy")`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Membership IDs in new rows are always checked against the same projectId.                                                                                                                                                                                                                                                                                       |
| `ProjectTemplateSnapshot` | Add `@@unique([id, projectId])`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Add `closurePolicyVersions ProjectClosurePolicyVersion[] @relation("ClosurePolicySourceTemplateSnapshot")`; the policy stores the exact materialized snapshot, not a mutable template pointer.                                                                                                                                                                  |
| `Issue`                   | No scalar changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Add `retrospectiveSources ProjectRetrospectiveIssueSource[] @relation("RetrospectiveIssueSource")` and `knowledgeSources KnowledgeEntrySource[] @relation("KnowledgeIssueSource")`.                                                                                                                                                                             |
| `DeliveryUnit`            | No scalar changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Add `retrospectiveContributions ProjectRetrospectiveContribution[] @relation("RetrospectiveContributionDeliveryUnit")` and `knowledgeReuseRecords KnowledgeReuseRecord[] @relation("KnowledgeReuseDeliveryUnit")`.                                                                                                                                              |
| `ProjectArchive`          | No changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | No direct closure-record relation; the exact Archive B relation is on `ProjectArchiveVersion`.                                                                                                                                                                                                                                                                  |

### A.3 New models - all fields

Exactly 15 new models are added. Every scalar below is required to carry the shown Prisma type and snake-case `@map`; every model has `id String @id @default(cuid())`, `createdAt DateTime @default(now()) @map("created_at")`, `onDelete: Restrict`, and `@@map` equal to the table name shown. Models whose project key is named `projectId` use `@@unique([id, projectId])`; reuse models whose key is `targetProjectId` use `@@unique([id, targetProjectId])`; global knowledge models do not invent a project key.

Field mapping is deterministic and not left to implementation choice: `id` is the primary key and has no `@map`; every other camelCase scalar uses the exact lower-snake `@map` spelling (`projectId -> project_id`, `versionNo -> version_no`, `createdById -> created_by_id`, `updatedById -> updated_by_id`, `currentPublishedVersionId -> current_published_version_id`, and so on). `Json` fields use `Json @map(...)`, dates use `DateTime @map(...)`, and nullable fields retain `?` in both schema and migration.

| Model / table                                                              | Complete scalar contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Required relations, unique/index/check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProjectRetrospective` / `project_retrospectives`                          | `id`; `projectId String @unique @map("project_id")`; `currentVersionId String? @unique @map("current_version_id")`; `latestApprovedVersionId String? @unique @map("latest_approved_version_id")`; `version Int @default(1)`; `createdById String @map("created_by_id")`; `updatedById String @map("updated_by_id")`; `createdAt`; `updatedAt DateTime @updatedAt @map("updated_at")`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `project Project @relation("ProjectRetrospectiveProject", fields:[projectId], references:[id], onDelete:Restrict)`; `currentVersion ProjectRetrospectiveVersion? @relation("ProjectRetrospectiveCurrentVersion", fields:[currentVersionId,projectId], references:[id,projectId], onDelete:Restrict)`; `latestApprovedVersion ProjectRetrospectiveVersion? @relation("ProjectRetrospectiveLatestApprovedVersion", fields:[latestApprovedVersionId,projectId], references:[id,projectId], onDelete:Restrict)`; `versions ProjectRetrospectiveVersion[] @relation("ProjectRetrospectiveVersions")`; `reviews ProjectRetrospectiveReview[] @relation("ProjectRetrospectiveReviews")`; named User relations `createdBy`, `updatedBy`. `@@unique([id, projectId])`; pointer trigger permits only the five pointer/audit columns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ProjectRetrospectiveVersion` / `project_retrospective_versions`           | `id`; `projectId String @map("project_id")`; `retrospectiveId String @map("retrospective_id")`; `versionNo Int @map("version_no")`; `supersedesVersionId String? @map("supersedes_version_id")`; `status ProjectRetrospectiveStatus`; `retrospectiveInputArchiveVersionId String @map("retrospective_input_archive_version_id")`; `retrospectiveInputManifestChecksum String @map("retrospective_input_manifest_checksum")`; `retrospectiveInputSourceWatermark String @map("retrospective_input_source_watermark")`; `retrospectiveInputWatermarkVersion String @map("retrospective_input_watermark_version")`; `retrospectiveInputWatermark String @map("retrospective_input_watermark")`; `projectSnapshotJson Json @map("project_snapshot_json")`; `deliverySummaryJson Json @map("delivery_summary_json")`; `successfulPracticesJson Json @map("successful_practices_json")`; `shortcomingsJson Json @map("shortcomings_json")`; `improvementsJson Json @map("improvements_json")`; `knowledgeDispositionJson Json @map("knowledge_disposition_json")`; `ipDeclarationJson Json @map("ip_declaration_json")`; `contentChecksum String @map("content_checksum")`; `submittedById String? @map("submitted_by_id")`; `submittedAt DateTime? @map("submitted_at")`; `createdById String @map("created_by_id")`; `createdAt`.                                                                                                                                                                                                                                       | `retrospective ProjectRetrospective @relation("ProjectRetrospectiveVersions", fields:[retrospectiveId,projectId], references:[id,projectId], onDelete:Restrict)`; `currentFor ProjectRetrospective? @relation("ProjectRetrospectiveCurrentVersion")`; `latestApprovedFor ProjectRetrospective? @relation("ProjectRetrospectiveLatestApprovedVersion")`; `supersedes ProjectRetrospectiveVersion? @relation("RetrospectiveVersionSupersedes", fields:[supersedesVersionId,projectId], references:[id,projectId], onDelete:Restrict)`; `supersededVersions ProjectRetrospectiveVersion[] @relation("RetrospectiveVersionSupersedes")`; `contributions ProjectRetrospectiveContribution[] @relation("RetrospectiveVersionContributions")`; `participants ProjectRetrospectiveParticipant[] @relation("RetrospectiveVersionParticipants")`; `issueSources ProjectRetrospectiveIssueSource[] @relation("RetrospectiveVersionIssueSources")`; `reviews ProjectRetrospectiveReview[] @relation("RetrospectiveVersionReviews")`; User `createdBy/submittedBy`; Archive `retrospectiveInputArchiveVersion`. `@@unique([retrospectiveId, versionNo])`, `@@unique([id, projectId])`, `@@index([projectId,status,createdAt])`; content immutable, with only the state transitions in A.4 allowed.                                                                               |
| `ProjectRetrospectiveContribution` / `project_retrospective_contributions` | `id`; `projectId String @map("project_id")`; `retrospectiveVersionId String @map("retrospective_version_id")`; `scopeType RetrospectiveScopeType @map("scope_type")`; `deliveryUnitId String? @map("delivery_unit_id")`; `discipline String`; `contributorMembershipId String @map("contributor_membership_id")`; `factText String @map("fact_text")`; `impactText String @map("impact_text")`; `reusable Boolean`; `required Boolean`; `createdAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `retrospectiveVersion ProjectRetrospectiveVersion @relation("RetrospectiveVersionContributions", fields:[retrospectiveVersionId,projectId], references:[id,projectId], onDelete:Restrict)`; `deliveryUnit DeliveryUnit? @relation("RetrospectiveContributionDeliveryUnit", fields:[deliveryUnitId,projectId], references:[id,projectId], onDelete:Restrict)`; `contributorMembership ProjectMember @relation("RetrospectiveContributionMember", fields:[contributorMembershipId,projectId], references:[id,projectId], onDelete:Restrict)`; `@@unique([id,projectId])`; `@@index([projectId,retrospectiveVersionId])`; CHECK `(scope_type='PROJECT' AND delivery_unit_id IS NULL) OR (scope_type='DELIVERY_UNIT' AND delivery_unit_id IS NOT NULL)`; immutable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ProjectRetrospectiveParticipant` / `project_retrospective_participants`   | `id`; `projectId String @map("project_id")`; `retrospectiveVersionId String @map("retrospective_version_id")`; `membershipId String @map("membership_id")`; `roleCode String @map("role_code")`; `responsibilityText String @map("responsibility_text")`; `createdAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `retrospectiveVersion ProjectRetrospectiveVersion @relation("RetrospectiveVersionParticipants", fields:[retrospectiveVersionId,projectId], references:[id,projectId], onDelete:Restrict)`; `membership ProjectMember @relation("RetrospectiveParticipantMember", fields:[membershipId,projectId], references:[id,projectId], onDelete:Restrict)`; `@@unique([retrospectiveVersionId,membershipId,roleCode])`, `@@unique([id,projectId])`; immutable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ProjectRetrospectiveIssueSource` / `project_retrospective_issue_sources`  | `id`; `projectId String @map("project_id")`; `retrospectiveVersionId String @map("retrospective_version_id")`; `issueId String @map("issue_id")`; `issueHistoryId String @map("issue_history_id")`; `issueHistorySequence Int @map("issue_history_sequence")`; `sourceChecksum String @map("source_checksum")`; `snapshotJson Json @map("snapshot_json")`; `createdAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `retrospectiveVersion ProjectRetrospectiveVersion @relation("RetrospectiveVersionIssueSources", fields:[retrospectiveVersionId,projectId], references:[id,projectId], onDelete:Restrict)`; `issue Issue @relation("RetrospectiveIssueSource", fields:[issueId,projectId], references:[id,projectId], onDelete:Restrict)`; `issueHistory IssueHistory @relation("RetrospectiveIssueHistorySource", fields:[issueHistoryId,projectId], references:[id,projectId], onDelete:Restrict)`; `@@unique([retrospectiveVersionId,issueHistoryId])`, `@@unique([id,projectId])`; immutable exact history snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ProjectRetrospectiveReview` / `project_retrospective_reviews`             | `id`; `projectId String @map("project_id")`; `retrospectiveId String @map("retrospective_id")`; `retrospectiveVersionId String @map("retrospective_version_id")`; `decision RetrospectiveReviewDecision`; `reason String`; `reviewerId String @map("reviewer_id")`; `reviewedAt DateTime @map("reviewed_at")`; `createdAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `retrospective ProjectRetrospective @relation("ProjectRetrospectiveReviews", fields:[retrospectiveId,projectId], references:[id,projectId], onDelete:Restrict)`; `retrospectiveVersion ProjectRetrospectiveVersion @relation("RetrospectiveVersionReviews", fields:[retrospectiveVersionId,projectId], references:[id,projectId], onDelete:Restrict)`; `reviewer User @relation("RetrospectiveReviewer", fields:[reviewerId], references:[id], onDelete:Restrict)`; `@@unique([id,projectId])`; `@@index([projectId,retrospectiveVersionId,reviewedAt])`; append-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ProjectClosurePolicy` / `project_closure_policies`                        | `id`; `projectId String @unique`; `status ClosurePolicyStatus`; `currentVersionId String? @unique`; `version Int @default(1)`; `createdById String`; `updatedById String`; `createdAt`; `updatedAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `project Project @relation("ProjectClosurePolicyProject", fields:[projectId], references:[id], onDelete:Restrict)`; `currentVersion ProjectClosurePolicyVersion? @relation("ProjectClosurePolicyCurrentVersion", fields:[currentVersionId,projectId], references:[id,projectId], onDelete:Restrict)`; `versions ProjectClosurePolicyVersion[] @relation("ProjectClosurePolicyVersions")`; `closureRecord ProjectClosureRecord? @relation("ClosurePolicyClosureRecord")`; User `createdBy/updatedBy`; aggregate trigger allows only `status,currentVersionId,version,updatedById,updatedAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ProjectClosurePolicyVersion` / `project_closure_policy_versions`          | `id`; `projectId String`; `policyId String`; `versionNo Int`; `status ClosurePolicyVersionStatus`; `sourceTemplateSnapshotId String`; `sourceGateDefinitionId String`; `archiveCheckerCode String`; `archiveCheckerVersion Int`; `retrospectiveCheckerCode String`; `retrospectiveCheckerVersion Int`; `archiveSourceFormulaVersion ArchiveSourceFormulaVersion`; `selfReferenceExclusionVersion String`; `bindingChecksum String`; `policyChecksum String`; `upgradeReason String?`; `effectiveAt DateTime`; `createdById String`; `createdAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | FKs to policy; `sourceTemplateSnapshot ProjectTemplateSnapshot @relation("ClosurePolicySourceTemplateSnapshot", fields:[sourceTemplateSnapshotId,projectId], references:[id,projectId])`, requiring APM-104 to add `@@unique([id,projectId])` and reverse `closurePolicyVersions` on snapshot; composite gate definition relation `(sourceGateDefinitionId,projectId)`; `@@unique([policyId,versionNo])`, `@@unique([id,projectId])`; `@@index([projectId,status,effectiveAt])`; partial unique index `(project_id) WHERE status='ACTIVE'`; immutable except one-way `DRAFT -> ACTIVE -> SUPERSEDED` status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ProjectClosureRecord` / `project_closure_records`                         | `id`; `projectId String @unique`; `archiveBId String`; `archiveSourceFormulaVersion ArchiveSourceFormulaVersion`; `archiveBManifestChecksum String`; `archiveBSourceWatermark String`; `closurePolicyVersionId String`; `closurePolicyChecksum String`; `gateInstanceId String`; `gateCheckSnapshotId String`; `gateSubmissionId String`; `gateApprovalSnapshotJson Json`; `retrospectiveVersionId String`; `retrospectiveContentChecksum String`; `closedById String`; `closedAt DateTime`; `createdAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `project Project @relation("ProjectClosureRecordProject", fields:[projectId], references:[id], onDelete:Restrict)`; archive `ProjectArchiveVersion @relation("ProjectClosureArchiveB", fields:[archiveBId,projectId], references:[id,projectId], onDelete:Restrict)`; policy/version/gate instance/snapshot/submission/retrospective and User `closedBy` relations all use same-project composite keys; `@@unique([id,projectId])`; immutable one-per-project.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `KnowledgeEntry` / `knowledge_entries`                                     | `id`; `code String @unique`; `status KnowledgeEntryStatus`; `currentPublishedVersionId String? @unique @map("current_published_version_id")`; `version Int @default(1)`; `createdById String @map("created_by_id")`; `updatedById String @map("updated_by_id")`; `createdAt`; `updatedAt DateTime @updatedAt @map("updated_at")`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `versions KnowledgeEntryVersion[] @relation("KnowledgeEntryVersions")`; `currentPublishedVersion KnowledgeEntryVersion? @relation("KnowledgeEntryCurrentPublishedVersion", fields:[currentPublishedVersionId], references:[id], onDelete:Restrict)`; `reviews KnowledgeEntryReview[] @relation("KnowledgeEntryReviews")`; `reuseRecords KnowledgeReuseRecord[] @relation("KnowledgeEntryReuseRecords")`; User `createdBy/updatedBy`; aggregate trigger allows only `status,currentPublishedVersionId,version,updatedById,updatedAt`. Sources are reached through exact versions, not directly from the aggregate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `KnowledgeEntryVersion` / `knowledge_entry_versions`                       | `id`; `entryId String @map("entry_id")`; `sourceProjectId String @map("source_project_id")`; `versionNo Int @map("version_no")`; `supersedesVersionId String? @map("supersedes_version_id")`; `status KnowledgeEntryVersionStatus`; `title String`; `sanitizedSummary String @map("sanitized_summary")`; `experienceType String @map("experience_type")`; `discipline String`; `normalizedKeywordsJson Json @map("normalized_keywords_json")`; `normalizedKeywordsText String @map("normalized_keywords_text")`; `applicableProjectTypesJson Json @map("applicable_project_types_json")`; `applicableStageCodesJson Json @map("applicable_stage_codes_json")`; `preconditions String`; `recommendedPractice String @map("recommended_practice")`; `antiPatterns String @map("anti_patterns")`; `limitations String`; `ipSanitizationDeclaration String @map("ip_sanitization_declaration")`; `internalReusable Boolean @map("internal_reusable")`; `contentChecksum String @map("content_checksum")`; `createdById String @map("created_by_id")`; `submittedById String? @map("submitted_by_id")`; `submittedAt DateTime? @map("submitted_at")`; `publishedById String? @map("published_by_id")`; `publishedAt DateTime? @map("published_at")`; `createdAt`.                                                                                                                                                                                                                                                                                                        | `entry KnowledgeEntry @relation("KnowledgeEntryVersions", fields:[entryId], references:[id], onDelete:Restrict)`; `sourceProject Project @relation("KnowledgeVersionSourceProject", fields:[sourceProjectId], references:[id], onDelete:Restrict)`; `currentFor KnowledgeEntry? @relation("KnowledgeEntryCurrentPublishedVersion")`; `supersedes KnowledgeEntryVersion? @relation("KnowledgeVersionSupersedes", fields:[supersedesVersionId], references:[id], onDelete:Restrict)`; `supersededVersions KnowledgeEntryVersion[] @relation("KnowledgeVersionSupersedes")`; `sources KnowledgeEntrySource[] @relation("KnowledgeEntryVersionSources")`; `reviews KnowledgeEntryReview[] @relation("KnowledgeEntryVersionReviews")`; User `createdBy/submittedBy/publishedBy`; `@@unique([entryId,versionNo])`; `@@unique([id,entryId])`; `@@unique([id,sourceProjectId])`; `@@unique([id,entryId,sourceProjectId])`; `@@index([sourceProjectId,status,publishedAt])`; trigram index is conditional. The project key is immutable and makes every source/review use one exact source project; content/source/checksum/creator fields are immutable, and the trigger permits only the frozen state transitions and matching actor/time columns.                                                                                                                         |
| `KnowledgeEntrySource` / `knowledge_entry_sources`                         | `id`; `knowledgeVersionId String @map("knowledge_version_id")`; `sourceProjectId String @map("source_project_id")`; `finalArchiveVersionId String @map("final_archive_version_id")`; `finalArchiveFormula ArchiveSourceFormulaVersion @map("final_archive_formula")`; `finalArchiveManifestChecksum String @map("final_archive_manifest_checksum")`; `finalArchiveSourceWatermark String @map("final_archive_source_watermark")`; `retrospectiveInputArchiveVersionId String @map("retrospective_input_archive_version_id")`; `retrospectiveInputFormula ArchiveSourceFormulaVersion @map("retrospective_input_formula")`; `retrospectiveInputManifestChecksum String @map("retrospective_input_manifest_checksum")`; `retrospectiveInputSourceWatermark String @map("retrospective_input_source_watermark")`; `retrospectiveInputWatermark String @map("retrospective_input_watermark")`; `retrospectiveVersionId String @map("retrospective_version_id")`; `retrospectiveVersionNo Int @map("retrospective_version_no")`; `retrospectiveContentChecksum String @map("retrospective_content_checksum")`; `issueId String? @map("issue_id")`; `issueHistoryId String? @map("issue_history_id")`; `issueHistorySequence Int? @map("issue_history_sequence")`; `sourceChecksum String @map("source_checksum")`; `sanitizedSnapshotJson Json @map("sanitized_snapshot_json")`; `createdAt`. `sourceProjectId` is the sole project key for every source fact; there is no second `projectId`, so source/archive/retrospective/issue rows cannot drift between projects. | `knowledgeVersion KnowledgeEntryVersion @relation("KnowledgeEntryVersionSources", fields:[knowledgeVersionId,sourceProjectId], references:[id,sourceProjectId], onDelete:Restrict)`; `sourceProject Project @relation("KnowledgeSourceProject", fields:[sourceProjectId], references:[id], onDelete:Restrict)`; `archiveA ProjectArchiveVersion @relation("KnowledgeSourceArchiveA", fields:[retrospectiveInputArchiveVersionId,sourceProjectId], references:[id,projectId], onDelete:Restrict)`; `archiveB ProjectArchiveVersion @relation("KnowledgeSourceArchiveB", fields:[finalArchiveVersionId,sourceProjectId], references:[id,projectId], onDelete:Restrict)`; `retrospectiveVersion ProjectRetrospectiveVersion @relation("KnowledgeSourceRetrospective", fields:[retrospectiveVersionId,sourceProjectId], references:[id,projectId], onDelete:Restrict)`; optional `issue Issue? @relation("KnowledgeIssueSource", fields:[issueId,sourceProjectId], references:[id,projectId], onDelete:Restrict)` and `issueHistory IssueHistory? @relation("KnowledgeIssueHistorySource", fields:[issueHistoryId,sourceProjectId], references:[id,projectId], onDelete:Restrict)`; CHECK issue triple all-null/all-non-null; `@@unique([id,sourceProjectId])`; partial unique `(knowledge_version_id,issue_history_id) WHERE issue_history_id IS NOT NULL`; immutable. |
| `KnowledgeEntryReview` / `knowledge_entry_reviews`                         | `id`; `projectId String @map("project_id")` (the one source project whose authorization evidence was inspected); `knowledgeEntryId String @map("knowledge_entry_id")`; `knowledgeVersionId String @map("knowledge_version_id")`; `decision KnowledgeReviewDecision`; `reason String`; `ipConfirmed Boolean @map("ip_confirmed")`; `sanitizationConfirmed Boolean @map("sanitization_confirmed")`; `reviewerId String @map("reviewer_id")`; `reviewedAt DateTime @map("reviewed_at")`; `sourceChecksum String @map("source_checksum")`; `createdAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `knowledgeEntry KnowledgeEntry @relation("KnowledgeEntryReviews", fields:[knowledgeEntryId], references:[id], onDelete:Restrict)`; `knowledgeVersion KnowledgeEntryVersion @relation("KnowledgeEntryVersionReviews", fields:[knowledgeVersionId,knowledgeEntryId,projectId], references:[id,entryId,sourceProjectId], onDelete:Restrict)`; `sourceProject Project @relation("KnowledgeReviewSourceProject", fields:[projectId], references:[id], onDelete:Restrict)`; `reviewer User @relation("KnowledgeReviewer", fields:[reviewerId], references:[id], onDelete:Restrict)`; `@@unique([id,projectId])`; append-only. The composite child FK proves the reviewed version belongs to the same entry and source project, preventing entry A/version B or authorization-project drift; because every `KnowledgeEntrySource` also references `(knowledgeVersionId,sourceProjectId)`, the version project is the common DB-enforced source project for all review evidence. PostgreSQL integration inserts both invalid combinations and expects FK violation.                                                                                                                                                                                                                                                                                                         |
| `KnowledgeReuseRecord` / `knowledge_reuse_records`                         | `id`; `targetProjectId String @map("target_project_id")`; `targetDeliveryUnitId String? @map("target_delivery_unit_id")`; `knowledgeEntryId String @map("knowledge_entry_id")`; `knowledgeVersionId String @map("knowledge_version_id")`; `scenario String`; `evidenceSummary String @map("evidence_summary")`; `confirmedById String @map("confirmed_by_id")`; `confirmedAt DateTime @map("confirmed_at")`; `idempotencyKey String @map("idempotency_key")`; `version Int @default(1)`; `createdAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `targetProject Project @relation("KnowledgeReuseTargetProject", fields:[targetProjectId], references:[id], onDelete:Restrict)`; `targetDeliveryUnit DeliveryUnit? @relation("KnowledgeReuseDeliveryUnit", fields:[targetDeliveryUnitId,targetProjectId], references:[id,projectId], onDelete:Restrict)`; `knowledgeEntry KnowledgeEntry @relation("KnowledgeEntryReuseRecords", fields:[knowledgeEntryId], references:[id], onDelete:Restrict)`; `knowledgeVersion KnowledgeEntryVersion @relation("KnowledgeVersionReuseRecords", fields:[knowledgeVersionId,knowledgeEntryId], references:[id,entryId], onDelete:Restrict)`; `confirmedBy ProjectMember @relation("KnowledgeReuseConfirmedBy", fields:[confirmedById,targetProjectId], references:[id,projectId], onDelete:Restrict)`; `corrections`; `@@unique([targetProjectId,knowledgeVersionId])`, `@@unique([id,targetProjectId])`; composite child FK prevents knowledgeEntry A + knowledgeVersion B; immutable.                                                                                                                                                                                                                                                                                                                                                                                           |
| `KnowledgeReuseCorrection` / `knowledge_reuse_corrections`                 | `id`; `targetProjectId String @map("target_project_id")`; `reuseRecordId String @map("reuse_record_id")`; `correctionType KnowledgeReuseCorrectionType @map("correction_type")`; `reason String`; `correctionText String @map("correction_text")`; `createdById String @map("created_by_id")`; `createdAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `reuseRecord KnowledgeReuseRecord @relation(fields:[reuseRecordId,targetProjectId], references:[id,targetProjectId], onDelete:Restrict)`; `targetProject Project @relation("KnowledgeReuseCorrectionProject", fields:[targetProjectId], references:[id], onDelete:Restrict)`; `createdBy User @relation("KnowledgeCorrectionCreatedBy", fields:[createdById], references:[id], onDelete:Restrict)`; `@@unique([id,targetProjectId])`; append-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### A.3.1 Relation and index matrix

The following child-to-parent tuples are mandatory; a listed project key is part of every foreign-key and lookup predicate. No single-column substitute is permitted:

| Child model                        | Relation name                           | Child fields -> parent fields                                                                                 | Required index/unique                                                                                                                 |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ProjectRetrospectiveVersion`      | `RetrospectiveInputArchive`             | `(retrospectiveInputArchiveVersionId, projectId) -> (ProjectArchiveVersion.id, projectId)`                    | `@@index([projectId, retrospectiveInputArchiveVersionId])`                                                                            |
| `ProjectRetrospectiveContribution` | `RetrospectiveVersionContributions`     | `(retrospectiveVersionId, projectId) -> (ProjectRetrospectiveVersion.id, projectId)`                          | `@@index([projectId, retrospectiveVersionId])`                                                                                        |
| `ProjectRetrospectiveContribution` | `RetrospectiveContributionDeliveryUnit` | `(deliveryUnitId, projectId) -> (DeliveryUnit.id, projectId)`                                                 | `@@index([projectId, deliveryUnitId])`                                                                                                |
| `ProjectRetrospectiveContribution` | `RetrospectiveContributionMember`       | `(contributorMembershipId, projectId) -> (ProjectMember.id, projectId)`                                       | `@@index([projectId, contributorMembershipId])`                                                                                       |
| `ProjectRetrospectiveParticipant`  | `RetrospectiveParticipantMember`        | `(membershipId, projectId) -> (ProjectMember.id, projectId)`                                                  | `@@index([projectId, membershipId])`                                                                                                  |
| `ProjectRetrospectiveIssueSource`  | `RetrospectiveIssueSource`              | `(issueId, projectId) -> (Issue.id, projectId)`                                                               | `@@index([projectId, issueId])`                                                                                                       |
| `ProjectRetrospectiveIssueSource`  | `RetrospectiveIssueHistorySource`       | `(issueHistoryId, projectId) -> (IssueHistory.id, projectId)`                                                 | `@@index([projectId, issueHistoryId])`                                                                                                |
| `ProjectClosurePolicyVersion`      | `ClosurePolicySourceTemplateSnapshot`   | `(sourceTemplateSnapshotId, projectId) -> (ProjectTemplateSnapshot.id, projectId)`                            | `@@index([projectId, sourceTemplateSnapshotId])`                                                                                      |
| `ProjectClosurePolicyVersion`      | `ClosurePolicySourceGateDefinition`     | `(sourceGateDefinitionId, projectId) -> (ProjectGateDefinition.id, projectId)`                                | `@@index([projectId, sourceGateDefinitionId])`                                                                                        |
| `ProjectClosureRecord`             | `ProjectClosureArchiveB`                | `(archiveBId, projectId) -> (ProjectArchiveVersion.id, projectId)`                                            | `@@index([projectId, archiveBId])`                                                                                                    |
| `ProjectClosureRecord`             | `ClosureRecordPolicyVersion`            | `(closurePolicyVersionId, projectId) -> (ProjectClosurePolicyVersion.id, projectId)`                          | `@@index([projectId, closurePolicyVersionId])`                                                                                        |
| `ProjectClosureRecord`             | `ClosureRecordRetrospectiveVersion`     | `(retrospectiveVersionId, projectId) -> (ProjectRetrospectiveVersion.id, projectId)`                          | `@@index([projectId, retrospectiveVersionId])`                                                                                        |
| `KnowledgeEntrySource`             | `KnowledgeEntryVersionSources`          | `(knowledgeVersionId, sourceProjectId) -> (KnowledgeEntryVersion.id, sourceProjectId)`                        | `@@index([sourceProjectId,knowledgeVersionId])`                                                                                       |
| `KnowledgeEntrySource`             | `KnowledgeSourceProject`                | `sourceProjectId -> Project.id`                                                                               | `@@index([sourceProjectId])`                                                                                                          |
| `KnowledgeEntrySource`             | `KnowledgeSourceArchiveA`               | `(retrospectiveInputArchiveVersionId, sourceProjectId) -> (ProjectArchiveVersion.id, projectId)`              | `@@index([sourceProjectId, retrospectiveInputArchiveVersionId])`; reverse `ProjectArchiveVersion.knowledgeSourcesAsArchiveA`          |
| `KnowledgeEntrySource`             | `KnowledgeSourceArchiveB`               | `(finalArchiveVersionId, sourceProjectId) -> (ProjectArchiveVersion.id, projectId)`                           | `@@index([sourceProjectId, finalArchiveVersionId])`; reverse `ProjectArchiveVersion.knowledgeSourcesAsArchiveB`                       |
| `KnowledgeEntrySource`             | `KnowledgeSourceRetrospective`          | `(retrospectiveVersionId, sourceProjectId) -> (ProjectRetrospectiveVersion.id, projectId)`                    | `@@index([sourceProjectId, retrospectiveVersionId])`; reverse `ProjectRetrospectiveVersion.knowledgeSources`                          |
| `KnowledgeEntrySource`             | `KnowledgeIssueSource`                  | `(issueId, sourceProjectId) -> (Issue.id, projectId)`, all-null or all-non-null optional triple               | `@@index([sourceProjectId, issueId])`; reverse `Issue.knowledgeSources`                                                               |
| `KnowledgeEntrySource`             | `KnowledgeIssueHistorySource`           | `(issueHistoryId, sourceProjectId) -> (IssueHistory.id, projectId)`, all-null or all-non-null optional triple | partial unique `(knowledge_version_id, issue_history_id) WHERE issue_history_id IS NOT NULL`; reverse `IssueHistory.knowledgeSources` |
| `KnowledgeEntryReview`             | `KnowledgeEntryVersionReviews`          | `(knowledgeVersionId, knowledgeEntryId, projectId) -> (KnowledgeEntryVersion.id, entryId, sourceProjectId)`   | `@@index([projectId,knowledgeEntryId,knowledgeVersionId])`; composite FK rejects cross-entry/cross-project pair                       |
| `KnowledgeEntryReview`             | `KnowledgeReviewSourceProject`          | `projectId -> Project.id`                                                                                     | `@@index([projectId])`; CHECK matches all source rows                                                                                 |
| `KnowledgeReuseRecord`             | `KnowledgeReuseDeliveryUnit`            | `(targetDeliveryUnitId, targetProjectId) -> (DeliveryUnit.id, projectId)`                                     | `@@index([targetProjectId, targetDeliveryUnitId])`                                                                                    |
| `KnowledgeReuseRecord`             | `KnowledgeReuseConfirmedBy`             | `(confirmedById, targetProjectId) -> (ProjectMember.id, projectId)`                                           | `@@index([targetProjectId, confirmedById])`                                                                                           |
| `KnowledgeReuseRecord`             | `KnowledgeReuseEntryVersion`            | `(knowledgeVersionId, knowledgeEntryId) -> (KnowledgeEntryVersion.id, entryId)`                               | `@@index([knowledgeEntryId, knowledgeVersionId])`; composite FK rejects cross-entry pair                                              |
| `KnowledgeReuseCorrection`         | `KnowledgeReuseCorrectionRecord`        | `(reuseRecordId, targetProjectId) -> (KnowledgeReuseRecord.id, targetProjectId)`                              | `@@index([targetProjectId, reuseRecordId])`                                                                                           |

### A.4 Constraints and triggers

1. Formula only ARCHIVE.SOURCE@1/2. Legacy migration updates label/applicability/null only, not legacy hash payload.
2. APPLICABLE requires RETROSPECTIVE.INPUT@1, snapshot and 64-char lowercase hex watermark; NOT_APPLICABLE requires all three null.
3. All archive, retrospective, issue, delivery unit, member, policy and knowledge source relations use projectId composite FK.
4. Gate definition revision immutable; sourceGateDefinitionId is the only executable G9 authority.
5. Gate instance/snapshot/submission policy tuple is all-null legacy or all-non-null V2; non-null tuple must match one same-project policy version.
6. Policy one ACTIVE partial unique; closure record one-per-project immutable.
7. Retrospective/knowledge versions preserve immutable content and append-only sources/reviews/reuse/corrections. Retrospective trigger permits `DRAFT -> IN_REVIEW`, `IN_REVIEW -> APPROVED|REJECTED`, and `DRAFT -> SUPERSEDED`, changing only `status`, `submittedById`, and `submittedAt` where required. Knowledge trigger permits the transitions listed in the KnowledgeEntryVersion row. All content, source snapshots, checksums, creator/database timestamps and reviewed versions reject UPDATE/DELETE. Aggregate triggers permit only the documented pointer/status/version/audit columns; any other changed column raises SQLSTATE 55000.
8. Archive version reuses the APM-054 trigger transitions exactly: VERIFYING -> READY/FAILED, READY/FAILED -> VERIFYING, READY -> FINALIZED; APM-104 adds the five formula/input columns to the immutable fact comparison. Archive B must first have `ProjectArchiveVersion.status=READY` and a latest `ArchiveIntegrityCheck.status=PASSED`; only then may it move READY -> FINALIZED, and its approved retrospective source item must exist. `ArchiveIntegrityCheckStatus` remains exactly PASSED/FAILED.
9. normalizedKeywordsText is server-generated immutable content and the only trigram/ILIKE text.
10. CLOSURE.SELF_REFERENCE_EXCLUSION@1 exists only in V2 adapter; G9 self facts and ProjectClosureRecord do not enter B. Archive reader, generation, currentness recheck, G9 evidence and close service all call the same registry adapter selected by the archive row's frozen formula; unknown/missing formula rejects instead of guessing.

## 附录 B - Restricted pg_trgm real replay

The CI job creates isolated names and executes the following complete script as `.github/scripts/apm-104-restricted-pg-trgm-replay.sh` (Task 12 creates and tests this file). GitHub Actions invokes it with `bash -Eeuo pipefail .github/scripts/apm-104-restricted-pg-trgm-replay.sh`; all connection values come from masked `PGHOST`, `PGPORT`, `PGOWNER_USER`, and `PGOWNER_PASSWORD` secrets. `PGOWNER_USER` is an explicit CI administration role created by the PostgreSQL service bootstrap with `LOGIN CREATEDB CREATEROLE` (it may also be the service superuser), owns the two temporary databases and all APM-054 replay objects, and grants itself temporary membership in the no-extension role solely to execute `ALTER ... OWNER TO`. It is not a runner default and must satisfy the preflight assertions below. The no-extension role remains `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`, never owns the database, and has database-level CREATE revoked. The script never uses implicit connection defaults, and its `trap` terminates sessions, drops only uniquely named databases, revokes temporary membership, and drops only the uniquely named role it created:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

host="${PGHOST:?PGHOST is required}"
port="${PGPORT:?PGPORT is required}"
owner_user="${PGOWNER_USER:?PGOWNER_USER is required}"
owner_password="${PGOWNER_PASSWORD:?PGOWNER_PASSWORD is required}"
suffix="${GITHUB_RUN_ID:-local}-$$"
normal_db="apm104_normal_${suffix}"
noext_db="apm104_noext_${suffix}"
noext_user="apm104_noext_${suffix}"
noext_password="$(openssl rand -hex 24)"
root="$(mktemp -d)"
url_password="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$owner_password")"
owner_url="postgresql://${owner_user}:${url_password}@${host}:${port}/${noext_db}"
noext_url_password="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$noext_password")"
noext_url="postgresql://${noext_user}:${noext_url_password}@${host}:${port}/${noext_db}"

cleanup() {
  set +e
  PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d postgres -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$normal_db','$noext_db') AND pid <> pg_backend_pid()"
  PGPASSWORD="$owner_password" dropdb -h "$host" -p "$port" -U "$owner_user" --if-exists "$normal_db"
  PGPASSWORD="$owner_password" dropdb -h "$host" -p "$port" -U "$owner_user" --if-exists "$noext_db"
  if PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d postgres -Atqc "SELECT 1 FROM pg_roles WHERE rolname='$noext_user'" | grep -qx 1; then
    PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d postgres -v ON_ERROR_STOP=1 -c "REVOKE \"$noext_user\" FROM \"$owner_user\"; DROP ROLE \"$noext_user\""
  fi
  rm -rf "$root"
}
trap cleanup EXIT

copy_until_apm054() {
  mkdir -p "$root/prisma/migrations"
  cp prisma/schema.prisma "$root/prisma/schema.prisma"
  for migration in prisma/migrations/*; do
    name="$(basename "$migration")"
    cp -R "$migration" "$root/prisma/migrations/$name"
    if [ "$name" = 20260811040000_apm_054_project_archives ]; then break; fi
  done
}
copy_until_apm054

PGPASSWORD="$owner_password" createdb -h "$host" -p "$port" -U "$owner_user" -O "$owner_user" "$normal_db"
PGPASSWORD="$owner_password" createdb -h "$host" -p "$port" -U "$owner_user" -O "$owner_user" "$noext_db"
PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d postgres -v ON_ERROR_STOP=1 -Atqc "SELECT rolcreatedb AND rolcreaterole FROM pg_roles WHERE rolname=current_user" | grep -qx t
PGPASSWORD="$owner_password" DATABASE_URL="postgresql://${owner_user}:${url_password}@${host}:${port}/${normal_db}" npx prisma migrate deploy --schema "$root/prisma/schema.prisma"
PGPASSWORD="$owner_password" DATABASE_URL="$owner_url" npx prisma migrate deploy --schema "$root/prisma/schema.prisma"
cp -R prisma/migrations/20260812010000_apm_104_retrospectives_knowledge_closure_policy "$root/prisma/migrations/"
PGPASSWORD="$owner_password" DATABASE_URL="postgresql://${owner_user}:${url_password}@${host}:${port}/${normal_db}" npx prisma migrate deploy --schema "$root/prisma/schema.prisma"

PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$noext_db" -v ON_ERROR_STOP=1 <<SQL
REVOKE CREATE ON DATABASE "$noext_db" FROM PUBLIC;
CREATE ROLE "$noext_user" LOGIN PASSWORD '$noext_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT "$noext_user" TO "$owner_user";
GRANT CONNECT ON DATABASE "$noext_db" TO "$noext_user";
GRANT USAGE, CREATE ON SCHEMA public TO "$noext_user";
REVOKE CREATE ON DATABASE "$noext_db" FROM "$noext_user";
SQL

PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d postgres -v ON_ERROR_STOP=1 -Atqc "SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit FROM pg_roles WHERE rolname='$noext_user'" | grep -qx t
PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d postgres -v ON_ERROR_STOP=1 -Atqc "SELECT pg_has_role(current_user, '$noext_user', 'MEMBER')" | grep -qx t
PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$noext_db" -v ON_ERROR_STOP=1 -Atqc "SELECT d.datdba=(SELECT oid FROM pg_roles WHERE rolname='$owner_user') AND NOT has_database_privilege('$noext_user',current_database(),'CREATE') FROM pg_database d WHERE d.datname=current_database()" | grep -qx t

# The marker equality below runs before any ownership mutation. It prevents a
# newly added ALTER/CREATE OR REPLACE against a legacy object from bypassing the
# exhaustive allow-list.
expected_legacy_objects="$(printf '%s\n' 'FUNCTION validate_project_archive_version_mutation' 'TABLE gate_check_snapshots' 'TABLE gate_submissions' 'TABLE issue_histories' 'TABLE project_archive_versions' 'TABLE project_gate_definitions' 'TABLE project_gate_instances' 'TABLE project_template_snapshots' 'TYPE ArchiveManifestSourceType')"
actual_legacy_objects="$(awk -f .github/scripts/apm-104-legacy-ddl-markers.awk prisma/migrations/20260812010000_apm_104_retrospectives_knowledge_closure_policy/migration.sql | sort -u)"
[ "$actual_legacy_objects" = "$expected_legacy_objects" ] || { printf 'legacy DDL allow-list mismatch\nexpected:\n%s\nactual:\n%s\n' "$expected_legacy_objects" "$actual_legacy_objects" >&2; exit 1; }

PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$noext_db" -v ON_ERROR_STOP=1 <<SQL
-- Exhaustive allow-list for every pre-existing object that APM-104 alters.
ALTER TABLE public.project_template_snapshots OWNER TO "$noext_user";
ALTER TABLE public.project_archive_versions OWNER TO "$noext_user";
ALTER TABLE public.project_gate_definitions OWNER TO "$noext_user";
ALTER TABLE public.project_gate_instances OWNER TO "$noext_user";
ALTER TABLE public.gate_check_snapshots OWNER TO "$noext_user";
ALTER TABLE public.gate_submissions OWNER TO "$noext_user";
ALTER TABLE public.issue_histories OWNER TO "$noext_user";
ALTER TABLE public._prisma_migrations OWNER TO "$noext_user";
ALTER TYPE public."ArchiveManifestSourceType" OWNER TO "$noext_user";
ALTER FUNCTION public.validate_project_archive_version_mutation() OWNER TO "$noext_user";
GRANT SELECT, REFERENCES ON ALL TABLES IN SCHEMA public TO "$noext_user";
GRANT INSERT, UPDATE, DELETE ON public._prisma_migrations TO "$noext_user";
SQL

PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$noext_db" -v ON_ERROR_STOP=1 -Atqc "SELECT string_agg(c.relname, ',' ORDER BY c.relname) FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname='$noext_user' AND c.relname IN ('project_template_snapshots','project_archive_versions','project_gate_definitions','project_gate_instances','gate_check_snapshots','gate_submissions','issue_histories','_prisma_migrations')" | grep -qx '_prisma_migrations,gate_check_snapshots,gate_submissions,issue_histories,project_archive_versions,project_gate_definitions,project_gate_instances,project_template_snapshots'
PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$noext_db" -v ON_ERROR_STOP=1 -Atqc "SELECT r.rolname FROM pg_type t JOIN pg_roles r ON r.oid=t.typowner WHERE t.typname='ArchiveManifestSourceType'" | grep -qx "$noext_user"
PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$noext_db" -v ON_ERROR_STOP=1 -Atqc "SELECT r.rolname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname='public' AND p.proname='validate_project_archive_version_mutation' AND pg_get_function_identity_arguments(p.oid)=''" | grep -qx "$noext_user"

PGPASSWORD="$noext_password" DATABASE_URL="$noext_url" npx prisma migrate deploy --schema "$root/prisma/schema.prisma"

assert_scalar() {
  local expected="$1"
  local sql="$2"
  local actual
  actual="$(PGPASSWORD="$noext_password" psql -h "$host" -p "$port" -U "$noext_user" -d "$noext_db" -Atqc "$sql")"
  [ "$actual" = "$expected" ] || { echo "assertion failed: expected [$expected], got [$actual]" >&2; exit 1; }
}
assert_scalar t "SELECT to_regclass('public.knowledge_entries') IS NOT NULL"
assert_scalar t "SELECT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='ArchiveManifestSourceType' AND e.enumlabel='PROJECT_RETROSPECTIVE_VERSION')"
assert_scalar t "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='knowledge_entry_reviews_version_entry_project_fkey')"
assert_scalar t "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='knowledge_reuse_records_version_entry_fkey')"
assert_scalar t "SELECT to_regclass('public.knowledge_entry_versions_search_trgm_idx') IS NULL"
assert_scalar f "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_trgm')"
PGPASSWORD="$noext_password" DATABASE_URL="$noext_url" npm run test -- src/modules/knowledge/infrastructure/knowledge-search-capability.integration.test.ts -t "server reports DEGRADED when pg_trgm is absent"
PGPASSWORD="$noext_password" DATABASE_URL="$noext_url" npm run test -- src/modules/knowledge/infrastructure/knowledge-search-capability.integration.test.ts -t "bounded ILIKE seeds and returns published knowledge"

PGPASSWORD="$owner_password" psql -h "$host" -p "$port" -U "$owner_user" -d "$normal_db" -Atqc "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_trgm') AND to_regclass('public.knowledge_entry_versions_search_trgm_idx') IS NOT NULL" | grep -qx t
PGPASSWORD="$owner_password" DATABASE_URL="postgresql://${owner_user}:${url_password}@${host}:${port}/${normal_db}" npm run test -- src/modules/knowledge/infrastructure/knowledge-search-capability.integration.test.ts -t "server reports TRIGRAM when extension and GIN exist"

set +e
PGPASSWORD="$noext_password" psql -h "$host" -p "$port" -U "$noext_user" -d "$noext_db" -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN RAISE EXCEPTION 'unexpected migration error' USING ERRCODE = 'XX000'; EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE '58P01' OR SQLSTATE '0A000' THEN RAISE NOTICE 'allowed'; END \$\$;"
unexpected_status=$?
set -e
[ "$unexpected_status" -ne 0 ] || { echo 'unexpected SQLSTATE was incorrectly accepted' >&2; exit 1; }
```

The shared parser `.github/scripts/apm-104-legacy-ddl-markers.awk` is frozen to this behavior: on a line matching `^-- APM104_LEGACY_DDL (TABLE|TYPE|FUNCTION) ([A-Za-z0-9_]+)$`, remember kind/object and require the immediately following line to match the appropriate header—`ALTER TABLE [public.]"object"`、`ALTER TYPE [public.]"object"` or `CREATE OR REPLACE FUNCTION [public.]"object"(`. It emits exactly `kind object`, rejects duplicate/second markers, rejects blank/comment interposition, rejects kind/name mismatch, rejects EOF with an unbound marker, and ignores every unmarked statement. It never derives `object` with `${ddl#* }` and never scans all migration `ALTER TABLE` statements.

The exact AWK state machine uses a literal-token comparison rather than interpolating an unchecked identifier into a regex:

```awk
function fail(message) { waiting=0; print message > "/dev/stderr"; exit 64 }
/^-- APM104_LEGACY_DDL (TABLE|TYPE|FUNCTION) [A-Za-z0-9_]+$/ {
  if (waiting) fail("second marker before bound statement")
  split($0, marker, " ")
  kind=marker[3]; object=marker[4]
  key=kind SUBSEP object
  if (seen[key]++) fail("duplicate legacy marker")
  waiting=1; next
}
waiting {
  if ($0 == "" || $0 ~ /^--/) fail("marker must bind the immediately following statement header")
  line=$0; gsub(/public[.]/, "", line); gsub(/\"/, "", line); gsub(/[[:space:]]+/, " ", line)
  split(line, token, /[ (]/)
  if (kind == "TABLE" && !(token[1] == "ALTER" && token[2] == "TABLE" && token[3] == object)) fail("TABLE marker mismatch")
  if (kind == "TYPE" && !(token[1] == "ALTER" && token[2] == "TYPE" && token[3] == object)) fail("TYPE marker mismatch")
  if (kind == "FUNCTION" && !(token[1] == "CREATE" && token[2] == "OR" && token[3] == "REPLACE" && token[4] == "FUNCTION" && token[5] == object)) fail("FUNCTION marker mismatch")
  print kind " " object; waiting=0; next
}
END { if (waiting) fail("unbound marker at EOF") }
```

The shell test writes three disposable SQL fixtures and calls the same AWK parser used by the replay script:

```bash
positive_sql="$(mktemp)"
negative_sql="$(mktemp)"
invalid_sql="$(mktemp)"
trap 'rm -f "$positive_sql" "$negative_sql" "$invalid_sql"' EXIT
printf '%s\n' \
  '-- APM104_LEGACY_DDL TABLE project_template_snapshots' 'ALTER TABLE "project_template_snapshots" ADD COLUMN "x" text;' \
  '-- APM104_LEGACY_DDL TABLE project_archive_versions' 'ALTER TABLE "project_archive_versions" ADD COLUMN "x" text;' \
  '-- APM104_LEGACY_DDL TABLE project_gate_definitions' 'ALTER TABLE "project_gate_definitions" ADD COLUMN "x" text;' \
  '-- APM104_LEGACY_DDL TABLE project_gate_instances' 'ALTER TABLE "project_gate_instances" ADD COLUMN "x" text;' \
  '-- APM104_LEGACY_DDL TABLE gate_check_snapshots' 'ALTER TABLE "gate_check_snapshots" ADD COLUMN "x" text;' \
  '-- APM104_LEGACY_DDL TABLE gate_submissions' 'ALTER TABLE "gate_submissions" ADD COLUMN "x" text;' \
  '-- APM104_LEGACY_DDL TABLE issue_histories' 'ALTER TABLE "issue_histories" ADD CONSTRAINT "x" CHECK (true);' \
  '-- APM104_LEGACY_DDL TYPE ArchiveManifestSourceType' 'ALTER TYPE "ArchiveManifestSourceType" ADD VALUE IF NOT EXISTS '\''PROJECT_RETROSPECTIVE_VERSION'\'';' \
  '-- APM104_LEGACY_DDL FUNCTION validate_project_archive_version_mutation' 'CREATE OR REPLACE FUNCTION "validate_project_archive_version_mutation"()' 'RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;' >"$positive_sql"
expected="$(printf '%s\n' 'FUNCTION validate_project_archive_version_mutation' 'TABLE gate_check_snapshots' 'TABLE gate_submissions' 'TABLE issue_histories' 'TABLE project_archive_versions' 'TABLE project_gate_definitions' 'TABLE project_gate_instances' 'TABLE project_template_snapshots' 'TYPE ArchiveManifestSourceType')"
actual="$(awk -f .github/scripts/apm-104-legacy-ddl-markers.awk "$positive_sql" | sort -u)"
[ "$actual" = "$expected" ]

printf '%s\n' 'CREATE TABLE "knowledge_entries" ("id" text PRIMARY KEY);' 'ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_code_key" UNIQUE ("id");' >"$negative_sql"
[ -z "$(awk -f .github/scripts/apm-104-legacy-ddl-markers.awk "$negative_sql")" ]

printf '%s\n' '-- APM104_LEGACY_DDL FUNCTION validate_project_archive_version_mutation' 'ALTER TABLE "validate_project_archive_version_mutation" ADD COLUMN "x" text;' >"$invalid_sql"
if awk -f .github/scripts/apm-104-legacy-ddl-markers.awk "$invalid_sql"; then
  echo 'function marker mismatch was incorrectly accepted' >&2
  exit 1
fi
```

The positive fixture proves all seven legacy tables, the enum, and the `CREATE OR REPLACE FUNCTION` marker; the negative fixture proves a new APM-104 table's unmarked `ALTER TABLE` is excluded; the invalid fixture proves a FUNCTION marker cannot bind an ALTER TABLE statement. The test also greps the replay script for both `GRANT "$noext_user" TO "$owner_user"` and its cleanup REVOKE and asserts its database preflight/ownership queries exist.

The normal database replays APM-054 and then the same APM-104 migration as owner; the restricted database first replays the real APM-054 migration, then only the APM-104 directory after the exhaustive ownership transfer. The allow-list is exact and machine-checked against only marker-bound DDL statements: seven altered legacy business tables, the modified `ArchiveManifestSourceType`, and the one replaced `validate_project_archive_version_mutation()` function, plus schema CREATE/USAGE and `_prisma_migrations` ownership/privileges. Every other existing table remains owner-controlled and is exposed only through SELECT/REFERENCES. The admin preflight proves CREATEDB/CREATEROLE, the membership assertion proves it may transfer owner to the temporary role, and the table/type/function owner queries prove every required transfer succeeded before deployment. The `ALTER TYPE ... ADD VALUE` therefore succeeds while `CREATE EXTENSION` reaches exactly one of the caught `42501`, `58P01`, or `0A000` states. Prisma's successful exit is enforced directly by `set -e`; a marker binding, membership, ownership, missing object, enum, constraint, extension/index, capability, or bounded-search mismatch fails a shell assertion or named integration test. The `set +e` block is intentional: under GitHub Actions `bash -e`, the unknown-SQLSTATE command is inside a disabled-errexit region, its status is captured, `set -e` is restored, and the explicit `[ "$unexpected_status" -ne 0 ]` assertion still runs.

Exact Bash verification is `bash -n .github/scripts/apm-104-restricted-pg-trgm-replay.sh`, `bash -n .github/scripts/apm-104-restricted-pg-trgm-replay.test.sh`, then `bash .github/scripts/apm-104-restricted-pg-trgm-replay.test.sh`; expected signal is exit 0 and `APM104 restricted replay shell contract: PASS`. On a Windows workstation without Bash these are recorded as local SKIPPED, not PASS; GitHub Actions must run all three commands and cannot mark the job successful if any is skipped or non-zero.

The two named capability integration tests are executable server-side probes, not adapter mocks. `server reports DEGRADED when pg_trgm is absent` queries `pg_extension` and `pg_indexes` through the server capability adapter and requires response metadata `{ searchCapability: "DEGRADED" }`. `bounded ILIKE seeds and returns published knowledge` inserts a closed source project, the precise Archive A and Archive B versions plus an approved retrospective, publishes one sanitized knowledge version with `normalizedKeywordsText='伺服 抖动 调参'`, invokes the real query service with `query='伺服'`, `page=1`, `pageSize=20`, asserts that exact version is returned with DEGRADED metadata, and deletes only its test transaction data on rollback. The normal named test requires `{ searchCapability: "TRIGRAM" }`. None of these application tests substitutes for the preceding real migration exit and database-object assertions.

## 附录 C - Browser fixture/auth

Task 8 creates real disposable data, not page-state mocks. Known users: `apm104-source-manager` (project manager), `apm104-retrospective-reviewer` (quality), `apm104-knowledge-reviewer` (department lead), `apm104-target-manager` (project manager). Development/test fixture route returns the four IDs and four distinct one-time tokens; the identity route consumes exactly one token and sets an HttpOnly `apm-dev-user-id` cookie only outside production. Production ignores the cookie and retains existing trusted-header secret. Provisioning requires `APM104_BROWSER_FIXTURE_ENABLED=true` and a server-side `current_database()` beginning `apm104_fixture_`; start only against that disposable database, migrate, run `npm run dev`, then POST `/api/dev/apm-104/browser-fixture`. Cleanup may drop only that named disposable database or run `docker compose down -v` for the disposable volume.

## Requirement mapping

| Approved design requirement                                           | Tasks             |
| --------------------------------------------------------------------- | ----------------- |
| APM-054 V1 byte/value compatibility                                   | 1,2,3,12          |
| V2 formula/self-reference/input watermark                             | 3,4,6,7,12        |
| V2 template/new project/legacy upgrade/active Gate                    | 5,6,7             |
| A -> approved retrospective -> B -> G9 -> close                       | 3,4,5,6,7,8,11,12 |
| Retrospective state/source/independent review                         | 4,8               |
| Knowledge privacy/IP/version/reuse                                    | 9,10,11           |
| pg_trgm normal and restricted real path                               | 2,9,12            |
| Thin API/auth/IDOR/optimistic lock/idempotency/Audit/Outbox           | 4-10              |
| UI states/responsive/keyboard/browser                                 | 8,11,12           |
| Excludes APM-024/110/111, AI/vector, external knowledge, backup media | 2,9,12            |

## Micro-step execution rule

Every numbered step above is a verification checkpoint. During implementation, each checkpoint must be executed as 2-5 minute checkboxes in this fixed order; do not combine the six actions into one edit:

- [ ] Add one named failing assertion to the listed current-task test file.
- [ ] Run only that test file/test name and record the expected failure code or missing symbol.
- [ ] Add the smallest schema/SQL/type/function/route/component change needed for that assertion.
- [ ] Re-run the named test and require PASS with zero unexpected snapshots.
- [ ] Run the task's complete focused command and require zero failures before advancing.
- [ ] Stage only the task's listed files and make the stated local commit; if the task text does not specify a message, use `feat(apm-104): <task responsibility>`.

Large Task 2 migration work follows this same loop per enum/model/constraint/trigger group; Task 11 follows it per page state and command flow. An implementer may add more checkboxes but may not skip or reorder these six actions.

## Plan self-check

- [ ] Requirement mapping has no gap and every GREEN depends only on prior/current tasks.
- [ ] Run `$parts = @('T','ODO','T','BD','FIX','ME','place','holder','类似','前面','适当','校验','相关','测试'); $pattern = ($parts[0]+$parts[1])+'|'+($parts[2]+$parts[3])+'|'+($parts[4]+$parts[5])+'|'+($parts[6]+$parts[7])+'|'+($parts[8]+$parts[9])+'|'+($parts[10]+$parts[11])+'|'+($parts[12]+$parts[13]); rg -n $pattern docs/superpowers/plans/2026-08-12-apm-104-retrospective-knowledge-implementation.md`; expected zero matches.
- [ ] Verify type/name consistency for formulas, policy, closure record, retrospective watermark and normalizedKeywordsText.
- [ ] Verify every `Create` path is absent, every `Modify` path exists at baseline, every `Extend` path is created in a prior task, and all test commands reference tests created in prior/current tasks.
- [ ] Fixed APM-054 hashes remain unchanged.
- [ ] Run Prettier on this document, git diff --check, and terminology/conflict searches.
- [ ] git status shows only the approved design and this plan; no implementation files.

## Recovery R1（Task 9 前）

在 Task 8 已完成、Task 9 尚未开始的前提下，追加一次独立恢复门禁。该恢复仅获准修改既有唯一 APM-104 migration、权限 persistence/integration 契约测试，以及 Task 8 的浏览器 fixture、身份路由、请求身份和复盘 page-state 查询/路由；不得新建补丁 migration、修改 Prisma Schema、实现知识业务、更新进度表、推送或创建 PR。恢复提交后必须暂停并向 APM-规划请求复核。

恢复步骤固定为：

1. 先以 RED 测试证明六个 Permission、冻结 RolePermission scope 矩阵、四个一次性身份 token、fixture 开关与 `current_database()` disposable 前缀、精确 `currentVersionId`/`latestApprovedVersionId` 指针均未满足；确认失败后再实现。
2. 在 `20260812010000_apm_104_retrospectives_knowledge_closure_policy/migration.sql` 追加幂等 Permission/RolePermission seeds，沿用仓库稳定 ID 与 `ON CONFLICT` 风格；不得破坏 legacy DDL marker parser，六项权限的未列出高权限授予必须保持不存在。
3. 修复 Task 8 fixture：`sourceManagerId`、`retrospectiveReviewerId`、`knowledgeReviewerId`、`targetManagerId` 使用不同用户和明确角色；响应分别返回一次性 token，单次兑换即失效，生产路由 404，开发 cookie 具备 HttpOnly/SameSite=Lax/Path=/ 且本地 HTTP 不强制 Secure。
4. `provisionApm104BrowserFixture` 在任何业务写入前同时验证显式开关和服务端 `SELECT current_database()` 的 `apm104_fixture_` 前缀；任一失败必须 fail closed 且零写入。fixture 不预关闭项目、不创建知识事实。
5. 扩展 retrospective query service/DTO，由服务端按冻结 `currentVersionId`、`latestApprovedVersionId`、Archive A/B 与确切 closure policy/source 语义解析；route 不得使用数组首项、`findFirst` 推断或 `any` 拼事实，缺失/不匹配默认拒绝 action。
6. 运行 focused tests、typecheck、format、`git diff --check`；PostgreSQL 集成/升级回放在本机不可用时记录 `SKIPPED`，Linux CI 必须实跑。仅提交上述恢复文件（含本计划与批准设计文档），提交后停止，不进入 Task 9。

Stop after document validation and send APM-规划 a fourth-round implementation-plan review request. Do not begin TDD.

## Recovery R1.1（R1 复审后的 Task 9 前独立修订）

**复审结论：** Recovery R1 的权限、四身份 fixture 和 fail-closed disposable 数据库保护保持有效；但复盘查询仍把 `findFirst` 的 Archive B 当作当前事实、没有查询 G9 批准证据，并且在没有复盘聚合时遗漏可创建复盘所需的 Archive A。Task 9 继续暂停。R1.1 必须作为新提交，绝不 amend `4eb8038`，完成后再次暂停复审。

**唯一允许范围：**

- Create/Modify: archives 侧仅用于 `ARCHIVE.SOURCE@2` 的 currentness/readiness helper 及其测试；governance 侧仅用于完整 closure-policy binding 的纯规则及其测试。
- Modify/Test: `src/modules/retrospectives/application/project-retrospective-query-service.ts`、其测试、`src/modules/retrospectives/contracts/project-retrospective-page-state.ts`、其测试、`src/app/api/projects/[projectId]/retrospectives/route.ts`、其测试。
- Modify: 本实施计划。
- 禁止：Prisma Schema、唯一 APM-104 migration、权限矩阵、fixture/identity route、Task 9 知识业务、推送、PR、进度表，以及任何对 `4eb8038` 的 amend。

恢复步骤固定为：

1. 先为 Archive B 非 G9 来源变化、G9 无/错配批准证据、self-reference/checker binding/checksum 不一致、无聚合/草稿/已批准复盘的 Archive A 指针，以及 GET 的 NORMAL/EMPTY/STALE/query-error 输出增加 RED。运行 query/page-state/route 聚焦测试并确认旧实现失败；测试不得以数组首项或裸 `findFirst` 证明正确性。
2. 创建有类型的 archive V2 helper。它只接受 `READY`、`ARCHIVE.SOURCE@2`、`APPLICABLE`、最新 integrity `PASSED` 的候选；B 还必须含确切 `PROJECT_RETROSPECTIVE_VERSION` manifest item。helper 通过 `ArchiveSourceFormulaRegistry` 重建当前 V2 manifest，并同时比较 `sourceWatermark` 和 `manifestChecksum`；未知公式、读源失败、哈希不一致或缺少 latest integrity 一律返回 `null`。多个当前 B 按冻结 version/id 顺序确定性选择，绝不以单个裸 `findFirst` 推断。
3. 将完整 V2 policy binding 收敛到 governance 纯规则，基于 `buildClosurePolicyVersionFacts` 重算并校验两项 checker、`ARCHIVE.SOURCE@2`、`CLOSURE.SELF_REFERENCE_EXCLUSION@1`、current ACTIVE version、source G9 definition/checkerBindings、source template snapshot、bindingChecksum 和 policyChecksum。查询只消费该完整规则，不维护弱化副本；任何未知或不匹配均为 `closurePolicy=null`。
4. 查询服务返回最小脱敏 `g9Approval`。它仅在 exact active policy、exact current B、`currentVersionId === latestApprovedVersionId`、APPROVED submission、两个 PASSED checker，以及 submission/snapshot/instance tuple 和两个 checker evidence 的 archive/policy/retrospective ID、manifest checksum、source watermark、retrospective checksum 全部匹配时出现。`RUN_G9` 只依赖 current B 和完整 policy；`CLOSE_PROJECT` 额外依赖该 G9 fact。
5. 无聚合时查询仍返回稳定完整 DTO，并用当前 V2 manifest 解析精确 Archive A；仅 `canCreate && archiveA` 显示 CREATE。无批准版本的 current draft 使用其冻结且当前的 Archive A；存在 approved 指针时 A/B 始终根据 approved version 冻结的来源解析，不能让后续 draft 替换治理来源。A/B 或指针缺失、过期、FAILED integrity、未知公式均 fail closed。
6. 重跑全部 R1.1 query/page-state/route/pure-rule/helper 聚焦测试，随后 `npm run typecheck`、`npm run format:check`、`git diff --check`。本机 PostgreSQL、迁移回放和 PostgreSQL integration 继续只能记为 `SKIPPED`；Task 12 Linux CI 必须实跑。只提交上述文件后停止并将提交、RED/GREEN、聚焦结果、限制和 `git status` 交 APM-规划复审。

## Recovery R1.2（R1.1 复审后的 Task 9 前单一策略规则修订）

**复审结论：** R1.1 已将复盘 query/page-state 切换到 `closure-policy-binding`，但 `project-close-service` 仍保留 `parseCheckerBindings`、`hasExactClosureBindings` 与 `evaluateClosurePolicyBinding` 的近似副本。这会使页面可执行性与真实 SERIALIZABLE 关项事务在未来策略变更后产生不同判定。Task 9 继续暂停；R1.2 必须作为独立提交，绝不 amend `97250a4`。

**唯一允许范围：**

- Modify: `src/modules/projects/application/project-close-service.ts`，直接导入并调用 governance 侧的 `parseClosureCheckerBindings` 和 `evaluateClosurePolicyBinding`，删除本地副本与仅为副本存在的 imports。
- Create/Test: `src/modules/governance/domain/closure-policy-binding.test.ts`，覆盖纯规则的完整绑定解析、checksum 不匹配默认拒绝，以及无脆弱行号的架构断言：`src` 仅有一个 evaluator 定义，关项服务通过共享模块导入。
- Modify/Test: `src/modules/projects/application/project-close-service.test.ts`，不再从关闭服务导入纯规则；以共享规则的失败输出驱动 close guard 拒绝。
- Modify: 本实施计划。
- 禁止：R1 权限与 fixture、Prisma Schema、migration、Archive 算法、知识业务和 Task 9–12、推送、PR、进度表；不得修改 `97250a4`。

**恢复步骤固定为：**

1. 先新增共享规则/架构 RED；旧源码必须因 `src` 内存在两处 `evaluateClosurePolicyBinding` 定义以及关闭服务没有共享 import 而失败。
2. 删除关闭服务本地 parser/evaluator，使用 governance 的同名 exports；不改变关项的锁顺序、SERIALIZABLE 重试、G9 evidence 或 archive currentness 逻辑。
3. 将纯 evaluator 的 checksum/default-deny 断言移入 governance 测试；关闭服务测试以共享 evaluator 的无效结果验证 `CLOSURE_POLICY_BINDING_MISMATCH`，不保留第二份规则测试。
4. 运行 shared binding、project-close-service、R1.1 query/page-state/route 聚焦测试，`npm run typecheck`、`npm run format:check`、`git diff --check` 和 `rg -n "function evaluateClosurePolicyBinding|export function evaluateClosurePolicyBinding" src`。预期 `rg` 只输出 governance 定义；本机 PostgreSQL/迁移回放仍记为 `SKIPPED`，Task 12 Linux CI 必须实跑。只提交本节列出的文件后停止并请求复审。

## Recovery R2（Task 9 生命周期迁移修补）

**根因和授权：** 已批准设计冻结 `PUBLISHED | SUPERSEDED -> REVOKED`；`knowledge-policy.ts` 和 Prisma 枚举均已表达该状态机，但尚未发布的唯一 APM-104 migration 在 `validate_knowledge_entry_version_mutation()` 中遗漏 `SUPERSEDED -> REVOKED`。真实 PostgreSQL 会以 `23514` 拒绝该设计允许的状态变迁。因分支尚无 upstream 且 migration 未发布，获准在同一 migration 作单行修补，不新建补丁 migration，也不缩窄生命周期。

**唯一允许范围：**

- Modify: `prisma/migrations/20260812010000_apm_104_retrospectives_knowledge_closure_policy/migration.sql`，仅在 `validate_knowledge_entry_version_mutation()` 的允许转换中追加 `OR (OLD."status" = 'SUPERSEDED' AND NEW."status" = 'REVOKED')`；不得改动其他状态、可更新字段、SQLSTATE、trigger、enum、legacy DDL marker 或 APM-054 兼容逻辑。
- Modify/Test: `src/modules/knowledge/domain/knowledge-persistence.test.ts`，从该函数的限定函数体读取状态机，精确验证两条终态撤销、反向转换缺席和 `23514` default-deny。
- Create/Test: `src/modules/knowledge/infrastructure/knowledge-entry-version-mutation.integration.test.ts`，在真实 PostgreSQL 事务内建立临时 probe table 并挂载真实 trigger function，验证 `SUPERSEDED -> REVOKED` 成功、`REVOKED -> PUBLISHED` 只可由 `23514` 拒绝、内容事实改动只可由 `55000` 拒绝。
- Modify: 本实施计划。
- 禁止：Prisma Schema、新 migration、AuditAction/KnowledgeReviewDecision enum、知识领域/API/UI、Task 10–12、推送、PR 和开发进度表。

**恢复步骤固定为：**

1. 先为 migration 函数体追加 named static RED，限定提取 `validate_knowledge_entry_version_mutation()`，使遗漏的 `SUPERSEDED -> REVOKED` 导致失败；不得用全文件宽泛文本断言或行号断言。
2. 只追加该状态转换，重跑 static persistence、knowledge policy 与 revoke-service 聚焦测试；保留撤销审计为既有 `KNOWLEDGE_ENTRY_REVIEWED`，payload 冻结 `decision="REVOKE"`、reason、版本/项目/状态，成功 Outbox 保持 `knowledge.entry-version.revoked`。
3. 创建真实 PostgreSQL trigger 行为测试；本机 `RUN_DATABASE_INTEGRATION`、`psql` 或 Docker 不可用时只能记录为 `SKIPPED`，不得把 skip 作为通过。Task 12 Linux CI 必须在空库、APM-054→104 升级和受限 pg_trgm 回放后实跑此测试。
4. 运行 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run db:generate`、`npm run db:validate` 和 `git diff --check`。本机没有可用 PostgreSQL 时，migration marker 与升级回放同样只能记录 `SKIPPED`。
5. 仅暂存本计划、同一 migration、static persistence test 与新的 PostgreSQL integration test，提交 `fix(apm-104): align knowledge revocation migration`；绝不混入正在进行的 Task 9 business files。提交后无需复审等待，立即恢复 Task 9；Task 9 完成后才暂停复审。

## Recovery R3（Task 9 知识发布、检索与来源加固）

**复审结论与范围：** Task 9 的既有聚焦测试、静态门禁和 R2 生命周期迁移修补均保持有效，但尚未覆盖五项会破坏“当前可采用版本”、审计时间权威或问题来源脱敏边界的缺口。本恢复仅修订 Task 9 的知识服务、repository、capability probe、相关单元/ PostgreSQL 集成测试和本计划；不得修改 Prisma Schema、唯一 APM-104 migration、知识生命周期、权限种子、Task 10 API/contracts/page-state/UI、开发进度表，且不得 push、创建 PR 或启动 Task 10。Recovery R3 必须独立提交 `fix(apm-104): harden knowledge publication and search`，提交后停止并请求复审。

**冻结的行为与 TDD 步骤：**

1. 先以 RED 证明已撤销的 `KnowledgeEntry` 可借助撤销前遗留的 `IN_REVIEW` 或 `DRAFT` 版本重新发布/提交；再令 submit 与 review 在初始读取和最终 `updateMany` CAS 都要求 `entry.status = ACTIVE`。任何 revoked/并发状态漂移均返回 `KNOWLEDGE_ENTRY_REVOKED` / 409，且不写版本、聚合、审核、Audit 或 Outbox 成功事实。
2. 以 RED 证明 repository 的公开查询和人工 adoptability 只检查版本 `PUBLISHED`；再收紧为 `KnowledgeEntry.status = ACTIVE` 且 `KnowledgeEntry.currentPublishedVersionId = KnowledgeEntryVersion.id`。repository SQL、服务回归和可选 PostgreSQL 测试分别覆盖 REVOKED 聚合、非当前 PUBLISHED 版本被排除，当前内部可复用发布版本仍可搜索/确认；公共 DTO 不得增加来源项目、客户、Issue、文件或归档标识。
3. 以 RED 证明业务实现使用应用服务器 `new Date()`；在同一 Prisma 事务内由 `SELECT CURRENT_TIMESTAMP AS "now"` 获取一次有效 `Date`。submit 的 `submittedAt`、publish 的 `publishedAt`/`reviewedAt`、reject 的 `reviewedAt` 和 reuse 的 `confirmedAt` 复用该事务时钟；时钟缺失或格式非法默认失败且不创建业务、Audit 或 Outbox 事实。测试 fixture 中的普通 `new Date()` 不属于本要求。
4. 以 RED 证明同名对象、错误表、非 GIN、非 `gin_trgm_ops`、`indisvalid = false` 或 `indisready = false` 也会被误报为 TRIGRAM；probe 只在 `pg_trgm` 已安装且命名索引确属 `public.knowledge_entry_versions`、访问方法为 GIN、有效且 ready、包含正确 trigram opclass 时返回 `TRIGRAM`。探测确认缺失返回 `DEGRADED`；查询异常或结构异常继续以 503 `KNOWLEDGE_SEARCH_CAPABILITY_UNAVAILABLE` default-deny。真实 PostgreSQL 覆盖在本机不可用时只能 `SKIPPED`，Task 12 Linux CI 必须实跑。
5. 以 RED 证明 `KnowledgeEntrySource.sanitizedSnapshotJson` 仅保存原始 IssueHistory snapshot hash；从确切 `IssueHistory.snapshotJson` 严格提取并冻结 `category`、`severity`、`status`、`eventType` 和 sequence，缺失或枚举非法一律 fail closed。快照不得复制 `confirmedText`、`title`、`phenomenonDescription`、`rootCauseDescription`、`verificationEvidence`、`sourceSnapshot`、客户文本、人员/成员 ID、文件或 URL；`sourceChecksum` 必须基于补齐后的规范化脱敏快照重算，且绝不读取当前 `Issue` 替代精确 `IssueHistory`。
6. 每个行为执行 RED → 确认预期失败 → 最小 GREEN → focused regression。完成后运行 Task 9 六文件聚焦命令、`npm run test`、`npm run format:check`、`npm run lint`、`npm run typecheck`、`npm run db:generate`、`npm run db:validate`、`npm run build` 和 `git diff --check`。本机 PostgreSQL、TRIGRAM 实例、空库/升级 replay 不可用时明确记为 `SKIPPED`，不得表述为通过；只提交 Recovery R3 文件后暂停复审。

## Task 10 authorization-scope safety supplement (2026-08-15)

Task 9 write commands expose only a boolean `sourceRead` input, so the initial Task 10 API draft accepted a caller-controlled `sourceProjectId` for submit/review/revoke. That would authorize a claimed project independently of the persisted entry/version relation. The approved supplement keeps Task 9 write services unchanged and adds only the internal `knowledge-authorization-query` application query, its tests, the Task 10 contracts/routes/tests, and this plan record. The query accepts only `{ entryId, versionId }`, uses the composite `id_entryId` lookup with an injected Prisma client, returns only `sourceProjectId`, and maps unknown/mismatched pairs to typed 404.

TDD evidence: the query test first failed with the expected missing-module RED, then passed 4/4 after the minimal query. Contract tests next failed while `sourceProjectId` remained required, then passed after the field was removed; strict unknown command fields, blank values, illegal enums, and invalid paths are mapped to HTTP 400. Submit/review/revoke route tests first failed against the caller-controlled source, then passed after the fixed global-guard → strict parse → exact source query → source `PROJECT_RETROSPECTIVE_READ` guard → idempotency/write sequence. The final Task 10 focused suite covers the query, both contracts, all seven routes, reuse/correction target scope and IDOR paths (10 files / 40 tests). No Task 9 write service, schema, migration, permission seed, UI, or tracker file was changed, and no recovery commit is created.
