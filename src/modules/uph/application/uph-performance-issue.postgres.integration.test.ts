import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthorizationActor } from "@/lib/auth/authorize";
import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import * as analyses from "@/modules/uph/application/uph-analysis-service";
import * as batches from "@/modules/uph/application/uph-test-batch-service";
import * as definitions from "@/modules/uph/application/uph-definition-service";

import { createUphPerformanceIssue } from "./uph-performance-issue-service";
import {
  createUphPerformanceTarget,
  publishUphPerformanceTarget
} from "./uph-performance-target-service";
import { createUphRetest } from "./uph-retest-service";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);

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

class Rollback extends Error {}

// Raw-SQL helpers used only by the fixture builders below (positional $1, $2...
// placeholders), kept distinct from the tagged-template `query` helper used by
// the acceptance test body itself.
async function rawQuery<T>(
  client: Pick<DatabaseClient, "$queryRawUnsafe">,
  statement: string,
  ...values: unknown[]
): Promise<T[]> {
  return client.$queryRawUnsafe<T[]>(statement, ...values);
}

async function rawExecute(
  client: Pick<DatabaseClient, "$executeRawUnsafe">,
  statement: string,
  ...values: unknown[]
): Promise<number> {
  return client.$executeRawUnsafe(statement, ...values);
}

async function query<T>(client: Pick<Prisma.TransactionClient, "$queryRaw">, sql: Prisma.Sql) {
  return client.$queryRaw<T[]>(sql);
}

let publishedFixture: Promise<PublishedFixture> | null = null;
let companyCapabilityEnabled: boolean | null = null;

