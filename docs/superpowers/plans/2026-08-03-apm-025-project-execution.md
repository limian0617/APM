# APM-025 Project Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the secure, read-only project execution page with workday-derived progress, template-created project milestones, task-triggered milestone achievement, and critical-path exception drill-down.

**Architecture:** Extend the existing immutable template-component/snapshot path with a `MILESTONE` component and copy it to project-owned milestone facts. Keep schedule precision in minutes, but convert aggregate planning work to workdays in a Planning read query; its percentage is derived only from effective task planned/remaining duration. Keep milestone commands in Projects, automatic milestone reconciliation in the task-progress transaction, and UI state mapping in a pure Planning view-model module.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6, Prisma 6/PostgreSQL 16, Zod 4, Vitest 4, existing audit/Outbox/idempotency/authorization libraries.

---

## Locked file structure

| Path | Responsibility |
| --- | --- |
| `prisma/schema.prisma` | Milestone enum/models, template component enum, foreign keys, indexes, audit vocabulary enum values. |
| `prisma/migrations/20260803090000_apm_025_project_execution/migration.sql` | PostgreSQL types/tables/constraints and append-only triggers for milestone facts. |
| `src/modules/configuration/domain/template-policy.ts` | Validate canonical `MILESTONE` component content and retain non-required status. |
| `src/modules/projects/domain/project-milestone.ts` | Pure milestone definition, state-transition, and task-link reconciliation rules. |
| `src/modules/projects/application/milestone-service.ts` | Transactional CRUD, task linking, event/audit/Outbox persistence, and template snapshot instantiation. |
| `src/modules/planning/domain/project-progress.ts` | Pure task-duration progress and aggregate workday conversion rules. |
| `src/modules/planning/application/project-execution-query.ts` | Authorized read-side aggregation of tasks, schedule forecast, packages, milestones, and exceptions. |
| `src/modules/planning/contracts/execution-page-state.ts` | Pure mapping of the execution DTO to normal/loading/empty/error/denied/stale/pending/failed/read-only UI states. |
| `src/app/api/projects/[projectId]/execution/route.ts` | Thin `PROJECT_READ` execution query handler. |
| `src/app/api/projects/[projectId]/milestones/**/route.ts` | Thin `PROJECT_PLAN_UPDATE` milestone read/command handlers. |
| `src/app/projects/[projectId]/execution/*` | Responsive read-only execution page and stable same-page drill-down UI. |
| `src/app/globals.css` | Narrow styles for the execution layout and state-preserving skeletons only. |

