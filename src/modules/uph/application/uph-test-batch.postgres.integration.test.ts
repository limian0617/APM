import { afterEach, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";

import type { AuthorizationActor } from "@/lib/auth/authorize";
import type { AuditContext } from "@/modules/audit/contracts/audit";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);

const tables = [
  "project_uph_test_batches",
  "project_uph_test_batch_revisions",
  "project_uph_test_batch_revision_module_bindings",
  "project_uph_test_batch_revision_production_counts",
  "project_uph_module_cycle_samples",
  "project_uph_test_batch_revision_evidence"
] as const;

type BatchFixture = {
  projectId: string;
  batchId: string;
  revisionId: string;
  topologyRootNodeId: string;
  moduleBindingId: string;
  moduleId: string;
  formulaVersionId: string;
  frozenCtDefinitionId: string;
  frozenCtVersionId: string;
  resourceVersion: number;
  auditContext: AuditContext;
  processActor: AuthorizationActor;
  pmActor: AuthorizationActor;
  qualityActor: AuthorizationActor;
};

type PublishedFixture = {
  projectId: string;
  topologyRootNodeId: string;
  moduleId: string;
  formulaVersionId: string;
  processActor: AuthorizationActor;
  commissioningActor: AuthorizationActor;
  pmActor: AuthorizationActor;
  qualityActor: AuthorizationActor;
  auditContext: AuditContext;
};

type TransactionClient = Prisma.TransactionClient;
type RawQueryClient = Pick<PrismaClient, "$queryRawUnsafe">;
type RawExecuteClient = Pick<PrismaClient, "$executeRawUnsafe">;

function postgresSqlState(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return candidate.meta?.code ?? candidate.code;
}

function postgresErrorMessage(error: unknown) {
  if (!error || typeof error !== "object") return "";
  const candidate = error as { message?: unknown; meta?: { message?: unknown } };
  return [candidate.meta?.message, candidate.message]
    .filter((message): message is string => typeof message === "string")
    .join(" ");
}

async function expectSqlStates(
  action: Promise<unknown>,
  states: readonly ("23514" | "23503" | "23502" | "55000" | "55P03")[]
) {
  await expect(action).rejects.toSatisfy((error: unknown) =>
    states.includes(postgresSqlState(error) as (typeof states)[number])
  );
}

async function expectSqlStateAndMessage(action: Promise<unknown>, state: "23514", message: RegExp) {
  await expect(action).rejects.toSatisfy(
    (error: unknown) =>
      postgresSqlState(error) === state && message.test(postgresErrorMessage(error))
  );
}

async function expectCtDefinitionVersionPairingRejection(action: Promise<unknown>) {
  await expect(action).rejects.toSatisfy((error: unknown) => {
    const sqlState = postgresSqlState(error);
    if (sqlState === "23503") return true;
    if (sqlState !== "23514") return false;

    const message = postgresErrorMessage(error);
    return (
      /ct definition\/version pairing/iu.test(message) &&
      !/current work revision|current locked revision|pointer|successor/iu.test(message)
    );
  });
}

async function requireApm081() {
  const [{ Prisma }, { db }, service, definitions, idempotency] = await Promise.all([
    import("@prisma/client"),
    import("@/lib/db"),
    import("@/modules/uph/application/uph-test-batch-service"),
    import("@/modules/uph/application/uph-definition-service"),
    import("@/modules/platform-api/application/idempotent-command")
  ]);
  return { Prisma, db, service, definitions, idempotency };
}

async function requireApm081Tables() {
  const { Prisma, db } = await requireApm081();
  const rows = await db.$queryRaw<Array<{ name: string; relation: string | null }>>(
    Prisma.sql`SELECT value AS name, to_regclass(value)::text AS relation FROM unnest(ARRAY[${Prisma.join(
      tables.map((table) => Prisma.sql`${table}::text`)
    )}]) AS value ORDER BY value`
  );
  expect(rows).toEqual(
    tables
      .slice()
      .sort()
      .map((name) => ({ name, relation: name }))
  );
}

let publishedFixturePromise: Promise<PublishedFixture> | null = null;

async function projectVersion(db: RawQueryClient) {
  const rows = (await db.$queryRawUnsafe(
    "SELECT version FROM projects WHERE id = 'p-uph-081'"
  )) as Array<{ version: number }>;
  return rows[0]!.version;
}

async function formulaRootVersion(db: RawQueryClient, projectId: string) {
  const rows = (await db.$queryRawUnsafe(
    "SELECT version FROM project_uph_formulas WHERE project_id = $1",
    projectId
  )) as Array<{ version: number }>;
  expect(rows).toHaveLength(1);
  return rows[0]!.version;
}

