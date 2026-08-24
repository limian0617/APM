import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import type { AuditContext } from "@/modules/audit/contracts/audit";
import {
  createUphDefinition,
  publishUphDefinition,
  signoffUphDefinition
} from "./uph-definition-service";
import { setDeliveryUnitEnabled } from "@/modules/projects/application/project-structure";

const sourcePath = new URL("./uph-definition-service.ts", import.meta.url);
const serviceSource = readFileSync(sourcePath, "utf8");
const describeDatabase = process.env.RUN_DATABASE_INTEGRATION === "1" ? describe : describe.skip;
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);

const ids = {
  project: `uph-lock-project-${suffix}`,
  template: `uph-lock-template-${suffix}`,
  templateVersion: `uph-lock-template-version-${suffix}`,
  process: `uph-lock-process-${suffix}`,
  commissioning: `uph-lock-commissioning-${suffix}`,
  quality: `uph-lock-quality-${suffix}`,
  processMember: `uph-lock-process-member-${suffix}`,
  commissioningMember: `uph-lock-commissioning-member-${suffix}`,
  qualityMember: `uph-lock-quality-member-${suffix}`,
  deliveryUnit: `uph-lock-delivery-unit-${suffix}`,
  projectModule: `uph-lock-project-module-${suffix}`
};

const actor = (id: string) => ({
  id,
  name: id,
  status: "ACTIVE" as const,
  departmentId: null,
  systemRoles: [],
  grants: []
});

function auditContext(actorId: string, operationId: string): AuditContext {
  return {
    actorId,
    requestId: `request-${operationId}`,
    traceId: null,
    source: "API",
    sourceIp: null,
    userAgent: "Vitest",
    reason: null,
    projectId: ids.project,
    departmentId: null,
    operationId
  };
}

const topologyBody = (projectVersion: number) => ({
  kind: "TOPOLOGY" as const,
  projectVersion,
  content: {
    projectShape: "LINE" as const,
    roots: [
      {
        sourceId: ids.deliveryUnit,
        sourceType: "LINE" as const,
        parentSourceId: null,
        relation: "ROOT" as const,
        capacity: 100,
        children: [
          {
            sourceId: ids.projectModule,
            sourceType: "MODULE" as const,
            parentSourceId: ids.deliveryUnit,
            relation: "MANDATORY" as const,
            capacity: 100
          }
        ]
      }
    ]
  }
});