## Task 1: Define the milestone template contract

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/modules/configuration/domain/template-policy.ts`
- Modify: `src/modules/platform-api/contracts/internal-routes.ts`
- Modify: `src/modules/configuration/domain/template-policy.test.ts`
- Modify: `src/modules/projects/domain/project-template-snapshot.test.ts`

- [ ] **Step 1: Write failing contract tests for a milestone component.**

  Add to `template-policy.test.ts`:

  ```ts
  it("validates canonical milestone definitions without making them template-required", () => {
    expect(validateTemplateComponentContent("MILESTONE", {
      milestones: [
        { code: "DESIGN.FREEZE", name: "设计冻结", position: 10 },
        { code: "FAT.READY", name: "FAT 准备", description: "客户验收前置", position: 20 }
      ]
    })).toEqual({
      milestones: [
        { code: "DESIGN.FREEZE", name: "设计冻结", position: 10 },
        { code: "FAT.READY", name: "FAT 准备", description: "客户验收前置", position: 20 }
      ]
    });
    expect(() => validateTemplateComponentContent("MILESTONE", {
      milestones: [
        { code: "DESIGN.FREEZE", name: "A", position: 1 },
        { code: "DESIGN.FREEZE", name: "B", position: 2 }
      ]
    })).toThrow(/重复代码/u);
  });
  ```

- [ ] **Step 2: Run the targeted test and verify that it fails because `MILESTONE` is not a component type.**

  Run: `npx vitest run src/modules/configuration/domain/template-policy.test.ts`

  Expected: TypeScript/Vitest failure referring to the missing `MILESTONE` union value.

- [ ] **Step 3: Add the component type, Zod contract, and pure validator.**

  Add the enum value without adding it to `REQUIRED_TEMPLATE_COMPONENT_TYPES`:

  ```ts
  export const TEMPLATE_COMPONENT_TYPES = {
    STAGE: "STAGE",
    GATE: "GATE",
    ROLE: "ROLE",
    WBS: "WBS",
    CAPABILITY_RULE: "CAPABILITY_RULE",
    MILESTONE: "MILESTONE"
  } as const;
  ```

  Add a `MILESTONE` switch branch that validates nonempty `milestones`, unique stable codes,
  unique non-negative integer `position`, `name`, and optional `description`. Add the matching
  `milestoneContentSchema` and discriminated-union member in `internal-routes.ts`. Extend the
  Prisma `TemplateComponentType` enum with `MILESTONE`.

- [ ] **Step 4: Extend the snapshot fixture with one `MILESTONE` component.**

  In `project-template-snapshot.test.ts`, append this source component while keeping the four
  existing required component types:

  ```ts
  {
    type: "MILESTONE",
    content: { milestones: [{ code: "DESIGN.FREEZE", name: "设计冻结", position: 10 }] }
  }
  ```

  Assert the snapshot checksum remains deterministic when source components are reordered and
  the milestone component is present in its sorted snapshot.

- [ ] **Step 5: Run focused tests and format the modified files.**

  Run:

  ```powershell
  npx prettier --write prisma/schema.prisma src/modules/configuration/domain/template-policy.ts src/modules/configuration/domain/template-policy.test.ts src/modules/platform-api/contracts/internal-routes.ts src/modules/projects/domain/project-template-snapshot.test.ts
  npx vitest run src/modules/configuration/domain/template-policy.test.ts src/modules/projects/domain/project-template-snapshot.test.ts
  ```

  Expected: both test files pass.

- [ ] **Step 6: Commit the contract slice.**

  ```powershell
  git add prisma/schema.prisma src/modules/configuration/domain/template-policy.ts src/modules/configuration/domain/template-policy.test.ts src/modules/platform-api/contracts/internal-routes.ts src/modules/projects/domain/project-template-snapshot.test.ts
  git commit -m "Add milestone template component contract"
  ```

## Task 2: Add durable project milestone and event facts

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260803090000_apm_025_project_execution/migration.sql`
- Create: `src/modules/projects/infrastructure/milestones.integration.test.ts`

- [ ] **Step 1: Write the PostgreSQL integration assertions before creating the migration.**

  Create a database-gated test following `responsibility-packages.integration.test.ts`. Its first
  test must attempt each invalid write below and expect PostgreSQL to reject it:

  ```ts
  await expect(db.projectMilestoneTaskLink.create({
    data: { projectId, milestoneId: milestone.id, taskId: foreignTask.id, status: "ACTIVE", createdById: adminId }
  })).rejects.toThrow();
  await expect(db.projectMilestoneEvent.update({
    where: { id: event.id }, data: { reason: "tampered" }
  })).rejects.toThrow(/append-only/u);
  ```

- [ ] **Step 2: Run the test to verify it cannot compile against the current Prisma client.**

  Run: `$env:RUN_DATABASE_INTEGRATION='1'; npx vitest run src/modules/projects/infrastructure/milestones.integration.test.ts`

  Expected: failure because the milestone models do not exist.

- [ ] **Step 3: Define the Prisma facts and relation constraints.**

  Add these enum values:

  ```prisma
  enum ProjectMilestoneStatus { PENDING ACHIEVED VOID }
  enum ProjectMilestoneAchievementSource { MANUAL LINKED_TASKS }
  enum ProjectMilestoneEventType { CREATED UPDATED TASK_LINKED TASK_LINK_VOIDED ACHIEVED_MANUALLY ACHIEVED_FROM_LINKED_TASKS VOIDED }
  enum ProjectMilestoneTaskLinkStatus { ACTIVE VOID }
  ```

  Add `ProjectMilestone`, `ProjectMilestoneTaskLink`, and `ProjectMilestoneEvent` models. Give
  milestones `@@unique([projectId, code])`, `@@unique([id, projectId])`, and a project/status/
  position index. Give links a `@@unique([milestoneId, taskId])`, status index, and composite
  milestone/task project foreign keys. Give events `@@unique([milestoneId, sequence])` plus
  project and actor/time indexes. Add matching arrays to `Project`, `PlanningTask`,
  `ProjectTemplateSnapshotComponent`, and `User`. Extend `AuditAction` and `AuditObjectType` with
  explicit milestone values.