async function seedPublishedUphFixture() {
  if (publishedFixturePromise) return publishedFixturePromise;
  publishedFixturePromise = (async () => {
    const { db, definitions } = await requireApm081();
    const now = "CURRENT_TIMESTAMP";
    await db.$transaction(async (transaction: TransactionClient) => {
      for (const [id, employeeNo, name] of [
        ["u-uph-081-process", "E-UPH081-PROC", "Process"],
        ["u-uph-081-commission", "E-UPH081-COMM", "Commission"],
        ["u-uph-081-pm", "E-UPH081-PM", "PM"],
        ["u-uph-081-quality", "E-UPH081-QUALITY", "Quality"]
      ]) {
        await transaction.$executeRawUnsafe(
          `INSERT INTO users(id,employee_no,name,status,version,created_at,updated_at)
           VALUES ($1,$2,$3,'ACTIVE',1,${now},${now})`,
          id,
          employeeNo,
          name
        );
      }
      await transaction.$executeRawUnsafe(
        `INSERT INTO templates(id,code,name,status,current_version,version,created_by_id,updated_by_id,created_at,updated_at)
         VALUES ('template-uph-081','UPH.081','UPH 081','ACTIVE',1,1,'u-uph-081-process','u-uph-081-process',${now},${now})`
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO template_versions(id,template_id,version,status,name,checksum,published_by_id,published_at)
         VALUES ('template-version-uph-081','template-uph-081',1,'PUBLISHED','UPH 081',repeat('0',64),'u-uph-081-process',${now})`
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO template_components(id,code,component_type,name,draft_content,status,current_version,version,created_by_id,updated_by_id,created_at,updated_at)
         VALUES ('component-uph-081','UPH.081.CAPABILITY','CAPABILITY_RULE'::"TemplateComponentType",'UPH capability','{"capabilities":[{"code":"UPH_ANALYSIS","required":false}]}'::jsonb,'ACTIVE'::"TemplateMasterStatus",1,1,'u-uph-081-process','u-uph-081-process',${now},${now})`
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO template_component_versions(id,component_id,version,status,component_type,name,content_json,checksum,published_by_id,published_at)
         VALUES ('component-version-uph-081','component-uph-081',1,'PUBLISHED'::"TemplateVersionStatus",'CAPABILITY_RULE'::"TemplateComponentType",'UPH capability','{"capabilities":[{"code":"UPH_ANALYSIS","required":false}]}'::jsonb,repeat('0',64),'u-uph-081-process',${now})`
      );
      await transaction.$executeRawUnsafe(
        `UPDATE company_capabilities SET enabled = true WHERE code = 'UPH_ANALYSIS'`
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO projects(id,code,name,status,version,initialization_status,source_template_version_id,source_template_checksum,initialized_at,project_type,equipment_shape,structure_status,capability_configuration_status,capabilities_configured_at,created_by_id,created_at,updated_at)
         VALUES ('p-uph-081','P-UPH081','UPH 081','DRAFT',1,'READY','template-version-uph-081',repeat('0',64),${now},'CUSTOMER_DELIVERY','LINE','READY','READY',${now},'u-uph-081-process',${now},${now})`
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO project_template_snapshots(id,project_id,source_template_version_id,source_template_checksum,snapshot_checksum,template_code,template_name,template_version,template_published_at)
         VALUES ('snapshot-uph-081','p-uph-081','template-version-uph-081',repeat('0',64),repeat('0',64),'UPH.081','UPH 081',1,${now})`
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO project_template_snapshot_components(id,snapshot_id,source_component_version_id,component_type,slot,position,source_checksum,component_code,component_name,component_version,content_json)
         VALUES ('snapshot-component-uph-081','snapshot-uph-081','component-version-uph-081','CAPABILITY_RULE'::"TemplateComponentType",'CAPABILITY_RULE',0,repeat('0',64),'UPH.081.CAPABILITY','UPH capability',1,'{"capabilities":[{"code":"UPH_ANALYSIS","required":false}]}'::jsonb)`
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO project_capabilities(project_id,capability_code,template_allowed,template_required,selected_enabled,source_snapshot_component_id,version,created_by_id,updated_by_id,created_at,updated_at)
         VALUES ('p-uph-081','UPH_ANALYSIS',true,false,true,'snapshot-component-uph-081',1,'u-uph-081-process','u-uph-081-process',${now},${now})`
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO delivery_units(id,project_id,parent_id,unit_type,code,name,status,position,version,created_by_id,updated_by_id,created_at,updated_at)
         VALUES ('du-uph-081-line','p-uph-081',NULL,'LINE','LINE-081','Line 081','ACTIVE',0,1,'u-uph-081-process','u-uph-081-process',${now},${now}),
                ('du-uph-081-machine','p-uph-081','du-uph-081-line','MACHINE','MACHINE-081','Machine 081','ACTIVE',0,1,'u-uph-081-process','u-uph-081-process',${now},${now})`
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO project_modules(id,project_id,delivery_unit_id,code,name,status,position,version,created_by_id,updated_by_id,created_at,updated_at)
         VALUES ('module-uph-081','p-uph-081','du-uph-081-machine','MOD-081','Module 081','ACTIVE',0,1,'u-uph-081-process','u-uph-081-process',${now},${now})`
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO project_members(id,project_id,user_id,project_role,assigned_by_id,joined_at,version)
         VALUES ('member-uph-081-process','p-uph-081','u-uph-081-process','ENGINEER','u-uph-081-process',${now},1),
                ('member-uph-081-commission','p-uph-081','u-uph-081-commission','ENGINEER','u-uph-081-process',${now},1),
                ('member-uph-081-pm','p-uph-081','u-uph-081-pm','PROJECT_MANAGER','u-uph-081-process',${now},1),
                ('member-uph-081-quality','p-uph-081','u-uph-081-quality','QUALITY','u-uph-081-process',${now},1)`
      );
    });

    const processActor = {
      id: "u-uph-081-process",
      name: "Process",
      status: "ACTIVE",
      departmentId: null,
      systemRoles: [],
      grants: [
        { permission: "PROJECT_UPH_BATCH_MANAGE", scope: "PROJECT", systemRole: "ENGINEER" },
        { permission: "PROJECT_UPH_READ", scope: "PROJECT", systemRole: "ENGINEER" }
      ]
    } satisfies AuthorizationActor;
    const commissioningActor = {
      ...processActor,
      id: "u-uph-081-commission",
      name: "Commission"
    } satisfies AuthorizationActor;
    const pmActor = {
      ...processActor,
      id: "u-uph-081-pm",
      name: "PM",
      grants: [
        {
          permission: "PROJECT_UPH_BATCH_CONFIRM",
          scope: "PROJECT",
          systemRole: "PROJECT_MANAGER"
        },
        { permission: "PROJECT_UPH_READ", scope: "PROJECT", systemRole: "PROJECT_MANAGER" }
      ]
    } satisfies AuthorizationActor;
    const qualityActor = {
      ...processActor,
      id: "u-uph-081-quality",
      name: "Quality",
      grants: [
        { permission: "PROJECT_UPH_BATCH_LOCK", scope: "PROJECT", systemRole: "QUALITY" },
        { permission: "PROJECT_UPH_READ", scope: "PROJECT", systemRole: "QUALITY" }
      ]
    } satisfies AuthorizationActor;
    const auditContext = {
      actorId: processActor.id,
      requestId: "uph-081-pg",
      traceId: null,
      source: "API",
      sourceIp: null,
      userAgent: null,
      reason: null,
      projectId: "p-uph-081",
      departmentId: null,
      operationId: "uph-081-pg"
    } satisfies AuditContext;
    const topology = await definitions.createUphDefinition({
      projectId: "p-uph-081",
      actorId: processActor.id,
      authorizationActor: processActor,
      body: {
        kind: "TOPOLOGY",
        projectVersion: await projectVersion(db),
        content: {
          projectShape: "LINE",
          roots: [
            {
              sourceId: "du-uph-081-line",
              sourceType: "LINE",
              parentSourceId: null,
              relation: "ROOT",
              capacity: 100,
              children: [
                {
                  sourceId: "du-uph-081-machine",
                  sourceType: "MACHINE",
                  parentSourceId: "du-uph-081-line",
                  relation: "MANDATORY",
                  capacity: 100,
                  children: [
                    {
                      sourceId: "module-uph-081",
                      sourceType: "MODULE",
                      parentSourceId: "du-uph-081-machine",
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
    const topologySigned = await definitions.signoffUphDefinition({
      projectId: "p-uph-081",
      kind: "TOPOLOGY",
      versionId: topology.id,
      resourceVersion: topology.resourceVersion,
      actorId: commissioningActor.id,
      authorizationActor: commissioningActor,
      auditContext: { ...auditContext, actorId: commissioningActor.id }
    });
    await definitions.publishUphDefinition({
      projectId: "p-uph-081",
      kind: "TOPOLOGY",
      versionId: topology.id,
      resourceVersion: topologySigned.resourceVersion,
      actorId: qualityActor.id,
      authorizationActor: qualityActor,
      auditContext: { ...auditContext, actorId: qualityActor.id }
    });
    const topologyRoots = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id
         FROM project_uph_topology_nodes
        WHERE topology_version_id = $1
          AND delivery_unit_id = 'du-uph-081-line'
          AND parent_relation = 'ROOT'`,
      topology.id
    );
    expect(topologyRoots).toHaveLength(1);
    const ct = await definitions.createUphDefinition({
      projectId: "p-uph-081",
      actorId: processActor.id,
      authorizationActor: processActor,
      body: {
        kind: "CT",
        projectVersion: await projectVersion(db),
        content: {
          projectModuleId: "module-uph-081",
          intrinsicCtSeconds: 12,
          outputPerCycleTotal: 1,
          parallelChannelCount: 1,
          cavityCount: 1
        }
      },
      auditContext
    });
    const ctSigned = await definitions.signoffUphDefinition({
      projectId: "p-uph-081",
      kind: "CT",
      versionId: ct.id,
      resourceVersion: ct.resourceVersion,
      actorId: commissioningActor.id,
      authorizationActor: commissioningActor,
      auditContext: { ...auditContext, actorId: commissioningActor.id }
    });
    await definitions.publishUphDefinition({
      projectId: "p-uph-081",
      kind: "CT",
      versionId: ct.id,
      resourceVersion: ctSigned.resourceVersion,
      actorId: qualityActor.id,
      authorizationActor: qualityActor,
      auditContext: { ...auditContext, actorId: qualityActor.id }
    });
    const formula = await definitions.createUphDefinition({
      projectId: "p-uph-081",
      actorId: processActor.id,
      authorizationActor: processActor,
      body: {
        kind: "FORMULA",
        projectVersion: await projectVersion(db),
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
      projectId: "p-uph-081",
      kind: "FORMULA",
      versionId: formula.id,
      resourceVersion: formula.resourceVersion,
      actorId: qualityActor.id,
      authorizationActor: qualityActor,
      auditContext: { ...auditContext, actorId: qualityActor.id }
    });
    return {
      projectId: "p-uph-081",
      topologyRootNodeId: topologyRoots[0]!.id,
      moduleId: "module-uph-081",
      formulaVersionId: formula.id,
      processActor,
      commissioningActor,
      pmActor,
      qualityActor,
      auditContext
    };
  })();
  return publishedFixturePromise;
}

afterEach(async () => {
  if (!enabled || !publishedFixturePromise) return;
  const { db } = await requireApm081();
  await db.$transaction(async (transaction: TransactionClient) => {
    await transaction.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    await transaction.$executeRawUnsafe(
      `DELETE FROM outbox_events
          WHERE aggregate_id IN (
            SELECT id FROM project_uph_test_batches WHERE project_id = 'p-uph-081'
            UNION
            SELECT id FROM project_uph_test_batch_revisions WHERE project_id = 'p-uph-081'
          )`
    );
    for (const table of [
      "project_uph_test_batch_revision_evidence",
      "project_uph_module_cycle_samples",
      "project_uph_test_batch_revision_production_counts",
      "project_uph_test_batch_revision_module_bindings",
      "project_uph_test_batch_revisions",
      "project_uph_test_batches"
    ]) {
      await transaction.$executeRawUnsafe(`DELETE FROM ${table} WHERE project_id = 'p-uph-081'`);
    }
    for (const table of [
      "project_uph_ct_definition_versions",
      "project_uph_ct_definitions",
      "project_uph_topology_nodes",
      "project_uph_topology_versions",
      "project_uph_topologies",
      "project_uph_formula_versions",
      "project_uph_formulas"
    ]) {
      await transaction.$executeRawUnsafe(`DELETE FROM ${table} WHERE project_id = 'p-uph-081'`);
    }
    await transaction.$executeRawUnsafe("DELETE FROM audit_logs WHERE project_id = 'p-uph-081'");
    await transaction.$executeRawUnsafe(
      "DELETE FROM api_idempotency_records WHERE actor_id LIKE 'u-uph-081-%'"
    );
    await transaction.$executeRawUnsafe(
      "DELETE FROM project_capabilities WHERE project_id = 'p-uph-081'"
    );
    await transaction.$executeRawUnsafe(
      "DELETE FROM project_modules WHERE project_id = 'p-uph-081'"
    );
    await transaction.$executeRawUnsafe(
      "DELETE FROM project_members WHERE project_id = 'p-uph-081'"
    );
    await transaction.$executeRawUnsafe(
      "DELETE FROM delivery_units WHERE project_id = 'p-uph-081'"
    );
    await transaction.$executeRawUnsafe(
      "DELETE FROM project_template_snapshot_components WHERE snapshot_id = 'snapshot-uph-081'"
    );
    await transaction.$executeRawUnsafe(
      "DELETE FROM project_template_snapshots WHERE project_id = 'p-uph-081'"
    );
    await transaction.$executeRawUnsafe("DELETE FROM projects WHERE id = 'p-uph-081'");
    await transaction.$executeRawUnsafe(
      "DELETE FROM template_component_versions WHERE id = 'component-version-uph-081'"
    );
    await transaction.$executeRawUnsafe(
      "DELETE FROM template_components WHERE id = 'component-uph-081'"
    );
    await transaction.$executeRawUnsafe(
      "DELETE FROM template_versions WHERE id = 'template-version-uph-081'"
    );
    await transaction.$executeRawUnsafe("DELETE FROM templates WHERE id = 'template-uph-081'");
    await transaction.$executeRawUnsafe("DELETE FROM file_objects WHERE project_id = 'p-uph-081'");
    await transaction.$executeRawUnsafe(
      "DELETE FROM file_objects WHERE project_id LIKE 'p-uph-081-other-%'"
    );
    await transaction.$executeRawUnsafe("DELETE FROM projects WHERE id LIKE 'p-uph-081-other-%'");
    await transaction.$executeRawUnsafe("DELETE FROM users WHERE id LIKE 'u-uph-081-%'");
  });
  publishedFixturePromise = null;
});

async function createConfirmedFixture(): Promise<BatchFixture> {
  const { service } = await requireApm081();
  const fixture = await seedPublishedUphFixture();
  const created = await service.createUphTestBatch({
    projectId: fixture.projectId,
    actorId: fixture.processActor.id,
    authorizationActor: fixture.processActor,
    body: {
      batchNumber: `BATCH-${crypto.randomUUID()}`,
      topologyRootNodeId: fixture.topologyRootNodeId,
      plannedProductionSeconds: 3600,
      planDeclarationReason: "Initial controlled production declaration",
      observationStartedAt: "2026-08-25T08:00:00.000Z",
      observationEndedAt: "2026-08-25T09:00:00.000Z",
      timezone: "Asia/Shanghai"
    },
    auditContext: fixture.auditContext
  });
  let resourceVersion = created.resourceVersion;
  for (let ordinal = 1; ordinal <= 10; ordinal += 1) {
    const appended = await service.appendUphCycleSample({
      projectId: fixture.projectId,
      batchId: created.batchId,
      revisionId: created.revisionId,
      actorId: fixture.processActor.id,
      authorizationActor: fixture.processActor,
      resourceVersion,
      body: {
        projectModuleId: fixture.moduleId,
        ordinal,
        sourceEventId: `device-${ordinal}`,
        cycleDurationSeconds: `${ordinal}.000000`,
        observedAt: `2026-08-25T08:${String(ordinal).padStart(2, "0")}:00.000Z`,
        captureMethod: "DEVICE_EVENT",
        disposition: "INCLUDED"
      },
      auditContext: { ...fixture.auditContext, actorId: fixture.processActor.id }
    });
    resourceVersion = appended.resourceVersion;
  }
  const current = await service.getUphTestBatchRevision({
    projectId: fixture.projectId,
    batchId: created.batchId,
    revisionId: created.revisionId,
    topologyRootNodeId: fixture.topologyRootNodeId,
    authorizationActor: fixture.processActor,
    projectMemberRoles: ["ENGINEER"]
  });
  await service.updateUphTestBatchProductionCount({
    projectId: fixture.projectId,
    batchId: created.batchId,
    revisionId: created.revisionId,
    actorId: fixture.processActor.id,
    authorizationActor: fixture.processActor,
    resourceVersion: current.resourceVersion,
    body: { actualGrossOutputCount: 0, finalGoodOutputCount: 0 },
    auditContext: { ...fixture.auditContext, actorId: fixture.processActor.id }
  });
  const afterProduction = await service.getUphTestBatchRevision({
    projectId: fixture.projectId,
    batchId: created.batchId,
    revisionId: created.revisionId,
    authorizationActor: fixture.processActor,
    projectMemberRoles: ["ENGINEER"]
  });
  await service.updateUphTestBatchModuleQualityCount({
    projectId: fixture.projectId,
    batchId: created.batchId,
    revisionId: created.revisionId,
    moduleId: fixture.moduleId,
    actorId: fixture.processActor.id,
    authorizationActor: fixture.processActor,
    resourceVersion: afterProduction.resourceVersion,
    body: {
      qualityInputCount: 10,
      firstPassGoodCount: 8,
      firstPassNonconformingCount: 2,
      reworkInputCount: 2,
      reworkRecoveredGoodCount: 1
    },
    auditContext: { ...fixture.auditContext, actorId: fixture.processActor.id }
  });
  const ready = await service.getUphTestBatchRevision({
    projectId: fixture.projectId,
    batchId: created.batchId,
    revisionId: created.revisionId,
    authorizationActor: fixture.processActor,
    projectMemberRoles: ["ENGINEER"]
  });
  return {
    projectId: fixture.projectId,
    batchId: created.batchId,
    revisionId: created.revisionId,
    topologyRootNodeId: fixture.topologyRootNodeId,
    moduleBindingId: ready.moduleBindings[0].id,
    moduleId: fixture.moduleId,
    formulaVersionId: fixture.formulaVersionId,
    frozenCtDefinitionId: ready.moduleBindings[0].ctDefinitionId,
    frozenCtVersionId: ready.moduleBindings[0].ctVersionId,
    resourceVersion: ready.resourceVersion,
    auditContext: fixture.auditContext,
    processActor: fixture.processActor,
    pmActor: fixture.pmActor,
    qualityActor: fixture.qualityActor
  };
}

async function waitForNowaitConflict(query: () => Promise<unknown>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await query();
    } catch (error) {
      if (postgresSqlState(error) === "55P03") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("APM-081 command did not hold the expected row lock");
}

async function createEvidenceFile(
  db: RawExecuteClient,
  fixture: BatchFixture,
  sensitivity: "INTERNAL" | "RESTRICTED",
  overrides: {
    projectId?: string;
    status?: "AVAILABLE" | "PENDING_SCAN";
  } = {}
) {
  const id = `file-uph-081-${crypto.randomUUID()}`;
  const pendingScan = overrides.status === "PENDING_SCAN";
  const sha256 = pendingScan ? null : "a".repeat(64);
  const objectKey = crypto.randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO file_objects
       (id, project_id, uploaded_by_id, original_name, declared_mime_type, verified_mime_type,
        declared_size, verified_size, sha256, object_key, storage_area, status, sensitivity,
        scan_engine, scanner_version, scan_signature, scanned_at, version, created_at, updated_at)
     VALUES ($1, $2, $3, 'uph-evidence.json', 'application/json', 'application/json',
             128, 128, $4, $5, $6::"FileStorageArea", $7::"FileObjectStatus", $8::"FileSensitivity",
             'fixture-scanner', '1', 'fixture-signature', $9, 1,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    id,
    overrides.projectId ?? fixture.projectId,
    fixture.processActor.id,
    sha256,
    objectKey,
    pendingScan ? "QUARANTINE" : "CONTROLLED",
    overrides.status ?? "AVAILABLE",
    sensitivity,
    pendingScan ? null : new Date()
  );
  return { id, sha256 };
}

async function createForeignProject(db: RawExecuteClient, fixture: BatchFixture) {
  const projectId = `p-uph-081-other-${crypto.randomUUID()}`;
  await db.$executeRawUnsafe(
    `INSERT INTO projects
       (id, code, name, status, version, initialization_status, source_template_version_id,
        source_template_checksum, initialized_at, project_type, equipment_shape, structure_status,
        capability_configuration_status, capabilities_configured_at, created_by_id, created_at, updated_at)
     SELECT $1, $2, 'UPH 081 foreign evidence project', status, 1, initialization_status,
            source_template_version_id, source_template_checksum, initialized_at, project_type,
            equipment_shape, structure_status, capability_configuration_status,
            capabilities_configured_at, created_by_id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       FROM projects WHERE id = $3`,
    projectId,
    `P-UPH081-OTHER-${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
    fixture.projectId
  );
  return projectId;
}

async function cloneDraftRevisionForDirectSql(
  transaction: TransactionClient,
  fixture: BatchFixture,
  topologyRootNodeId = fixture.topologyRootNodeId
) {
  const batchId = `direct-sql-batch-${crypto.randomUUID()}`;
  const revisionId = `direct-sql-revision-${crypto.randomUUID()}`;
  await transaction.$executeRawUnsafe(
    `INSERT INTO project_uph_test_batches
     SELECT (
       jsonb_populate_record(
         NULL::project_uph_test_batches,
         to_jsonb(batch) || jsonb_build_object(
           'id', $1,
           'batch_number', $2,
           'resource_version', 1,
           'current_work_revision_id', NULL,
           'current_locked_revision_id', NULL
         )
       )
     ).*
     FROM project_uph_test_batches batch
     WHERE batch.id = $3`,
    batchId,
    `DIRECT-SQL-${crypto.randomUUID()}`,
    fixture.batchId
  );
  await transaction.$executeRawUnsafe(
    `INSERT INTO project_uph_test_batch_revisions
     SELECT (
       jsonb_populate_record(
         NULL::project_uph_test_batch_revisions,
         to_jsonb(revision) || jsonb_build_object(
           'id', $1,
           'batch_id', $2,
           'revision_number', 1,
           'supersedes_revision_id', NULL,
           'status', 'DRAFT',
           'resource_version', 1,
           'topology_root_node_id', $3
         )
       )
     ).*
     FROM project_uph_test_batch_revisions revision
     WHERE revision.id = $4`,
    revisionId,
    batchId,
    topologyRootNodeId,
    fixture.revisionId
  );
  await transaction.$executeRawUnsafe(
    `UPDATE project_uph_test_batches
        SET current_work_revision_id = $1, resource_version = resource_version + 1
      WHERE id = $2`,
    revisionId,
    batchId
  );
  return { batchId, revisionId };
}

async function runBarrier(
  db: PrismaClient,
  left: (transaction?: TransactionClient) => Promise<unknown>,
  right: (transaction?: TransactionClient) => Promise<unknown>,
  lockProbe: (transaction: TransactionClient) => Promise<unknown>,
  options: { allowedFailureStatuses?: readonly number[] } = {}
) {
  const allowedFailureStatuses = options.allowedFailureStatuses ?? [409];
  let releaseHeld!: () => void;
  const holdReleased = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  let signalHeldBarrier!: () => void;
  const heldAtBarrier = new Promise<void>((resolve) => {
    signalHeldBarrier = resolve;
  });
  const heldCommand = db.$transaction(async (transaction) => {
    const result = await left(transaction);
    signalHeldBarrier();
    await holdReleased;
    return result;
  });

  await heldAtBarrier;
  await waitForNowaitConflict(() => db.$transaction(lockProbe));
  const contendingCommand = right();
  releaseHeld();
  const outcomes = await Promise.allSettled([heldCommand, contendingCommand]);
  const failures = outcomes
    .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
    .map((outcome) => outcome.reason);
  expect(failures.filter((error) => postgresSqlState(error) === "40P01")).toEqual([]);
  expect(failures.filter((error) => postgresSqlState(error) === "55P03")).toEqual([]);
  expect(
    failures.every((error) => {
      const status = (error as { status?: unknown }).status;
      return typeof status === "number" && allowedFailureStatuses.includes(status);
    })
  ).toBe(true);
  return outcomes;
}

describe.skipIf(!enabled)("APM-081 PostgreSQL persistence RED contract", () => {
  it("requires migration 59 to create the six root, revision, binding, fact, and evidence relations", async () => {
    await requireApm081Tables();
  });

  it("rejects direct SQL cross-project, binding, count, checksum, pointer, and orphan-successor violations", async () => {
    await requireApm081Tables();
    const { db, definitions } = await requireApm081();
    const fixture = await createConfirmedFixture();

    const foreignProjectId = await createForeignProject(db, fixture);
    await expectSqlStates(
      db.$executeRawUnsafe(
        `INSERT INTO project_uph_test_batch_revision_module_bindings
         SELECT (
           jsonb_populate_record(
             NULL::project_uph_test_batch_revision_module_bindings,
             to_jsonb(binding) || jsonb_build_object(
               'id', $1,
               'project_id', $2
             )
           )
         ).*
         FROM project_uph_test_batch_revision_module_bindings binding
         WHERE binding.id = $3`,
        `cross-project-binding-${crypto.randomUUID()}`,
        foreignProjectId,
        fixture.moduleBindingId
      ),
      ["23503"]
    );
    await expectSqlStates(
      db.$executeRawUnsafe(
        `INSERT INTO project_uph_module_cycle_samples
         SELECT (
           jsonb_populate_record(
             NULL::project_uph_module_cycle_samples,
             to_jsonb(sample) || jsonb_build_object(
               'id', $1,
               'module_binding_id', $2,
               'ordinal', 99,
               'source_event_id', $3
             )
           )
         ).*
         FROM project_uph_module_cycle_samples sample
         WHERE sample.id = (
           SELECT id
             FROM project_uph_module_cycle_samples
            WHERE revision_id = $4
            ORDER BY ordinal
            LIMIT 1
         )`,
        `missing-binding-sample-${crypto.randomUUID()}`,
        "missing-module-binding",
        `missing-binding-event-${crypto.randomUUID()}`,
        fixture.revisionId
      ),
      ["23503"]
    );
    await expectSqlStates(
      db.$executeRawUnsafe(
        `INSERT INTO project_uph_test_batch_revision_production_counts
         SELECT (
           jsonb_populate_record(
             NULL::project_uph_test_batch_revision_production_counts,
             to_jsonb(counts) || jsonb_build_object(
               'id', $1,
               'revision_id', $2
             )
           )
         ).*
         FROM project_uph_test_batch_revision_production_counts counts
         WHERE counts.revision_id = $3`,
        `orphan-production-${crypto.randomUUID()}`,
        `missing-revision-${crypto.randomUUID()}`,
        fixture.revisionId
      ),
      ["23503"]
    );
    await expectSqlStates(
      db.$executeRawUnsafe(
        `INSERT INTO project_uph_test_batch_revision_production_counts
         SELECT (
           jsonb_populate_record(
             NULL::project_uph_test_batch_revision_production_counts,
             to_jsonb(counts) || jsonb_build_object(
               'id', $1,
               'project_id', $2,
               'revision_id', $3
             )
           )
         ).*
         FROM project_uph_test_batch_revision_production_counts counts
         WHERE counts.revision_id = $3`,
        `cross-project-production-${crypto.randomUUID()}`,
        foreignProjectId,
        fixture.revisionId
      ),
      ["23503"]
    );
    const topologyResource = await db.$queryRawUnsafe<Array<{ version: number }>>(
      `SELECT version FROM project_uph_topologies WHERE project_id = $1`,
      fixture.projectId
    );
    expect(topologyResource).toHaveLength(1);
    const alternateTopology = await definitions.createUphDefinition({
      projectId: fixture.projectId,
      actorId: fixture.processActor.id,
      authorizationActor: fixture.processActor,
      body: {
        kind: "TOPOLOGY",
        projectVersion: topologyResource[0]!.version,
        content: {
          projectShape: "LINE",
          roots: [
            {
              sourceId: "du-uph-081-line",
              sourceType: "LINE",
              parentSourceId: null,
              relation: "ROOT",
              capacity: 100,
              children: [
                {
                  sourceId: "du-uph-081-machine",
                  sourceType: "MACHINE",
                  parentSourceId: "du-uph-081-line",
                  relation: "MANDATORY",
                  capacity: 100,
                  children: [
                    {
                      sourceId: "module-uph-081",
                      sourceType: "MODULE",
                      parentSourceId: "du-uph-081-machine",
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
      auditContext: { ...fixture.auditContext, actorId: fixture.processActor.id }
    });
    const alternateTopologyRoots = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM project_uph_topology_nodes
        WHERE project_id = $1 AND topology_version_id = $2 AND parent_relation = 'ROOT'`,
      fixture.projectId,
      alternateTopology.id
    );
    expect(alternateTopologyRoots).toHaveLength(1);
    await expectSqlStates(
      db.$transaction(async (transaction) => {
        await cloneDraftRevisionForDirectSql(transaction, fixture, alternateTopologyRoots[0]!.id);
      }),
      ["23503"]
    );
    const otherModuleId = `module-uph-081-other-${crypto.randomUUID()}`;
    await db.$executeRawUnsafe(
      `INSERT INTO project_modules
         (id, project_id, delivery_unit_id, code, name, status, position, version,
          created_by_id, updated_by_id, created_at, updated_at)
       VALUES ($1, $2, 'du-uph-081-machine', $3, 'UPH 081 other module', 'ACTIVE', 1, 1,
               $4, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      otherModuleId,
      fixture.projectId,
      `MOD-081-${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
      fixture.processActor.id
    );
    const otherCt = await definitions.createUphDefinition({
      projectId: fixture.projectId,
      actorId: fixture.processActor.id,
      authorizationActor: fixture.processActor,
      body: {
        kind: "CT",
        projectVersion: await projectVersion(db),
        content: {
          projectModuleId: otherModuleId,
          intrinsicCtSeconds: 13,
          outputPerCycleTotal: 1,
          parallelChannelCount: 1,
          cavityCount: 1
        }
      },
      auditContext: { ...fixture.auditContext, actorId: fixture.processActor.id }
    });
    const otherCtDefinition = await db.$queryRawUnsafe<Array<{ ct_definition_id: string }>>(
      `SELECT ct_definition_id FROM project_uph_ct_definition_versions WHERE id = $1`,
      otherCt.id
    );
    expect(otherCtDefinition).toEqual([{ ct_definition_id: expect.not.stringMatching(/^$/u) }]);
    expect(otherCtDefinition[0]!.ct_definition_id).not.toBe(fixture.frozenCtDefinitionId);
    await expectCtDefinitionVersionPairingRejection(
      db.$transaction(async (transaction) => {
        const clone = await cloneDraftRevisionForDirectSql(transaction, fixture);
        await transaction.$executeRawUnsafe(
          `INSERT INTO project_uph_test_batch_revision_module_bindings
           SELECT (
             jsonb_populate_record(
               NULL::project_uph_test_batch_revision_module_bindings,
               to_jsonb(binding) || jsonb_build_object(
                 'id', $1,
                 'revision_id', $2,
                 'ct_definition_id', $3,
                 'ct_version_id', $4
               )
             )
           ).*
           FROM project_uph_test_batch_revision_module_bindings binding
           WHERE binding.id = $5`,
          `mixed-ct-binding-${crypto.randomUUID()}`,
          clone.revisionId,
          fixture.frozenCtDefinitionId,
          otherCt.id,
          fixture.moduleBindingId
        );
      })
    );
    const ctRootResource = await db.$queryRawUnsafe<Array<{ version: number }>>(
      `SELECT version FROM project_uph_ct_definitions WHERE id = $1 AND project_id = $2`,
      fixture.frozenCtDefinitionId,
      fixture.projectId
    );
    expect(ctRootResource).toHaveLength(1);
    const draftCt = await definitions.createUphDefinition({
      projectId: fixture.projectId,
      actorId: fixture.processActor.id,
      authorizationActor: fixture.processActor,
      body: {
        kind: "CT",
        projectVersion: ctRootResource[0]!.version,
        content: {
          projectModuleId: fixture.moduleId,
          intrinsicCtSeconds: 13,
          outputPerCycleTotal: 1,
          parallelChannelCount: 1,
          cavityCount: 1
        }
      },
      auditContext: { ...fixture.auditContext, actorId: fixture.processActor.id }
    });
    await expectSqlStateAndMessage(
      db.$transaction(async (transaction) => {
        const clone = await cloneDraftRevisionForDirectSql(transaction, fixture);
        await transaction.$executeRawUnsafe(
          `INSERT INTO project_uph_test_batch_revision_module_bindings
           SELECT (
             jsonb_populate_record(
               NULL::project_uph_test_batch_revision_module_bindings,
               to_jsonb(binding) || jsonb_build_object(
                 'id', $1,
                 'revision_id', $2,
                 'ct_version_id', version.id,
                 'ct_source_snapshot_json', version.snapshot_json,
                 'ct_source_checksum', version.snapshot_checksum,
                 'ct_source_watermark', version.source_watermark
               )
             )
           ).*
           FROM project_uph_test_batch_revision_module_bindings binding
           JOIN project_uph_ct_definition_versions version
             ON version.id = $3
            AND version.ct_definition_id = binding.ct_definition_id
            AND version.project_id = binding.project_id
           WHERE binding.id = $4`,
          `wrong-ct-binding-${crypto.randomUUID()}`,
          clone.revisionId,
          draftCt.id,
          fixture.moduleBindingId
        );
        await transaction.$executeRawUnsafe(
          'SET CONSTRAINTS "project_uph_test_batch_binding_guard" IMMEDIATE'
        );
      }),
      "23514",
      /UPH test-batch requires each module current PUBLISHED CT version/iu
    );
    await expectSqlStates(
      db.$executeRawUnsafe(
        `UPDATE project_uph_test_batch_revision_module_bindings
            SET ct_version_id = $1
          WHERE id = $2`,
        draftCt.id,
        fixture.moduleBindingId
      ),
      ["55000"]
    );
    await expectSqlStates(
      db.$executeRawUnsafe(
        `UPDATE project_uph_test_batch_revision_production_counts SET final_good_output_count = actual_gross_output_count + 1 WHERE revision_id = $1`,
        fixture.revisionId
      ),
      ["23514"]
    );
    await expectSqlStates(
      db.$executeRawUnsafe(
        `UPDATE project_uph_test_batch_revision_module_bindings SET first_pass_nonconforming_count = quality_input_count WHERE id = $1`,
        fixture.moduleBindingId
      ),
      ["23514"]
    );
    await expectSqlStates(
      db.$executeRawUnsafe(
        `UPDATE project_uph_test_batch_revisions SET confirmed_input_checksum = repeat('0', 64) WHERE id = $1`,
        fixture.revisionId
      ),
      ["23514"]
    );
    await expectSqlStates(
      db.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          `UPDATE project_uph_test_batches SET current_locked_revision_id = current_work_revision_id WHERE id = $1`,
          fixture.batchId
        );
        await transaction.$executeRawUnsafe(
          'SET CONSTRAINTS "project_uph_test_batch_pointer_commit_guard" IMMEDIATE'
        );
      }),
      ["23514"]
    );
    await expectSqlStates(
      db.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe(
          `UPDATE project_uph_test_batch_revisions SET status = 'SUPERSEDED' WHERE id = $1`,
          fixture.revisionId
        );
        await transaction.$executeRawUnsafe(
          'SET CONSTRAINTS "project_uph_test_batch_revision_successor_guard" IMMEDIATE'
        );
      }),
      ["23514"]
    );
  });

  it("blocks UPDATE, DELETE, and TRUNCATE of confirmed and locked raw facts", async () => {
    const { db, service } = await requireApm081();
    const fixture = await createConfirmedFixture();
    const confirmed = await service.confirmUphTestBatch({
      projectId: fixture.projectId,
      batchId: fixture.batchId,
      revisionId: fixture.revisionId,
      actorId: fixture.pmActor.id,
      authorizationActor: fixture.pmActor,
      resourceVersion: fixture.resourceVersion,
      auditContext: { ...fixture.auditContext, actorId: fixture.pmActor.id }
    });

    await expectSqlStates(
      db.$executeRawUnsafe(
        `UPDATE project_uph_module_cycle_samples SET cycle_duration_seconds = 99 WHERE module_binding_id = $1`,
        fixture.moduleBindingId
      ),
      ["55000"]
    );
    await expectSqlStates(
      db.$executeRawUnsafe(
        `DELETE FROM project_uph_test_batch_revision_production_counts WHERE revision_id = $1`,
        fixture.revisionId
      ),
      ["55000"]
    );
    const locked = await service.lockUphTestBatch({
      projectId: fixture.projectId,
      batchId: fixture.batchId,
      revisionId: fixture.revisionId,
      actorId: fixture.qualityActor.id,
      authorizationActor: fixture.qualityActor,
      resourceVersion: confirmed.resourceVersion,
      auditContext: { ...fixture.auditContext, actorId: fixture.qualityActor.id }
    });
    expect(locked.status).toBe("LOCKED");
    await expectSqlStates(
      db.$executeRawUnsafe(
        `TRUNCATE project_uph_test_batch_revision_evidence, project_uph_module_cycle_samples`
      ),
      ["55000"]
    );
  });

  it("clears derived confirmation, checksum, and statistic facts when a successor raw-copies", async () => {
    const { db, service } = await requireApm081();
    const fixture = await createConfirmedFixture();
    const published = await seedPublishedUphFixture();
    const commissioningSampleId = `commissioning-history-${crypto.randomUUID()}`;
    const commissioningSourceEventId = `commissioning-device-${crypto.randomUUID()}`;
    await expect(
      db.$executeRawUnsafe(
        `WITH capture_fact AS (
           SELECT member.id AS membership_id,
                  member.user_id,
                  date_trunc('milliseconds', CURRENT_TIMESTAMP) AS recorded_at
             FROM project_members member
             JOIN users actor ON actor.id = member.user_id
            WHERE member.id = $1
              AND member.project_id = $2
              AND member.user_id = $3
              AND member.project_role = 'ENGINEER'
              AND member.left_at IS NULL
              AND actor.status = 'ACTIVE'
         )
         INSERT INTO project_uph_module_cycle_samples (
           id, project_id, revision_id, module_binding_id, ordinal, correction_of_sample_id,
           source_event_id, cycle_duration_seconds, observed_at, recorded_at, capture_method,
           captured_by_membership_id, captured_by_user_id, captured_by_role,
           captured_by_snapshot_json, captured_by_checksum, disposition, exclusion_reason_code
         )
         SELECT $4, binding.project_id, binding.revision_id, binding.id, 11, NULL,
                $5, 11.000000, '2026-08-25T08:11:00.000Z'::timestamptz, capture_fact.recorded_at,
                'DEVICE_EVENT'::"UphTestBatchSampleCaptureMethod",
                capture_fact.membership_id, capture_fact.user_id, 'ENGINEER'::"ProjectRole",
                "uph_test_batch_responsibility_snapshot"(
                  capture_fact.membership_id, capture_fact.user_id, 'ENGINEER'::"ProjectRole",
                  capture_fact.recorded_at, NULL
                ),
                "uph_test_batch_responsibility_checksum"(
                  capture_fact.membership_id, capture_fact.user_id, 'ENGINEER'::"ProjectRole",
                  capture_fact.recorded_at, NULL
                ),
                'INCLUDED'::"UphTestBatchSampleDisposition", NULL
           FROM project_uph_test_batch_revision_module_bindings binding
           CROSS JOIN capture_fact
          WHERE binding.id = $6
            AND binding.project_id = $2
            AND binding.revision_id = $7`,
        "member-uph-081-commission",
        fixture.projectId,
        published.commissioningActor.id,
        commissioningSampleId,
        commissioningSourceEventId,
        fixture.moduleBindingId,
        fixture.revisionId
      )
    ).resolves.toBe(1);
    const confirmed = await service.confirmUphTestBatch({
      projectId: fixture.projectId,
      batchId: fixture.batchId,
      revisionId: fixture.revisionId,
      actorId: fixture.pmActor.id,
      authorizationActor: fixture.pmActor,
      resourceVersion: fixture.resourceVersion,
      auditContext: { ...fixture.auditContext, actorId: fixture.pmActor.id }
    });
    const locked = await service.lockUphTestBatch({
      projectId: fixture.projectId,
      batchId: fixture.batchId,
      revisionId: fixture.revisionId,
      actorId: fixture.qualityActor.id,
      authorizationActor: fixture.qualityActor,
      resourceVersion: confirmed.resourceVersion,
      auditContext: { ...fixture.auditContext, actorId: fixture.qualityActor.id }
    });
    const [lockedRevision, lockedBinding] = await Promise.all([
      db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT confirmed_input_snapshot_json, confirmed_input_checksum,
                statistics_snapshot_json, statistics_checksum, locked_snapshot_json, locked_checksum
           FROM project_uph_test_batch_revisions WHERE id = $1`,
        fixture.revisionId
      ),
      db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT quality_input_count, first_pass_good_count, first_pass_nonconforming_count,
                rework_input_count, rework_recovered_good_count,
                valid_sample_count, excluded_sample_count, arithmetic_mean_seconds, p50_seconds,
                p90_seconds, max_seconds, spread_p90_minus_p50_seconds
           FROM project_uph_test_batch_revision_module_bindings WHERE revision_id = $1`,
        fixture.revisionId
      )
    ]);
    expect(locked.status).toBe("LOCKED");
    expect(lockedRevision[0]).toMatchObject({
      confirmed_input_snapshot_json: expect.anything(),
      confirmed_input_checksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
      statistics_snapshot_json: expect.anything(),
      statistics_checksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
      locked_snapshot_json: expect.anything(),
      locked_checksum: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(lockedBinding[0]).toMatchObject({
      valid_sample_count: 11,
      excluded_sample_count: 0,
      arithmetic_mean_seconds: expect.anything(),
      p50_seconds: expect.anything(),
      p90_seconds: expect.anything(),
      max_seconds: expect.anything(),
      spread_p90_minus_p50_seconds: expect.anything()
    });
    await expectSqlStates(
      db.$executeRawUnsafe(
        `UPDATE project_uph_test_batch_revisions SET locked_checksum = repeat('0', 64) WHERE id = $1`,
        fixture.revisionId
      ),
      ["23514", "55000"]
    );
    await expectSqlStates(
      db.$executeRawUnsafe(
        `UPDATE project_uph_test_batch_revision_module_bindings SET p50_seconds = 999 WHERE id = $1`,
        fixture.moduleBindingId
      ),
      ["23514", "55000"]
    );
    await db.$executeRawUnsafe(
      `UPDATE project_members SET left_at = CURRENT_TIMESTAMP WHERE id = $1`,
      "member-uph-081-commission"
    );
    await db.$executeRawUnsafe(
      `UPDATE users SET status = 'DISABLED' WHERE id = $1`,
      published.commissioningActor.id
    );
    const successor = await service.replaceUphTestBatchRevision({
      projectId: fixture.projectId,
      batchId: fixture.batchId,
      revisionId: fixture.revisionId,
      actorId: fixture.processActor.id,
      authorizationActor: fixture.processActor,
      resourceVersion: locked.resourceVersion,
      reason: "correct locked sample",
      auditContext: { ...fixture.auditContext, actorId: fixture.processActor.id }
    });
    const [revision, binding, pointers, copiedSamples] = await Promise.all([
      db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT pm_confirmer_user_id, quality_locker_user_id, confirmed_input_snapshot_json,
                confirmed_input_checksum, statistics_snapshot_json, statistics_checksum,
                locked_snapshot_json, locked_checksum
         FROM project_uph_test_batch_revisions WHERE id = $1`,
        successor.revisionId
      ),
      db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT quality_input_count, first_pass_good_count, first_pass_nonconforming_count,
                rework_input_count, rework_recovered_good_count,
                valid_sample_count, excluded_sample_count, arithmetic_mean_seconds, p50_seconds,
                p90_seconds, max_seconds, spread_p90_minus_p50_seconds
         FROM project_uph_test_batch_revision_module_bindings WHERE revision_id = $1`,
        successor.revisionId
      ),
      db.$queryRawUnsafe<
        Array<{
          original_status: string;
          successor_status: string;
          current_work_revision_id: string | null;
          current_locked_revision_id: string | null;
        }>
      >(
        `SELECT original.status::text AS original_status,
                successor.status::text AS successor_status,
                batch.current_work_revision_id,
                batch.current_locked_revision_id
           FROM project_uph_test_batches batch
           JOIN project_uph_test_batch_revisions original ON original.id = $1
           JOIN project_uph_test_batch_revisions successor ON successor.id = $2
          WHERE batch.id = $3`,
        fixture.revisionId,
        successor.revisionId,
        fixture.batchId
      ),
      db.$queryRawUnsafe<
        Array<{ copied: number; exact_frozen_facts: number; commissioning_capture: number }>
      >(
        `SELECT count(*)::int AS copied,
                count(*) FILTER (
                  WHERE (copied.source_event_id, copied.cycle_duration_seconds, copied.observed_at,
                         copied.recorded_at, copied.capture_method, copied.captured_by_membership_id,
                         copied.captured_by_user_id, copied.captured_by_role, copied.captured_by_snapshot_json,
                         copied.captured_by_checksum, copied.disposition, copied.exclusion_reason_code)
                        IS NOT DISTINCT FROM
                        (original.source_event_id, original.cycle_duration_seconds, original.observed_at,
                         original.recorded_at, original.capture_method, original.captured_by_membership_id,
                         original.captured_by_user_id, original.captured_by_role, original.captured_by_snapshot_json,
                         original.captured_by_checksum, original.disposition, original.exclusion_reason_code)
                )::int AS exact_frozen_facts,
                count(*) FILTER (
                  WHERE original.ordinal = 11
                    AND original.captured_by_membership_id = $3
                    AND original.captured_by_user_id = $4
                    AND original.captured_by_role = 'ENGINEER'
                )::int AS commissioning_capture
           FROM project_uph_module_cycle_samples original
           JOIN project_uph_test_batch_revision_module_bindings original_binding
             ON original_binding.id = original.module_binding_id
           JOIN project_uph_test_batch_revision_module_bindings copied_binding
             ON copied_binding.revision_id = $2
            AND copied_binding.project_id = original_binding.project_id
            AND copied_binding.project_module_id = original_binding.project_module_id
           JOIN project_uph_module_cycle_samples copied
             ON copied.module_binding_id = copied_binding.id
            AND copied.revision_id = $2
            AND copied.project_id = original.project_id
            AND copied.ordinal = original.ordinal
          WHERE original.revision_id = $1`,
        fixture.revisionId,
        successor.revisionId,
        "member-uph-081-commission",
        published.commissioningActor.id
      )
    ]);
    expect(revision[0]).toEqual({
      pm_confirmer_user_id: null,
      quality_locker_user_id: null,
      confirmed_input_snapshot_json: null,
      confirmed_input_checksum: null,
      statistics_snapshot_json: null,
      statistics_checksum: null,
      locked_snapshot_json: null,
      locked_checksum: null
    });
    expect(binding[0]).toEqual({
      quality_input_count: 10n,
      first_pass_good_count: 8n,
      first_pass_nonconforming_count: 2n,
      rework_input_count: 2n,
      rework_recovered_good_count: 1n,
      valid_sample_count: null,
      excluded_sample_count: null,
      arithmetic_mean_seconds: null,
      p50_seconds: null,
      p90_seconds: null,
      max_seconds: null,
      spread_p90_minus_p50_seconds: null
    });
    expect(pointers).toEqual([
      {
        original_status: "LOCKED",
        successor_status: "DRAFT",
        current_work_revision_id: successor.revisionId,
        current_locked_revision_id: fixture.revisionId
      }
    ]);
    expect(copiedSamples).toEqual([
      { copied: 11, exact_frozen_facts: 11, commissioning_capture: 1 }
    ]);
    await expectSqlStateAndMessage(
      db.$executeRawUnsafe(
        `WITH capture_fact AS (
           SELECT member.id AS membership_id,
                  member.user_id,
                  date_trunc('milliseconds', CURRENT_TIMESTAMP) AS recorded_at
             FROM project_members member
             JOIN users actor ON actor.id = member.user_id
            WHERE member.id = $1
              AND member.project_id = $2
              AND member.user_id = $3
              AND member.project_role = 'ENGINEER'
         )
         INSERT INTO project_uph_module_cycle_samples (
           id, project_id, revision_id, module_binding_id, ordinal, correction_of_sample_id,
           source_event_id, cycle_duration_seconds, observed_at, recorded_at, capture_method,
           captured_by_membership_id, captured_by_user_id, captured_by_role,
           captured_by_snapshot_json, captured_by_checksum, disposition, exclusion_reason_code
         )
         SELECT $4, binding.project_id, binding.revision_id, binding.id, 12, NULL,
                $5, 12.000000, '2026-08-25T08:12:00.000Z'::timestamptz, capture_fact.recorded_at,
                'DEVICE_EVENT'::"UphTestBatchSampleCaptureMethod",
                capture_fact.membership_id, capture_fact.user_id, 'ENGINEER'::"ProjectRole",
                "uph_test_batch_responsibility_snapshot"(
                  capture_fact.membership_id, capture_fact.user_id, 'ENGINEER'::"ProjectRole",
                  capture_fact.recorded_at, NULL
                ),
                "uph_test_batch_responsibility_checksum"(
                  capture_fact.membership_id, capture_fact.user_id, 'ENGINEER'::"ProjectRole",
                  capture_fact.recorded_at, NULL
                ),
                'INCLUDED'::"UphTestBatchSampleDisposition", NULL
           FROM project_uph_test_batch_revision_module_bindings binding
           CROSS JOIN capture_fact
          WHERE binding.revision_id = $6
            AND binding.project_id = $2
            AND binding.project_module_id = $7`,
        "member-uph-081-commission",
        fixture.projectId,
        published.commissioningActor.id,
        `stale-commissioning-${crypto.randomUUID()}`,
        `stale-commissioning-event-${crypto.randomUUID()}`,
        successor.revisionId,
        fixture.moduleId
      ),
      "23514",
      /UPH sample must freeze an active same-project ENGINEER capture membership/u
    );
    const successorConfirmed = await service.confirmUphTestBatch({
      projectId: fixture.projectId,
      batchId: fixture.batchId,
      revisionId: successor.revisionId,
      actorId: fixture.pmActor.id,
      authorizationActor: fixture.pmActor,
      resourceVersion: successor.resourceVersion,
      auditContext: { ...fixture.auditContext, actorId: fixture.pmActor.id }
    });
    await expect(
      service.lockUphTestBatch({
        projectId: fixture.projectId,
        batchId: fixture.batchId,
        revisionId: successor.revisionId,
        actorId: fixture.qualityActor.id,
        authorizationActor: fixture.qualityActor,
        resourceVersion: successorConfirmed.resourceVersion,
        auditContext: { ...fixture.auditContext, actorId: fixture.qualityActor.id }
      })
    ).resolves.toMatchObject({ status: "LOCKED" });
    await expect(
      db.$queryRawUnsafe<
        Array<{
          original_status: string;
          successor_status: string;
          current_work_revision_id: string | null;
          current_locked_revision_id: string | null;
        }>
      >(
        `SELECT original.status::text AS original_status,
                successor.status::text AS successor_status,
                batch.current_work_revision_id,
                batch.current_locked_revision_id
           FROM project_uph_test_batches batch
           JOIN project_uph_test_batch_revisions original ON original.id = $1
           JOIN project_uph_test_batch_revisions successor ON successor.id = $2
          WHERE batch.id = $3`,
        fixture.revisionId,
        successor.revisionId,
        fixture.batchId
      )
    ).resolves.toEqual([
      {
        original_status: "SUPERSEDED",
        successor_status: "LOCKED",
        current_work_revision_id: null,
        current_locked_revision_id: successor.revisionId
      }
    ]);
  });

  it("wraps APM-081 business, SUCCESS Audit, Outbox, and replay in existing idempotency transactions", async () => {
    const { db, idempotency, service } = await requireApm081();
    const fixture = await createConfirmedFixture();
    const evidence = await createEvidenceFile(db, fixture, "INTERNAL");
    const operation = "projects.uph.test-batch.evidence.attach";
    const idempotencyKey = `evidence-success-${crypto.randomUUID()}`;
    const path = {
      projectId: fixture.projectId,
      batchId: fixture.batchId,
      revisionId: fixture.revisionId
    };
    const body = {
      resourceVersion: fixture.resourceVersion,
      fileObjectId: evidence.id,
      purpose: "ROOT_PRODUCTION"
    };
    const execute = (transaction: TransactionClient) =>
      service.attachUphTestBatchEvidence(
        {
          projectId: fixture.projectId,
          batchId: fixture.batchId,
          revisionId: fixture.revisionId,
          actorId: fixture.processActor.id,
          authorizationActor: fixture.processActor,
          resourceVersion: fixture.resourceVersion,
          body,
          auditContext: {
            ...fixture.auditContext,
            actorId: fixture.processActor.id,
            operationId: operation
          }
        },
        transaction
      );
    let businessExecutions = 0;
    const run = () =>
      idempotency.executeIdempotentCommand({
        actorId: fixture.processActor.id,
        operation,
        idempotencyKey,
        request: { path, body },
        execute: async (transaction: TransactionClient) => {
          businessExecutions += 1;
          return { status: 200, body: await execute(transaction) };
        }
      });

    const first = await run();
    const replay = await run();
    expect(businessExecutions).toBe(1);
    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, body: first.body });
    await expect(
      db.$queryRawUnsafe<
        Array<{ evidence: number; audits: number; outbox: number; responses: number }>
      >(
        `SELECT
           (SELECT count(*)::int FROM project_uph_test_batch_revision_evidence WHERE revision_id = $1 AND file_object_id = $2) AS evidence,
           (SELECT count(*)::int FROM audit_logs WHERE project_id = $3 AND operation_id = $4 AND result = 'SUCCESS') AS audits,
           (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'uph.test-batch.evidence.referenced') AS outbox,
           (SELECT count(*)::int FROM api_idempotency_records WHERE actor_id = $5 AND operation = $4 AND idempotency_key = $6 AND response_status IS NOT NULL AND completed_at IS NOT NULL) AS responses`,
        fixture.revisionId,
        evidence.id,
        fixture.projectId,
        operation,
        fixture.processActor.id,
        idempotencyKey
      )
    ).resolves.toEqual([{ evidence: 1, audits: 1, outbox: 1, responses: 1 }]);
    await expect(
      idempotency.executeIdempotentCommand({
        actorId: fixture.processActor.id,
        operation,
        idempotencyKey,
        request: { path, body: { ...body, purpose: "PROTOCOL" } },
        execute: async () => ({ status: 200, body: { impossible: true } })
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });

    const failedFixture = await createConfirmedFixture();
    const failedOperation = "projects.uph.test-batch.evidence.attach.rollback";
    const failedKey = `evidence-rollback-${crypto.randomUUID()}`;
    const failedPath = {
      projectId: failedFixture.projectId,
      batchId: failedFixture.batchId,
      revisionId: failedFixture.revisionId
    };
    const failedBody = {
      resourceVersion: failedFixture.resourceVersion,
      fileObjectId: "missing-file-object",
      purpose: "ROOT_PRODUCTION"
    };
    const before = await db.$queryRawUnsafe<
      Array<{ revisions: number; evidence: number; audits: number; outbox: number }>
    >(
      `SELECT
         (SELECT count(*)::int FROM project_uph_test_batch_revisions WHERE batch_id = $1) AS revisions,
         (SELECT count(*)::int FROM project_uph_test_batch_revision_evidence WHERE revision_id = $2) AS evidence,
         (SELECT count(*)::int FROM audit_logs WHERE operation_id = $3 AND result = 'SUCCESS') AS audits,
         (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $2) AS outbox`,
      failedFixture.batchId,
      failedFixture.revisionId,
      failedOperation
    );
    await expect(
      idempotency.executeIdempotentCommand({
        actorId: failedFixture.processActor.id,
        operation: failedOperation,
        idempotencyKey: failedKey,
        request: { path: failedPath, body: failedBody },
        execute: async (transaction: TransactionClient) => ({
          status: 200,
          body: await service.attachUphTestBatchEvidence(
            {
              projectId: failedFixture.projectId,
              batchId: failedFixture.batchId,
              revisionId: failedFixture.revisionId,
              actorId: failedFixture.processActor.id,
              authorizationActor: failedFixture.processActor,
              resourceVersion: failedFixture.resourceVersion,
              body: failedBody,
              auditContext: {
                ...failedFixture.auditContext,
                actorId: failedFixture.processActor.id,
                operationId: failedOperation
              }
            },
            transaction
          )
        })
      })
    ).rejects.toMatchObject({ code: "FILE_OBJECT_NOT_FOUND" });
    await expect(
      db.$queryRawUnsafe<
        Array<{
          revisions: number;
          evidence: number;
          audits: number;
          outbox: number;
          idempotency_records: number;
        }>
      >(
        `SELECT
           (SELECT count(*)::int FROM project_uph_test_batch_revisions WHERE batch_id = $1) AS revisions,
           (SELECT count(*)::int FROM project_uph_test_batch_revision_evidence WHERE revision_id = $2) AS evidence,
           (SELECT count(*)::int FROM audit_logs WHERE operation_id = $3 AND result = 'SUCCESS') AS audits,
           (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $2) AS outbox,
           (SELECT count(*)::int FROM api_idempotency_records WHERE actor_id = $4 AND operation = $3 AND idempotency_key = $5) AS idempotency_records`,
        failedFixture.batchId,
        failedFixture.revisionId,
        failedOperation,
        failedFixture.processActor.id,
        failedKey
      )
    ).resolves.toEqual([{ ...before[0], idempotency_records: 0 }]);

    const deferredCreated = await service.createUphTestBatch({
      projectId: fixture.projectId,
      actorId: fixture.processActor.id,
      authorizationActor: fixture.processActor,
      body: {
        batchNumber: `DEFERRED-${crypto.randomUUID()}`,
        topologyRootNodeId: fixture.topologyRootNodeId,
        plannedProductionSeconds: 3600,
        planDeclarationReason: "Deferred guard rollback fixture",
        observationStartedAt: "2026-08-25T08:00:00.000Z",
        observationEndedAt: null,
        timezone: "Asia/Shanghai"
      },
      auditContext: { ...fixture.auditContext, actorId: fixture.processActor.id }
    });
    const deferredOperation = "projects.uph.test-batch.pm-confirm.deferred-rollback";
    const deferredKey = `pm-confirm-deferred-${crypto.randomUUID()}`;
    const deferredBefore = await db.$queryRawUnsafe<
      Array<{
        status: string;
        resource_version: number;
        audit_success: number;
        outbox: number;
        idempotency_records: number;
      }>
    >(
      `SELECT revision.status::text AS status,
              batch.resource_version,
              (SELECT count(*)::int FROM audit_logs WHERE operation_id = $3 AND result = 'SUCCESS') AS audit_success,
              (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $2 AND event_type = 'uph.test-batch.pm-confirmed') AS outbox,
              (SELECT count(*)::int FROM api_idempotency_records WHERE actor_id = $4 AND operation = $3 AND idempotency_key = $5) AS idempotency_records
         FROM project_uph_test_batch_revisions revision
         JOIN project_uph_test_batches batch ON batch.id = revision.batch_id
        WHERE revision.id = $1 AND batch.id = $2`,
      deferredCreated.revisionId,
      deferredCreated.batchId,
      deferredOperation,
      fixture.pmActor.id,
      deferredKey
    );
    await expect(
      idempotency.executeIdempotentCommand({
        actorId: fixture.pmActor.id,
        operation: deferredOperation,
        idempotencyKey: deferredKey,
        request: {
          path: {
            projectId: fixture.projectId,
            batchId: deferredCreated.batchId,
            revisionId: deferredCreated.revisionId
          },
          body: { resourceVersion: deferredCreated.resourceVersion }
        },
        execute: async (transaction: TransactionClient) => ({
          status: 200,
          body: await service.confirmUphTestBatch(
            {
              projectId: fixture.projectId,
              batchId: deferredCreated.batchId,
              revisionId: deferredCreated.revisionId,
              actorId: fixture.pmActor.id,
              authorizationActor: fixture.pmActor,
              resourceVersion: deferredCreated.resourceVersion,
              auditContext: {
                ...fixture.auditContext,
                actorId: fixture.pmActor.id,
                operationId: deferredOperation
              }
            },
            transaction
          )
        })
      })
    ).rejects.toMatchObject({ code: "UPH_CONSTRAINT_VIOLATION", status: 422 });
    await expect(
      db.$queryRawUnsafe<
        Array<{
          status: string;
          resource_version: number;
          audit_success: number;
          outbox: number;
          idempotency_records: number;
        }>
      >(
        `SELECT revision.status::text AS status,
                batch.resource_version,
                (SELECT count(*)::int FROM audit_logs WHERE operation_id = $3 AND result = 'SUCCESS') AS audit_success,
                (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $2 AND event_type = 'uph.test-batch.pm-confirmed') AS outbox,
                (SELECT count(*)::int FROM api_idempotency_records WHERE actor_id = $4 AND operation = $3 AND idempotency_key = $5) AS idempotency_records
           FROM project_uph_test_batch_revisions revision
           JOIN project_uph_test_batches batch ON batch.id = revision.batch_id
          WHERE revision.id = $1 AND batch.id = $2`,
        deferredCreated.revisionId,
        deferredCreated.batchId,
        deferredOperation,
        fixture.pmActor.id,
        deferredKey
      )
    ).resolves.toEqual(deferredBefore);
  });

  it("accepts only eligible revision evidence, hides denied restricted metadata, and audits authorized sensitive reads", async () => {
    const { db, service } = await requireApm081();
    const fixture = await createConfirmedFixture();
    const controlled = await createEvidenceFile(db, fixture, "INTERNAL");
    const attached = await service.attachUphTestBatchEvidence({
      projectId: fixture.projectId,
      batchId: fixture.batchId,
      revisionId: fixture.revisionId,
      actorId: fixture.processActor.id,
      authorizationActor: fixture.processActor,
      resourceVersion: fixture.resourceVersion,
      body: { fileObjectId: controlled.id, purpose: "ROOT_PRODUCTION" },
      auditContext: { ...fixture.auditContext, actorId: fixture.processActor.id }
    });
    expect(attached.resourceVersion).toBeGreaterThan(fixture.resourceVersion);
    await expect(
      db.$queryRawUnsafe<Array<{ file_sha256: string; sensitivity: string }>>(
        `SELECT file_sha256, sensitivity::text
           FROM project_uph_test_batch_revision_evidence
          WHERE revision_id = $1 AND file_object_id = $2`,
        fixture.revisionId,
        controlled.id
      )
    ).resolves.toEqual([{ file_sha256: controlled.sha256, sensitivity: "INTERNAL" }]);

    const invalidFixture = await createConfirmedFixture();
    const foreignProjectId = await createForeignProject(db, invalidFixture);
    const invalidFiles = [
      [
        "cross-project",
        await createEvidenceFile(db, invalidFixture, "INTERNAL", { projectId: foreignProjectId })
      ],
      [
        "pending-scan",
        await createEvidenceFile(db, invalidFixture, "INTERNAL", { status: "PENDING_SCAN" })
      ]
    ] as const;
    for (const [label, file] of invalidFiles) {
      const operationId = `uph-081-evidence-reject-${label}-${crypto.randomUUID()}`;
      const before = await db.$queryRawUnsafe<
        Array<{ evidence: number; audits: number; outbox: number; responses: number }>
      >(
        `SELECT
           (SELECT count(*)::int FROM project_uph_test_batch_revision_evidence WHERE revision_id = $1 AND file_object_id = $2) AS evidence,
           (SELECT count(*)::int FROM audit_logs WHERE operation_id = $3 AND result = 'SUCCESS') AS audits,
           (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1) AS outbox,
           (SELECT count(*)::int FROM api_idempotency_records WHERE actor_id = $4 AND operation = $3 AND response_status IS NOT NULL) AS responses`,
        invalidFixture.revisionId,
        file.id,
        operationId,
        invalidFixture.processActor.id
      );
      await expect(
        service.attachUphTestBatchEvidence({
          projectId: invalidFixture.projectId,
          batchId: invalidFixture.batchId,
          revisionId: invalidFixture.revisionId,
          actorId: invalidFixture.processActor.id,
          authorizationActor: invalidFixture.processActor,
          resourceVersion: invalidFixture.resourceVersion,
          body: { fileObjectId: file.id, purpose: "ROOT_PRODUCTION" },
          auditContext: {
            ...invalidFixture.auditContext,
            actorId: invalidFixture.processActor.id,
            operationId
          }
        })
      ).rejects.toSatisfy((error: unknown) => {
        const status = (error as { status?: unknown }).status;
        return status === 403 || status === 404 || status === 409 || status === 422;
      });
      await expect(
        db.$queryRawUnsafe<
          Array<{ evidence: number; audits: number; outbox: number; responses: number }>
        >(
          `SELECT
             (SELECT count(*)::int FROM project_uph_test_batch_revision_evidence WHERE revision_id = $1 AND file_object_id = $2) AS evidence,
             (SELECT count(*)::int FROM audit_logs WHERE operation_id = $3 AND result = 'SUCCESS') AS audits,
             (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1) AS outbox,
             (SELECT count(*)::int FROM api_idempotency_records WHERE actor_id = $4 AND operation = $3 AND response_status IS NOT NULL) AS responses`,
          invalidFixture.revisionId,
          file.id,
          operationId,
          invalidFixture.processActor.id
        )
      ).resolves.toEqual(before);
    }

    const restrictedFixture = await createConfirmedFixture();
    const restricted = await createEvidenceFile(db, restrictedFixture, "RESTRICTED");
    const deniedBefore = await db.$queryRawUnsafe<
      Array<{ evidence: number; audits: number; outbox: number; responses: number }>
    >(
      `SELECT
         (SELECT count(*)::int FROM project_uph_test_batch_revision_evidence WHERE revision_id = $1 AND file_object_id = $2) AS evidence,
         (SELECT count(*)::int FROM audit_logs WHERE project_id = $3 AND action = 'UPH_TEST_BATCH_EVIDENCE_REFERENCED') AS audits,
         (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1) AS outbox,
         (SELECT count(*)::int FROM api_idempotency_records WHERE actor_id = $4 AND operation = 'projects.uph.test-batch.evidence.attach' AND response_status IS NOT NULL) AS responses`,
      restrictedFixture.revisionId,
      restricted.id,
      restrictedFixture.projectId,
      restrictedFixture.processActor.id
    );
    await expect(
      service.attachUphTestBatchEvidence({
        projectId: restrictedFixture.projectId,
        batchId: restrictedFixture.batchId,
        revisionId: restrictedFixture.revisionId,
        actorId: restrictedFixture.processActor.id,
        authorizationActor: restrictedFixture.processActor,
        resourceVersion: restrictedFixture.resourceVersion,
        body: { fileObjectId: restricted.id, purpose: "ROOT_PRODUCTION" },
        auditContext: {
          ...restrictedFixture.auditContext,
          actorId: restrictedFixture.processActor.id
        }
      })
    ).rejects.toSatisfy((error: unknown) => {
      const serialized = JSON.stringify(error);
      return (
        (error as { status?: unknown }).status === 403 && !serialized.includes("uph-evidence.json")
      );
    });
    const deniedAfter = await db.$queryRawUnsafe<
      Array<{ evidence: number; audits: number; outbox: number; responses: number }>
    >(
      `SELECT
         (SELECT count(*)::int FROM project_uph_test_batch_revision_evidence WHERE revision_id = $1 AND file_object_id = $2) AS evidence,
         (SELECT count(*)::int FROM audit_logs WHERE project_id = $3 AND action = 'UPH_TEST_BATCH_EVIDENCE_REFERENCED') AS audits,
         (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1) AS outbox,
         (SELECT count(*)::int FROM api_idempotency_records WHERE actor_id = $4 AND operation = 'projects.uph.test-batch.evidence.attach' AND response_status IS NOT NULL) AS responses`,
      restrictedFixture.revisionId,
      restricted.id,
      restrictedFixture.projectId,
      restrictedFixture.processActor.id
    );
    expect(deniedAfter).toEqual(deniedBefore);

    const sensitiveActor = {
      ...restrictedFixture.processActor,
      grants: [
        ...restrictedFixture.processActor.grants,
        { permission: "SENSITIVE_FILE_READ", scope: "PROJECT", systemRole: "ENGINEER" }
      ]
    };
    await expect(
      service.attachUphTestBatchEvidence({
        projectId: restrictedFixture.projectId,
        batchId: restrictedFixture.batchId,
        revisionId: restrictedFixture.revisionId,
        actorId: sensitiveActor.id,
        authorizationActor: sensitiveActor,
        resourceVersion: restrictedFixture.resourceVersion,
        body: { fileObjectId: restricted.id, purpose: "ROOT_PRODUCTION" },
        auditContext: { ...restrictedFixture.auditContext, actorId: sensitiveActor.id }
      })
    ).resolves.toMatchObject({ revisionId: restrictedFixture.revisionId });
    await expect(
      db.$queryRawUnsafe<Array<{ reads: number }>>(
        `SELECT count(*)::int AS reads FROM audit_logs
          WHERE action = 'SENSITIVE_FILE_READ' AND object_type = 'FILE_OBJECT'
            AND object_id = $1 AND actor_id = $2`,
        restricted.id,
        sensitiveActor.id
      )
    ).resolves.toEqual([{ reads: 1 }]);
  });

  it("uses the frozen version-before-source lock order in both startup directions without a deadlock", async () => {
    const { db, service } = await requireApm081();
    const first = await createConfirmedFixture();
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const batchFirst = db.$transaction(async (transaction) => {
      const confirmed = await service.confirmUphTestBatch(
        {
          projectId: first.projectId,
          batchId: first.batchId,
          revisionId: first.revisionId,
          actorId: first.pmActor.id,
          authorizationActor: first.pmActor,
          resourceVersion: first.resourceVersion,
          auditContext: { ...first.auditContext, actorId: first.pmActor.id }
        },
        transaction
      );
      await firstReleased;
      return confirmed;
    });
    await waitForNowaitConflict(() =>
      db.$transaction((transaction) =>
        transaction.$executeRawUnsafe(
          `SELECT id FROM project_modules WHERE id = $1 FOR UPDATE NOWAIT`,
          first.moduleId
        )
      )
    );
    releaseFirst();
    await expect(batchFirst).resolves.toMatchObject({ status: "PM_CONFIRMED" });

    const second = await createConfirmedFixture();
    let beginVersionProbe!: () => void;
    const sourceLocked = new Promise<void>((resolve) => {
      beginVersionProbe = resolve;
    });
    let sourceProbe!: () => void;
    const versionProbe = new Promise<void>((resolve) => {
      sourceProbe = resolve;
    });
    const sourceFirst = db.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        `SELECT id FROM project_modules WHERE id = $1 FOR UPDATE`,
        second.moduleId
      );
      beginVersionProbe();
      await versionProbe;
      await expectSqlStates(
        transaction.$executeRawUnsafe(
          `SELECT id FROM project_uph_ct_definition_versions WHERE id = $1 FOR UPDATE NOWAIT`,
          second.frozenCtVersionId
        ),
        ["55P03"]
      );
    });
    await sourceLocked;
    const batchSecond = service.confirmUphTestBatch({
      projectId: second.projectId,
      batchId: second.batchId,
      revisionId: second.revisionId,
      actorId: second.pmActor.id,
      authorizationActor: second.pmActor,
      resourceVersion: second.resourceVersion,
      auditContext: { ...second.auditContext, actorId: second.pmActor.id }
    });
    await waitForNowaitConflict(() =>
      db.$transaction((transaction) =>
        transaction.$executeRawUnsafe(
          `SELECT id FROM project_uph_ct_definition_versions WHERE id = $1 FOR UPDATE NOWAIT`,
          second.frozenCtVersionId
        )
      )
    );
    sourceProbe();
    const outcomes = await Promise.allSettled([sourceFirst, batchSecond]);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
  });

  it.each(
    [
      "batch-create <> APM-080 publish",
      "batch-create <> APM-080 correction",
      "sample <> PM_CONFIRM"
    ].flatMap((scenario) => [
      { scenario, direction: "LEFT_THEN_RIGHT" as const },
      { scenario, direction: "RIGHT_THEN_LEFT" as const }
    ])
  )("uses a proven lock barrier for $scenario in $direction", async ({ scenario, direction }) => {
    const { db, definitions, service } = await requireApm081();
    const fixture = await createConfirmedFixture();
    const batchNumber = `CONCURRENT-${crypto.randomUUID()}`;
    const createBatch = (transaction?: TransactionClient) =>
      service.createUphTestBatch(
        {
          projectId: fixture.projectId,
          actorId: fixture.processActor.id,
          authorizationActor: fixture.processActor,
          body: {
            batchNumber,
            topologyRootNodeId: fixture.topologyRootNodeId,
            plannedProductionSeconds: 3600,
            planDeclarationReason: "Concurrent controlled production declaration",
            observationStartedAt: "2026-08-25T08:00:00.000Z",
            observationEndedAt: null,
            timezone: "Asia/Shanghai"
          },
          auditContext: { ...fixture.auditContext, actorId: fixture.processActor.id }
        },
        transaction
      );
    const createFormulaCorrection = async (transaction?: TransactionClient) =>
      definitions.createUphDefinition(
        {
          projectId: fixture.projectId,
          actorId: fixture.processActor.id,
          authorizationActor: fixture.processActor,
          body: {
            kind: "FORMULA",
            projectVersion: await formulaRootVersion(db, fixture.projectId),
            content: {
              formulaCode: "CANONICAL_UPH_V1",
              formulaJson: {
                numerator: "3600*outputPerCycleTotal*parallelChannelCount",
                denominator: "intrinsicCtSeconds"
              }
            }
          },
          auditContext: { ...fixture.auditContext, actorId: fixture.processActor.id }
        },
        transaction
      );
    const appendSample = (transaction?: TransactionClient) =>
      service.appendUphCycleSample(
        {
          projectId: fixture.projectId,
          batchId: fixture.batchId,
          revisionId: fixture.revisionId,
          actorId: fixture.processActor.id,
          authorizationActor: fixture.processActor,
          resourceVersion: fixture.resourceVersion,
          body: {
            projectModuleId: fixture.moduleId,
            ordinal: 11,
            sourceEventId: "device-concurrent-11",
            cycleDurationSeconds: "11.000000",
            observedAt: "2026-08-25T08:11:00.000Z",
            captureMethod: "DEVICE_EVENT",
            disposition: "INCLUDED"
          },
          auditContext: { ...fixture.auditContext, actorId: fixture.processActor.id }
        },
        transaction
      );
    const confirm = (transaction?: TransactionClient) =>
      service.confirmUphTestBatch(
        {
          projectId: fixture.projectId,
          batchId: fixture.batchId,
          revisionId: fixture.revisionId,
          actorId: fixture.pmActor.id,
          authorizationActor: fixture.pmActor,
          resourceVersion: fixture.resourceVersion,
          auditContext: { ...fixture.auditContext, actorId: fixture.pmActor.id }
        },
        transaction
      );
    const probeRevisionLock = (transaction: TransactionClient) =>
      transaction.$executeRawUnsafe(
        `SELECT id FROM project_uph_test_batch_revisions WHERE id = $1 FOR UPDATE NOWAIT`,
        fixture.revisionId
      );
    const probeVersionLock = (transaction: TransactionClient) =>
      transaction.$executeRawUnsafe(
        `SELECT id FROM project_uph_ct_definition_versions WHERE id = $1 FOR UPDATE NOWAIT`,
        fixture.frozenCtVersionId
      );
    const probeFormulaVersionLock = (transaction: TransactionClient) =>
      transaction.$executeRawUnsafe(
        `SELECT id FROM project_uph_formula_versions WHERE id = $1 FOR UPDATE NOWAIT`,
        fixture.formulaVersionId
      );

    if (scenario === "batch-create <> APM-080 publish") {
      const formulaDraft = await createFormulaCorrection();
      const publish = (transaction?: TransactionClient) =>
        definitions.publishUphDefinition(
          {
            projectId: fixture.projectId,
            kind: "FORMULA",
            versionId: formulaDraft.id,
            resourceVersion: formulaDraft.resourceVersion,
            actorId: fixture.qualityActor.id,
            authorizationActor: fixture.qualityActor,
            auditContext: { ...fixture.auditContext, actorId: fixture.qualityActor.id }
          },
          transaction
        );
      await runBarrier(
        db,
        direction === "LEFT_THEN_RIGHT" ? createBatch : publish,
        direction === "LEFT_THEN_RIGHT" ? publish : createBatch,
        direction === "LEFT_THEN_RIGHT" ? probeVersionLock : probeFormulaVersionLock
      );
      await expect(
        db.$queryRawUnsafe<Array<{ bindings: number; missing_sources: number }>>(
          `SELECT count(b.id)::int AS bindings,
                  count(*) FILTER (WHERE r.topology_version_id IS NULL OR r.formula_version_id IS NULL OR b.ct_version_id IS NULL)::int AS missing_sources
             FROM project_uph_test_batches batch
             JOIN project_uph_test_batch_revisions r ON r.batch_id = batch.id
             LEFT JOIN project_uph_test_batch_revision_module_bindings b ON b.revision_id = r.id
            WHERE batch.project_id = $1 AND batch.batch_number = $2`,
          fixture.projectId,
          batchNumber
        )
      ).resolves.toEqual([{ bindings: 1, missing_sources: 0 }]);
    } else if (scenario === "batch-create <> APM-080 correction") {
      await runBarrier(
        db,
        direction === "LEFT_THEN_RIGHT" ? createBatch : createFormulaCorrection,
        direction === "LEFT_THEN_RIGHT" ? createFormulaCorrection : createBatch,
        direction === "LEFT_THEN_RIGHT" ? probeVersionLock : probeFormulaVersionLock
      );
      await expect(
        db.$queryRawUnsafe<Array<{ bindings: number; missing_sources: number }>>(
          `SELECT count(b.id)::int AS bindings,
                  count(*) FILTER (WHERE r.topology_version_id IS NULL OR r.formula_version_id IS NULL OR b.ct_version_id IS NULL)::int AS missing_sources
             FROM project_uph_test_batches batch
             JOIN project_uph_test_batch_revisions r ON r.batch_id = batch.id
             LEFT JOIN project_uph_test_batch_revision_module_bindings b ON b.revision_id = r.id
            WHERE batch.project_id = $1 AND batch.batch_number = $2`,
          fixture.projectId,
          batchNumber
        )
      ).resolves.toEqual([{ bindings: 1, missing_sources: 0 }]);
    } else if (scenario === "sample <> PM_CONFIRM") {
      await runBarrier(
        db,
        direction === "LEFT_THEN_RIGHT" ? appendSample : confirm,
        direction === "LEFT_THEN_RIGHT" ? confirm : appendSample,
        probeRevisionLock
      );
      const [revision] = await db.$queryRawUnsafe<
        Array<{ status: string; confirmed_input_snapshot_json: unknown | null; samples: number }>
      >(
        `SELECT r.status::text, r.confirmed_input_snapshot_json,
                (SELECT count(*)::int FROM project_uph_module_cycle_samples s WHERE s.revision_id = r.id) AS samples
           FROM project_uph_test_batch_revisions r
          WHERE r.id = $1`,
        fixture.revisionId
      );
      expect(revision).toBeDefined();
      if (revision!.status === "PM_CONFIRMED") {
        expect(revision!.confirmed_input_snapshot_json).not.toBeNull();
      } else {
        expect(revision!.status).toBe("DRAFT");
      }
      expect(revision!.samples).toBeGreaterThanOrEqual(10);
    }

    await expect(
      db.$queryRawUnsafe<Array<{ invalid_pointers: number; malformed_outbox: number }>>(
        `SELECT
           (SELECT count(*)::int
              FROM project_uph_test_batches batch
              LEFT JOIN project_uph_test_batch_revisions work ON work.id = batch.current_work_revision_id
              LEFT JOIN project_uph_test_batch_revisions locked ON locked.id = batch.current_locked_revision_id
             WHERE batch.project_id = $1
               AND (batch.current_work_revision_id = batch.current_locked_revision_id
                    OR (work.id IS NOT NULL AND work.status NOT IN ('DRAFT', 'PM_CONFIRMED'))
                    OR (locked.id IS NOT NULL AND locked.status <> 'LOCKED'))) AS invalid_pointers,
           (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $2 AND payload IS NULL) AS malformed_outbox`,
        fixture.projectId,
        fixture.revisionId
      )
    ).resolves.toEqual([{ invalid_pointers: 0, malformed_outbox: 0 }]);
  });

  it("serializes evidence attach and FileObject sensitivity in both lock-proven directions", async () => {
    const { db, service } = await requireApm081();
    const attachFirstFixture = await createConfirmedFixture();
    const attachFirstFile = await createEvidenceFile(db, attachFirstFixture, "INTERNAL");
    const attachFirstOperation = `uph-081-evidence-attach-first-${crypto.randomUUID()}`;
    const attachFirst = (transaction?: TransactionClient) =>
      service.attachUphTestBatchEvidence(
        {
          projectId: attachFirstFixture.projectId,
          batchId: attachFirstFixture.batchId,
          revisionId: attachFirstFixture.revisionId,
          actorId: attachFirstFixture.processActor.id,
          authorizationActor: attachFirstFixture.processActor,
          resourceVersion: attachFirstFixture.resourceVersion,
          body: { fileObjectId: attachFirstFile.id, purpose: "ROOT_PRODUCTION" },
          auditContext: {
            ...attachFirstFixture.auditContext,
            actorId: attachFirstFixture.processActor.id,
            operationId: attachFirstOperation
          }
        },
        transaction
      );
    const restrictAttachFirstFile = (transaction?: TransactionClient) =>
      (transaction ?? db).$executeRawUnsafe(
        `UPDATE file_objects SET sensitivity = 'RESTRICTED', version = version + 1 WHERE id = $1`,
        attachFirstFile.id
      );
    const probeAttachFirstFileLock = (transaction: TransactionClient) =>
      transaction.$executeRawUnsafe(
        `SELECT id FROM file_objects WHERE id = $1 FOR UPDATE NOWAIT`,
        attachFirstFile.id
      );
    const attachFirstOutcomes = await runBarrier(
      db,
      attachFirst,
      restrictAttachFirstFile,
      probeAttachFirstFileLock,
      { allowedFailureStatuses: [] }
    );
    expect(attachFirstOutcomes).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" })
    ]);
    await expect(
      db.$queryRawUnsafe<
        Array<{
          evidence: number;
          audits: number;
          outbox: number;
          frozen_sensitivity: string;
          current_sensitivity: string;
        }>
      >(
        `SELECT
           (SELECT count(*)::int FROM project_uph_test_batch_revision_evidence WHERE revision_id = $1 AND file_object_id = $2) AS evidence,
           (SELECT count(*)::int FROM audit_logs WHERE project_id = $3 AND operation_id = $4 AND result = 'SUCCESS') AS audits,
           (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'uph.test-batch.evidence.referenced') AS outbox,
           (SELECT evidence.sensitivity::text FROM project_uph_test_batch_revision_evidence evidence WHERE evidence.revision_id = $1 AND evidence.file_object_id = $2) AS frozen_sensitivity,
           (SELECT sensitivity::text FROM file_objects WHERE id = $2) AS current_sensitivity`,
        attachFirstFixture.revisionId,
        attachFirstFile.id,
        attachFirstFixture.projectId,
        attachFirstOperation
      )
    ).resolves.toEqual([
      {
        evidence: 1,
        audits: 1,
        outbox: 1,
        frozen_sensitivity: "INTERNAL",
        current_sensitivity: "RESTRICTED"
      }
    ]);

    const fileFirstFixture = await createConfirmedFixture();
    const fileFirst = await createEvidenceFile(db, fileFirstFixture, "INTERNAL");
    const deniedOperation = `uph-081-evidence-restricted-${crypto.randomUUID()}`;
    const restrictFileFirst = (transaction?: TransactionClient) =>
      (transaction ?? db).$executeRawUnsafe(
        `UPDATE file_objects SET sensitivity = 'RESTRICTED', version = version + 1 WHERE id = $1`,
        fileFirst.id
      );
    const deniedAttach = (transaction?: TransactionClient) =>
      service.attachUphTestBatchEvidence(
        {
          projectId: fileFirstFixture.projectId,
          batchId: fileFirstFixture.batchId,
          revisionId: fileFirstFixture.revisionId,
          actorId: fileFirstFixture.processActor.id,
          authorizationActor: fileFirstFixture.processActor,
          resourceVersion: fileFirstFixture.resourceVersion,
          body: { fileObjectId: fileFirst.id, purpose: "ROOT_PRODUCTION" },
          auditContext: {
            ...fileFirstFixture.auditContext,
            actorId: fileFirstFixture.processActor.id,
            operationId: deniedOperation
          }
        },
        transaction
      );
    const probeFileFirstLock = (transaction: TransactionClient) =>
      transaction.$executeRawUnsafe(
        `SELECT id FROM file_objects WHERE id = $1 FOR UPDATE NOWAIT`,
        fileFirst.id
      );
    const before = await db.$queryRawUnsafe<
      Array<{ evidence: number; audits: number; outbox: number }>
    >(
      `SELECT
         (SELECT count(*)::int FROM project_uph_test_batch_revision_evidence WHERE revision_id = $1 AND file_object_id = $2) AS evidence,
         (SELECT count(*)::int FROM audit_logs WHERE project_id = $3 AND operation_id = $4 AND result = 'SUCCESS') AS audits,
         (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1) AS outbox`,
      fileFirstFixture.revisionId,
      fileFirst.id,
      fileFirstFixture.projectId,
      deniedOperation
    );
    const fileFirstOutcomes = await runBarrier(
      db,
      restrictFileFirst,
      deniedAttach,
      probeFileFirstLock,
      { allowedFailureStatuses: [403] }
    );
    expect(fileFirstOutcomes).toHaveLength(2);
    expect(fileFirstOutcomes[0]).toMatchObject({ status: "fulfilled" });
    expect(fileFirstOutcomes[1]).toMatchObject({ status: "rejected" });
    if (fileFirstOutcomes[1]?.status !== "rejected") {
      throw new Error(
        "FileObject-first evidence attach did not reject after sensitivity restriction."
      );
    }
    expect(fileFirstOutcomes[1].reason).toMatchObject({ status: 403 });
    await expect(
      db.$queryRawUnsafe<Array<{ evidence: number; audits: number; outbox: number }>>(
        `SELECT
           (SELECT count(*)::int FROM project_uph_test_batch_revision_evidence WHERE revision_id = $1 AND file_object_id = $2) AS evidence,
           (SELECT count(*)::int FROM audit_logs WHERE project_id = $3 AND operation_id = $4 AND result = 'SUCCESS') AS audits,
           (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $1) AS outbox`,
        fileFirstFixture.revisionId,
        fileFirst.id,
        fileFirstFixture.projectId,
        deniedOperation
      )
    ).resolves.toEqual(before);
  });

  it("holds PM confirmation before lock contention, then rejects an early lock with no side effects", async () => {
    const { db, service } = await requireApm081();
    const heldFixture = await createConfirmedFixture();
    let releaseConfirmation!: () => void;
    const confirmationReleased = new Promise<void>((resolve) => {
      releaseConfirmation = resolve;
    });
    let signalConfirmationHeld!: () => void;
    const confirmationHeld = new Promise<void>((resolve) => {
      signalConfirmationHeld = resolve;
    });
    const confirmHeld = db.$transaction(async (transaction) => {
      const result = await service.confirmUphTestBatch(
        {
          projectId: heldFixture.projectId,
          batchId: heldFixture.batchId,
          revisionId: heldFixture.revisionId,
          actorId: heldFixture.pmActor.id,
          authorizationActor: heldFixture.pmActor,
          resourceVersion: heldFixture.resourceVersion,
          auditContext: {
            ...heldFixture.auditContext,
            actorId: heldFixture.pmActor.id,
            operationId: "uph-081-concurrent-confirm-held"
          }
        },
        transaction
      );
      signalConfirmationHeld();
      await confirmationReleased;
      return result;
    });
    await confirmationHeld;
    await waitForNowaitConflict(() =>
      db.$transaction((transaction) =>
        transaction.$executeRawUnsafe(
          `SELECT id FROM project_uph_test_batch_revisions WHERE id = $1 FOR UPDATE NOWAIT`,
          heldFixture.revisionId
        )
      )
    );
    const lockContender = service.lockUphTestBatch({
      projectId: heldFixture.projectId,
      batchId: heldFixture.batchId,
      revisionId: heldFixture.revisionId,
      actorId: heldFixture.qualityActor.id,
      authorizationActor: heldFixture.qualityActor,
      resourceVersion: heldFixture.resourceVersion,
      auditContext: {
        ...heldFixture.auditContext,
        actorId: heldFixture.qualityActor.id,
        operationId: "uph-081-concurrent-lock-contender"
      }
    });
    releaseConfirmation();
    const [confirmed, contestedLock] = await Promise.allSettled([confirmHeld, lockContender]);
    expect(confirmed.status).toBe("fulfilled");
    expect(contestedLock).toMatchObject({ status: "rejected", reason: { status: 409 } });
    await expect(
      db.$queryRawUnsafe<
        Array<{
          status: string;
          current_work_revision_id: string | null;
          current_locked_revision_id: string | null;
        }>
      >(
        `SELECT r.status::text, batch.current_work_revision_id, batch.current_locked_revision_id
           FROM project_uph_test_batch_revisions r
           JOIN project_uph_test_batches batch ON batch.id = r.batch_id
          WHERE r.id = $1`,
        heldFixture.revisionId
      )
    ).resolves.toEqual([
      {
        status: "PM_CONFIRMED",
        current_work_revision_id: heldFixture.revisionId,
        current_locked_revision_id: null
      }
    ]);

    const draftFixture = await createConfirmedFixture();
    const earlyLockOperation = "uph-081-lock-before-confirm";
    const before = await db.$queryRawUnsafe<
      Array<{ audits: number; outbox: number; pointers: number }>
    >(
      `SELECT
         (SELECT count(*)::int FROM audit_logs WHERE operation_id = $1 AND result = 'SUCCESS') AS audits,
         (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $2) AS outbox,
         (SELECT count(*)::int FROM project_uph_test_batches WHERE id = $3 AND current_work_revision_id = $4 AND current_locked_revision_id IS NULL) AS pointers`,
      earlyLockOperation,
      draftFixture.revisionId,
      draftFixture.batchId,
      draftFixture.revisionId
    );
    await expect(
      service.lockUphTestBatch({
        projectId: draftFixture.projectId,
        batchId: draftFixture.batchId,
        revisionId: draftFixture.revisionId,
        actorId: draftFixture.qualityActor.id,
        authorizationActor: draftFixture.qualityActor,
        resourceVersion: draftFixture.resourceVersion,
        auditContext: {
          ...draftFixture.auditContext,
          actorId: draftFixture.qualityActor.id,
          operationId: earlyLockOperation
        }
      })
    ).rejects.toMatchObject({ code: "PM_CONFIRMATION_REQUIRED", status: 409 });
    await expect(
      db.$queryRawUnsafe<Array<{ audits: number; outbox: number; pointers: number }>>(
        `SELECT
           (SELECT count(*)::int FROM audit_logs WHERE operation_id = $1 AND result = 'SUCCESS') AS audits,
           (SELECT count(*)::int FROM outbox_events WHERE aggregate_id = $2) AS outbox,
           (SELECT count(*)::int FROM project_uph_test_batches WHERE id = $3 AND current_work_revision_id = $4 AND current_locked_revision_id IS NULL) AS pointers`,
        earlyLockOperation,
        draftFixture.revisionId,
        draftFixture.batchId,
        draftFixture.revisionId
      )
    ).resolves.toEqual(before);
    await expect(
      service.confirmUphTestBatch({
        projectId: draftFixture.projectId,
        batchId: draftFixture.batchId,
        revisionId: draftFixture.revisionId,
        actorId: draftFixture.pmActor.id,
        authorizationActor: draftFixture.pmActor,
        resourceVersion: draftFixture.resourceVersion,
        auditContext: { ...draftFixture.auditContext, actorId: draftFixture.pmActor.id }
      })
    ).resolves.toMatchObject({ status: "PM_CONFIRMED" });
  });

  it("permits exactly one distinguishable concurrent correction successor", async () => {
    const { db, service } = await requireApm081();
    const fixture = await createConfirmedFixture();
    const confirmed = await service.confirmUphTestBatch({
      projectId: fixture.projectId,
      batchId: fixture.batchId,
      revisionId: fixture.revisionId,
      actorId: fixture.pmActor.id,
      authorizationActor: fixture.pmActor,
      resourceVersion: fixture.resourceVersion,
      auditContext: { ...fixture.auditContext, actorId: fixture.pmActor.id }
    });
    let releaseCorrection!: () => void;
    const correctionReleased = new Promise<void>((resolve) => {
      releaseCorrection = resolve;
    });
    let signalCorrectionHeld!: () => void;
    const correctionHeld = new Promise<void>((resolve) => {
      signalCorrectionHeld = resolve;
    });
    const correctionA = db.$transaction(async (transaction) => {
      const result = await service.replaceUphTestBatchRevision(
        {
          projectId: fixture.projectId,
          batchId: fixture.batchId,
          revisionId: fixture.revisionId,
          actorId: fixture.processActor.id,
          authorizationActor: fixture.processActor,
          resourceVersion: confirmed.resourceVersion,
          reason: "concurrent correction A",
          auditContext: {
            ...fixture.auditContext,
            actorId: fixture.processActor.id,
            operationId: "uph-081-concurrent-correction-A"
          }
        },
        transaction
      );
      signalCorrectionHeld();
      await correctionReleased;
      return result;
    });
    await correctionHeld;
    await waitForNowaitConflict(() =>
      db.$transaction((transaction) =>
        transaction.$executeRawUnsafe(
          `SELECT id FROM project_uph_test_batch_revisions WHERE id = $1 FOR UPDATE NOWAIT`,
          fixture.revisionId
        )
      )
    );
    const correctionB = service.replaceUphTestBatchRevision({
      projectId: fixture.projectId,
      batchId: fixture.batchId,
      revisionId: fixture.revisionId,
      actorId: fixture.processActor.id,
      authorizationActor: fixture.processActor,
      resourceVersion: confirmed.resourceVersion,
      reason: "concurrent correction B",
      auditContext: {
        ...fixture.auditContext,
        actorId: fixture.processActor.id,
        operationId: "uph-081-concurrent-correction-B"
      }
    });
    releaseCorrection();
    const outcomes = await Promise.allSettled([correctionA, correctionB]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ status: 409 });
    await expect(
      db.$queryRawUnsafe<
        Array<{ successors: number; current_work: number; original_status: string }>
      >(
        `SELECT
           (SELECT count(*)::int FROM project_uph_test_batch_revisions WHERE supersedes_revision_id = $1) AS successors,
           (SELECT count(*)::int FROM project_uph_test_batches WHERE id = $2 AND current_work_revision_id IS NOT NULL) AS current_work,
           (SELECT status::text FROM project_uph_test_batch_revisions WHERE id = $1) AS original_status`,
        fixture.revisionId,
        fixture.batchId
      )
    ).resolves.toEqual([{ successors: 1, current_work: 1, original_status: "SUPERSEDED" }]);
    await expect(
      db.$queryRawUnsafe<Array<{ successful_a: number; successful_b: number }>>(
        `SELECT
           (SELECT count(*)::int FROM audit_logs WHERE operation_id = 'uph-081-concurrent-correction-A' AND result = 'SUCCESS') AS successful_a,
           (SELECT count(*)::int FROM audit_logs WHERE operation_id = 'uph-081-concurrent-correction-B' AND result = 'SUCCESS') AS successful_b`
      )
    ).resolves.toEqual([{ successful_a: 1, successful_b: 0 }]);
  });
});
