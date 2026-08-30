import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthorizationActor } from "@/lib/auth/authorize";
import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import * as idempotency from "@/modules/platform-api/application/idempotent-command";
import * as definitions from "@/modules/uph/application/uph-definition-service";
import * as batches from "@/modules/uph/application/uph-test-batch-service";

import * as analyses from "./uph-analysis-service";

const runDatabaseIntegration =
  process.env.RUN_DATABASE_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);

type TransactionClient = Prisma.TransactionClient;
type DatabaseClient = PrismaClient | TransactionClient;

type PublishedFixture = {
  projectId: string;
  topologyRootNodeId: string;
  moduleId: string;
  processActor: AuthorizationActor;
  pmActor: AuthorizationActor;
  qualityActor: AuthorizationActor;
  auditContext: AuditContext;
  ids: Record<string, string>;
};

type BatchFixture = PublishedFixture & {
  batchId: string;
  revisionId: string;
  resourceVersion: number;
};

function postgresSqlState(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  const value = candidate.meta?.code ?? candidate.code;
  return typeof value === "string" ? value : undefined;
}

function postgresMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const candidate = error as { message?: unknown; meta?: { message?: unknown } };
  return [candidate.meta?.message, candidate.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

async function expectSqlState(
  action: Promise<unknown>,
  state: "23503" | "23505" | "23514" | "55000",
  message?: RegExp
) {
  await expect(action).rejects.toSatisfy(
    (error: unknown) =>
      postgresSqlState(error) === state && (!message || message.test(postgresMessage(error)))
  );
}

function analysisContext(
  fixture: BatchFixture,
  actor: AuthorizationActor = fixture.processActor
): analyses.CreateUphAnalysisInput {
  return {
    projectId: fixture.projectId,
    batchId: fixture.batchId,
    revisionId: fixture.revisionId,
    actorId: actor.id,
    authorizationActor: actor,
    auditContext: {
      ...fixture.auditContext,
      actorId: actor.id,
      operationId: `uph-082-analysis-${randomUUID()}`
    }
  };
}

function memberActor(
  base: AuthorizationActor,
  grants: AuthorizationActor["grants"]
): AuthorizationActor {
  return { ...base, grants };
}

async function query<T>(
  client: Pick<DatabaseClient, "$queryRawUnsafe">,
  statement: string,
  ...values: unknown[]
): Promise<T[]> {
  return client.$queryRawUnsafe<T[]>(statement, ...values);
}

async function execute(
  client: Pick<DatabaseClient, "$executeRawUnsafe">,
  statement: string,
  ...values: unknown[]
): Promise<number> {
  return client.$executeRawUnsafe(statement, ...values);
}

let publishedFixture: Promise<PublishedFixture> | null = null;
let companyCapabilityEnabled: boolean | null = null;

async function projectVersion(projectId: string): Promise<number> {
  const rows = await query<{ version: number }>(
    db,
    "SELECT version FROM projects WHERE id = $1",
    projectId
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.version;
}

async function seedPublishedFixture(): Promise<PublishedFixture> {
  if (publishedFixture) return publishedFixture;
  publishedFixture = (async () => {
    const suffix = randomUUID();
    const ids = {
      project: `p-uph-082-${suffix}`,
      process: `u-uph-082-process-${suffix}`,
      commission: `u-uph-082-commission-${suffix}`,
      pm: `u-uph-082-pm-${suffix}`,
      quality: `u-uph-082-quality-${suffix}`,
      template: `template-uph-082-${suffix}`,
      templateVersion: `template-version-uph-082-${suffix}`,
      component: `component-uph-082-${suffix}`,
      componentVersion: `component-version-uph-082-${suffix}`,
      snapshot: `snapshot-uph-082-${suffix}`,
      snapshotComponent: `snapshot-component-uph-082-${suffix}`,
      line: `du-uph-082-line-${suffix}`,
      machine: `du-uph-082-machine-${suffix}`,
      module: `module-uph-082-${suffix}`
    };
    const projectCode = `P-UPH082-${suffix.slice(0, 8)}`.toUpperCase();
    const now = "CURRENT_TIMESTAMP";

    await db.$transaction(async (transaction) => {
      const company = await query<{ enabled: boolean }>(
        transaction,
        "SELECT enabled FROM company_capabilities WHERE code = 'UPH_ANALYSIS'"
      );
      companyCapabilityEnabled = company[0]?.enabled ?? null;
      for (const [id, employeeNo, name] of [
        [ids.process, `E-UPH082-PROC-${suffix.slice(0, 8)}`, "Process"],
        [ids.commission, `E-UPH082-COMM-${suffix.slice(0, 8)}`, "Commission"],
        [ids.pm, `E-UPH082-PM-${suffix.slice(0, 8)}`, "PM"],
        [ids.quality, `E-UPH082-QUALITY-${suffix.slice(0, 8)}`, "Quality"]
      ]) {
        await execute(
          transaction,
          `INSERT INTO users(id, employee_no, name, status, version, created_at, updated_at)
           VALUES ($1, $2, $3, 'ACTIVE', 1, ${now}, ${now})`,
          id,
          employeeNo,
          name
        );
      }
      await execute(
        transaction,
        `INSERT INTO templates(id, code, name, status, current_version, version, created_by_id, updated_by_id, created_at, updated_at)
         VALUES ($1, $2, 'UPH 082', 'ACTIVE', 1, 1, $3, $3, ${now}, ${now})`,
        ids.template,
        `UPH.082.${suffix.slice(0, 8)}`.toUpperCase(),
        ids.process
      );
      await execute(
        transaction,
        `INSERT INTO template_versions(id, template_id, version, status, name, checksum, published_by_id, published_at)
         VALUES ($1, $2, 1, 'PUBLISHED', 'UPH 082', repeat('0', 64), $3, ${now})`,
        ids.templateVersion,
        ids.template,
        ids.process
      );
      await execute(
        transaction,
        `INSERT INTO template_components(id, code, component_type, name, draft_content, status, current_version, version, created_by_id, updated_by_id, created_at, updated_at)
         VALUES ($1, $2, 'CAPABILITY_RULE'::"TemplateComponentType", 'UPH capability',
           '{"capabilities":[{"code":"UPH_ANALYSIS","required":false}]}'::jsonb,
           'ACTIVE'::"TemplateMasterStatus", 1, 1, $3, $3, ${now}, ${now})`,
        ids.component,
        `UPH.082.CAPABILITY.${suffix.slice(0, 8)}`.toUpperCase(),
        ids.process
      );
      await execute(
        transaction,
        `INSERT INTO template_component_versions(id, component_id, version, status, component_type, name, content_json, checksum, published_by_id, published_at)
         VALUES ($1, $2, 1, 'PUBLISHED'::"TemplateVersionStatus", 'CAPABILITY_RULE'::"TemplateComponentType", 'UPH capability',
           '{"capabilities":[{"code":"UPH_ANALYSIS","required":false}]}'::jsonb, repeat('0', 64), $3, ${now})`,
        ids.componentVersion,
        ids.component,
        ids.process
      );
      await execute(
        transaction,
        "UPDATE company_capabilities SET enabled = true WHERE code = 'UPH_ANALYSIS'"
      );
      await execute(
        transaction,
        `INSERT INTO projects(id, code, name, status, version, initialization_status, source_template_version_id,
          source_template_checksum, initialized_at, project_type, equipment_shape, structure_status,
          capability_configuration_status, capabilities_configured_at, created_by_id, created_at, updated_at)
         VALUES ($1, $2, 'UPH 082', 'DRAFT', 1, 'READY', $3, repeat('0', 64), ${now},
           'CUSTOMER_DELIVERY', 'LINE', 'READY', 'READY', ${now}, $4, ${now}, ${now})`,
        ids.project,
        projectCode,
        ids.templateVersion,
        ids.process
      );
      const insertedSnapshotRows = await execute(
        transaction,
        `INSERT INTO project_template_snapshots(id, project_id, source_template_version_id, source_template_checksum,
          snapshot_checksum, template_code, template_name, template_version, template_published_at)
         SELECT $1, $2, template_version.id, template_version.checksum, repeat('0', 64),
           template.code, template_version.name, template_version.version, template_version.published_at
         FROM template_versions template_version
         JOIN templates template ON template.id = template_version.template_id
         WHERE template_version.id = $3`,
        ids.snapshot,
        ids.project,
        ids.templateVersion
      );
      expect(insertedSnapshotRows).toBe(1);
      const insertedSnapshotComponentRows = await execute(
        transaction,
        `INSERT INTO project_template_snapshot_components(id, snapshot_id, source_component_version_id, component_type,
          slot, position, source_checksum, component_code, component_name, component_version, description, content_json)
         SELECT $1, $2, component_version.id, component_version.component_type, 'CAPABILITY_RULE', 0,
           component_version.checksum, component.code, component_version.name, component_version.version,
           component_version.description, component_version.content_json
         FROM template_component_versions component_version
         JOIN template_components component ON component.id = component_version.component_id
         WHERE component_version.id = $3`,
        ids.snapshotComponent,
        ids.snapshot,
        ids.componentVersion
      );
      expect(insertedSnapshotComponentRows).toBe(1);
      await execute(
        transaction,
        `INSERT INTO project_capabilities(project_id, capability_code, template_allowed, template_required,
          selected_enabled, source_snapshot_component_id, version, created_by_id, updated_by_id, created_at, updated_at)
         VALUES ($1, 'UPH_ANALYSIS', true, false, true, $2, 1, $3, $3, ${now}, ${now})`,
        ids.project,
        ids.snapshotComponent,
        ids.process
      );
      await execute(
        transaction,
        `INSERT INTO delivery_units(id, project_id, parent_id, unit_type, code, name, status, position, version, created_by_id, updated_by_id, created_at, updated_at)
         VALUES ($1, $2, NULL, 'LINE', 'LINE-082', 'Line 082', 'ACTIVE', 0, 1, $3, $3, ${now}, ${now}),
                ($4, $2, $1, 'MACHINE', 'MACHINE-082', 'Machine 082', 'ACTIVE', 0, 1, $3, $3, ${now}, ${now})`,
        ids.line,
        ids.project,
        ids.process,
        ids.machine
      );
      await execute(
        transaction,
        `INSERT INTO project_modules(id, project_id, delivery_unit_id, code, name, status, position, version, created_by_id, updated_by_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'MOD-082', 'Module 082', 'ACTIVE', 0, 1, $4, $4, ${now}, ${now})`,
        ids.module,
        ids.project,
        ids.machine,
        ids.process
      );
      await execute(
        transaction,
        `INSERT INTO project_members(id, project_id, user_id, project_role, assigned_by_id, joined_at, version)
         VALUES ($1, $2, $3, 'ENGINEER', $3, ${now}, 1),
                ($4, $2, $5, 'ENGINEER', $3, ${now}, 1),
                ($6, $2, $7, 'PROJECT_MANAGER', $3, ${now}, 1),
                ($8, $2, $9, 'QUALITY', $3, ${now}, 1)`,
        `member-process-${suffix}`,
        ids.project,
        ids.process,
        `member-commission-${suffix}`,
        ids.commission,
        `member-pm-${suffix}`,
        ids.pm,
        `member-quality-${suffix}`,
        ids.quality
      );
    });

    const processActor = {
      id: ids.process,
      name: "Process",
      status: "ACTIVE",
      departmentId: null,
      systemRoles: [],
      grants: [
        { permission: "PROJECT_UPH_BATCH_MANAGE", scope: "PROJECT", systemRole: "ENGINEER" },
        { permission: "PROJECT_UPH_ANALYZE", scope: "PROJECT", systemRole: "ENGINEER" },
        { permission: "PROJECT_UPH_READ", scope: "PROJECT", systemRole: "ENGINEER" }
      ]
    } satisfies AuthorizationActor;
    const commissioningActor = { ...processActor, id: ids.commission, name: "Commission" };
    const pmActor = {
      ...processActor,
      id: ids.pm,
      name: "PM",
      grants: [
        {
          permission: "PROJECT_UPH_BATCH_CONFIRM",
          scope: "PROJECT",
          systemRole: "PROJECT_MANAGER"
        },
        { permission: "PROJECT_UPH_ANALYZE", scope: "PROJECT", systemRole: "PROJECT_MANAGER" },
        { permission: "PROJECT_UPH_READ", scope: "PROJECT", systemRole: "PROJECT_MANAGER" }
      ]
    } satisfies AuthorizationActor;
    const qualityActor = {
      ...processActor,
      id: ids.quality,
      name: "Quality",
      grants: [
        { permission: "PROJECT_UPH_BATCH_LOCK", scope: "PROJECT", systemRole: "QUALITY" },
        { permission: "PROJECT_UPH_ANALYZE", scope: "PROJECT", systemRole: "QUALITY" },
        { permission: "PROJECT_UPH_READ", scope: "PROJECT", systemRole: "QUALITY" }
      ]
    } satisfies AuthorizationActor;
    const auditContext = {
      actorId: processActor.id,
      requestId: `uph-082-pg-${suffix}`,
      traceId: null,
      source: "API",
      sourceIp: null,
      userAgent: null,
      reason: null,
      projectId: ids.project,
      departmentId: null,
      operationId: `uph-082-pg-${suffix}`
    } satisfies AuditContext;

    const topology = await definitions.createUphDefinition({
      projectId: ids.project,
      actorId: processActor.id,
      authorizationActor: processActor,
      body: {
        kind: "TOPOLOGY",
        projectVersion: await projectVersion(ids.project),
        content: {
          projectShape: "LINE",
          roots: [
            {
              sourceId: ids.line,
              sourceType: "LINE",
              parentSourceId: null,
              relation: "ROOT",
              capacity: 100,
              children: [
                {
                  sourceId: ids.machine,
                  sourceType: "MACHINE",
                  parentSourceId: ids.line,
                  relation: "MANDATORY",
                  capacity: 100,
                  children: [
                    {
                      sourceId: ids.module,
                      sourceType: "MODULE",
                      parentSourceId: ids.machine,
                      relation: "MANDATORY",
                      capacity: 100
                    }
                  ]
                }
              ]
            }
          ]
        }
      },
      auditContext
    });
    const signedTopology = await definitions.signoffUphDefinition({
      projectId: ids.project,
      kind: "TOPOLOGY",
      versionId: topology.id,
      resourceVersion: topology.resourceVersion,
      actorId: commissioningActor.id,
      authorizationActor: commissioningActor,
      auditContext: { ...auditContext, actorId: commissioningActor.id }
    });
    await definitions.publishUphDefinition({
      projectId: ids.project,
      kind: "TOPOLOGY",
      versionId: topology.id,
      resourceVersion: signedTopology.resourceVersion,
      actorId: qualityActor.id,
      authorizationActor: qualityActor,
      auditContext: { ...auditContext, actorId: qualityActor.id }
    });
    const topologyRoots = await query<{ id: string }>(
      db,
      `SELECT id FROM project_uph_topology_nodes
       WHERE topology_version_id = $1 AND delivery_unit_id = $2 AND parent_relation = 'ROOT'`,
      topology.id,
      ids.line
    );
    expect(topologyRoots).toHaveLength(1);

    const ct = await definitions.createUphDefinition({
      projectId: ids.project,
      actorId: processActor.id,
      authorizationActor: processActor,
      body: {
        kind: "CT",
        projectVersion: await projectVersion(ids.project),
        content: {
          projectModuleId: ids.module,
          intrinsicCtSeconds: 12,
          outputPerCycleTotal: 1,
          parallelChannelCount: 1,
          cavityCount: 1
        }
      },
      auditContext
    });
    const signedCt = await definitions.signoffUphDefinition({
      projectId: ids.project,
      kind: "CT",
      versionId: ct.id,
      resourceVersion: ct.resourceVersion,
      actorId: commissioningActor.id,
      authorizationActor: commissioningActor,
      auditContext: { ...auditContext, actorId: commissioningActor.id }
    });
    await definitions.publishUphDefinition({
      projectId: ids.project,
      kind: "CT",
      versionId: ct.id,
      resourceVersion: signedCt.resourceVersion,
      actorId: qualityActor.id,
      authorizationActor: qualityActor,
      auditContext: { ...auditContext, actorId: qualityActor.id }
    });
    const formula = await definitions.createUphDefinition({
      projectId: ids.project,
      actorId: processActor.id,
      authorizationActor: processActor,
      body: {
        kind: "FORMULA",
        projectVersion: await projectVersion(ids.project),
        content: {
          formulaCode: "CANONICAL_UPH_V1",
          formulaJson: {
            numerator: "3600*outputPerCycleTotal*parallelChannelCount",
            denominator: "intrinsicCtSeconds"
          }
        }
      },
      auditContext
    });
    await definitions.publishUphDefinition({
      projectId: ids.project,
      kind: "FORMULA",
      versionId: formula.id,
      resourceVersion: formula.resourceVersion,
      actorId: qualityActor.id,
      authorizationActor: qualityActor,
      auditContext: { ...auditContext, actorId: qualityActor.id }
    });
    return {
      projectId: ids.project,
      topologyRootNodeId: topologyRoots[0]!.id,
      moduleId: ids.module,
      processActor,
      pmActor,
      qualityActor,
      auditContext,
      ids
    };
  })();
  return publishedFixture;
}

async function createBatchFixture(
  options: {
    state?: "DRAFT" | "PM_CONFIRMED" | "LOCKED";
    actualGrossOutputCount?: number;
    finalGoodOutputCount?: number;
  } = {}
): Promise<BatchFixture> {
  const published = await seedPublishedFixture();
  const state = options.state ?? "LOCKED";
  const created = await batches.createUphTestBatch({
    projectId: published.projectId,
    actorId: published.processActor.id,
    authorizationActor: published.processActor,
    body: {
      batchNumber: `ANALYSIS-${randomUUID()}`,
      topologyRootNodeId: published.topologyRootNodeId,
      plannedProductionSeconds: 3600,
      planDeclarationReason: "APM-082 exact locked analysis fixture",
      observationStartedAt: "2026-08-26T08:00:00.000Z",
      observationEndedAt: "2026-08-26T09:00:00.000Z",
      timezone: "Asia/Shanghai"
    },
    auditContext: published.auditContext
  });
  let resourceVersion = created.resourceVersion;
  for (let ordinal = 1; ordinal <= 10; ordinal += 1) {
    const sample = await batches.appendUphCycleSample({
      projectId: published.projectId,
      batchId: created.batchId,
      revisionId: created.revisionId,
      actorId: published.processActor.id,
      authorizationActor: published.processActor,
      resourceVersion,
      body: {
        projectModuleId: published.moduleId,
        ordinal,
        sourceEventId: `analysis-device-${created.revisionId}-${ordinal}`,
        cycleDurationSeconds: `${ordinal}.000000`,
        observedAt: `2026-08-26T08:${String(ordinal).padStart(2, "0")}:00.000Z`,
        captureMethod: "DEVICE_EVENT",
        disposition: "INCLUDED"
      },
      auditContext: published.auditContext
    });
    resourceVersion = sample.resourceVersion;
  }
  const afterSamples = await batches.getUphTestBatchRevision({
    projectId: published.projectId,
    batchId: created.batchId,
    revisionId: created.revisionId,
    authorizationActor: published.processActor,
    projectMemberRoles: ["ENGINEER"]
  });
  const production = await batches.updateUphTestBatchProductionCount({
    projectId: published.projectId,
    batchId: created.batchId,
    revisionId: created.revisionId,
    actorId: published.processActor.id,
    authorizationActor: published.processActor,
    resourceVersion: afterSamples.resourceVersion,
    body: {
      actualGrossOutputCount: options.actualGrossOutputCount ?? 100,
      finalGoodOutputCount: options.finalGoodOutputCount ?? 90
    },
    auditContext: published.auditContext
  });
  const quality = await batches.updateUphTestBatchModuleQualityCount({
    projectId: published.projectId,
    batchId: created.batchId,
    revisionId: created.revisionId,
    moduleId: published.moduleId,
    actorId: published.processActor.id,
    authorizationActor: published.processActor,
    resourceVersion: production.resourceVersion,
    body: {
      qualityInputCount: 10,
      firstPassGoodCount: 8,
      firstPassNonconformingCount: 2,
      reworkInputCount: 2,
      reworkRecoveredGoodCount: 1
    },
    auditContext: published.auditContext
  });
  if (state === "DRAFT")
    return { ...published, ...created, resourceVersion: quality.resourceVersion };
  const confirmed = await batches.confirmUphTestBatch({
    projectId: published.projectId,
    batchId: created.batchId,
    revisionId: created.revisionId,
    actorId: published.pmActor.id,
    authorizationActor: published.pmActor,
    resourceVersion: quality.resourceVersion,
    auditContext: { ...published.auditContext, actorId: published.pmActor.id }
  });
  if (state === "PM_CONFIRMED") {
    return { ...published, ...created, resourceVersion: confirmed.resourceVersion };
  }
  const locked = await batches.lockUphTestBatch({
    projectId: published.projectId,
    batchId: created.batchId,
    revisionId: created.revisionId,
    actorId: published.qualityActor.id,
    authorizationActor: published.qualityActor,
    resourceVersion: confirmed.resourceVersion,
    auditContext: { ...published.auditContext, actorId: published.qualityActor.id }
  });
  return { ...published, ...created, resourceVersion: locked.resourceVersion };
}

async function countFacts(fixture: BatchFixture): Promise<{
  snapshots: number;
  audits: number;
  outbox: number;
  completedResponses: number;
}> {
  const counts = await query<{
    snapshots: bigint;
    audits: bigint;
    outbox: bigint;
    completedResponses: bigint;
  }>(
    db,
    `SELECT
       (SELECT count(*) FROM project_uph_analysis_snapshots WHERE project_id = $1 AND revision_id = $2) AS snapshots,
       (SELECT count(*) FROM audit_logs WHERE project_id = $1 AND action = 'UPH_ANALYSIS_SNAPSHOT_CREATED'
          AND object_id IN (SELECT id FROM project_uph_analysis_snapshots WHERE project_id = $1 AND revision_id = $2)) AS audits,
       (SELECT count(*) FROM outbox_events WHERE event_type = 'uph.analysis-snapshot.created'
          AND payload->>'projectId' = $1 AND payload->>'revisionId' = $2) AS outbox,
       (SELECT count(*) FROM api_idempotency_records WHERE actor_id = $3 AND completed_at IS NOT NULL
          AND response_json->>'revisionId' = $2) AS "completedResponses"`,
    fixture.projectId,
    fixture.revisionId,
    fixture.processActor.id
  );
  const value = counts[0]!;
  return {
    snapshots: Number(value.snapshots),
    audits: Number(value.audits),
    outbox: Number(value.outbox),
    completedResponses: Number(value.completedResponses)
  };
}

async function rollbackProbe(
  operation: (transaction: TransactionClient) => Promise<void>
): Promise<void> {
  const marker = new Error("APM-082 rollback probe complete");
  try {
    await db.$transaction(async (transaction) => {
      await operation(transaction);
      throw marker;
    });
  } catch (error) {
    if (error !== marker) throw error;
  }
}

async function cleanupFixture(): Promise<void> {
  if (!publishedFixture) return;
  const fixture = await publishedFixture;
  await db.$transaction(async (transaction) => {
    await execute(transaction, "SET LOCAL session_replication_role = replica");
    await execute(
      transaction,
      `DELETE FROM outbox_events WHERE aggregate_id IN (
        SELECT id FROM project_uph_analysis_snapshots WHERE project_id = $1
        UNION SELECT id FROM project_uph_test_batch_revisions WHERE project_id = $1
        UNION SELECT id FROM project_uph_test_batches WHERE project_id = $1
      )`,
      fixture.projectId
    );
    await execute(transaction, "DELETE FROM audit_logs WHERE project_id = $1", fixture.projectId);
    await execute(
      transaction,
      "DELETE FROM api_idempotency_records WHERE actor_id LIKE $1",
      `${fixture.ids.process}%`
    );
    for (const table of [
      "project_uph_analysis_snapshots",
      "project_uph_test_batch_revision_evidence",
      "project_uph_module_cycle_samples",
      "project_uph_test_batch_revision_production_counts",
      "project_uph_test_batch_revision_module_bindings",
      "project_uph_test_batch_revisions",
      "project_uph_test_batches",
      "project_uph_ct_definition_versions",
      "project_uph_ct_definitions",
      "project_uph_topology_nodes",
      "project_uph_topology_versions",
      "project_uph_topologies",
      "project_uph_formula_versions",
      "project_uph_formulas",
      "project_capabilities",
      "project_modules",
      "project_members",
      "delivery_units"
    ]) {
      await execute(transaction, `DELETE FROM ${table} WHERE project_id = $1`, fixture.projectId);
    }
    await execute(
      transaction,
      "DELETE FROM project_template_snapshot_components WHERE snapshot_id = $1",
      fixture.ids.snapshot
    );
    await execute(
      transaction,
      "DELETE FROM project_template_snapshots WHERE project_id = $1",
      fixture.projectId
    );
    await execute(transaction, "DELETE FROM projects WHERE id = $1", fixture.projectId);
    await execute(
      transaction,
      "DELETE FROM template_component_versions WHERE id = $1",
      fixture.ids.componentVersion
    );
    await execute(
      transaction,
      "DELETE FROM template_components WHERE id = $1",
      fixture.ids.component
    );
    await execute(
      transaction,
      "DELETE FROM template_versions WHERE id = $1",
      fixture.ids.templateVersion
    );
    await execute(transaction, "DELETE FROM templates WHERE id = $1", fixture.ids.template);
    await execute(
      transaction,
      "DELETE FROM users WHERE id IN ($1, $2, $3, $4)",
      fixture.ids.process,
      fixture.ids.commission,
      fixture.ids.pm,
      fixture.ids.quality
    );
    if (companyCapabilityEnabled !== null) {
      await execute(
        transaction,
        "UPDATE company_capabilities SET enabled = $1 WHERE code = 'UPH_ANALYSIS'",
        companyCapabilityEnabled
      );
    }
  });
}

describe.skipIf(!runDatabaseIntegration)(
  "APM-082 UPH analysis PostgreSQL acceptance matrix",
  () => {
    beforeAll(async () => {
      await db.$connect();
    });

    afterAll(async () => {
      try {
        await cleanupFixture();
      } finally {
        await db.$disconnect();
      }
    });

    it("checks migration 60's exact composite FKs, unique input, checks, immutable guards, and deferred insert-only trigger", async () => {
      const constraints = await query<{ name: string; definition: string }>(
        db,
        `SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'project_uph_analysis_snapshots'::regclass ORDER BY conname`
      );
      const byName = new Map(constraints.map((row) => [row.name, row.definition]));
      expect(byName.get("project_uph_analysis_snapshots_batch_fkey")).toContain(
        "FOREIGN KEY (batch_id, project_id) REFERENCES project_uph_test_batches(id, project_id)"
      );
      expect(byName.get("project_uph_analysis_snapshots_revision_fkey")).toContain(
        "FOREIGN KEY (revision_id, project_id) REFERENCES project_uph_test_batch_revisions(id, project_id)"
      );
      expect(byName.get("project_uph_analysis_snapshots_formula_fkey")).toContain(
        "FOREIGN KEY (formula_version_id, project_id) REFERENCES project_uph_formula_versions(id, project_id)"
      );
      expect(byName.get("project_uph_analysis_snapshots_unique_engine")).toContain(
        "UNIQUE (project_id, revision_id, locked_checksum, engine_code)"
      );
      expect([...byName.keys()].some((name) => name.endsWith("_check"))).toBe(true);
      const triggers = await query<{ name: string; isConstraint: boolean; isDeferrable: boolean }>(
        db,
        `SELECT tgname AS name, (tgconstraint <> 0) AS "isConstraint", tgdeferrable AS "isDeferrable" FROM pg_trigger WHERE tgrelid = 'project_uph_analysis_snapshots'::regclass AND NOT tgisinternal ORDER BY tgname`
      );
      expect(
        triggers.find((trigger) => trigger.name === "project_uph_analysis_snapshot_commit_guard")
      ).toMatchObject({ isConstraint: true, isDeferrable: true });
      expect(triggers.map((trigger) => trigger.name)).toEqual(
        expect.arrayContaining([
          "project_uph_analysis_snapshot_insert_guard",
          "project_uph_analysis_snapshot_immutable_guard",
          "project_uph_analysis_snapshot_truncate_guard"
        ])
      );
    });

    it("creates deterministic COMPUTED and NO_OUTPUT snapshots from real APM-080/081 LOCKED facts", async () => {
      const computedFixture = await createBatchFixture();
      const computed = await analyses.createUphAnalysis(analysisContext(computedFixture));
      expect(computed).toMatchObject({
        projectId: computedFixture.projectId,
        batchId: computedFixture.batchId,
        revisionId: computedFixture.revisionId,
        status: "COMPUTED",
        createdById: computedFixture.processActor.id,
        actualGoodUph: "90.000000",
        resourceVersion: 1
      });
      expect(computed.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(computed.rootMeasuredCapacityUph).toMatch(/^\d+\.\d{6}$/u);
      expect(computed.inputSnapshot).toMatchObject({ lockedChecksum: computed.lockedChecksum });
      expect(computed.resultSnapshot).toMatchObject({
        status: "COMPUTED",
        reductionLevels: expect.any(Array),
        bottleneck: expect.any(Array),
        warnings: expect.any(Array)
      });
      expect(await countFacts(computedFixture)).toMatchObject({
        snapshots: 1,
        audits: 1,
        outbox: 1
      });

      const zeroFixture = await createBatchFixture({
        actualGrossOutputCount: 0,
        finalGoodOutputCount: 0
      });
      const zero = await analyses.createUphAnalysis(analysisContext(zeroFixture));
      expect(zero).toMatchObject({ status: "NO_OUTPUT", actualGoodUph: "0.000000", a: "0.000000" });
      expect(zero.resultSnapshot).toMatchObject({
        status: "NO_OUTPUT",
        reductionLevels: expect.any(Array),
        moduleFpy: expect.any(Array)
      });
    });

    it("rejects DRAFT, PM_CONFIRMED, SUPERSEDED, and pointer-drift revisions with 409 and no snapshot facts", async () => {
      for (const state of ["DRAFT", "PM_CONFIRMED"] as const) {
        const fixture = await createBatchFixture({ state });
        await expect(analyses.createUphAnalysis(analysisContext(fixture))).rejects.toMatchObject({
          status: 409
        });
        expect(await countFacts(fixture)).toMatchObject({ snapshots: 0, audits: 0, outbox: 0 });
      }
      const locked = await createBatchFixture();
      await rollbackProbe(async (transaction) => {
        await execute(transaction, "SET LOCAL session_replication_role = replica");
        await execute(
          transaction,
          "UPDATE project_uph_test_batch_revisions SET status = 'SUPERSEDED' WHERE id = $1",
          locked.revisionId
        );
        await expect(
          analyses.createUphAnalysis(analysisContext(locked), transaction)
        ).rejects.toMatchObject({ code: "LOCKED_REVISION_REQUIRED", status: 409 });
      });
      await rollbackProbe(async (transaction) => {
        await execute(transaction, "SET LOCAL session_replication_role = replica");
        await execute(
          transaction,
          "UPDATE project_uph_test_batches SET current_locked_revision_id = NULL WHERE id = $1",
          locked.batchId
        );
        await expect(
          analyses.createUphAnalysis(analysisContext(locked), transaction)
        ).rejects.toMatchObject({ code: "LOCKED_REVISION_REQUIRED", status: 409 });
      });
      expect(await countFacts(locked)).toMatchObject({ snapshots: 0, audits: 0, outbox: 0 });
    });

    it("rejects corrupted checksum/statistic/formula facts as 422 without persisting an analysis", async () => {
      const fixture = await createBatchFixture();
      for (const mutation of [
        "UPDATE project_uph_test_batch_revisions SET locked_checksum = repeat('f', 64) WHERE id = $1",
        "UPDATE project_uph_test_batch_revision_module_bindings SET valid_sample_count = 11 WHERE revision_id = $1",
        `UPDATE project_uph_test_batch_revision_module_bindings
         SET valid_sample_count = NULL, excluded_sample_count = NULL, arithmetic_mean_seconds = NULL,
             p50_seconds = NULL, p90_seconds = NULL, max_seconds = NULL,
             spread_p90_minus_p50_seconds = NULL
         WHERE revision_id = $1`
      ]) {
        await rollbackProbe(async (transaction) => {
          await execute(transaction, "SET LOCAL session_replication_role = replica");
          await execute(transaction, mutation, fixture.revisionId);
          await expect(
            analyses.createUphAnalysis(analysisContext(fixture), transaction)
          ).rejects.toMatchObject({ status: 422 });
        });
        expect(await countFacts(fixture)).toMatchObject({ snapshots: 0, audits: 0, outbox: 0 });
      }
      await rollbackProbe(async (transaction) => {
        await execute(
          transaction,
          "ALTER TABLE project_uph_formula_versions DROP CONSTRAINT project_uph_formula_versions_check"
        );
        await execute(transaction, "SET LOCAL session_replication_role = replica");
        expect(
          await execute(
            transaction,
            `UPDATE project_uph_formula_versions SET formula_code = 'UNSUPPORTED'
             WHERE id = (SELECT formula_version_id FROM project_uph_test_batch_revisions WHERE id = $1)`,
            fixture.revisionId
          )
        ).toBe(1);
        await expect(
          analyses.createUphAnalysis(analysisContext(fixture), transaction)
        ).rejects.toMatchObject({ code: "ANALYSIS_FORMULA_UNSUPPORTED", status: 422 });
      });
      await expect(
        query<{ name: string }>(
          db,
          `SELECT conname AS name FROM pg_constraint
           WHERE conrelid = 'project_uph_formula_versions'::regclass
             AND conname = 'project_uph_formula_versions_check'`
        )
      ).resolves.toEqual([{ name: "project_uph_formula_versions_check" }]);
      await expect(
        query<{ formulaCode: string }>(
          db,
          `SELECT formula_code AS "formulaCode" FROM project_uph_formula_versions
           WHERE id = (SELECT formula_version_id FROM project_uph_test_batch_revisions WHERE id = $1)`,
          fixture.revisionId
        )
      ).resolves.toEqual([{ formulaCode: "CANONICAL_UPH_V1" }]);
      expect(await countFacts(fixture)).toMatchObject({ snapshots: 0, audits: 0, outbox: 0 });
    });

    it("enforces active authorization and composite IDOR scopes, while historical SUPERSEDED snapshot detail remains readable", async () => {
      const fixture = await createBatchFixture();
      const noGrant = memberActor(fixture.processActor, []);
      await expect(
        analyses.createUphAnalysis(analysisContext(fixture, noGrant))
      ).rejects.toMatchObject({ status: 403 });
      const readOnly = memberActor(fixture.processActor, [
        { permission: "PROJECT_UPH_READ", scope: "PROJECT", systemRole: "ENGINEER" }
      ]);
      await expect(
        analyses.createUphAnalysis(analysisContext(fixture, readOnly))
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        analyses.createUphAnalysis({
          ...analysisContext(fixture),
          batchId: `missing-${randomUUID()}`
        })
      ).rejects.toMatchObject({ status: 404 });
      await rollbackProbe(async (transaction) => {
        await execute(transaction, "SET LOCAL session_replication_role = replica");
        await execute(
          transaction,
          "UPDATE project_members SET left_at = CURRENT_TIMESTAMP WHERE project_id = $1 AND user_id = $2",
          fixture.projectId,
          fixture.processActor.id
        );
        await expect(
          analyses.createUphAnalysis(analysisContext(fixture), transaction)
        ).rejects.toMatchObject({ status: 403 });
      });
      await rollbackProbe(async (transaction) => {
        await execute(transaction, "SET LOCAL session_replication_role = replica");
        await execute(
          transaction,
          "UPDATE users SET status = 'DISABLED' WHERE id = $1",
          fixture.processActor.id
        );
        await expect(
          analyses.createUphAnalysis(analysisContext(fixture), transaction)
        ).rejects.toMatchObject({ status: 403 });
      });

      const created = await analyses.createUphAnalysis(analysisContext(fixture));
      const analyzeOnly = memberActor(fixture.processActor, [
        { permission: "PROJECT_UPH_ANALYZE", scope: "PROJECT", systemRole: "ENGINEER" }
      ]);
      await expect(
        analyses.getUphAnalysis({
          ...analysisContext(fixture, analyzeOnly),
          analysisId: created.analysisId
        })
      ).rejects.toMatchObject({ status: 403 });
      await db.$transaction(async (transaction) => {
        await execute(transaction, "SET LOCAL session_replication_role = replica");
        await execute(
          transaction,
          "UPDATE project_uph_test_batch_revisions SET status = 'SUPERSEDED' WHERE id = $1",
          fixture.revisionId
        );
      });
      await expect(
        analyses.getUphAnalysis({ ...analysisContext(fixture), analysisId: created.analysisId })
      ).resolves.toMatchObject({ analysisId: created.analysisId });
      await expect(analyses.listUphAnalyses(analysisContext(fixture))).resolves.toMatchObject({
        items: [expect.objectContaining({ analysisId: created.analysisId })]
      });
      const pmFixture = await createBatchFixture();
      await expect(
        analyses.createUphAnalysis(analysisContext(pmFixture, pmFixture.pmActor))
      ).resolves.toMatchObject({ createdById: pmFixture.pmActor.id });
      const qualityFixture = await createBatchFixture();
      await expect(
        analyses.createUphAnalysis(analysisContext(qualityFixture, qualityFixture.qualityActor))
      ).resolves.toMatchObject({ createdById: qualityFixture.qualityActor.id });
    });

    it("rejects direct checksum, duplicate, composite-FK, UPDATE, DELETE, and TRUNCATE probes", async () => {
      const fixture = await createBatchFixture();
      const created = await analyses.createUphAnalysis(analysisContext(fixture));
      const clone = (patch: string) =>
        execute(
          db,
          `INSERT INTO project_uph_analysis_snapshots SELECT (jsonb_populate_record(NULL::project_uph_analysis_snapshots, to_jsonb(snapshot) || jsonb_build_object('id', $1, ${patch}))).* FROM project_uph_analysis_snapshots snapshot WHERE snapshot.id = $2`,
          `analysis-probe-${randomUUID()}`,
          created.analysisId
        );
      await expectSqlState(
        clone("'input_checksum', repeat('0', 64)"),
        "23514",
        /canonical snapshot/u
      );
      await expectSqlState(
        clone("'formula_checksum', repeat('0', 64)"),
        "23514",
        /formula checksum/u
      );
      await expectSqlState(
        clone("'locked_checksum', repeat('f', 64)"),
        "23514",
        /locked checksum/u
      );
      await expectSqlState(
        clone("'result_checksum', repeat('0', 64)"),
        "23514",
        /canonical snapshot/u
      );
      await expectSqlState(clone("'created_at', CURRENT_TIMESTAMP"), "23505");
      await expectSqlState(
        execute(
          db,
          "UPDATE project_uph_analysis_snapshots SET engine_code = 'changed' WHERE id = $1",
          created.analysisId
        ),
        "55000",
        /immutable/u
      );
      await expectSqlState(
        execute(db, "DELETE FROM project_uph_analysis_snapshots WHERE id = $1", created.analysisId),
        "55000",
        /immutable/u
      );
      await expectSqlState(
        execute(db, "TRUNCATE project_uph_analysis_snapshots"),
        "55000",
        /TRUNCATE/u
      );

      await rollbackProbe(async (transaction) => {
        await execute(
          transaction,
          "ALTER TABLE project_uph_analysis_snapshots DISABLE TRIGGER project_uph_analysis_snapshot_insert_guard"
        );
        await execute(
          transaction,
          `INSERT INTO project_uph_analysis_snapshots SELECT (jsonb_populate_record(NULL::project_uph_analysis_snapshots, to_jsonb(snapshot) || jsonb_build_object('id', $1, 'batch_id', $2, 'engine_code', 'UPH_ANALYSIS@FK_BATCH'))).* FROM project_uph_analysis_snapshots snapshot WHERE snapshot.id = $3`,
          `analysis-fk-batch-${randomUUID()}`,
          `missing-batch-${randomUUID()}`,
          created.analysisId
        );
        await expectSqlState(
          execute(
            transaction,
            'SET CONSTRAINTS "project_uph_analysis_snapshots_batch_fkey" IMMEDIATE'
          ),
          "23503"
        );
      });
      await rollbackProbe(async (transaction) => {
        await execute(
          transaction,
          "ALTER TABLE project_uph_analysis_snapshots DISABLE TRIGGER project_uph_analysis_snapshot_insert_guard"
        );
        await execute(
          transaction,
          `INSERT INTO project_uph_analysis_snapshots SELECT (jsonb_populate_record(NULL::project_uph_analysis_snapshots, to_jsonb(snapshot) || jsonb_build_object('id', $1, 'revision_id', $2, 'engine_code', 'UPH_ANALYSIS@FK_REVISION'))).* FROM project_uph_analysis_snapshots snapshot WHERE snapshot.id = $3`,
          `analysis-fk-revision-${randomUUID()}`,
          `missing-revision-${randomUUID()}`,
          created.analysisId
        );
        await expectSqlState(
          execute(
            transaction,
            'SET CONSTRAINTS "project_uph_analysis_snapshots_revision_fkey" IMMEDIATE'
          ),
          "23503"
        );
      });
      await rollbackProbe(async (transaction) => {
        await execute(
          transaction,
          "ALTER TABLE project_uph_analysis_snapshots DISABLE TRIGGER project_uph_analysis_snapshot_insert_guard"
        );
        await expectSqlState(
          execute(
            transaction,
            `INSERT INTO project_uph_analysis_snapshots SELECT (jsonb_populate_record(NULL::project_uph_analysis_snapshots,
              to_jsonb(snapshot) || jsonb_build_object('id', $1, 'formula_version_id', $2, 'engine_code', 'UPH_ANALYSIS@FK_FORMULA'))).*
             FROM project_uph_analysis_snapshots snapshot WHERE snapshot.id = $3`,
            `analysis-fk-formula-${randomUUID()}`,
            `missing-formula-${randomUUID()}`,
            created.analysisId
          ),
          "23503"
        );
      });
      await rollbackProbe(async (transaction) => {
        const engineCode = "UPH_ANALYSIS@2";
        await execute(
          transaction,
          `WITH source AS (
            SELECT snapshot.*,
              jsonb_set(snapshot.input_snapshot_json, '{engineCode}', to_jsonb($1::text)) AS input_json,
              jsonb_set(snapshot.result_snapshot_json, '{engineCode}', to_jsonb($1::text)) AS result_json
            FROM project_uph_analysis_snapshots snapshot WHERE snapshot.id = $2
          ) INSERT INTO project_uph_analysis_snapshots
            SELECT (jsonb_populate_record(NULL::project_uph_analysis_snapshots,
              to_jsonb(source) || jsonb_build_object(
                'id', $3, 'engine_code', $1, 'input_snapshot_json', source.input_json,
                'input_checksum', "uph_analysis_snapshot_checksum"(source.input_json),
                'result_snapshot_json', source.result_json,
                'result_checksum', "uph_analysis_snapshot_checksum"(source.result_json)
              ))).* FROM source`,
          engineCode,
          created.analysisId,
          `analysis-deferred-${randomUUID()}`
        );
        await execute(transaction, "SET LOCAL session_replication_role = replica");
        await execute(
          transaction,
          "UPDATE project_uph_test_batches SET current_locked_revision_id = NULL WHERE id = $1",
          fixture.batchId
        );
        await execute(transaction, "SET LOCAL session_replication_role = origin");
        await expectSqlState(
          execute(
            transaction,
            'SET CONSTRAINTS "project_uph_analysis_snapshot_commit_guard" IMMEDIATE'
          ),
          "23514",
          /current LOCKED revision/u
        );
      });
    });

    it("makes Audit/Outbox/idempotency writes transactional and replays same-key responses", async () => {
      const fixture = await createBatchFixture();
      const operation = "projects.uph.analysis.create";
      const key = `analysis-key-${randomUUID()}`;
      const request = { path: analysisContext(fixture), body: {} };
      const executeCommand = () =>
        idempotency.executeIdempotentCommand({
          actorId: fixture.processActor.id,
          operation,
          idempotencyKey: key,
          request,
          execute: async (transaction) => ({
            status: 201,
            body: await analyses.createUphAnalysis(analysisContext(fixture), transaction)
          })
        });
      const first = await executeCommand();
      const replay = await executeCommand();
      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(replay.body).toEqual(first.body);
      expect(await countFacts(fixture)).toMatchObject({
        snapshots: 1,
        audits: 1,
        outbox: 1,
        completedResponses: 1
      });
      await expect(
        idempotency.executeIdempotentCommand({
          actorId: fixture.processActor.id,
          operation,
          idempotencyKey: key,
          request: { path: analysisContext(fixture), body: { changed: true } },
          execute: async () => ({ status: 201, body: {} })
        })
      ).rejects.toMatchObject({ status: 409 });

      const rollbackFixture = await createBatchFixture();
      await expect(
        idempotency.executeIdempotentCommand({
          actorId: rollbackFixture.processActor.id,
          operation: `${operation}.rollback`,
          idempotencyKey: `analysis-rollback-${randomUUID()}`,
          request: { path: analysisContext(rollbackFixture), body: {} },
          execute: async (transaction) => {
            await analyses.createUphAnalysis(analysisContext(rollbackFixture), transaction);
            throw new Error("forced idempotent completion failure");
          }
        })
      ).rejects.toThrow("forced idempotent completion failure");
      expect(await countFacts(rollbackFixture)).toMatchObject({
        snapshots: 0,
        audits: 0,
        outbox: 0,
        completedResponses: 0
      });
    });

    it("serializes different idempotency keys for one exact LOCKED input into one snapshot and one SUCCESS event pair", async () => {
      const fixture = await createBatchFixture();
      const operation = "projects.uph.analysis.concurrent";
      const executeWithKey = (idempotencyKey: string) =>
        idempotency.executeIdempotentCommand({
          actorId: fixture.processActor.id,
          operation,
          idempotencyKey,
          request: { path: analysisContext(fixture), body: {} },
          execute: async (transaction) => ({
            status: 201,
            body: await analyses.createUphAnalysis(analysisContext(fixture), transaction)
          })
        });
      const [left, right] = await Promise.all([
        executeWithKey(`analysis-left-${randomUUID()}`),
        executeWithKey(`analysis-right-${randomUUID()}`)
      ]);
      expect((left.body as { analysisId: string }).analysisId).toBe(
        (right.body as { analysisId: string }).analysisId
      );
      expect(await countFacts(fixture)).toMatchObject({
        snapshots: 1,
        audits: 1,
        outbox: 1,
        completedResponses: 2
      });
    });

    it("holds the Project-to-batch-to-revision lock order without leaking 40P01 or 55P03", async () => {
      const fixture = await createBatchFixture();
      let releaseHeld!: () => void;
      const holdReleased = new Promise<void>((resolve) => {
        releaseHeld = resolve;
      });
      let signalHeld!: () => void;
      const heldAtBarrier = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      const first = db.$transaction(async (transaction) => {
        const result = await analyses.createUphAnalysis(analysisContext(fixture), transaction);
        signalHeld();
        await holdReleased;
        return result;
      });
      await heldAtBarrier;
      await expect(
        db.$transaction((transaction) =>
          query<{ id: string }>(
            transaction,
            "SELECT id FROM project_uph_test_batches WHERE id = $1 FOR UPDATE NOWAIT",
            fixture.batchId
          )
        )
      ).rejects.toSatisfy((error: unknown) => postgresSqlState(error) === "55P03");
      const second = db.$transaction((transaction) =>
        analyses.createUphAnalysis(analysisContext(fixture), transaction)
      );
      releaseHeld();
      const outcomes = await Promise.allSettled([first, second]);
      const failures = outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
        .map((outcome) => outcome.reason);
      expect(failures.filter((error) => postgresSqlState(error) === "40P01")).toEqual([]);
      expect(failures.filter((error) => postgresSqlState(error) === "55P03")).toEqual([]);
      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<analyses.UphAnalysisSnapshotResponse> =>
          outcome.status === "fulfilled"
      );
      expect(fulfilled).toHaveLength(2);
      expect(fulfilled[0]!.value.analysisId).toBe(fulfilled[1]!.value.analysisId);
    });
  }
);