- [ ] **Step 4: Write the SQL migration with database-side safeguards.**

  The migration must create the new PostgreSQL enum types/tables/indexes, create composite unique
  keys before composite foreign keys, and create the same `BEFORE UPDATE OR DELETE OR TRUNCATE`
  append-only trigger pattern used by `responsibility_package_events` for
  `project_milestone_events`. Add a trigger that rejects a task-link row when its milestone and
  task project IDs differ.

- [ ] **Step 5: Generate Prisma Client, replay the migration, and run the integration test.**

  Run:

  ```powershell
  npm run db:generate
  npm run db:validate
  $env:RUN_DATABASE_INTEGRATION='1'; npx vitest run src/modules/projects/infrastructure/milestones.integration.test.ts
  ```

  Expected: the test passes and proves cross-project, duplicate, and immutable-event protection.

- [ ] **Step 6: Commit the durable storage slice.**

  ```powershell
  git add prisma/schema.prisma prisma/migrations/20260803090000_apm_025_project_execution src/modules/projects/infrastructure/milestones.integration.test.ts
  git commit -m "Add project milestone persistence"
  ```

## Task 3: Implement pure workday progress and milestone state rules

**Files:**
- Create: `src/modules/planning/domain/project-progress.ts`
- Create: `src/modules/planning/domain/project-progress.test.ts`
- Create: `src/modules/projects/domain/project-milestone.ts`
- Create: `src/modules/projects/domain/project-milestone.test.ts`

- [ ] **Step 1: Write failing progress tests for partial completion, completed tasks, closed tasks, and zero denominator.**

  Use this representative assertion:

  ```ts
  expect(calculateProjectProgress([
    { status: "COMPLETED", plannedDurationMinutes: 960, remainingDurationMinutes: 99 },
    { status: "IN_PROGRESS", plannedDurationMinutes: 480, remainingDurationMinutes: 240 },
    { status: "CLOSED", plannedDurationMinutes: 960, remainingDurationMinutes: 0 }
  ], 480)).toEqual({
    status: "READY",
    completedWorkdays: 2.5,
    totalWorkdays: 3,
    percent: 83.33333333333334
  });
  expect(calculateProjectProgress([], 480)).toEqual({ status: "EMPTY" });
  ```

- [ ] **Step 2: Write failing milestone-rule tests.**

  Cover manual achievement, void rejection, and the all-linked-task rule:

  ```ts
  expect(shouldAutoAchieveMilestone({
    status: "PENDING",
    links: [{ status: "ACTIVE", taskStatus: "COMPLETED" }, { status: "ACTIVE", taskStatus: "COMPLETED" }]
  })).toBe(true);
  expect(shouldAutoAchieveMilestone({
    status: "PENDING",
    links: [{ status: "ACTIVE", taskStatus: "COMPLETED" }, { status: "ACTIVE", taskStatus: "IN_PROGRESS" }]
  })).toBe(false);
  ```

- [ ] **Step 3: Run both tests and verify imports fail.**

  Run: `npx vitest run src/modules/planning/domain/project-progress.test.ts src/modules/projects/domain/project-milestone.test.ts`

  Expected: failure because neither module exists.

- [ ] **Step 4: Implement the two pure modules.**

  `calculateProjectProgress` must exclude `CLOSED`, clamp each non-completed task contribution to
  its planned duration, force `COMPLETED` contribution to planned duration, divide aggregates once
  by `minutesPerWorkday`, and never round `percent`. `workdays` are rounded only by the page-format
  function. `shouldAutoAchieveMilestone` must return true only for a `PENDING` milestone with at
  least one active link and every active linked task `COMPLETED`.

- [ ] **Step 5: Run the unit tests and commit.**

  Run:

  ```powershell
  npx vitest run src/modules/planning/domain/project-progress.test.ts src/modules/projects/domain/project-milestone.test.ts
  git add src/modules/planning/domain/project-progress.ts src/modules/planning/domain/project-progress.test.ts src/modules/projects/domain/project-milestone.ts src/modules/projects/domain/project-milestone.test.ts
  git commit -m "Add project execution calculation rules"
  ```

## Task 4: Instantiate and manage project milestones transactionally

