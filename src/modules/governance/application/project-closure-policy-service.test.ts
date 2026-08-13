import { describe, expect, it, vi } from "vitest";

import {
  materializeInitialProjectClosurePolicy,
  upgradeProjectClosurePolicy
} from "./project-closure-policy-service";
import {
  CLOSURE_POLICY_BINDINGS,
  buildClosurePolicyVersionFacts
} from "../domain/project-closure-policy";
import { payloadHash } from "../domain/idempotency";

function clientFixture() {
  const definition = {
    id: "g9-definition-v2",
    projectId: "project-1",
    code: "G9",
    revision: 2,
    scope: "PROJECT",
    checkerBindingsJson: [
      { code: "CLOSURE.ARCHIVE.G9", version: 2 },
      { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
    ],
    instances: [{ id: "g9-instance-v2" }]
  };
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ now: new Date("2026-08-13T06:00:00.000Z") }]),
    project: { findUnique: vi.fn().mockResolvedValue({ id: "project-1", status: "IN_PROGRESS" }) },
    projectTemplateSnapshot: {
      findFirst: vi.fn().mockResolvedValue({ id: "snapshot-1", projectId: "project-1" })
    },
    projectGateDefinition: {
      findFirst: vi.fn().mockResolvedValue(definition),
      create: vi.fn().mockResolvedValue({ id: "g9-definition-v2-revision" })
    },
    projectClosurePolicy: {
      create: vi.fn().mockResolvedValue({ id: "policy-1", projectId: "project-1", version: 1 }),
      findUnique: vi.fn().mockResolvedValue({
        id: "policy-1",
        projectId: "project-1",
        version: 1,
        currentVersionId: "policy-version-1",
        currentVersion: { id: "policy-version-1", status: "ACTIVE" }
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    projectClosurePolicyVersion: {
      create: vi.fn().mockResolvedValue({ id: "policy-version-1", versionNo: 1, status: "ACTIVE" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue({ versionNo: 1 })
    },
    projectGateInstance: {
      create: vi.fn().mockResolvedValue({ id: "g9-instance-v2-revision" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    outboxEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockImplementation(async (input: any) => ({
        id: "outbox-1",
        payloadHash: input.create.payloadHash,
        aggregateType: input.create.aggregateType,
        aggregateId: input.create.aggregateId
      }))
    }
  };
}

describe("project closure policy service", () => {
  it("materializes the initial policy and binds the exact project G9 instance", async () => {
    const client = clientFixture();
    const result = await materializeInitialProjectClosurePolicy(client as any, {
      projectId: "project-1",
      sourceTemplateSnapshotId: "snapshot-1",
      sourceGateDefinitionId: "g9-definition-v2",
      gateInstanceId: "g9-instance-v2",
      actorId: "user-1",
      auditContext: { actorId: "user-1", projectId: "project-1" } as any
    });
    expect(client.projectClosurePolicyVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceGateDefinitionId: "g9-definition-v2",
          archiveSourceFormulaVersion: "V2",
          effectiveAt: new Date("2026-08-13T06:00:00.000Z"),
          bindingChecksum: expect.stringMatching(/^[0-9a-f]{64}$/u),
          policyChecksum: expect.stringMatching(/^[0-9a-f]{64}$/u)
        })
      })
    );
    expect(client.projectGateInstance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "g9-instance-v2", closurePolicyVersionId: null }),
        data: expect.objectContaining({ closurePolicyVersionId: "policy-version-1" })
      })
    );
    expect(result).toMatchObject({ policyVersionId: "policy-version-1", auditId: "audit-1" });
  });

  it("upgrades an open project append-only and supersedes the old active version", async () => {
    const client = clientFixture();
    client.projectClosurePolicyVersion.create.mockResolvedValue({
      id: "policy-version-2",
      versionNo: 2,
      status: "ACTIVE"
    });
    await upgradeProjectClosurePolicy(
      {
        projectId: "project-1",
        sourceTemplateSnapshotId: "snapshot-1",
        sourceGateDefinitionId: "g9-definition-v2",
        gateInstanceId: "g9-instance-v2",
        expectedPolicyVersion: 1,
        reason: "升级为复盘关项策略",
        actorId: "user-1",
        idempotencyKey: "policy-upgrade-1",
        auditContext: { actorId: "user-1", projectId: "project-1" } as any
      },
      client as any
    );
    expect(client.projectClosurePolicyVersion.updateMany).toHaveBeenCalledWith({
      where: { id: "policy-version-1", projectId: "project-1", status: "ACTIVE" },
      data: { status: "SUPERSEDED" }
    });
    expect(client.projectClosurePolicy.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ version: 1 }) })
    );
    expect(client.projectGateDefinition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          code: "G9",
          revision: 3,
          checkerBindingsJson: [
            { code: "CLOSURE.ARCHIVE.G9", version: 2 },
            { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
          ]
        })
      })
    );
    expect(client.projectGateInstance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ gateDefinitionId: "g9-definition-v2-revision" })
      })
    );
    expect(client.projectGateInstance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "g9-instance-v2-revision" }),
        data: expect.objectContaining({ closurePolicyVersionId: "policy-version-2" })
      })
    );
  });

  it("creates the first policy aggregate for an unclosed legacy project", async () => {
    const client = clientFixture();
    client.projectClosurePolicy.findUnique.mockResolvedValue(null);
    const result = await upgradeProjectClosurePolicy(
      {
        projectId: "project-1",
        sourceTemplateSnapshotId: "snapshot-1",
        sourceGateDefinitionId: "g9-definition-v2",
        gateInstanceId: "g9-instance-v2",
        expectedPolicyVersion: 0,
        reason: "存量项目升级为复盘关项策略",
        actorId: "user-1",
        idempotencyKey: "legacy-policy-upgrade-1",
        auditContext: { actorId: "user-1", projectId: "project-1" } as any
      },
      client as any
    );
    expect(client.projectClosurePolicy.create).toHaveBeenCalledWith({
      data: {
        projectId: "project-1",
        status: "ACTIVE",
        createdById: "user-1",
        updatedById: "user-1"
      }
    });
    expect(client.projectClosurePolicyVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ versionNo: 1, status: "ACTIVE" }) })
    );
    expect(result).toMatchObject({ policyId: "policy-1", policyVersionId: "policy-version-1" });
  });

  it("replays an already activated upgrade by idempotency key without adding a version", async () => {
    const client = clientFixture();
    const facts = buildClosurePolicyVersionFacts({
      projectId: "project-1",
      sourceTemplateSnapshotId: "snapshot-1",
      sourceGateDefinitionId: "g9-definition-v2",
      checkerBindings: [
        { code: "CLOSURE.ARCHIVE.G9", version: 2 },
        { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
      ]
    });
    client.outboxEvent.findUnique.mockResolvedValue({
      id: "outbox-existing",
      aggregateId: "policy-version-2",
      payload: {
        projectId: "project-1",
        closurePolicyId: "policy-1",
        closurePolicyVersionId: "policy-version-2",
        sourceTemplateSnapshotId: "snapshot-1",
        sourceGateDefinitionId: "g9-definition-v2",
        gateInstanceId: "g9-instance-v2",
        archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
        bindingChecksum: facts.bindingChecksum,
        policyChecksum: facts.policyChecksum,
        actorId: "user-1",
        operationReason: "升级为复盘关项策略",
        auditId: "audit-existing"
      }
    });
    const result = await upgradeProjectClosurePolicy(
      {
        projectId: "project-1",
        sourceTemplateSnapshotId: "snapshot-1",
        sourceGateDefinitionId: "g9-definition-v2",
        gateInstanceId: "g9-instance-v2",
        expectedPolicyVersion: 1,
        reason: "升级为复盘关项策略",
        actorId: "user-1",
        idempotencyKey: "policy-upgrade-replay",
        auditContext: { actorId: "user-1", projectId: "project-1" } as any
      },
      client as any
    );
    expect(result).toMatchObject({
      replayed: true,
      policyVersionId: "policy-version-2",
      auditId: "audit-existing",
      outboxEventId: "outbox-existing"
    });
    expect(client.projectClosurePolicyVersion.updateMany).not.toHaveBeenCalled();
    expect(client.projectClosurePolicyVersion.create).not.toHaveBeenCalled();
  });

  it("rejects a legacy G9 binding before creating policy facts", async () => {
    const client = clientFixture();
    client.projectGateDefinition.findFirst.mockResolvedValue({
      id: "legacy-g9",
      projectId: "project-1",
      code: "G9",
      scope: "PROJECT",
      checkerBindingsJson: [{ code: "CLOSURE.ARCHIVE.G9", version: 1 }],
      instances: [{ id: "legacy-instance" }]
    });
    await expect(
      materializeInitialProjectClosurePolicy(client as any, {
        projectId: "project-1",
        sourceTemplateSnapshotId: "snapshot-1",
        sourceGateDefinitionId: "legacy-g9",
        gateInstanceId: "legacy-instance",
        actorId: "user-1",
        auditContext: { actorId: "user-1", projectId: "project-1" } as any
      })
    ).rejects.toMatchObject({ code: "CLOSURE_POLICY_BINDINGS_INVALID" });
    expect(client.projectClosurePolicy.create).not.toHaveBeenCalled();
  });

  it("appends a V2 G9 revision and instance when upgrading a legacy project", async () => {
    const client = clientFixture();
    client.projectGateDefinition.findFirst
      .mockResolvedValueOnce({
        id: "legacy-g9-definition",
        projectId: "project-1",
        sourceSnapshotComponentId: "gate-component-1",
        projectStageId: "stage-s8",
        code: "G9",
        name: "旧结项",
        scope: "PROJECT",
        definitionJson: { approvalMode: "ALL" },
        definitionChecksum: "a".repeat(64),
        checkerBindingsJson: [{ code: "CLOSURE.ARCHIVE.G9", version: 1 }],
        instances: [{ id: "legacy-g9-instance" }]
      })
      .mockResolvedValueOnce({ revision: 1 });

    await upgradeProjectClosurePolicy(
      {
        projectId: "project-1",
        sourceTemplateSnapshotId: "snapshot-1",
        sourceGateDefinitionId: "legacy-g9-definition",
        gateInstanceId: "legacy-g9-instance",
        expectedPolicyVersion: 1,
        reason: "升级为复盘关项策略",
        actorId: "user-1",
        idempotencyKey: "legacy-g9-upgrade-1",
        auditContext: { actorId: "user-1", projectId: "project-1" } as any
      },
      client as any
    );

    expect(client.projectGateDefinition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "project-1",
          code: "G9",
          revision: 2,
          definitionJson: {
            approvalMode: "ALL",
            checkers: [...CLOSURE_POLICY_BINDINGS],
            scope: "PROJECT"
          },
          definitionChecksum: payloadHash({
            approvalMode: "ALL",
            checkers: [...CLOSURE_POLICY_BINDINGS],
            scope: "PROJECT"
          }).hash,
          checkerBindingsJson: [
            { code: "CLOSURE.ARCHIVE.G9", version: 2 },
            { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
          ]
        })
      })
    );
    expect(client.projectGateInstance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: "project-1",
          gateDefinitionId: "g9-definition-v2-revision",
          scope: "PROJECT"
        })
      })
    );
    expect(client.projectGateInstance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "g9-instance-v2-revision" })
      })
    );
    expect(client.auditLog.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          afterJson: expect.objectContaining({
            projectId: "project-1",
            gateDefinitionId: "g9-definition-v2-revision",
            code: "G9",
            revision: 2
          })
        })
      })
    );
    expect(client.auditLog.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          afterJson: expect.objectContaining({
            projectId: "project-1",
            gateDefinitionId: "g9-definition-v2-revision",
            gateInstanceId: "g9-instance-v2-revision"
          })
        })
      })
    );
  });
});
