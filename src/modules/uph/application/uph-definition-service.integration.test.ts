import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { payloadHash } from "@/modules/governance/domain/idempotency";

import {
  createUphDefinition,
  getUphDefinition,
  publishUphDefinition,
  replaceSignedUphDraft,
  signoffUphDefinition
} from "./uph-definition-service";
import { setDeliveryUnitEnabled } from "@/modules/projects/application/project-structure";

const enabled = process.env.RUN_DATABASE_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL);
const actor = {
  id: "u-proc",
  name: "Process",
  status: "ACTIVE" as const,
  departmentId: null,
  systemRoles: [],
  grants: []
};
const auditContext = {
  actorId: "u-proc",
  requestId: "uph-test",
  traceId: null,
  source: "API" as const,
  sourceIp: null,
  userAgent: null,
  reason: null,
  projectId: "p-uph",
  departmentId: null,
  operationId: "uph-test"
};

function postgresSqlState(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return candidate.meta?.code ?? candidate.code;
}

function waitFor(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForCtRootLock(rootId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await db.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          SELECT id FROM project_uph_ct_definitions WHERE id = ${rootId} FOR UPDATE NOWAIT
        `;
      });
    } catch (error) {
      if (postgresSqlState(error) === "55P03") return;
      throw error;
    }
    await waitFor(10);
  }
  throw new Error("UPH CT command did not lock its root before the source/version probe");
}

async function waitForCtRootWait() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [activity] = await db.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%project_uph_ct_definitions%'
      ) AS waiting
    `;
    if (activity?.waiting) return;
    await waitFor(10);
  }
  throw new Error("UPH CT command did not reach the CT root lock before the inverse source probe");
}

async function runDeterministicSourceCross<T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>
) {
  let projectLocked!: () => void;
  let sourceLocked!: () => void;
  const projectLockedReady = new Promise<void>((resolve) => {
    projectLocked = resolve;
  });
  const sourceLockedReady = new Promise<void>((resolve) => {
    sourceLocked = resolve;
  });

  const uphTx = db.$transaction(
    async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL deadlock_timeout = '100ms'");
      await transaction.$executeRaw`SELECT id FROM projects WHERE id = 'p-uph' FOR NO KEY UPDATE`;
      projectLocked();
      await sourceLockedReady;
      return operation(transaction);
    },
    { timeout: 10_000 }
  );
  await projectLockedReady;
  const sourceTx = db.$transaction(
    async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL deadlock_timeout = '100ms'");
      await transaction.$executeRaw`SELECT id FROM delivery_units WHERE id = 'du-line' FOR UPDATE`;
      sourceLocked();
      return setDeliveryUnitEnabled(
        {
          projectId: "p-uph",
          deliveryUnitId: "du-line",
          version: 1,
          enabled: false,
          reason: "并发锁序 RED",
          actorId: "u-proc",
          auditContext: { ...auditContext, operationId: "uph-source-lock-red" }
        },
        transaction
      );
    },
    { timeout: 10_000 }
  );

  const outcomes = await Promise.allSettled([uphTx, sourceTx]);
  const deadlocks = outcomes.filter(
    (result) => result.status === "rejected" && /40P01/u.test(String(result.reason))
  );
  expect(deadlocks, "APM-080/012 lock order produced PostgreSQL deadlock").toHaveLength(0);
  return outcomes;
}

async function seedCtDraftForModule(input: {
  rootId: string;
  versionId: string;
  projectModuleId: string;
  sourceWatermark: string;
}) {
  const processOwnerSnapshot = payloadHash({
    membershipId: "pm-proc",
    userId: "u-proc",
    role: "ENGINEER"
  });
  await db.$transaction(async (transaction) => {
    await transaction.$executeRaw`
      INSERT INTO project_uph_ct_definitions (
        id, project_id, project_module_id, version, created_by_id, updated_by_id
      ) VALUES (
        ${input.rootId}, 'p-uph', ${input.projectModuleId}, 1, 'u-proc', 'u-proc'
      )
    `;
    await transaction.$executeRaw`
      INSERT INTO project_uph_ct_definition_versions (
        id, project_id, ct_definition_id, revision, status, resource_version,
        intrinsic_ct_seconds, output_per_cycle_total, parallel_channel_count, cavity_count,
        snapshot_json, snapshot_checksum, source_watermark,
        process_owner_membership_id, process_owner_user_id, process_owner_role,
        process_owner_snapshot_json, process_owner_checksum, created_by_id
      ) VALUES (
        ${input.versionId}, 'p-uph', ${input.rootId}, 1, 'DRAFT'::"UphVersionStatus", 1,
        12, 4, 1, 1,
        ${JSON.stringify({ projectModuleId: input.projectModuleId })}::jsonb, repeat('0', 64), ${input.sourceWatermark},
        'pm-proc', 'u-proc', 'ENGINEER'::"ProjectRole",
        ${JSON.stringify(processOwnerSnapshot.value)}::jsonb, ${processOwnerSnapshot.hash}, 'u-proc'
      )
    `;
    await transaction.$executeRaw`
      UPDATE project_uph_ct_definitions
      SET current_work_version_id = ${input.versionId}, version = 2, updated_by_id = 'u-proc'
      WHERE id = ${input.rootId} AND project_id = 'p-uph' AND version = 1
    `;
  });
}

function ctBody(projectVersion: number, intrinsicCtSeconds = 12) {
  return {
    kind: "CT" as const,
    projectVersion,
    content: {
      projectModuleId: "pm-uph",
      intrinsicCtSeconds,
      outputPerCycleTotal: 4,
      parallelChannelCount: 2,
      cavityCount: 1
    }
  };
}

function formulaBody(projectVersion: number) {
  return {
    kind: "FORMULA" as const,
    projectVersion,
    content: {
      formulaCode: "CANONICAL_UPH_V1" as const,
      formulaJson: {
        numerator: "3600*outputPerCycleTotal*parallelChannelCount",
        denominator: "intrinsicCtSeconds"
      }
    }
  };
}

function lineTopologyContent() {
  return {
    projectShape: "LINE" as const,
    roots: [
      {
        sourceId: "du-line",
        sourceType: "LINE" as const,
        parentSourceId: null,
        relation: "ROOT" as const,
        capacity: 100,
        children: [
          {
            sourceId: "du-machine",
            sourceType: "MACHINE" as const,
            parentSourceId: "du-line",
            relation: "MANDATORY" as const,
            capacity: 100,
            children: [
              {
                sourceId: "pm-uph",
                sourceType: "MODULE" as const,
                parentSourceId: "du-machine",
                relation: "MANDATORY" as const,
                capacity: 100
              }
            ]
          }
        ]
      }
    ]
  };
}

async function expectUphCheckViolation(action: Promise<unknown>) {
  await expect(action).rejects.toMatchObject({ code: "P2010", meta: { code: "23514" } });
}