function waitFor(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function seedFixture() {
  await db.$executeRawUnsafe("SET session_replication_role = replica");
  await db.$executeRaw`
    INSERT INTO users(id, employee_no, name, status, version, created_at, updated_at)
    VALUES
      (${ids.process}, ${`E-${ids.process}`}, 'Process', 'ACTIVE', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      (${ids.commissioning}, ${`E-${ids.commissioning}`}, 'Commissioning', 'ACTIVE', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      (${ids.quality}, ${`E-${ids.quality}`}, 'Quality', 'ACTIVE', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `;
  await db.$executeRaw`
    INSERT INTO templates(id, code, name, status, current_version, version, created_by_id, updated_by_id, created_at, updated_at)
    VALUES (${ids.template}, ${`UPH.LOCK.${suffix.toUpperCase()}`}, 'UPH lock test', 'ACTIVE', 1, 1, ${ids.process}, ${ids.process}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `;
  await db.$executeRaw`
    INSERT INTO template_versions(id, template_id, version, status, name, checksum, published_by_id, published_at)
    VALUES (${ids.templateVersion}, ${ids.template}, 1, 'PUBLISHED', 'UPH lock test v1', repeat('0', 64), ${ids.process}, CURRENT_TIMESTAMP)
  `;
  await db.$executeRaw`
    INSERT INTO projects(
      id, code, name, status, version, initialization_status, source_template_version_id,
      source_template_checksum, initialized_at, project_type, equipment_shape, structure_status,
      capability_configuration_status, capabilities_configured_at, created_by_id, created_at, updated_at
    )
    VALUES (
      ${ids.project}, ${`P-UPH-LOCK-${suffix.toUpperCase()}`}, 'UPH lock test project', 'DRAFT', 1, 'READY',
      ${ids.templateVersion}, repeat('0', 64), CURRENT_TIMESTAMP, 'CUSTOMER_DELIVERY', 'LINE', 'READY',
      'READY', CURRENT_TIMESTAMP, ${ids.process}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `;
  await db.$executeRaw`
    INSERT INTO project_capabilities(
      project_id, capability_code, template_allowed, template_required, selected_enabled,
      source_snapshot_component_id, version, created_by_id, updated_by_id, created_at, updated_at
    )
    VALUES (${ids.project}, 'UPH_ANALYSIS', true, false, true, ${`source-${suffix}`}, 1, ${ids.process}, ${ids.process}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `;
  await db.$executeRaw`UPDATE company_capabilities SET enabled = true WHERE code = 'UPH_ANALYSIS'`;
  await db.$executeRaw`
    INSERT INTO delivery_units(
      id, project_id, parent_id, unit_type, code, name, status, position, version,
      created_by_id, updated_by_id, created_at, updated_at
    )
    VALUES (${ids.deliveryUnit}, ${ids.project}, NULL, 'LINE', ${`LINE-${suffix.toUpperCase()}`}, 'Line', 'ACTIVE', 0, 1, ${ids.process}, ${ids.process}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `;
  await db.$executeRaw`
    INSERT INTO project_modules(
      id, project_id, delivery_unit_id, code, name, status, position, version,
      created_by_id, updated_by_id, created_at, updated_at
    )
    VALUES (${ids.projectModule}, ${ids.project}, ${ids.deliveryUnit}, ${`MODULE-${suffix.toUpperCase()}`}, 'Module', 'ACTIVE', 0, 1, ${ids.process}, ${ids.process}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `;
  await db.$executeRaw`
    INSERT INTO project_members(id, project_id, user_id, project_role, assigned_by_id, joined_at, version)
    VALUES
      (${ids.processMember}, ${ids.project}, ${ids.process}, 'ENGINEER', ${ids.process}, CURRENT_TIMESTAMP, 1),
      (${ids.commissioningMember}, ${ids.project}, ${ids.commissioning}, 'ENGINEER', ${ids.process}, CURRENT_TIMESTAMP, 1),
      (${ids.qualityMember}, ${ids.project}, ${ids.quality}, 'QUALITY', ${ids.process}, CURRENT_TIMESTAMP, 1)
  `;
  await db.$executeRawUnsafe("SET session_replication_role = origin");
}

async function cleanupFixture() {
  // The disposable cluster is dropped after the run; immutable template facts stay intact.
  await db.$executeRaw`UPDATE company_capabilities SET enabled = false WHERE code = 'UPH_ANALYSIS'`;
}

async function createSignedTopology() {
  const created = await createUphDefinition({
    projectId: ids.project,
    actorId: ids.process,
    authorizationActor: actor(ids.process),
    body: topologyBody(1),
    auditContext: auditContext(ids.process, `create-${suffix}`)
  });
  return signoffUphDefinition({
    projectId: ids.project,
    kind: "TOPOLOGY",
    versionId: created.id,
    resourceVersion: created.resourceVersion,
    actorId: ids.commissioning,
    authorizationActor: actor(ids.commissioning),
    auditContext: auditContext(ids.commissioning, `signoff-${suffix}`)
  });
}

const publishInput = (versionId: string, resourceVersion: number) => ({
  projectId: ids.project,
  kind: "TOPOLOGY" as const,
  versionId,
  resourceVersion,
  actorId: ids.quality,
  authorizationActor: actor(ids.quality),
  auditContext: auditContext(ids.quality, `publish-${suffix}`)
});

const disableInput = (version: number) => ({
  projectId: ids.project,
  deliveryUnitId: ids.deliveryUnit,
  version,
  enabled: false,
  reason: "锁序测试停用",
  actorId: ids.process,
  auditContext: auditContext(ids.process, `disable-${suffix}`)
});

describe("APM-080 lock-order contract (RED)", () => {
  it("requires a legal sourceType+stableId cross-table lock plan", () => {
    expect(serviceSource).toMatch(/FOR NO KEY UPDATE/u);
    expect(serviceSource).toMatch(/sourceType[\s\S]{0,300}stableId/u);
    expect(serviceSource).toMatch(/lockUphStructureSources[\s\S]{0,600}sourceType/u);
    expect(serviceSource).toMatch(/delivery_units[\s\S]{0,300}FOR UPDATE/u);
    expect(serviceSource).toMatch(/project_modules[\s\S]{0,300}FOR UPDATE/u);
  });

  it("requires current-work and current-published versions to be locked in stable ID order", () => {
    expect(serviceSource).toMatch(
      /currentWorkVersionId[\s\S]{0,500}ORDER BY[\s\S]{0,80}id[\s\S]{0,80}FOR UPDATE/u
    );
    expect(serviceSource).toMatch(
      /currentPublishedVersionId[\s\S]{0,500}ORDER BY[\s\S]{0,80}id[\s\S]{0,80}FOR UPDATE/u
    );
  });
});

describeDatabase("APM-080 real lock-order concurrency (RED)", () => {
  beforeAll(seedFixture);
  afterAll(cleanupFixture);

  it("must avoid a deadlock when real APM-012 source transition crosses UPH publish", async () => {
    const signed = await createSignedTopology();
    let projectLocked!: () => void;
    let sourceLocked!: () => void;
    const projectLockedReady = new Promise<void>((resolve) => {
      projectLocked = resolve;
    });
    const sourceLockedReady = new Promise<void>((resolve) => {
      sourceLocked = resolve;
    });

    const publishTx = db.$transaction(
      async (transaction) => {
        await transaction.$executeRawUnsafe("SET LOCAL deadlock_timeout = '100ms'");
        await transaction.$executeRaw`
          SELECT id FROM projects WHERE id = ${ids.project} FOR NO KEY UPDATE
        `;
        projectLocked();
        await sourceLockedReady;
        return publishUphDefinition(publishInput(signed.id, signed.resourceVersion), transaction);
      },
      { timeout: 30_000 }
    );

    await projectLockedReady;
    const sourceTx = db.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`
          SELECT id FROM delivery_units WHERE id = ${ids.deliveryUnit} FOR UPDATE
        `;
        sourceLocked();
        return setDeliveryUnitEnabled(disableInput(1), transaction);
      },
      { timeout: 30_000 }
    );

    const [publishResult, sourceResult] = await Promise.allSettled([publishTx, sourceTx]);
    const outcomes = [publishResult, sourceResult];
    const deadlocks = outcomes.filter(
      (result) => result.status === "rejected" && /40P01/u.test(String(result.reason))
    );
    expect(deadlocks, "APM-080/012 lock order produced PostgreSQL deadlock").toHaveLength(0);

    const facts = await db.$queryRaw<
      Array<{
        version_status: string;
        resource_version: number;
        current_published_version_id: string | null;
        delivery_status: string;
      }>
    >`
      SELECT v.status::text AS version_status, v.resource_version,
             t.current_published_version_id, d.status::text AS delivery_status
      FROM project_uph_topology_versions v
      JOIN project_uph_topologies t ON t.id = v.topology_id
      JOIN delivery_units d ON d.id = ${ids.deliveryUnit}
      WHERE v.id = ${signed.id}
    `;
    const fact = facts[0];
    expect(fact).toBeTruthy();
    expect(
      fact?.current_published_version_id === signed.id
        ? fact.delivery_status === "ACTIVE" && fact.version_status === "PUBLISHED"
        : fact?.current_published_version_id === null && fact?.version_status === "DRAFT"
    ).toBe(true);
  });
});