**Files:**
- Modify: `src/modules/projects/application/create-project.ts`
- Create: `src/modules/projects/application/milestone-service.ts`
- Modify: `src/modules/audit/domain/vocabulary.ts`
- Modify: `src/modules/projects/contracts/project-http.ts`
- Create: `src/modules/projects/application/milestone-service.test.ts`
- Modify: `src/modules/projects/infrastructure/milestones.integration.test.ts`

- [ ] **Step 1: Write a failing unit test for snapshot instantiation and lifecycle event sequence.**

  Assert that a source snapshot `MILESTONE` component creates two `PENDING` project milestones with
  source component references, and that a manual achievement produces sequence 2 with source
  `MANUAL`:

  ```ts
  expect(result.milestone).toMatchObject({ code: "DESIGN.FREEZE", status: "ACHIEVED", achievementSource: "MANUAL" });
  expect(result.event).toMatchObject({ sequence: 2, eventType: "ACHIEVED_MANUALLY" });
  ```

- [ ] **Step 2: Run the focused service test and verify it fails.**

  Run: `npx vitest run src/modules/projects/application/milestone-service.test.ts`

  Expected: module-not-found or missing exported service functions.

- [ ] **Step 3: Implement `instantiateProjectMilestones` and call it inside project creation.**

  Parse only `MILESTONE` snapshot-component content. For every canonical definition, create the
  milestone and sequence-1 `CREATED` event in the same `inTransaction` callback that creates the
  project snapshot. Do not query mutable template tables after the snapshot has been written.

- [ ] **Step 4: Implement commands with current-version checks and shared audit/Outbox writes.**

  Export `createProjectMilestone`, `updateProjectMilestone`, `voidProjectMilestone`,
  `manuallyAchieveProjectMilestone`, `linkMilestoneTask`, and `voidMilestoneTaskLink`. Each command
  must validate the project is writable, compare `version` with `updateMany`, append the event,
  call `writeAudit`, and call `appendOutboxEvent` in the same transaction. Return HTTP-mappable
  `ProjectMilestoneError` codes for not found, conflict, cross-project relation, invalid state, and
  read-only project.

- [ ] **Step 5: Add integration assertions and run the suite.**

  Assert snapshot-derived rows persist, template updates do not alter them, a stale version yields
  `VERSION_CONFLICT`, void does not delete the row, and the business write/event/audit/Outbox counts
  roll back together on a forced invalid link.

  Run:

  ```powershell
  $env:RUN_DATABASE_INTEGRATION='1'; npx vitest run src/modules/projects/application/milestone-service.test.ts src/modules/projects/infrastructure/milestones.integration.test.ts
  ```

- [ ] **Step 6: Commit the project milestone commands.**

  ```powershell
  git add src/modules/projects/application/create-project.ts src/modules/projects/application/milestone-service.ts src/modules/projects/application/milestone-service.test.ts src/modules/projects/contracts/project-http.ts src/modules/projects/infrastructure/milestones.integration.test.ts src/modules/audit/domain/vocabulary.ts
  git commit -m "Implement project milestone lifecycle"
  ```

## Task 5: Reconcile milestones in the task-progress transaction

**Files:**
- Modify: `src/modules/planning/application/planning-service.ts`
- Modify: `src/modules/projects/application/milestone-service.ts`
- Modify: `src/modules/planning/infrastructure/planning.integration.test.ts`

- [ ] **Step 1: Add a failing transaction test.**

  Seed one milestone linked to two tasks. Complete the first task and assert `PENDING`; complete
  the second and assert `ACHIEVED` with `LINKED_TASKS`; then force the second update to fail and
  assert no new milestone event or Outbox fact exists.

- [ ] **Step 2: Run the test to verify automatic reconciliation is absent.**

  Run: `$env:RUN_DATABASE_INTEGRATION='1'; npx vitest run src/modules/planning/infrastructure/planning.integration.test.ts`

  Expected: the milestone stays `PENDING` after the second completion.

- [ ] **Step 3: Add the reconciliation call after the task update and before transaction return.**

  In `updatePlanningTaskProgress`, call the Projects service with the existing Prisma transaction:

  ```ts
  await reconcileMilestonesForTask(client, {
    projectId: input.projectId,
    taskId: updated.id,
    actorId: input.actorId,
    auditContext: commandAuditContext(input, project, reason),
    reason: `任务 ${updated.code} 完成状态更新：${reason}`
  });
  ```

  The service must query only active links, lock pending milestones deterministically by ID, check
  all active linked task statuses, and append `ACHIEVED_FROM_LINKED_TASKS` exactly once.