describe.skipIf(!enabled)("APM-080 PostgreSQL service contract", () => {
  beforeEach(async () => {
    for (const [id, employeeNo, name] of [
      ["u-proc", "E-UPH-PROC", "Process"],
      ["u-comm", "E-UPH-COMM", "Commission"],
      ["u-qual", "E-UPH-QUAL", "Quality"]
    ] as const) {
      await db.$executeRaw`INSERT INTO users(id,employee_no,name,status,version,created_at,updated_at) VALUES (${id},${employeeNo},${name},'ACTIVE',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`;
    }
    await db.$executeRaw`INSERT INTO templates(id,code,name,status,current_version,version,created_by_id,updated_by_id,created_at,updated_at) VALUES ('uph-test-template','UPH.TEST','UPH Test','ACTIVE',1,1,'u-proc','u-proc',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`;
    await db.$executeRaw`INSERT INTO template_versions(id,template_id,version,status,name,checksum,published_by_id,published_at) VALUES ('uph-test-template-version','uph-test-template',1,'PUBLISHED','UPH Test v1',repeat('0',64),'u-proc',CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`;
    await db.$executeRaw`INSERT INTO template_components(id,code,component_type,name,draft_content,status,current_version,version,created_by_id,updated_by_id,created_at,updated_at) VALUES ('uph-test-capability-component','UPH.TEST.CAPABILITY','CAPABILITY_RULE'::"TemplateComponentType",'UPH capability rule','{"capabilities":[{"code":"UPH_ANALYSIS","required":false}]}'::jsonb,'ACTIVE'::"TemplateMasterStatus",1,1,'u-proc','u-proc',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`;
    await db.$executeRaw`INSERT INTO template_component_versions(id,component_id,version,status,component_type,name,content_json,checksum,published_by_id,published_at) VALUES ('uph-test-capability-component-version','uph-test-capability-component',1,'PUBLISHED'::"TemplateVersionStatus",'CAPABILITY_RULE'::"TemplateComponentType",'UPH capability rule','{"capabilities":[{"code":"UPH_ANALYSIS","required":false}]}'::jsonb,repeat('0',64),'u-proc',CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`;
    await db.$executeRaw`UPDATE company_capabilities SET enabled = true WHERE code = 'UPH_ANALYSIS'`;
    await db.$executeRaw`INSERT INTO projects(id,code,name,status,version,initialization_status,source_template_version_id,source_template_checksum,initialized_at,project_type,equipment_shape,structure_status,capability_configuration_status,capabilities_configured_at,created_by_id,created_at,updated_at) VALUES ('p-uph','P-UPH','UPH test project','DRAFT',1,'READY','uph-test-template-version',repeat('0',64),CURRENT_TIMESTAMP,'CUSTOMER_DELIVERY','LINE','READY','READY',CURRENT_TIMESTAMP,'u-proc',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`;
    await db.$executeRaw`INSERT INTO project_template_snapshots(id,project_id,source_template_version_id,source_template_checksum,snapshot_checksum,template_code,template_name,template_version,template_published_at) SELECT 'uph-test-project-snapshot',p.id,v.id,v.checksum,repeat('0',64),t.code,v.name,v.version,v.published_at FROM projects p JOIN template_versions v ON v.id = p.source_template_version_id JOIN templates t ON t.id = v.template_id WHERE p.id = 'p-uph' ON CONFLICT (project_id) DO NOTHING`;
    await db.$executeRaw`INSERT INTO project_template_snapshot_components(id,snapshot_id,source_component_version_id,component_type,slot,position,source_checksum,component_code,component_name,component_version,content_json) SELECT 'uph-test-capability-snapshot-component','uph-test-project-snapshot',v.id,v.component_type,'CAPABILITY_RULE',0,v.checksum,c.code,v.name,v.version,v.content_json FROM template_component_versions v JOIN template_components c ON c.id = v.component_id WHERE v.id = 'uph-test-capability-component-version' ON CONFLICT (snapshot_id,slot) DO NOTHING`;
    await db.$executeRaw`INSERT INTO project_capabilities(project_id,capability_code,template_allowed,template_required,selected_enabled,source_snapshot_component_id,version,created_by_id,updated_by_id,created_at,updated_at) VALUES ('p-uph','UPH_ANALYSIS',true,false,true,'uph-test-capability-snapshot-component',1,'u-proc','u-proc',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (project_id,capability_code) DO UPDATE SET selected_enabled = EXCLUDED.selected_enabled`;
    await db.$executeRaw`INSERT INTO delivery_units(id,project_id,parent_id,unit_type,code,name,status,position,version,created_by_id,updated_by_id,created_at,updated_at) VALUES ('du-line','p-uph',NULL,'LINE','LINE-1','Line 1','ACTIVE',0,1,'u-proc','u-proc',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`;
    await db.$executeRaw`INSERT INTO delivery_units(id,project_id,parent_id,unit_type,code,name,status,position,version,created_by_id,updated_by_id,created_at,updated_at) VALUES ('du-machine','p-uph','du-line','MACHINE','MACHINE-1','Machine 1','ACTIVE',0,1,'u-proc','u-proc',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`;
    await db.$executeRaw`INSERT INTO project_members(id,project_id,user_id,project_role,assigned_by_id,joined_at,version) VALUES ('pm-proc','p-uph','u-proc','ENGINEER','u-proc',CURRENT_TIMESTAMP,1),('pm-comm','p-uph','u-comm','ENGINEER','u-proc',CURRENT_TIMESTAMP,1),('pm-qual','p-uph','u-qual','QUALITY','u-proc',CURRENT_TIMESTAMP,1) ON CONFLICT (id) DO NOTHING`;
    await db.$executeRaw`INSERT INTO project_modules(id,project_id,delivery_unit_id,code,name,status,position,version,created_by_id,updated_by_id,created_at,updated_at) VALUES ('pm-uph','p-uph','du-machine','MOD1','Module 1','ACTIVE',0,1,'u-proc','u-proc',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`;
    await db.$executeRaw`INSERT INTO project_modules(id,project_id,delivery_unit_id,code,name,status,position,version,created_by_id,updated_by_id,created_at,updated_at) VALUES ('pm-uph-b','p-uph','du-machine','MOD2','Module 2','DISABLED',1,1,'u-proc','u-proc',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`;
  });

  afterEach(async () => {
    await db.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await transaction.$executeRaw`DELETE FROM outbox_events WHERE aggregate_id IN (SELECT id FROM project_uph_topology_versions WHERE project_id = 'p-uph') OR aggregate_id IN (SELECT id FROM project_uph_ct_definition_versions WHERE project_id = 'p-uph') OR aggregate_id IN (SELECT id FROM project_uph_formula_versions WHERE project_id = 'p-uph')`;
      await transaction.$executeRaw`DELETE FROM audit_logs WHERE project_id = 'p-uph'`;
      await transaction.$executeRaw`DELETE FROM project_uph_ct_definition_versions WHERE project_id = 'p-uph'`;
      await transaction.$executeRaw`DELETE FROM project_uph_ct_definitions WHERE project_id = 'p-uph'`;
      await transaction.$executeRaw`DELETE FROM project_uph_topology_nodes WHERE project_id = 'p-uph'`;
      await transaction.$executeRaw`DELETE FROM project_uph_topology_versions WHERE project_id = 'p-uph'`;
      await transaction.$executeRaw`DELETE FROM project_uph_topologies WHERE project_id = 'p-uph'`;
      await transaction.$executeRaw`DELETE FROM project_uph_formula_versions WHERE project_id = 'p-uph'`;
      await transaction.$executeRaw`DELETE FROM project_uph_formulas WHERE project_id = 'p-uph'`;
      await transaction.$executeRaw`DELETE FROM api_idempotency_records WHERE actor_id IN ('u-proc','u-comm','u-qual')`;
      await transaction.$executeRaw`DELETE FROM project_capabilities WHERE project_id = 'p-uph'`;
      await transaction.$executeRaw`UPDATE company_capabilities SET enabled = false WHERE code = 'UPH_ANALYSIS'`;
      await transaction.$executeRaw`DELETE FROM project_modules WHERE id = 'pm-uph'`;
      await transaction.$executeRaw`DELETE FROM project_modules WHERE id = 'pm-uph-b'`;
      await transaction.$executeRaw`DELETE FROM delivery_units WHERE id = 'du-child'`;
      await transaction.$executeRaw`DELETE FROM delivery_units WHERE id = 'du-machine'`;
      await transaction.$executeRaw`DELETE FROM project_members WHERE project_id = 'p-uph'`;
      await transaction.$executeRaw`DELETE FROM delivery_units WHERE id = 'du-line'`;
      await transaction.$executeRaw`DELETE FROM project_template_snapshot_components WHERE id = 'uph-test-capability-snapshot-component'`;
      await transaction.$executeRaw`DELETE FROM project_template_snapshots WHERE id = 'uph-test-project-snapshot'`;
      await transaction.$executeRaw`DELETE FROM template_component_versions WHERE id = 'uph-test-capability-component-version'`;
      await transaction.$executeRaw`DELETE FROM template_components WHERE id = 'uph-test-capability-component'`;
      await transaction.$executeRaw`DELETE FROM projects WHERE id = 'p-uph'`;
    });
  });

  it("creates, signs and publishes a CT version with independent actors", async () => {
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "CT",
        projectVersion: 1,
        content: {
          projectModuleId: "pm-uph",
          intrinsicCtSeconds: 12,
          outputPerCycleTotal: 4,
          parallelChannelCount: 2,
          cavityCount: 1
        }
      },
      auditContext
    });
    expect(created.status).toBe("DRAFT");
    const signed = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: created.id,
      resourceVersion: created.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });
    expect(signed.resourceVersion).toBe(2);
    await expect(
      db.$executeRaw`UPDATE project_uph_ct_definition_versions SET commissioning_snapshot_json = '{}'::jsonb, resource_version = 3 WHERE id = ${created.id} AND project_id = 'p-uph'`
    ).rejects.toMatchObject({ code: "P2010" });
    const signedFacts = await db.$queryRaw<
      Array<{ resource_version: number; commissioning_snapshot_json: unknown }>
    >`SELECT resource_version, commissioning_snapshot_json FROM project_uph_ct_definition_versions WHERE id = ${created.id}`;
    expect(signedFacts[0]?.resource_version).toBe(2);
    const published = await publishUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: created.id,
      resourceVersion: signed.resourceVersion,
      actorId: "u-qual",
      authorizationActor: { ...actor, id: "u-qual", name: "Quality" },
      auditContext: { ...auditContext, actorId: "u-qual" }
    });
    expect(published.status).toBe("PUBLISHED");
    const correction = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "CT",
        projectVersion: 3,
        content: {
          projectModuleId: "pm-uph",
          intrinsicCtSeconds: 10,
          outputPerCycleTotal: 4,
          parallelChannelCount: 2,
          cavityCount: 1
        }
      },
      auditContext
    });
    const supersedes = await db.$queryRaw<
      Array<{ supersedes_version_id: string | null }>
    >`SELECT supersedes_version_id FROM project_uph_ct_definition_versions WHERE id = ${correction.id}`;
    expect(supersedes[0]?.supersedes_version_id).toBe(created.id);
  });

  it("creates independent CT roots for two modules and keeps module B commands scoped", async () => {
    await db.$executeRaw`UPDATE project_modules SET status = 'ACTIVE'::"ProjectStructureNodeStatus", version = version + 1 WHERE id = 'pm-uph-b' AND project_id = 'p-uph'`;
    const moduleA = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "CT",
        projectVersion: 1,
        content: {
          projectModuleId: "pm-uph",
          intrinsicCtSeconds: 12,
          outputPerCycleTotal: 4,
          parallelChannelCount: 2,
          cavityCount: 1
        }
      },
      auditContext
    });
    const moduleB = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "CT",
        projectVersion: 1,
        content: {
          projectModuleId: "pm-uph-b",
          intrinsicCtSeconds: 10,
          outputPerCycleTotal: 6,
          parallelChannelCount: 1,
          cavityCount: 2
        }
      },
      auditContext: { ...auditContext, operationId: "ct-module-b-create" }
    });
    expect(moduleB.id).not.toBe(moduleA.id);
    const roots = await db.$queryRaw<
      Array<{ project_module_id: string; current_work_version_id: string | null }>
    >`
      SELECT project_module_id, current_work_version_id
      FROM project_uph_ct_definitions
      WHERE project_id = 'p-uph'
      ORDER BY project_module_id
    `;
    expect(roots).toHaveLength(2);
    expect(roots.map((root) => root.project_module_id)).toEqual(["pm-uph", "pm-uph-b"]);
    expect(roots.every((root) => root.current_work_version_id)).toBe(true);

    const [beforeFailedCommand] = await db.$queryRaw<
      Array<{ audit_count: bigint; outbox_count: bigint; version_count: bigint }>
    >`
      SELECT
        (SELECT count(*) FROM audit_logs WHERE project_id = 'p-uph') AS audit_count,
        (SELECT count(*) FROM outbox_events WHERE aggregate_id IN (SELECT id FROM project_uph_ct_definition_versions WHERE project_id = 'p-uph')) AS outbox_count,
        (SELECT count(*) FROM project_uph_ct_definition_versions WHERE project_id = 'p-uph') AS version_count
    `;
    await expect(
      createUphDefinition({
        projectId: "p-uph",
        actorId: "u-proc",
        authorizationActor: actor,
        body: {
          kind: "CT",
          projectVersion: 2,
          versionId: moduleA.id,
          resourceVersion: moduleA.resourceVersion,
          content: {
            projectModuleId: "pm-uph-b",
            intrinsicCtSeconds: 9,
            outputPerCycleTotal: 6,
            parallelChannelCount: 1,
            cavityCount: 2
          }
        },
        auditContext: { ...auditContext, operationId: "ct-module-b-wrong-version" }
      })
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    const [afterFailedCommand] = await db.$queryRaw<
      Array<{ audit_count: bigint; outbox_count: bigint; version_count: bigint }>
    >`
      SELECT
        (SELECT count(*) FROM audit_logs WHERE project_id = 'p-uph') AS audit_count,
        (SELECT count(*) FROM outbox_events WHERE aggregate_id IN (SELECT id FROM project_uph_ct_definition_versions WHERE project_id = 'p-uph')) AS outbox_count,
        (SELECT count(*) FROM project_uph_ct_definition_versions WHERE project_id = 'p-uph') AS version_count
    `;
    expect(afterFailedCommand).toEqual(beforeFailedCommand);

    const patchedModuleB = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "CT",
        projectVersion: 2,
        versionId: moduleB.id,
        resourceVersion: moduleB.resourceVersion,
        content: {
          projectModuleId: "pm-uph-b",
          intrinsicCtSeconds: 9,
          outputPerCycleTotal: 6,
          parallelChannelCount: 1,
          cavityCount: 2
        }
      },
      auditContext: { ...auditContext, operationId: "ct-module-b-patch" }
    });
    const signedModuleB = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: patchedModuleB.id,
      resourceVersion: patchedModuleB.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm", operationId: "ct-module-b-signoff" }
    });
    const publishedModuleB = await publishUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: signedModuleB.id,
      resourceVersion: signedModuleB.resourceVersion,
      actorId: "u-qual",
      authorizationActor: { ...actor, id: "u-qual", name: "Quality" },
      auditContext: { ...auditContext, actorId: "u-qual", operationId: "ct-module-b-publish" }
    });
    const correctionDraftModuleB = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "CT",
        projectVersion: 4,
        content: {
          projectModuleId: "pm-uph-b",
          intrinsicCtSeconds: 9,
          outputPerCycleTotal: 6,
          parallelChannelCount: 1,
          cavityCount: 2
        }
      },
      auditContext: { ...auditContext, operationId: "ct-module-b-correction-create" }
    });
    const correctionSignedModuleB = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: correctionDraftModuleB.id,
      resourceVersion: correctionDraftModuleB.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: {
        ...auditContext,
        actorId: "u-comm",
        operationId: "ct-module-b-correction-signoff"
      }
    });
    const replacementModuleB = await replaceSignedUphDraft({
      projectId: "p-uph",
      kind: "CT",
      reason: "模块B会签后纠错",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "CT",
        projectVersion: 5,
        content: {
          projectModuleId: "pm-uph-b",
          intrinsicCtSeconds: 8,
          outputPerCycleTotal: 6,
          parallelChannelCount: 1,
          cavityCount: 2
        }
      },
      auditContext: { ...auditContext, operationId: "ct-module-b-replace" }
    });
    expect(publishedModuleB.status).toBe("PUBLISHED");
    expect(replacementModuleB.status).toBe("DRAFT");
    expect(replacementModuleB.id).not.toBe(correctionSignedModuleB.id);

    const currentModuleB = await getUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      selection: "currentPublished",
      projectModuleId: "pm-uph-b"
    } as never);
    const exactModuleB = await getUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      selection: "exact",
      versionId: publishedModuleB.id
    });
    expect(currentModuleB.id).toBe(publishedModuleB.id);
    expect(exactModuleB.id).toBe(publishedModuleB.id);

    const moduleAFacts = await db.$queryRaw<
      Array<{
        current_work_version_id: string | null;
        current_published_version_id: string | null;
        version: number;
      }>
    >`SELECT current_work_version_id, current_published_version_id, version FROM project_uph_ct_definitions WHERE project_id = 'p-uph' AND project_module_id = 'pm-uph'`;
    expect(moduleAFacts).toEqual([
      { current_work_version_id: moduleA.id, current_published_version_id: null, version: 2 }
    ]);
  });

  it("allows concurrent module A and B CT patches without crossing roots, versions, or pointers", async () => {
    await db.$executeRaw`UPDATE project_modules SET status = 'ACTIVE'::"ProjectStructureNodeStatus", version = version + 1 WHERE id = 'pm-uph-b' AND project_id = 'p-uph'`;
    const moduleA = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "CT",
        projectVersion: 1,
        content: {
          projectModuleId: "pm-uph",
          intrinsicCtSeconds: 12,
          outputPerCycleTotal: 4,
          parallelChannelCount: 1,
          cavityCount: 1
        }
      },
      auditContext: { ...auditContext, operationId: "ct-module-a-create-concurrent" }
    });
    if (!("sourceWatermark" in moduleA) || !moduleA.sourceWatermark)
      throw new Error("CT creation must return its source watermark");
    await seedCtDraftForModule({
      rootId: "uph-ct-root-b-concurrent",
      versionId: "uph-ct-version-b-concurrent",
      projectModuleId: "pm-uph-b",
      sourceWatermark: moduleA.sourceWatermark
    });

    const outcomes = await Promise.allSettled([
      createUphDefinition({
        projectId: "p-uph",
        actorId: "u-proc",
        authorizationActor: actor,
        body: {
          kind: "CT",
          projectVersion: moduleA.resourceVersion + 1,
          versionId: moduleA.id,
          resourceVersion: moduleA.resourceVersion,
          content: {
            projectModuleId: "pm-uph",
            intrinsicCtSeconds: 11,
            outputPerCycleTotal: 4,
            parallelChannelCount: 1,
            cavityCount: 1
          }
        },
        auditContext: { ...auditContext, operationId: "ct-module-a-patch-concurrent" }
      }),
      createUphDefinition({
        projectId: "p-uph",
        actorId: "u-proc",
        authorizationActor: actor,
        body: {
          kind: "CT",
          projectVersion: 2,
          versionId: "uph-ct-version-b-concurrent",
          resourceVersion: 1,
          content: {
            projectModuleId: "pm-uph-b",
            intrinsicCtSeconds: 10,
            outputPerCycleTotal: 4,
            parallelChannelCount: 1,
            cavityCount: 1
          }
        },
        auditContext: { ...auditContext, operationId: "ct-module-b-patch-concurrent" }
      })
    ]);
    const failures = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
    );
    expect(
      failures.map(({ reason }) => ({ code: reason?.code, sqlState: reason?.meta?.code }))
    ).toEqual([]);
    expect(
      failures.some(({ reason }) => /40P01|55P03/u.test(String(reason?.meta?.code ?? reason)))
    ).toBe(false);

    const roots = await db.$queryRaw<
      Array<{
        project_module_id: string;
        current_work_version_id: string | null;
        current_published_version_id: string | null;
        version: number;
      }>
    >`
      SELECT project_module_id, current_work_version_id, current_published_version_id, version
      FROM project_uph_ct_definitions
      WHERE project_id = 'p-uph'
      ORDER BY project_module_id
    `;
    expect(roots).toEqual([
      {
        project_module_id: "pm-uph",
        current_work_version_id: moduleA.id,
        current_published_version_id: null,
        version: 3
      },
      {
        project_module_id: "pm-uph-b",
        current_work_version_id: "uph-ct-version-b-concurrent",
        current_published_version_id: null,
        version: 3
      }
    ]);
  });

  it("locates the exact CT root from module B version before locking instead of waiting on module A", async () => {
    await db.$executeRaw`UPDATE project_modules SET status = 'ACTIVE'::"ProjectStructureNodeStatus", version = version + 1 WHERE id = 'pm-uph-b' AND project_id = 'p-uph'`;
    const moduleA = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "CT",
        projectVersion: 1,
        content: {
          projectModuleId: "pm-uph",
          intrinsicCtSeconds: 12,
          outputPerCycleTotal: 4,
          parallelChannelCount: 1,
          cavityCount: 1
        }
      },
      auditContext: { ...auditContext, operationId: "ct-module-a-create-lock-test" }
    });
    const moduleB = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "CT",
        projectVersion: 1,
        content: {
          projectModuleId: "pm-uph-b",
          intrinsicCtSeconds: 12,
          outputPerCycleTotal: 4,
          parallelChannelCount: 1,
          cavityCount: 1
        }
      },
      auditContext: { ...auditContext, operationId: "ct-module-b-create-lock-test" }
    });
    const [before] = await db.$queryRaw<Array<{ audit_count: bigint; outbox_count: bigint }>>`
      SELECT
        (SELECT count(*) FROM audit_logs WHERE project_id = 'p-uph') AS audit_count,
        (SELECT count(*) FROM outbox_events WHERE aggregate_id = ${moduleB.id}) AS outbox_count
    `;
    let releaseRootA!: () => void;
    let rootALocked!: () => void;
    const rootALockedReady = new Promise<void>((resolve) => {
      rootALocked = resolve;
    });
    const releaseRootAReady = new Promise<void>((resolve) => {
      releaseRootA = resolve;
    });
    const holder = db.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT id FROM project_uph_ct_definitions WHERE id = (SELECT ct_definition_id FROM project_uph_ct_definition_versions WHERE id = ${moduleA.id}) FOR UPDATE`;
        rootALocked();
        await releaseRootAReady;
      },
      { timeout: 10_000 }
    );
    await rootALockedReady;
    let signed: Awaited<ReturnType<typeof signoffUphDefinition>> | undefined;
    let failure: unknown;
    try {
      signed = await db.$transaction(
        async (transaction) => {
          await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '200ms'");
          return signoffUphDefinition(
            {
              projectId: "p-uph",
              kind: "CT",
              versionId: moduleB.id,
              resourceVersion: 1,
              actorId: "u-comm",
              authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
              auditContext: {
                ...auditContext,
                actorId: "u-comm",
                operationId: "ct-module-b-signoff-lock-test"
              }
            },
            transaction
          );
        },
        { timeout: 10_000 }
      );
    } catch (error) {
      failure = error;
    } finally {
      releaseRootA();
      await holder;
    }
    const [after] = await db.$queryRaw<Array<{ audit_count: bigint; outbox_count: bigint }>>`
      SELECT
        (SELECT count(*) FROM audit_logs WHERE project_id = 'p-uph') AS audit_count,
        (SELECT count(*) FROM outbox_events WHERE aggregate_id = ${moduleB.id}) AS outbox_count
    `;
    const [moduleBPointer] = await db.$queryRaw<
      Array<{ current_work_version_id: string | null; version: number }>
    >`
      SELECT current_work_version_id, version
      FROM project_uph_ct_definitions
      WHERE id = (
        SELECT ct_definition_id FROM project_uph_ct_definition_versions WHERE id = ${moduleB.id}
      ) AND project_id = 'p-uph'
    `;
    if (failure) {
      expect(after).toEqual(before);
      expect(moduleBPointer).toEqual({
        current_work_version_id: moduleB.id,
        version: 2
      });
      throw failure;
    }
    expect(signed?.resourceVersion).toBe(2);
    expect(after.audit_count - before.audit_count).toBe(1n);
    expect(after.outbox_count - before.outbox_count).toBe(1n);
  });

  it("locks CT versions before its ProjectModule source and rolls back a blocked signoff", async () => {
    const draft = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: ctBody(1),
      auditContext: { ...auditContext, operationId: "ct-lock-order-create" }
    });
    const [root] = await db.$queryRaw<Array<{ id: string }>>`
      SELECT ct_definition_id AS id
      FROM project_uph_ct_definition_versions
      WHERE id = ${draft.id} AND project_id = 'p-uph'
    `;
    if (!root) throw new Error("CT draft root was not created");

    let sourceLocked!: () => void;
    let startVersionProbe!: () => void;
    const sourceLockedReady = new Promise<void>((resolve) => {
      sourceLocked = resolve;
    });
    const startVersionProbeReady = new Promise<void>((resolve) => {
      startVersionProbe = resolve;
    });
    const sourceTransaction = db.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`
          SELECT id FROM project_modules WHERE id = 'pm-uph' AND project_id = 'p-uph' FOR UPDATE
        `;
        sourceLocked();
        await startVersionProbeReady;
        await transaction.$executeRaw`
          SELECT id FROM project_uph_ct_definition_versions
          WHERE id = ${draft.id} AND project_id = 'p-uph' FOR UPDATE NOWAIT
        `;
        await waitFor(400);
      },
      { timeout: 10_000 }
    );

    await sourceLockedReady;
    const signoffTransaction = db.$transaction(
      async (transaction) => {
        await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '200ms'");
        return signoffUphDefinition(
          {
            projectId: "p-uph",
            kind: "CT",
            versionId: draft.id,
            resourceVersion: draft.resourceVersion,
            actorId: "u-comm",
            authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
            auditContext: {
              ...auditContext,
              actorId: "u-comm",
              operationId: "ct-lock-order-signoff"
            }
          },
          transaction
        );
      },
      { timeout: 10_000 }
    );

    await waitForCtRootLock(root.id);
    startVersionProbe();
    const [sourceResult, signoffResult] = await Promise.allSettled([
      sourceTransaction,
      signoffTransaction
    ]);

    const [facts] = await db.$queryRaw<
      Array<{
        current_work_version_id: string | null;
        resource_version: number;
        commissioning_signed_at: Date | null;
        audit_count: bigint;
        outbox_count: bigint;
      }>
    >`
      SELECT r.current_work_version_id, v.resource_version, v.commissioning_signed_at,
             (SELECT count(*) FROM audit_logs WHERE project_id = 'p-uph' AND object_id = ${draft.id}) AS audit_count,
             (SELECT count(*) FROM outbox_events WHERE aggregate_id = ${draft.id}) AS outbox_count
      FROM project_uph_ct_definitions r
      JOIN project_uph_ct_definition_versions v ON v.ct_definition_id = r.id
      WHERE v.id = ${draft.id} AND r.project_id = 'p-uph'
    `;

    if (sourceResult.status === "fulfilled") {
      expect(signoffResult.status).toBe("rejected");
      if (signoffResult.status === "rejected")
        expect(postgresSqlState(signoffResult.reason)).toBe("55P03");
      expect(facts).toEqual({
        current_work_version_id: draft.id,
        resource_version: draft.resourceVersion,
        commissioning_signed_at: null,
        audit_count: 1n,
        outbox_count: 1n
      });
    }

    expect(sourceResult.status).toBe("rejected");
    if (sourceResult.status === "rejected")
      expect(postgresSqlState(sourceResult.reason)).toBe("55P03");
    expect(signoffResult.status).toBe("fulfilled");
    expect(facts).toMatchObject({
      current_work_version_id: draft.id,
      resource_version: draft.resourceVersion + 1,
      audit_count: 2n,
      outbox_count: 2n
    });
  });

  it("keeps the inverse CT command/source startup order deadlock-free", async () => {
    const draft = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: ctBody(1),
      auditContext: { ...auditContext, operationId: "ct-lock-order-inverse-create" }
    });
    const [root] = await db.$queryRaw<Array<{ id: string }>>`
      SELECT ct_definition_id AS id
      FROM project_uph_ct_definition_versions
      WHERE id = ${draft.id} AND project_id = 'p-uph'
    `;
    if (!root) throw new Error("CT draft root was not created");

    let versionLocked!: () => void;
    let releaseVersion!: () => void;
    const versionLockedReady = new Promise<void>((resolve) => {
      versionLocked = resolve;
    });
    const releaseVersionReady = new Promise<void>((resolve) => {
      releaseVersion = resolve;
    });
    const versionHolder = db.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`
          SELECT id FROM project_uph_ct_definitions WHERE id = ${root.id} FOR UPDATE
        `;
        await transaction.$executeRaw`
          SELECT id FROM project_uph_ct_definition_versions
          WHERE id = ${draft.id} AND project_id = 'p-uph' FOR UPDATE
        `;
        versionLocked();
        await releaseVersionReady;
      },
      { timeout: 10_000 }
    );
    await versionLockedReady;

    const signoffTransaction = db.$transaction(
      async (transaction) =>
        signoffUphDefinition(
          {
            projectId: "p-uph",
            kind: "CT",
            versionId: draft.id,
            resourceVersion: draft.resourceVersion,
            actorId: "u-comm",
            authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
            auditContext: {
              ...auditContext,
              actorId: "u-comm",
              operationId: "ct-lock-order-inverse-signoff"
            }
          },
          transaction
        ),
      { timeout: 10_000 }
    );
    await waitForCtRootWait();
    const sourceResult = await Promise.allSettled([
      db.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`
            SELECT id FROM project_modules WHERE id = 'pm-uph' AND project_id = 'p-uph' FOR UPDATE
          `;
          await transaction.$executeRaw`
            SELECT id FROM project_uph_ct_definition_versions
            WHERE id = ${draft.id} AND project_id = 'p-uph' FOR UPDATE NOWAIT
          `;
        },
        { timeout: 10_000 }
      )
    ]);
    expect(sourceResult[0]?.status).toBe("rejected");
    if (sourceResult[0]?.status === "rejected")
      expect(postgresSqlState(sourceResult[0].reason)).toBe("55P03");

    releaseVersion();
    await versionHolder;
    const signoffResult = await Promise.allSettled([signoffTransaction]);
    expect(signoffResult[0]?.status).toBe("fulfilled");
    expect(
      signoffResult.some(
        (result) => result.status === "rejected" && postgresSqlState(result.reason) === "40P01"
      )
    ).toBe(false);
  });

  it("creates and publishes a formula without commissioning signoff", async () => {
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "FORMULA",
        projectVersion: 1,
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
    await expect(
      db.$executeRaw`UPDATE project_uph_formula_versions SET formula_code = 'UNSUPPORTED_UPH_FORMULA' WHERE id = ${created.id}`
    ).rejects.toMatchObject({ code: "P2010" });
    const published = await publishUphDefinition({
      projectId: "p-uph",
      kind: "FORMULA",
      versionId: created.id,
      resourceVersion: created.resourceVersion,
      actorId: "u-qual",
      authorizationActor: { ...actor, id: "u-qual", name: "Quality" },
      auditContext: { ...auditContext, actorId: "u-qual" }
    });
    expect(published.status).toBe("PUBLISHED");
  });

  it("rejects direct SQL source snapshot mutation and preserves the draft node", async () => {
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "TOPOLOGY",
        projectVersion: 1,
        content: lineTopologyContent()
      },
      auditContext
    });
    const node = (
      await db.$queryRaw<
        Array<{ id: string; source_version: number }>
      >`SELECT id, source_version FROM project_uph_topology_nodes WHERE topology_version_id = ${created.id}`
    )[0];
    expect(node?.source_version).toBe(1);
    await expect(
      db.$executeRaw`UPDATE project_uph_topology_nodes SET source_version = 99 WHERE id = ${node?.id}`
    ).rejects.toMatchObject({ code: "P2010" });
    const unchanged = (
      await db.$queryRaw<
        Array<{ source_version: number }>
      >`SELECT source_version FROM project_uph_topology_nodes WHERE id = ${node?.id}`
    )[0];
    expect(unchanged?.source_version).toBe(1);
  });

  it("allows unsigned topology draft node deletion but seals nodes after signoff", async () => {
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "TOPOLOGY",
        projectVersion: 1,
        content: lineTopologyContent()
      },
      auditContext
    });
    const moduleNode = (
      await db.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM project_uph_topology_nodes WHERE topology_version_id = ${created.id} AND project_module_id = 'pm-uph'`
    )[0];
    expect(moduleNode?.id).toBeTruthy();
    await db.$executeRaw`DELETE FROM project_uph_topology_nodes WHERE id = ${moduleNode?.id}`;
    const remaining = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM project_uph_topology_nodes WHERE topology_version_id = ${created.id}
    `;
    expect(Number(remaining[0]?.count ?? 0)).toBe(2);

    await expect(
      signoffUphDefinition({
        projectId: "p-uph",
        kind: "TOPOLOGY",
        versionId: created.id,
        resourceVersion: created.resourceVersion,
        actorId: "u-comm",
        authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
        auditContext: { ...auditContext, actorId: "u-comm" }
      })
    ).rejects.toThrow(/cover every active project module/);

    const restored = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "TOPOLOGY",
        projectVersion: 2,
        versionId: created.id,
        resourceVersion: created.resourceVersion,
        content: lineTopologyContent()
      },
      auditContext
    });

    const signed = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "TOPOLOGY",
      versionId: created.id,
      resourceVersion: restored.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });
    const rootNode = (
      await db.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM project_uph_topology_nodes WHERE topology_version_id = ${created.id}`
    )[0];
    await expect(
      db.$executeRaw`DELETE FROM project_uph_topology_nodes WHERE id = ${rootNode?.id}`
    ).rejects.toThrow(/sealed UPH topology cannot be changed/);
    await expect(
      db.$executeRaw`INSERT INTO project_uph_topology_nodes (id, project_id, topology_version_id, source_type, project_module_id, parent_node_id, parent_relation, source_version, source_status, source_snapshot_json, source_checksum, source_watermark) VALUES ('uph-signed-insert', 'p-uph', ${created.id}, 'PROJECT_MODULE', 'pm-uph', ${rootNode?.id}, 'MANDATORY', 1, 'ACTIVE', '{}'::jsonb, repeat('0', 64), 'test')`
    ).rejects.toThrow(/sealed UPH topology cannot be changed/);
    expect(signed.resourceVersion).toBe(3);
  });

  it("rebuilds a multi-level unsigned topology draft with restrict self-FK", async () => {
    const content = lineTopologyContent();
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: { kind: "TOPOLOGY", projectVersion: 1, content },
      auditContext
    });

    const patched = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "TOPOLOGY",
        projectVersion: 2,
        versionId: created.id,
        resourceVersion: created.resourceVersion,
        content
      },
      auditContext
    });

    expect(patched.resourceVersion).toBe(2);
    const nodes = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM project_uph_topology_nodes WHERE topology_version_id = ${created.id}
    `;
    expect(Number(nodes[0]?.count ?? 0)).toBe(3);

    const moduleNode = (
      await db.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM project_uph_topology_nodes
        WHERE topology_version_id = ${created.id} AND project_module_id = 'pm-uph'
      `
    )[0];
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`DELETE FROM project_uph_topology_nodes WHERE id = ${moduleNode?.id}`;
        await tx.$executeRaw`UPDATE project_uph_topology_versions SET resource_version = resource_version + 1 WHERE id = ${created.id}`;
      })
    ).rejects.toThrow(/cover every active project module/);
    const restored = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM project_uph_topology_nodes WHERE topology_version_id = ${created.id}
    `;
    expect(Number(restored[0]?.count ?? 0)).toBe(3);

    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE project_modules SET version = version + 1 WHERE id = 'pm-uph'`;
        await tx.$executeRaw`UPDATE project_uph_topology_versions SET resource_version = resource_version + 1 WHERE id = ${created.id}`;
      })
    ).rejects.toThrow(/stale or inactive source snapshot/);
    const sourceVersion = await db.$queryRaw<Array<{ version: number }>>`
      SELECT version FROM project_modules WHERE id = 'pm-uph'
    `;
    expect(sourceVersion[0]?.version).toBe(1);
  });

  it("serializes concurrent draft creation on the project lock", async () => {
    const body = {
      kind: "CT" as const,
      projectVersion: 1,
      content: {
        projectModuleId: "pm-uph",
        intrinsicCtSeconds: 12,
        outputPerCycleTotal: 4,
        parallelChannelCount: 2,
        cavityCount: 1
      }
    };
    const results = await Promise.allSettled([
      createUphDefinition({
        projectId: "p-uph",
        actorId: "u-proc",
        authorizationActor: actor,
        body,
        auditContext
      }),
      createUphDefinition({
        projectId: "p-uph",
        actorId: "u-proc",
        authorizationActor: actor,
        body,
        auditContext: { ...auditContext, requestId: "uph-test-concurrent" }
      })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(rejected?.reason).toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });

  it("keeps publish and the real APM-012 source transition deadlock-free", async () => {
    const body = {
      kind: "TOPOLOGY" as const,
      projectVersion: 1,
      content: lineTopologyContent()
    };
    const draft = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body,
      auditContext
    });
    const signed = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "TOPOLOGY",
      versionId: draft.id,
      resourceVersion: draft.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });

    const outcomes = await Promise.allSettled([
      setDeliveryUnitEnabled({
        projectId: "p-uph",
        deliveryUnitId: "du-line",
        version: 1,
        enabled: false,
        reason: "并发锁序 RED",
        actorId: "u-proc",
        auditContext
      }),
      publishUphDefinition({
        projectId: "p-uph",
        kind: "TOPOLOGY",
        versionId: draft.id,
        resourceVersion: signed.resourceVersion,
        actorId: "u-qual",
        authorizationActor: { ...actor, id: "u-qual", name: "Quality" },
        auditContext: { ...auditContext, actorId: "u-qual" }
      })
    ]);

    const failures = outcomes.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(failures.some(({ reason }) => String(reason).includes("40P01"))).toBe(false);
    expect(
      failures.every(({ reason }) =>
        ["VERSION_CONFLICT", "UPH_SOURCE_WATERMARK_STALE", "UPH_SOURCE_NOT_AVAILABLE"].includes(
          reason?.code
        )
      )
    ).toBe(true);

    const pointers = await db.$queryRaw<
      Array<{ current_work_version_id: string | null; current_published_version_id: string | null }>
    >`SELECT current_work_version_id, current_published_version_id FROM project_uph_topologies WHERE project_id = 'p-uph'`;
    expect(pointers).toHaveLength(1);
    expect(pointers[0]?.current_work_version_id).not.toBe(
      pointers[0]?.current_published_version_id
    );
  });

  it("serializes signoff and signed-draft replacement against APM-012 source transition", async () => {
    const body = {
      kind: "TOPOLOGY" as const,
      projectVersion: 1,
      content: lineTopologyContent()
    };
    const draft = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body,
      auditContext
    });
    const outcomes = await Promise.allSettled([
      signoffUphDefinition({
        projectId: "p-uph",
        kind: "TOPOLOGY",
        versionId: draft.id,
        resourceVersion: draft.resourceVersion,
        actorId: "u-comm",
        authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
        auditContext: { ...auditContext, actorId: "u-comm" }
      }),
      setDeliveryUnitEnabled({
        projectId: "p-uph",
        deliveryUnitId: "du-line",
        version: 1,
        enabled: false,
        reason: "并发会签 RED",
        actorId: "u-proc",
        auditContext
      })
    ]);
    expect(outcomes.some(({ status }) => status === "fulfilled")).toBe(true);
    expect(
      outcomes
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .some(({ reason }) => String(reason).includes("40P01"))
    ).toBe(false);
    const pointer = await db.$queryRaw<
      Array<{ current_work_version_id: string | null; version: number }>
    >`SELECT current_work_version_id, version FROM project_uph_topologies WHERE project_id = 'p-uph'`;
    expect(pointer).toHaveLength(1);
    expect(pointer[0]?.current_work_version_id).toBe(draft.id);
  });

  it.each([true, false])(
    "serializes publish and replacement of the same signed version in launch order=%s",
    async (publishFirst) => {
      const body = {
        kind: "CT" as const,
        projectVersion: 1,
        content: {
          projectModuleId: "pm-uph",
          intrinsicCtSeconds: 12,
          outputPerCycleTotal: 4,
          parallelChannelCount: 2,
          cavityCount: 1
        }
      };
      const draft = await createUphDefinition({
        projectId: "p-uph",
        actorId: "u-proc",
        authorizationActor: actor,
        body,
        auditContext: { ...auditContext, requestId: `lock-order-${publishFirst}` }
      });
      const signed = await signoffUphDefinition({
        projectId: "p-uph",
        kind: "CT",
        versionId: draft.id,
        resourceVersion: draft.resourceVersion,
        actorId: "u-comm",
        authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
        auditContext: { ...auditContext, actorId: "u-comm" }
      });
      const replacement = replaceSignedUphDraft({
        projectId: "p-uph",
        kind: "CT",
        reason: "并发替代 RED",
        actorId: "u-proc",
        authorizationActor: actor,
        body: {
          ...body,
          projectVersion: 2,
          content: { ...body.content, intrinsicCtSeconds: 10 }
        },
        auditContext
      });
      const publish = publishUphDefinition({
        projectId: "p-uph",
        kind: "CT",
        versionId: draft.id,
        resourceVersion: signed.resourceVersion,
        actorId: "u-qual",
        authorizationActor: { ...actor, id: "u-qual", name: "Quality" },
        auditContext: { ...auditContext, actorId: "u-qual" }
      });
      const outcomes = await Promise.allSettled(
        publishFirst ? [publish, replacement] : [replacement, publish]
      );
      const failures = outcomes.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      expect(failures.some(({ reason }) => String(reason).includes("40P01"))).toBe(false);
      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(
        failures.every(({ reason }) =>
          [
            "VERSION_CONFLICT",
            "VERSION_IMMUTABLE",
            "SIGNED_DRAFT_REQUIRED",
            "UPH_CURRENT_WORK_CONFLICT",
            "UPH_SOURCE_WATERMARK_STALE"
          ].includes(reason?.code)
        )
      ).toBe(true);
    }
  );

  it("must keep deterministic publish/source locking deadlock-free", async () => {
    const body = {
      kind: "TOPOLOGY" as const,
      projectVersion: 1,
      content: lineTopologyContent()
    };
    const draft = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body,
      auditContext
    });
    const signed = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "TOPOLOGY",
      versionId: draft.id,
      resourceVersion: draft.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });
    await runDeterministicSourceCross((transaction) =>
      publishUphDefinition(
        {
          projectId: "p-uph",
          kind: "TOPOLOGY",
          versionId: draft.id,
          resourceVersion: signed.resourceVersion,
          actorId: "u-qual",
          authorizationActor: { ...actor, id: "u-qual", name: "Quality" },
          auditContext: { ...auditContext, actorId: "u-qual" }
        },
        transaction
      )
    );
  });

  it("must keep deterministic signoff/source locking deadlock-free", async () => {
    const body = {
      kind: "TOPOLOGY" as const,
      projectVersion: 1,
      content: lineTopologyContent()
    };
    const draft = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body,
      auditContext
    });
    await runDeterministicSourceCross((transaction) =>
      signoffUphDefinition(
        {
          projectId: "p-uph",
          kind: "TOPOLOGY",
          versionId: draft.id,
          resourceVersion: draft.resourceVersion,
          actorId: "u-comm",
          authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
          auditContext: { ...auditContext, actorId: "u-comm" }
        },
        transaction
      )
    );
  });

  it("must keep deterministic signed-draft replacement/source locking deadlock-free", async () => {
    const body = {
      kind: "TOPOLOGY" as const,
      projectVersion: 1,
      content: lineTopologyContent()
    };
    const draft = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body,
      auditContext
    });
    const signed = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "TOPOLOGY",
      versionId: draft.id,
      resourceVersion: draft.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });
    expect(signed.status).toBe("DRAFT");
    const root = await db.$queryRaw<Array<{ version: number }>>`
      SELECT version FROM project_uph_topologies WHERE project_id = 'p-uph'
    `;
    await runDeterministicSourceCross((transaction) =>
      replaceSignedUphDraft(
        {
          projectId: "p-uph",
          kind: "TOPOLOGY",
          reason: "锁序 RED",
          actorId: "u-proc",
          authorizationActor: actor,
          body: { ...body, projectVersion: root[0]?.version ?? 1 },
          auditContext
        },
        transaction
      )
    );
  });

  it("rejects direct SQL truncation of UPH facts", async () => {
    await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "CT",
        projectVersion: 1,
        content: {
          projectModuleId: "pm-uph",
          intrinsicCtSeconds: 12,
          outputPerCycleTotal: 4,
          parallelChannelCount: 2,
          cavityCount: 1
        }
      },
      auditContext
    });

    await expect(
      db.$executeRawUnsafe("TRUNCATE TABLE project_uph_ct_definition_versions")
    ).rejects.toMatchObject({ code: "P2010" });
  });

  it("rejects fractional CT counts at the PostgreSQL boundary", async () => {
    await expect(
      createUphDefinition({
        projectId: "p-uph",
        actorId: "u-proc",
        authorizationActor: actor,
        body: {
          kind: "CT",
          projectVersion: 1,
          content: {
            projectModuleId: "pm-uph",
            intrinsicCtSeconds: 12,
            outputPerCycleTotal: 1.5,
            parallelChannelCount: 2,
            cavityCount: 1
          }
        },
        auditContext
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 422 });
  });

  it("keeps responsibility facts immutable and permits publication after owner departure", async () => {
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "CT",
        projectVersion: 1,
        content: {
          projectModuleId: "pm-uph",
          intrinsicCtSeconds: 12,
          outputPerCycleTotal: 4,
          parallelChannelCount: 2,
          cavityCount: 1
        }
      },
      auditContext
    });

    await expect(
      db.$executeRaw`UPDATE project_uph_ct_definition_versions SET created_by_id = 'u-comm', resource_version = ${created.resourceVersion + 1} WHERE id = ${created.id}`
    ).rejects.toMatchObject({ code: "P2010" });

    await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: created.id,
      resourceVersion: created.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });
    await db.$executeRaw`UPDATE project_members SET left_at = CURRENT_TIMESTAMP WHERE id = 'pm-proc'`;
    const published = await publishUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: created.id,
      resourceVersion: created.resourceVersion + 1,
      actorId: "u-qual",
      authorizationActor: { ...actor, id: "u-qual", name: "Quality" },
      auditContext: { ...auditContext, actorId: "u-qual" }
    });
    expect(published.status).toBe("PUBLISHED");
    await db.$executeRaw`UPDATE project_members SET left_at = NULL WHERE id = 'pm-proc'`;
  });

  it("rejects a malformed non-current or unlineaged direct SQL publication", async () => {
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "CT",
        projectVersion: 1,
        content: {
          projectModuleId: "pm-uph",
          intrinsicCtSeconds: 12,
          outputPerCycleTotal: 4,
          parallelChannelCount: 2,
          cavityCount: 1
        }
      },
      auditContext
    });
    const signed = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: created.id,
      resourceVersion: created.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });
    await publishUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: created.id,
      resourceVersion: signed.resourceVersion,
      actorId: "u-qual",
      authorizationActor: { ...actor, id: "u-qual", name: "Quality" },
      auditContext: { ...auditContext, actorId: "u-qual" }
    });
    const draft = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "CT",
        projectVersion: 3,
        content: {
          projectModuleId: "pm-uph",
          intrinsicCtSeconds: 10,
          outputPerCycleTotal: 4,
          parallelChannelCount: 2,
          cavityCount: 1
        }
      },
      auditContext
    });
    const draftSigned = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: draft.id,
      resourceVersion: draft.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });

    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.$executeRaw`UPDATE project_uph_ct_definition_versions SET supersedes_version_id = NULL WHERE id = ${draft.id}`;
      await tx.$executeRaw`UPDATE project_uph_ct_definitions SET current_work_version_id = NULL, version = version + 1 WHERE project_id = 'p-uph'`;
    });

    await expect(
      publishUphDefinition({
        projectId: "p-uph",
        kind: "CT",
        versionId: draft.id,
        resourceVersion: draftSigned.resourceVersion,
        actorId: "u-qual",
        authorizationActor: { ...actor, id: "u-qual", name: "Quality" },
        auditContext: { ...auditContext, actorId: "u-qual" }
      })
    ).rejects.toMatchObject({ code: "UPH_CURRENT_WORK_CONFLICT", status: 409 });
  });

  it("rejects duplicate topology sources and non-root physical sources", async () => {
    await db.$executeRaw`INSERT INTO delivery_units(id,project_id,parent_id,unit_type,code,name,status,position,version,created_by_id,updated_by_id,created_at,updated_at) VALUES ('du-child','p-uph','du-line','MACHINE','MACHINE-2','Machine 2','ACTIVE',1,1,'u-proc','u-proc',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`;
    await expect(
      createUphDefinition({
        projectId: "p-uph",
        actorId: "u-proc",
        authorizationActor: actor,
        body: {
          kind: "TOPOLOGY",
          projectVersion: 1,
          content: {
            projectShape: "SINGLE_MACHINE",
            roots: [
              {
                sourceId: "du-child",
                sourceType: "MACHINE",
                parentSourceId: null,
                relation: "ROOT",
                capacity: 100
              }
            ]
          }
        },
        auditContext
      })
    ).rejects.toMatchObject({ code: "TOPOLOGY_PHYSICAL_PARENT_MISMATCH", status: 422 });

    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: {
        kind: "TOPOLOGY",
        projectVersion: 1,
        content: {
          projectShape: "LINE",
          roots: [
            {
              sourceId: "du-line",
              sourceType: "LINE",
              parentSourceId: null,
              relation: "ROOT",
              capacity: 100,
              children: [
                {
                  sourceId: "du-machine",
                  sourceType: "MACHINE",
                  parentSourceId: "du-line",
                  relation: "MANDATORY",
                  capacity: 100,
                  children: [
                    {
                      sourceId: "pm-uph",
                      sourceType: "MODULE",
                      parentSourceId: "du-machine",
                      relation: "MANDATORY",
                      capacity: 100
                    }
                  ]
                },
                {
                  sourceId: "du-child",
                  sourceType: "MACHINE",
                  parentSourceId: "du-line",
                  relation: "MANDATORY",
                  capacity: 100
                }
              ]
            }
          ]
        }
      },
      auditContext
    });
    const node = (
      await db.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM project_uph_topology_nodes WHERE topology_version_id = ${created.id}`
    )[0];
    await expect(
      db.$executeRaw`INSERT INTO project_uph_topology_nodes (id, project_id, topology_version_id, source_type, delivery_unit_id, parent_relation, capacity, source_version, source_status, source_snapshot_json, source_checksum, source_watermark) SELECT 'uph-duplicate-node', project_id, topology_version_id, source_type, delivery_unit_id, parent_relation, capacity, source_version, source_status, source_snapshot_json, source_checksum, source_watermark FROM project_uph_topology_nodes WHERE id = ${node?.id}`
    ).rejects.toMatchObject({ code: "P2010" });
  });

  it("keeps Formula drafts unsigned yet replaces them through the controlled correction path", async () => {
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: formulaBody(1),
      auditContext
    });

    await expect(
      signoffUphDefinition({
        projectId: "p-uph",
        kind: "FORMULA",
        versionId: created.id,
        resourceVersion: created.resourceVersion,
        actorId: "u-comm",
        authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
        auditContext: { ...auditContext, actorId: "u-comm" }
      })
    ).rejects.toMatchObject({ code: "SIGNOFF_NOT_REQUIRED", status: 409 });

    const replacement = await replaceSignedUphDraft({
      projectId: "p-uph",
      kind: "FORMULA",
      reason: "公式草稿纠错",
      actorId: "u-proc",
      authorizationActor: actor,
      body: formulaBody(2),
      auditContext
    });

    const rows = await db.$queryRaw<
      Array<{
        id: string;
        status: string;
        supersedes_version_id: string | null;
        current_work_version_id: string | null;
      }>
    >`
      SELECT v.id, v.status::text AS status, v.supersedes_version_id, r.current_work_version_id
      FROM project_uph_formula_versions v
      JOIN project_uph_formulas r ON r.id = v.formula_id AND r.project_id = v.project_id
      WHERE v.id IN (${created.id}, ${replacement.id})
      ORDER BY v.revision
    `;
    expect(rows).toEqual([
      {
        id: created.id,
        status: "SUPERSEDED",
        supersedes_version_id: null,
        current_work_version_id: replacement.id
      },
      {
        id: replacement.id,
        status: "DRAFT",
        supersedes_version_id: created.id,
        current_work_version_id: replacement.id
      }
    ]);
  });

  it("stores the process-owner checksum for the canonical responsibility snapshot, not content", async () => {
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: ctBody(1),
      auditContext
    });
    const expectedSnapshot = { membershipId: "pm-proc", userId: "u-proc", role: "ENGINEER" };
    const persisted = (
      await db.$queryRaw<
        Array<{ process_owner_snapshot_json: unknown; process_owner_checksum: string }>
      >`
        SELECT process_owner_snapshot_json, process_owner_checksum
        FROM project_uph_ct_definition_versions
        WHERE id = ${created.id}
      `
    )[0];

    expect(persisted?.process_owner_snapshot_json).toEqual(expectedSnapshot);
    expect(persisted?.process_owner_checksum).toBe(payloadHash(expectedSnapshot).hash);
  });

  it("rejects a direct SQL Formula process-owner snapshot checksum mismatch", async () => {
    await expectUphCheckViolation(
      db.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          INSERT INTO project_uph_formulas (id, project_id, version, created_by_id, updated_by_id)
          VALUES ('uph-bad-process-root', 'p-uph', 1, 'u-proc', 'u-proc')
        `;
        await transaction.$executeRaw`
          INSERT INTO project_uph_formula_versions (
            id, project_id, formula_id, revision, status, resource_version,
            formula_code, formula_json, snapshot_checksum,
            process_owner_membership_id, process_owner_user_id, process_owner_role,
            process_owner_snapshot_json, process_owner_checksum, created_by_id
          ) VALUES (
            'uph-bad-process-version', 'p-uph', 'uph-bad-process-root', 1, 'DRAFT', 1,
            'CANONICAL_UPH_V1', '{}'::jsonb, repeat('0', 64),
            'pm-proc', 'u-proc', 'ENGINEER',
            '{"membershipId":"pm-proc","userId":"u-proc","role":"ENGINEER"}'::jsonb,
            repeat('a', 64), 'u-proc'
          )
        `;
        await transaction.$executeRaw`
          UPDATE project_uph_formulas
          SET current_work_version_id = 'uph-bad-process-version', version = 2, updated_by_id = 'u-proc'
          WHERE id = 'uph-bad-process-root' AND project_id = 'p-uph'
        `;
      })
    );
  });

  it("rejects a direct SQL commissioning snapshot checksum mismatch without partial signoff", async () => {
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: ctBody(1),
      auditContext
    });

    await expectUphCheckViolation(
      db.$executeRaw`
        UPDATE project_uph_ct_definition_versions
        SET commissioning_membership_id = 'pm-comm',
            commissioning_user_id = 'u-comm',
            commissioning_role = 'ENGINEER',
            commissioning_snapshot_json = '{"membershipId":"pm-comm","userId":"u-comm","role":"ENGINEER"}'::jsonb,
            commissioning_checksum = repeat('a', 64),
            commissioning_signed_at = CURRENT_TIMESTAMP,
            resource_version = resource_version + 1
        WHERE id = ${created.id}
      `
    );
    const persisted = (
      await db.$queryRaw<Array<{ commissioning_signed_at: Date | null }>>`
        SELECT commissioning_signed_at FROM project_uph_ct_definition_versions WHERE id = ${created.id}
      `
    )[0];
    expect(persisted?.commissioning_signed_at).toBeNull();
  });

  it("rejects a direct SQL quality snapshot checksum mismatch without changing the published pointer", async () => {
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: ctBody(1),
      auditContext
    });
    const signed = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: created.id,
      resourceVersion: created.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });

    await expectUphCheckViolation(
      db.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          UPDATE project_uph_ct_definition_versions
          SET status = 'PUBLISHED',
              quality_publisher_membership_id = 'pm-qual',
              quality_publisher_user_id = 'u-qual',
              quality_publisher_role = 'QUALITY',
              quality_publisher_snapshot_json = '{"membershipId":"pm-qual","userId":"u-qual","role":"QUALITY"}'::jsonb,
              quality_publisher_checksum = repeat('a', 64),
              published_at = CURRENT_TIMESTAMP,
              resource_version = resource_version + 1
          WHERE id = ${created.id}
        `;
        await transaction.$executeRaw`
          UPDATE project_uph_ct_definitions
          SET current_work_version_id = NULL,
              current_published_version_id = ${created.id},
              version = version + 1,
              updated_by_id = 'u-qual'
          WHERE project_id = 'p-uph' AND project_module_id = 'pm-uph'
        `;
      })
    );
    const pointer = (
      await db.$queryRaw<
        Array<{
          current_work_version_id: string | null;
          current_published_version_id: string | null;
        }>
      >`
        SELECT current_work_version_id, current_published_version_id
        FROM project_uph_ct_definitions
        WHERE project_id = 'p-uph' AND project_module_id = 'pm-uph'
      `
    )[0];
    expect(pointer).toEqual({
      current_work_version_id: created.id,
      current_published_version_id: null
    });
    expect(signed.status).toBe("DRAFT");
  });

  it("rejects direct orphaning of a signed draft by superseding it and clearing current work", async () => {
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: ctBody(1),
      auditContext
    });
    await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: created.id,
      resourceVersion: created.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });

    await expectUphCheckViolation(
      db.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          UPDATE project_uph_ct_definition_versions
          SET status = 'SUPERSEDED', resource_version = resource_version + 1
          WHERE id = ${created.id}
        `;
        await transaction.$executeRaw`
          UPDATE project_uph_ct_definitions
          SET current_work_version_id = NULL, version = version + 1, updated_by_id = 'u-proc'
          WHERE project_id = 'p-uph' AND project_module_id = 'pm-uph'
        `;
        await transaction.$executeRawUnsafe(
          'SET CONSTRAINTS "project_uph_ct_versions_successor_guard" IMMEDIATE'
        );
      })
    );
    const persisted = (
      await db.$queryRaw<Array<{ status: string; current_work_version_id: string | null }>>`
        SELECT v.status::text AS status, r.current_work_version_id
        FROM project_uph_ct_definition_versions v
        JOIN project_uph_ct_definitions r ON r.id = v.ct_definition_id AND r.project_id = v.project_id
        WHERE v.id = ${created.id}
      `
    )[0];
    expect(persisted).toEqual({ status: "DRAFT", current_work_version_id: created.id });
  });

  it("rejects a replacement successor that omits the exact supersedes link", async () => {
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: ctBody(1),
      auditContext
    });
    await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: created.id,
      resourceVersion: created.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });

    await expectUphCheckViolation(
      db.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          UPDATE project_uph_ct_definition_versions
          SET status = 'SUPERSEDED', resource_version = resource_version + 1
          WHERE id = ${created.id}
        `;
        await transaction.$executeRaw`
          INSERT INTO project_uph_ct_definition_versions (
            id, project_id, ct_definition_id, revision, status, supersedes_version_id, resource_version,
            intrinsic_ct_seconds, output_per_cycle_total, parallel_channel_count, cavity_count,
            snapshot_json, snapshot_checksum, source_watermark,
            process_owner_membership_id, process_owner_user_id, process_owner_role,
            process_owner_snapshot_json, process_owner_checksum, created_by_id
          )
          SELECT
            'uph-fake-successor', project_id, ct_definition_id, revision + 1, 'DRAFT', NULL, 1,
            intrinsic_ct_seconds, output_per_cycle_total, parallel_channel_count, cavity_count,
            snapshot_json, snapshot_checksum, source_watermark,
            process_owner_membership_id, process_owner_user_id, process_owner_role,
            process_owner_snapshot_json, process_owner_checksum, created_by_id
          FROM project_uph_ct_definition_versions
          WHERE id = ${created.id}
        `;
        await transaction.$executeRaw`
          UPDATE project_uph_ct_definitions
          SET current_work_version_id = 'uph-fake-successor', version = version + 1, updated_by_id = 'u-proc'
          WHERE project_id = 'p-uph' AND project_module_id = 'pm-uph'
        `;
        await transaction.$executeRawUnsafe(
          'SET CONSTRAINTS "project_uph_ct_versions_successor_guard" IMMEDIATE'
        );
      })
    );
  });

  it("rejects direct orphaning of a published version by clearing current published", async () => {
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: ctBody(1),
      auditContext
    });
    const signed = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: created.id,
      resourceVersion: created.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });
    await publishUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: created.id,
      resourceVersion: signed.resourceVersion,
      actorId: "u-qual",
      authorizationActor: { ...actor, id: "u-qual", name: "Quality" },
      auditContext: { ...auditContext, actorId: "u-qual" }
    });

    await expectUphCheckViolation(
      db.$transaction(async (transaction) => {
        await transaction.$executeRaw`
          UPDATE project_uph_ct_definition_versions
          SET status = 'SUPERSEDED', resource_version = resource_version + 1
          WHERE id = ${created.id}
        `;
        await transaction.$executeRaw`
          UPDATE project_uph_ct_definitions
          SET current_published_version_id = NULL, version = version + 1, updated_by_id = 'u-qual'
          WHERE project_id = 'p-uph' AND project_module_id = 'pm-uph'
        `;
        await transaction.$executeRawUnsafe(
          'SET CONSTRAINTS "project_uph_ct_versions_successor_guard" IMMEDIATE'
        );
      })
    );
    const persisted = (
      await db.$queryRaw<Array<{ status: string; current_published_version_id: string | null }>>`
        SELECT v.status::text AS status, r.current_published_version_id
        FROM project_uph_ct_definition_versions v
        JOIN project_uph_ct_definitions r ON r.id = v.ct_definition_id AND r.project_id = v.project_id
        WHERE v.id = ${created.id}
      `
    )[0];
    expect(persisted).toEqual({ status: "PUBLISHED", current_published_version_id: created.id });
  });

  it("publishes a correction atomically with its exact predecessor and current-published pointer", async () => {
    const initial = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: ctBody(1),
      auditContext
    });
    const initialSigned = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: initial.id,
      resourceVersion: initial.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });
    await publishUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: initial.id,
      resourceVersion: initialSigned.resourceVersion,
      actorId: "u-qual",
      authorizationActor: { ...actor, id: "u-qual", name: "Quality" },
      auditContext: { ...auditContext, actorId: "u-qual" }
    });
    const root = (
      await db.$queryRaw<Array<{ version: number }>>`
        SELECT version FROM project_uph_ct_definitions
        WHERE project_id = 'p-uph' AND project_module_id = 'pm-uph'
      `
    )[0];
    const correction = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: ctBody(root!.version, 10),
      auditContext
    });
    const correctionSigned = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: correction.id,
      resourceVersion: correction.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });
    await publishUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: correction.id,
      resourceVersion: correctionSigned.resourceVersion,
      actorId: "u-qual",
      authorizationActor: { ...actor, id: "u-qual", name: "Quality" },
      auditContext: { ...auditContext, actorId: "u-qual" }
    });

    const versions = await db.$queryRaw<
      Array<{
        id: string;
        status: string;
        supersedes_version_id: string | null;
        current_published_version_id: string | null;
      }>
    >`
      SELECT v.id, v.status::text AS status, v.supersedes_version_id, r.current_published_version_id
      FROM project_uph_ct_definition_versions v
      JOIN project_uph_ct_definitions r ON r.id = v.ct_definition_id AND r.project_id = v.project_id
      WHERE v.id IN (${initial.id}, ${correction.id})
      ORDER BY v.revision
    `;
    expect(versions).toEqual([
      {
        id: initial.id,
        status: "SUPERSEDED",
        supersedes_version_id: null,
        current_published_version_id: correction.id
      },
      {
        id: correction.id,
        status: "PUBLISHED",
        supersedes_version_id: initial.id,
        current_published_version_id: correction.id
      }
    ]);
  });

  it("publishes a signed correction replacement while retaining the full published lineage", async () => {
    const initial = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: ctBody(1),
      auditContext
    });
    const initialSigned = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: initial.id,
      resourceVersion: initial.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });
    await publishUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: initial.id,
      resourceVersion: initialSigned.resourceVersion,
      actorId: "u-qual",
      authorizationActor: { ...actor, id: "u-qual", name: "Quality" },
      auditContext: { ...auditContext, actorId: "u-qual" }
    });

    let root = (
      await db.$queryRaw<Array<{ version: number }>>`
        SELECT version FROM project_uph_ct_definitions
        WHERE project_id = 'p-uph' AND project_module_id = 'pm-uph'
      `
    )[0];
    const correction = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: ctBody(root!.version, 10),
      auditContext
    });
    const correctionSigned = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: correction.id,
      resourceVersion: correction.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });
    expect(correctionSigned.status).toBe("DRAFT");
    root = (
      await db.$queryRaw<Array<{ version: number }>>`
        SELECT version FROM project_uph_ct_definitions
        WHERE project_id = 'p-uph' AND project_module_id = 'pm-uph'
      `
    )[0];
    const replacement = await replaceSignedUphDraft({
      projectId: "p-uph",
      kind: "CT",
      reason: "已会签纠错草稿仍需替代",
      actorId: "u-proc",
      authorizationActor: actor,
      body: ctBody(root!.version, 9),
      auditContext
    });
    const replacementSigned = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: replacement.id,
      resourceVersion: replacement.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });
    await publishUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: replacement.id,
      resourceVersion: replacementSigned.resourceVersion,
      actorId: "u-qual",
      authorizationActor: { ...actor, id: "u-qual", name: "Quality" },
      auditContext: { ...auditContext, actorId: "u-qual" }
    });

    const versions = await db.$queryRaw<
      Array<{ id: string; status: string; supersedes_version_id: string | null }>
    >`
      SELECT id, status::text AS status, supersedes_version_id
      FROM project_uph_ct_definition_versions
      WHERE id IN (${initial.id}, ${correction.id}, ${replacement.id})
      ORDER BY revision
    `;
    expect(versions).toEqual([
      { id: initial.id, status: "SUPERSEDED", supersedes_version_id: null },
      { id: correction.id, status: "SUPERSEDED", supersedes_version_id: initial.id },
      { id: replacement.id, status: "PUBLISHED", supersedes_version_id: correction.id }
    ]);
    const pointer = (
      await db.$queryRaw<
        Array<{
          current_work_version_id: string | null;
          current_published_version_id: string | null;
        }>
      >`
        SELECT current_work_version_id, current_published_version_id
        FROM project_uph_ct_definitions
        WHERE project_id = 'p-uph' AND project_module_id = 'pm-uph'
      `
    )[0];
    expect(pointer).toEqual({
      current_work_version_id: null,
      current_published_version_id: replacement.id
    });
  });

  it("projects user-level ownership and independence even when one user has multiple memberships", async () => {
    await db.$executeRaw`
      INSERT INTO project_members(id, project_id, user_id, project_role, assigned_by_id, joined_at, version)
      VALUES ('pm-proc-quality', 'p-uph', 'u-proc', 'QUALITY', 'u-proc', CURRENT_TIMESTAMP, 1)
    `;
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: ctBody(1),
      auditContext
    });
    const nonOwnerEngineer = {
      ...actor,
      id: "u-comm",
      name: "Commission",
      grants: [
        {
          permission: "PROJECT_UPH_DEFINITION_MANAGE",
          scope: "PROJECT" as const,
          systemRole: "role-engineer"
        }
      ]
    };
    const dualRoleOwner = {
      ...actor,
      grants: [
        {
          permission: "PROJECT_UPH_DEFINITION_MANAGE",
          scope: "PROJECT" as const,
          systemRole: "role-engineer"
        },
        {
          permission: "PROJECT_UPH_PUBLISH",
          scope: "PROJECT" as const,
          systemRole: "role-quality"
        }
      ]
    };
    const [nonOwnerRead, ownerRead] = await Promise.all([
      getUphDefinition({
        projectId: "p-uph",
        kind: "CT",
        selection: "exact",
        versionId: created.id,
        authorizationActor: nonOwnerEngineer,
        projectMemberRoles: ["ENGINEER"]
      }),
      getUphDefinition({
        projectId: "p-uph",
        kind: "CT",
        selection: "exact",
        versionId: created.id,
        authorizationActor: dualRoleOwner,
        projectMemberRoles: ["ENGINEER", "QUALITY"]
      })
    ]);
    expect(nonOwnerRead.allowedActions).toEqual([]);
    expect(ownerRead.allowedActions).toEqual(["PATCH"]);

    await expect(
      createUphDefinition({
        projectId: "p-uph",
        actorId: "u-comm",
        authorizationActor: nonOwnerEngineer,
        body: { ...ctBody(2), versionId: created.id, resourceVersion: created.resourceVersion },
        auditContext: { ...auditContext, actorId: "u-comm" }
      })
    ).rejects.toMatchObject({ code: "PROCESS_OWNER_REQUIRED", status: 403 });

    const signed = await signoffUphDefinition({
      projectId: "p-uph",
      kind: "CT",
      versionId: created.id,
      resourceVersion: created.resourceVersion,
      actorId: "u-comm",
      authorizationActor: { ...actor, id: "u-comm", name: "Commission" },
      auditContext: { ...auditContext, actorId: "u-comm" }
    });
    await expect(
      publishUphDefinition({
        projectId: "p-uph",
        kind: "CT",
        versionId: created.id,
        resourceVersion: signed.resourceVersion,
        actorId: "u-proc",
        authorizationActor: dualRoleOwner,
        auditContext
      })
    ).rejects.toMatchObject({ code: "ACTOR_NOT_INDEPENDENT", status: 409 });
  });

  it("returns only actions the current actor can execute, including Formula replacement", async () => {
    const created = await createUphDefinition({
      projectId: "p-uph",
      actorId: "u-proc",
      authorizationActor: actor,
      body: formulaBody(1),
      auditContext
    });
    const readOnlyActor = {
      ...actor,
      grants: [
        { permission: "PROJECT_UPH_READ", scope: "PROJECT" as const, systemRole: "role-engineer" }
      ]
    };
    const managingActor = {
      ...actor,
      grants: [
        {
          permission: "PROJECT_UPH_DEFINITION_MANAGE",
          scope: "PROJECT" as const,
          systemRole: "role-engineer"
        }
      ]
    };
    const publishingActor = {
      ...actor,
      id: "u-qual",
      name: "Quality",
      grants: [
        { permission: "PROJECT_UPH_PUBLISH", scope: "PROJECT" as const, systemRole: "role-quality" }
      ]
    };
    const input = {
      projectId: "p-uph",
      kind: "FORMULA" as const,
      selection: "exact" as const,
      versionId: created.id,
      projectMemberRoles: ["ENGINEER"]
    };
    const [readOnly, managing, publishing] = await Promise.all([
      getUphDefinition({ ...input, authorizationActor: readOnlyActor } as never),
      getUphDefinition({ ...input, authorizationActor: managingActor } as never),
      getUphDefinition({
        ...input,
        authorizationActor: publishingActor,
        projectMemberRoles: ["QUALITY"]
      } as never)
    ]);

    expect(readOnly.allowedActions).toEqual([]);
    expect(managing.allowedActions).toEqual(["PATCH", "REPLACE"]);
    expect(publishing.allowedActions).toEqual(["PUBLISH"]);
  });
});