async function projectVersion(projectId: string): Promise<number> {
  const rows = await rawQuery<{ version: number }>(
    db,
    "SELECT version FROM projects WHERE id = $1",
    projectId
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.version;
}

// Self-contained fixture, copied from APM-082's
// uph-analysis.postgres.integration.test.ts (seedPublishedFixture /
// createBatchFixture / cleanupFixture) per project convention: each
// APM-08x PostgreSQL integration test embeds its own copy rather than
// sharing a helper module.
async function seedPublishedFixture(): Promise<PublishedFixture> {
  if (publishedFixture) return publishedFixture;
  publishedFixture = (async () => {
    const suffix = randomUUID();
    const ids = {
      project: `p-uph-084-${suffix}`,
      process: `u-uph-084-process-${suffix}`,
      commission: `u-uph-084-commission-${suffix}`,
      pm: `u-uph-084-pm-${suffix}`,
      quality: `u-uph-084-quality-${suffix}`,
      template: `template-uph-084-${suffix}`,
      templateVersion: `template-version-uph-084-${suffix}`,
      component: `component-uph-084-${suffix}`,
      componentVersion: `component-version-uph-084-${suffix}`,
      snapshot: `snapshot-uph-084-${suffix}`,
      snapshotComponent: `snapshot-component-uph-084-${suffix}`,
      line: `du-uph-084-line-${suffix}`,
      machine: `du-uph-084-machine-${suffix}`,
      module: `module-uph-084-${suffix}`
    };
    const projectCode = `P-UPH084-${suffix.slice(0, 8)}`.toUpperCase();
    const now = "CURRENT_TIMESTAMP";

    await db.$transaction(async (transaction) => {
      const company = await rawQuery<{ enabled: boolean }>(
        transaction,
        "SELECT enabled FROM company_capabilities WHERE code = 'UPH_ANALYSIS'"
      );
      companyCapabilityEnabled = company[0]?.enabled ?? null;
      for (const [id, employeeNo, name] of [
        [ids.process, `E-UPH084-PROC-${suffix.slice(0, 8)}`, "Process"],
        [ids.commission, `E-UPH084-COMM-${suffix.slice(0, 8)}`, "Commission"],
        [ids.pm, `E-UPH084-PM-${suffix.slice(0, 8)}`, "PM"],
        [ids.quality, `E-UPH084-QUALITY-${suffix.slice(0, 8)}`, "Quality"]
      ]) {
        await rawExecute(
          transaction,
          `INSERT INTO users(id, employee_no, name, status, version, created_at, updated_at)
           VALUES ($1, $2, $3, 'ACTIVE', 1, ${now}, ${now})`,
          id,
          employeeNo,
          name
        );
      }
      await rawExecute(
        transaction,
        `INSERT INTO templates(id, code, name, status, current_version, version, created_by_id, updated_by_id, created_at, updated_at)
         VALUES ($1, $2, 'UPH 084', 'ACTIVE', 1, 1, $3, $3, ${now}, ${now})`,
        ids.template,
        `UPH.084.${suffix.slice(0, 8)}`.toUpperCase(),
        ids.process
      );
      await rawExecute(
        transaction,
        `INSERT INTO template_versions(id, template_id, version, status, name, checksum, published_by_id, published_at)
         VALUES ($1, $2, 1, 'PUBLISHED', 'UPH 084', repeat('0', 64), $3, ${now})`,
        ids.templateVersion,
        ids.template,
        ids.process
      );
      await rawExecute(
        transaction,
        `INSERT INTO template_components(id, code, component_type, name, draft_content, status, current_version, version, created_by_id, updated_by_id, created_at, updated_at)
         VALUES ($1, $2, 'CAPABILITY_RULE'::"TemplateComponentType", 'UPH capability',
           '{"capabilities":[{"code":"UPH_ANALYSIS","required":false}]}'::jsonb,
           'ACTIVE'::"TemplateMasterStatus", 1, 1, $3, $3, ${now}, ${now})`,
        ids.component,
        `UPH.084.CAPABILITY.${suffix.slice(0, 8)}`.toUpperCase(),
        ids.process
      );
      await rawExecute(
        transaction,
        `INSERT INTO template_component_versions(id, component_id, version, status, component_type, name, content_json, checksum, published_by_id, published_at)
         VALUES ($1, $2, 1, 'PUBLISHED'::"TemplateVersionStatus", 'CAPABILITY_RULE'::"TemplateComponentType", 'UPH capability',
           '{"capabilities":[{"code":"UPH_ANALYSIS","required":false}]}'::jsonb, repeat('0', 64), $3, ${now})`,
        ids.componentVersion,
        ids.component,
        ids.process
      );
      await rawExecute(
        transaction,
        "UPDATE company_capabilities SET enabled = true WHERE code = 'UPH_ANALYSIS'"
      );
      await rawExecute(
        transaction,
        `INSERT INTO projects(id, code, name, status, version, initialization_status, source_template_version_id,
          source_template_checksum, initialized_at, project_type, equipment_shape, structure_status,
          capability_configuration_status, capabilities_configured_at, created_by_id, created_at, updated_at)
         VALUES ($1, $2, 'UPH 084', 'DRAFT', 1, 'READY', $3, repeat('0', 64), ${now},
           'CUSTOMER_DELIVERY', 'LINE', 'READY', 'READY', ${now}, $4, ${now}, ${now})`,
        ids.project,
        projectCode,
        ids.templateVersion,
        ids.process
      );
      const insertedSnapshotRows = await rawExecute(
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
      const insertedSnapshotComponentRows = await rawExecute(
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
      await rawExecute(
        transaction,
        `INSERT INTO project_capabilities(project_id, capability_code, template_allowed, template_required,
          selected_enabled, source_snapshot_component_id, version, created_by_id, updated_by_id, created_at, updated_at)
         VALUES ($1, 'UPH_ANALYSIS', true, false, true, $2, 1, $3, $3, ${now}, ${now})`,
        ids.project,
        ids.snapshotComponent,
        ids.process
      );
      await rawExecute(
        transaction,
        `INSERT INTO delivery_units(id, project_id, parent_id, unit_type, code, name, status, position, version, created_by_id, updated_by_id, created_at, updated_at)
         VALUES ($1, $2, NULL, 'LINE', 'LINE-084', 'Line 084', 'ACTIVE', 0, 1, $3, $3, ${now}, ${now}),
                ($4, $2, $1, 'MACHINE', 'MACHINE-084', 'Machine 084', 'ACTIVE', 0, 1, $3, $3, ${now}, ${now})`,
        ids.line,
        ids.project,
        ids.process,
        ids.machine
      );
      await rawExecute(
        transaction,
        `INSERT INTO project_modules(id, project_id, delivery_unit_id, code, name, status, position, version, created_by_id, updated_by_id, created_at, updated_at)
         VALUES ($1, $2, $3, 'MOD-084', 'Module 084', 'ACTIVE', 0, 1, $4, $4, ${now}, ${now})`,
        ids.module,
        ids.project,
        ids.machine,
        ids.process
      );
      await rawExecute(
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
      requestId: `uph-084-pg-${suffix}`,
      traceId: null,
      source: "API",
      sourceIp: null,
      userAgent: null,
      reason: null,
      projectId: ids.project,
      departmentId: null,
      operationId: `uph-084-pg-${suffix}`
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
    const topologyRoots = await rawQuery<{ id: string }>(
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
      batchNumber: `APM084-${randomUUID()}`,
      topologyRootNodeId: published.topologyRootNodeId,
      plannedProductionSeconds: 3600,
      planDeclarationReason: "APM-084 self-built PostgreSQL acceptance fixture",
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
        sourceEventId: `apm084-device-${created.revisionId}-${ordinal}`,
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

async function cleanupFixture(): Promise<void> {
  if (!publishedFixture) return;
  const fixture = await publishedFixture;
  await db.$transaction(async (transaction) => {
    await rawExecute(transaction, "SET LOCAL session_replication_role = replica");
    await rawExecute(
      transaction,
      `DELETE FROM outbox_events WHERE aggregate_id IN (
        SELECT id FROM issues WHERE project_id = $1
        UNION SELECT id FROM project_uph_performance_target_versions WHERE project_id = $1
        UNION SELECT id FROM project_uph_analysis_snapshots WHERE project_id = $1
        UNION SELECT id FROM project_uph_test_batch_revisions WHERE project_id = $1
        UNION SELECT id FROM project_uph_test_batches WHERE project_id = $1
      )`,
      fixture.projectId
    );
    await rawExecute(
      transaction,
      "DELETE FROM audit_logs WHERE project_id = $1",
      fixture.projectId
    );
    await rawExecute(
      transaction,
      "DELETE FROM api_idempotency_records WHERE actor_id LIKE $1",
      `${fixture.ids.process}%`
    );
    for (const table of [
      // APM-084-specific tables: children before parents, deleted under
      // session_replication_role = replica since issues / issue_relations /
      // issue_histories / project_uph_performance_target_versions all carry
      // guard triggers that reject plain DELETE outside replica mode.
      "issue_relations",
      "issue_histories",
      "issues",
      "project_uph_performance_target_versions",
      "project_uph_performance_targets",
      // APM-082-style UPH batch/analysis/topology facts.
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
      await rawExecute(
        transaction,
        `DELETE FROM ${table} WHERE project_id = $1`,
        fixture.projectId
      );
    }
    await rawExecute(
      transaction,
      "DELETE FROM project_template_snapshot_components WHERE snapshot_id = $1",
      fixture.ids.snapshot
    );
    await rawExecute(
      transaction,
      "DELETE FROM project_template_snapshots WHERE project_id = $1",
      fixture.projectId
    );
    await rawExecute(transaction, "DELETE FROM projects WHERE id = $1", fixture.projectId);
    await rawExecute(
      transaction,
      "DELETE FROM template_component_versions WHERE id = $1",
      fixture.ids.componentVersion
    );
    await rawExecute(
      transaction,
      "DELETE FROM template_components WHERE id = $1",
      fixture.ids.component
    );
    await rawExecute(
      transaction,
      "DELETE FROM template_versions WHERE id = $1",
      fixture.ids.templateVersion
    );
    await rawExecute(transaction, "DELETE FROM templates WHERE id = $1", fixture.ids.template);
    await rawExecute(
      transaction,
      "DELETE FROM users WHERE id IN ($1, $2, $3, $4)",
      fixture.ids.process,
      fixture.ids.commission,
      fixture.ids.pm,
      fixture.ids.quality
    );
    if (companyCapabilityEnabled !== null) {
      await rawExecute(
        transaction,
        "UPDATE company_capabilities SET enabled = $1 WHERE code = 'UPH_ANALYSIS'",
        companyCapabilityEnabled
      );
    }
  });
}

describe.skipIf(!enabled)("APM-084 PostgreSQL service evidence", () => {
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

  it("creates, deduplicates, retests and rolls back all APM-084 facts on the real fixture", async () => {
    const suffix = randomUUID();
    const title = `APM-084 PostgreSQL acceptance ${suffix}`;
    const reason = `APM-084 real PostgreSQL evidence ${suffix}`;

    // 1. Publish TOPOLOGY / CT / FORMULA on a brand-new self-built project.
    const published = await seedPublishedFixture();
    const projectId = published.projectId;
    const topologyRootNodeId = published.topologyRootNodeId;

    function auditContext(actorId: string, reason: string, suffix: string): AuditContext {
      return {
        actorId,
        requestId: `apm084-pg-${suffix}`,
        traceId: null,
        source: "API" as const,
        sourceIp: null,
        userAgent: "APM-084-postgres-integration",
        reason,
        projectId,
        departmentId: null,
        operationId: `apm084-pg-${suffix}`
      };
    }

    // Acceptance-side actors: the same seeded, active project members as the
    // fixture's own processActor/qualityActor, extended with the additional
    // grants that the APM-084 issue/target/retest APIs require.
    const processActor: AuthorizationActor = {
      ...published.processActor,
      grants: [
        ...published.processActor.grants,
        { permission: "PROJECT_ISSUE_CREATE", scope: "PROJECT", systemRole: "ENGINEER" },
        { permission: "PROJECT_ISSUE_UPDATE", scope: "PROJECT", systemRole: "ENGINEER" },
        { permission: "PROJECT_UPH_DEFINITION_MANAGE", scope: "PROJECT", systemRole: "ENGINEER" }
      ]
    };
    const qualityActor: AuthorizationActor = {
      ...published.qualityActor,
      grants: [
        ...published.qualityActor.grants,
        { permission: "PROJECT_UPH_PUBLISH", scope: "PROJECT", systemRole: "QUALITY" }
      ]
    };
    const processUserId = processActor.id;
    const qualityUserId = qualityActor.id;

    // 2. Create and publish the first performance target (targetUph =
    // "101.000000") before the batch exists, so its publishedAt is a real,
    // committed CURRENT_TIMESTAMP that naturally precedes the batch's lock.
    const seedTargetReason = `APM-084 target seed ${suffix}`;
    const draftTarget = await createUphPerformanceTarget({
      projectId,
      actorId: processUserId,
      authorizationActor: processActor,
      projectMemberRoles: ["ENGINEER"],
      topologyRootNodeId,
      targetUph: "101.000000",
      reason: seedTargetReason,
      auditContext: auditContext(processUserId, seedTargetReason, `${suffix}-target-seed`)
    });
    const seedTargetPublishReason = `APM-084 target seed publish ${suffix}`;
    await publishUphPerformanceTarget({
      projectId,
      actorId: qualityUserId,
      authorizationActor: qualityActor,
      projectMemberRoles: ["QUALITY"],
      targetVersionId: String(draftTarget.id),
      resourceVersion: Number(draftTarget.resourceVersion),
      reason: seedTargetPublishReason,
      auditContext: auditContext(
        qualityUserId,
        seedTargetPublishReason,
        `${suffix}-target-seed-publish`
      )
    });

    // 3. Create and lock a UPH test batch on the same topology root. Its
    // lockedAt is a later CURRENT_TIMESTAMP than the target's publishedAt.
    const batchFixture = await createBatchFixture();
    const batchId = batchFixture.batchId;
    const revisionId = batchFixture.revisionId;

    // 4. Analyze the locked revision to obtain a real analysisId,
    // actualGoodUph and lockedChecksum instead of hardcoding them.
    const analysis = await analyses.createUphAnalysis({
      projectId,
      batchId,
      revisionId,
      actorId: batchFixture.processActor.id,
      authorizationActor: batchFixture.processActor,
      auditContext: {
        ...batchFixture.auditContext,
        actorId: batchFixture.processActor.id,
        operationId: `apm084-pg-analysis-${suffix}`
      }
    });
    const analysisId = analysis.analysisId;

    let transactionError: unknown;
    try {
      await db.$transaction(async (transaction) => {
        const before = await query<{
          issues: number;
          relations: number;
          histories: number;
          audits: number;
          outbox: number;
        }>(
          transaction,
          Prisma.sql`SELECT
            (SELECT count(*)::int FROM issues WHERE project_id = ${projectId} AND title = ${title}) AS issues,
            (SELECT count(*)::int FROM issue_relations WHERE project_id = ${projectId} AND reason = ${reason}) AS relations,
            (SELECT count(*)::int FROM issue_histories WHERE project_id = ${projectId} AND reason = ${reason}) AS histories,
            (SELECT count(*)::int FROM audit_logs WHERE project_id = ${projectId} AND operation_id = ${`apm084-pg-${suffix}`}) AS audits,
            (SELECT count(*)::int FROM outbox_events WHERE idempotency_key LIKE ${`uph-performance-issue:%:${suffix}`}) AS outbox`
        );
        expect(before[0]).toEqual({ issues: 0, relations: 0, histories: 0, audits: 0, outbox: 0 });

        const input = {
          projectId,
          batchId,
          revisionId,
          analysisId,
          actorId: processUserId,
          authorizationActor: processActor,
          title,
          confirmedText: "Actual good UPH is below the published target.",
          severity: "HIGH" as const,
          reason,
          auditContext: auditContext(processUserId, reason, suffix)
        };
        const first = await createUphPerformanceIssue(input, transaction);
        expect(first.deduplicated).toBe(false);
        expect(first.issue).toMatchObject({
          projectId,
          category: "PERFORMANCE",
          sourceType: "PROJECT",
          rootCauseCategory: null,
          rootCauseDescription: null
        });
        expect(first.sourceSnapshot).toMatchObject({
          analysisId,
          lockedChecksum: analysis.lockedChecksum,
          actualGoodUph: "90.000000",
          targetUph: "101.000000",
          shortfallUph: "11.000000"
        });

        const duplicate = await createUphPerformanceIssue(input, transaction);
        expect(duplicate.deduplicated).toBe(true);
        expect(duplicate.sourceSnapshot).toMatchObject({ analysisId, actualGoodUph: "90.000000" });

        const counts = await query<{
          relations: number;
          histories: number;
          audits: number;
          outbox: number;
        }>(
          transaction,
          Prisma.sql`SELECT
            (SELECT count(*)::int FROM issue_relations WHERE project_id = ${projectId} AND issue_id = ${(first.issue as { id: string }).id}) AS relations,
            (SELECT count(*)::int FROM issue_histories WHERE project_id = ${projectId} AND issue_id = ${(first.issue as { id: string }).id}) AS histories,
            (SELECT count(*)::int FROM audit_logs WHERE project_id = ${projectId} AND object_id = ${(first.issue as { id: string }).id} AND result = 'SUCCESS') AS audits,
            (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = ${(first.issue as { id: string }).id} AND event_type = 'uph.performance-issue.created') AS outbox`
        );
        expect(counts[0]).toEqual({ relations: 2, histories: 3, audits: 1, outbox: 1 });

        const retest = await createUphRetest(
          {
            projectId,
            issueId: (first.issue as { id: string; version: number }).id,
            actorId: processUserId,
            authorizationActor: processActor,
            issueVersion: (first.issue as { version: number }).version,
            reason,
            auditContext: auditContext(processUserId, reason, `${suffix}-retest`),
            body: {
              batchNumber: `APM084-RETEST-${suffix.slice(0, 8)}`,
              plannedProductionSeconds: 3600,
              planDeclarationReason: "APM-084 PostgreSQL retest evidence",
              observationStartedAt: "2026-09-05T02:00:00.000Z",
              observationEndedAt: "2026-09-05T03:00:00.000Z",
              timezone: "Asia/Shanghai"
            }
          },
          transaction
        );
        expect(retest.sourceBatchId).toBe(batchId);
        expect(retest.relation.relationType).toBe("UPH_RETEST_BATCH");

        const draft = await createUphPerformanceTarget(
          {
            projectId,
            actorId: processUserId,
            authorizationActor: processActor,
            projectMemberRoles: ["ENGINEER"],
            topologyRootNodeId,
            targetUph: "102.000000",
            reason,
            auditContext: auditContext(processUserId, reason, `${suffix}-target-create`)
          },
          transaction
        );
        const publishedTarget = await publishUphPerformanceTarget(
          {
            projectId,
            actorId: qualityUserId,
            authorizationActor: qualityActor,
            projectMemberRoles: ["QUALITY"],
            targetVersionId: String(draft.id),
            resourceVersion: Number(draft.resourceVersion),
            reason,
            auditContext: auditContext(qualityUserId, reason, `${suffix}-target-publish`)
          },
          transaction
        );
        expect(publishedTarget.status).toBe("PUBLISHED");
        expect(typeof publishedTarget.publishedAt).toBe("string");
        const targetOutbox = await query<{ publishedAt: string; versionReason: string }>(
          transaction,
          Prisma.sql`SELECT payload->>'publishedAt' AS "publishedAt", payload->>'versionReason' AS "versionReason"
            FROM outbox_events WHERE event_type = 'uph.performance-target.published'
              AND aggregate_id = ${String(draft.id)}`
        );
        expect(targetOutbox[0]).toMatchObject({
          publishedAt: publishedTarget.publishedAt,
          versionReason: reason
        });

        throw new Rollback("rollback acceptance fixture transaction");
      });
    } catch (error) {
      transactionError = error;
    }
    if (!(transactionError instanceof Rollback)) {
      throw transactionError;
    }

    const leftovers = await query<{ issues: number; relations: number; batches: number }>(
      db,
      Prisma.sql`SELECT
        (SELECT count(*)::int FROM issues WHERE project_id = ${projectId} AND title = ${title}) AS issues,
        (SELECT count(*)::int FROM issue_relations WHERE project_id = ${projectId} AND reason = ${reason}) AS relations,
        (SELECT count(*)::int FROM project_uph_test_batches WHERE project_id = ${projectId} AND batch_number = ${`APM084-RETEST-${suffix.slice(0, 8)}`}) AS batches`
    );
    expect(leftovers[0]).toEqual({ issues: 0, relations: 0, batches: 0 });
  });
});