- [ ] **Step 4: Re-run the integration test and commit.**

  Run:

  ```powershell
  $env:RUN_DATABASE_INTEGRATION='1'; npx vitest run src/modules/planning/infrastructure/planning.integration.test.ts
  git add src/modules/planning/application/planning-service.ts src/modules/projects/application/milestone-service.ts src/modules/planning/infrastructure/planning.integration.test.ts
  git commit -m "Achieve milestones from completed tasks"
  ```

## Task 6: Expose secure milestone and project execution APIs

**Files:**
- Modify: `src/modules/platform-api/contracts/internal-routes.ts`
- Create: `src/modules/planning/application/project-execution-query.ts`
- Create: `src/modules/planning/contracts/project-execution-http.ts`
- Create: `src/app/api/projects/[projectId]/execution/route.ts`
- Create: `src/app/api/projects/[projectId]/milestones/route.ts`
- Create: `src/app/api/projects/[projectId]/milestones/[milestoneId]/route.ts`
- Create: `src/app/api/projects/[projectId]/milestones/[milestoneId]/[command]/route.ts`
- Create: `src/modules/planning/contracts/project-execution-http.test.ts`

- [ ] **Step 1: Write failing route tests for authorization and stable execution states.**

  Test an outsider receives `403`, a member receives `200`, no effective tasks returns
  `progress.status: "EMPTY"`, an unpublished current forecast returns `schedule.stale: true`, and
  a failed forecast returns its structured error without a stack trace.

- [ ] **Step 2: Define strict request schemas and route paths.**

  Add paths and command bodies with `version`, `reason`, target date, and task IDs. The command path
  must only accept `achieve`, `void`, `link-task`, and `void-task-link`; direct status strings are
  never accepted from the client.

- [ ] **Step 3: Implement the execution query with one normalized DTO.**

  Query the project, effective planning tasks, package summaries, milestones/active links, active
  calendar revision, and `getProjectScheduleForecast` data. Compute `minutesPerWorkday` from the
  active weekly calendar intervals; use 480 only when there is no active calendar. Return source
  IDs and no raw minute fields. Emit a critical exception only when `isCritical` is true and
  `predictedFinishAt > task.plannedFinishAt`.

- [ ] **Step 4: Implement thin project-guarded handlers.**

  `GET /execution` uses `PROJECT_READ`. Milestone GET uses `PROJECT_READ`; all milestone commands
  use `PROJECT_PLAN_UPDATE`, `parseIdempotencyHeaders`, `idempotentCommandResponse`, and
  `auditContextFromRequest`, matching the existing responsibility-package routes.

- [ ] **Step 5: Run contract and PostgreSQL API tests, then commit.**

  Run:

  ```powershell
  npx vitest run src/modules/planning/contracts/project-execution-http.test.ts
  $env:RUN_DATABASE_INTEGRATION='1'; npx vitest run src/modules/projects/infrastructure/milestones.integration.test.ts src/modules/planning/infrastructure/planning.integration.test.ts
  git add src/modules/platform-api/contracts/internal-routes.ts src/modules/planning/application/project-execution-query.ts src/modules/planning/contracts/project-execution-http.ts src/modules/planning/contracts/project-execution-http.test.ts src/app/api/projects/[projectId]/execution src/app/api/projects/[projectId]/milestones
  git commit -m "Expose project execution APIs"
  ```

## Task 7: Build the responsive read-only execution page

**Files:**
- Create: `src/modules/planning/contracts/execution-page-state.ts`
- Create: `src/modules/planning/contracts/execution-page-state.test.ts`
- Create: `src/app/projects/[projectId]/execution/page.tsx`
- Create: `src/app/projects/[projectId]/execution/execution-page-client.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Write the failing pure page-state tests.**

  Test `loading`, `empty`, `error`, `denied`, `stale`, `calculation-pending`,
  `calculation-failed`, `archived`, and populated DTO inputs. For a stale DTO, assert the model
  contains both the latest result timestamp and the pending-state label; it must not discard task
  rows.

- [ ] **Step 2: Run the page-state test and verify it fails because the state mapper is absent.**

  Run: `npx vitest run src/modules/planning/contracts/execution-page-state.test.ts`

- [ ] **Step 3: Implement the pure view model and page component.**

  `buildExecutionPageState` accepts the execution DTO or a typed fetch result and returns a
  discriminated state. The populated state must expose this ordering:

  ```ts
  type PopulatedExecutionState = {
    kind: "populated";
    progress: { completedWorkdays: number; totalWorkdays: number; percent: number; calculatedAt: string };
    exceptions: ExecutionException[];
    nextMilestone: ExecutionMilestone | null;
    criticalTasks: ExecutionTask[];
    responsibilityPackages: ExecutionResponsibilityPackage[];
    milestones: ExecutionMilestone[];
  };
  ```

  Render the approved exception-first desktop layout with a main execution column and milestone
  side column. Render mobile in the exact order: progress, exceptions, next milestone, drill-down
  lists. List row selection uses local URL search parameters `task`, `package`, or `milestone` and
  shows a read-only details region; it never invokes a command API.

- [ ] **Step 4: Implement stable visual states without exposing production fixture controls.**

  Use fixed-size skeleton rows for loading. Render retryable error, denied, empty, stale, pending,
  failed, and archived/read-only labels from the mapped state. Development-only fixture responses
  are allowed only when `process.env.NODE_ENV !== "production"`; production data always comes from
  the guarded execution endpoint.

- [ ] **Step 5: Run unit tests, type check, and build, then commit.**

  Run:

  ```powershell
  npx vitest run src/modules/planning/contracts/execution-page-state.test.ts
  npm run typecheck
  npm run build
  git add src/modules/planning/contracts/execution-page-state.ts src/modules/planning/contracts/execution-page-state.test.ts src/app/projects/[projectId]/execution src/app/globals.css
  git commit -m "Add project execution page"
  ```

## Task 8: Perform browser acceptance and complete the work-package gate

**Files:**
- Modify after all gates pass: `D:/GPT Prj/自动化设备项目管理/规划/APM-开发进度跟踪.html`

- [ ] **Step 1: Start the local application with deterministic development fixtures and inspect the desktop page.**

  Run: `npm run dev`

  Use the in-app browser to open the execution page at a desktop viewport. Verify the first visible
  information is progress/calculate time, then the exception band, then next milestone; click one
  critical task, responsibility package, and milestone and verify the matching read-only detail
  selection.

- [ ] **Step 2: Inspect the mobile page and every required visual state.**

  At a 390px-wide viewport verify normal, loading, empty, error, denied, stale, pending, failed,
  archived/read-only, and all three drill-down selections. Record that the full desktop matrix is
  not squeezed into the mobile viewport and no state causes horizontal overflow.

- [ ] **Step 3: Run all local quality gates.**

  Run:

  ```powershell
  npm run format:check
  npm run lint
  npm run typecheck
  npm run test
  npm run db:generate
  npm run db:validate
  npm run build
  ```

  Expected: every command exits 0.

- [ ] **Step 4: Validate PostgreSQL migration replay in both required states.**

  Run the repository CI-equivalent PostgreSQL 16 workflow (or its exact documented commands) once
  from an empty schema and once after deploying migrations through APM-022. Run database-gated
  Vitest with `RUN_DATABASE_INTEGRATION=1` for each state. Preserve command output showing both
  migration histories finish at `20260803090000_apm_025_project_execution`.

- [ ] **Step 5: Commit any final formatting-only corrections and publish the draft PR.**

  Verify `git status --short` is intentional, then use the GitHub publish workflow to push
  `codex/apm-025` and create a Draft PR with base `codex/apm-022`. Do not update the external
  tracker until every GitHub Actions check is green.

- [ ] **Step 6: Repair CI if needed, then update the external tracker only after acceptance.**

  If a GitHub Actions check fails, inspect the exact run/log, reproduce the failure locally where
  possible, add a focused regression test, fix it, rerun all local gates, push the repair, and wait
  for green CI. Then update the APM-025 row and evidence block in the tracker with date, migration,
  main files, test/command counts, commit/PR/run links, the new workday progress decision, residual
  risk, and next eligible package. Do not change any later work-package status.
