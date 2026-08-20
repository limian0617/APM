import { describe, expect, it, vi } from "vitest";

import {
  GateServiceError,
  assertExecutableGateDefinition,
  buildProjectGateListing,
  buildGateCheckRun,
  resolveAcceptanceConfirmationScope
} from "./gate-service";
import { buildClosurePolicyVersionFacts } from "../domain/project-closure-policy";

describe("APM-102 acceptance confirmation Gate scope", () => {
  it("maps a module Gate target to its matching MACHINE acceptance scope", () => {
    expect(
      resolveAcceptanceConfirmationScope({
        projectId: "project-1",
        scope: { scope: "MODULE", deliveryUnitId: "delivery-1", moduleId: "machine-1" }
      })
    ).toEqual({ scopeType: "MACHINE", scopeId: "machine-1" });
  });
});

describe("APM-104 active/legacy Gate listing", () => {
  it("does not advertise manual project instance creation for active project G9", () => {
    const run = buildGateCheckRun({
      projectId: "project-1",
      instanceId: "instance-1",
      definition: {
        code: "G9",
        name: "结项",
        projectStageId: "stage-8",
        definitionJson: { approval: { mode: "ALL", projectRoles: ["QUALITY"] } }
      },
      scope: { scope: "PROJECT", deliveryUnitId: null, moduleId: null },
      stage: { code: "S8", status: "AWAITING_GATE" },
      checkerBindings: [
        { code: "CLOSURE.ARCHIVE.G9", version: 2 },
        { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
      ],
      checkerFacts: {
        closureArchiveV2: { factsAvailable: false, projectId: "project-1" },
        closureRetrospective: { factsAvailable: false, projectId: "project-1" }
      },
      reason: "执行 V2 G9"
    });
    expect(run.results).toHaveLength(2);
    expect(run.overallStatus).toBe("HARD_FAILED");
  });

  it("does not advertise a malformed G9 policy as active or executable", () => {
    const policyFacts = buildClosurePolicyVersionFacts({
      projectId: "project-1",
      sourceTemplateSnapshotId: "snapshot-1",
      sourceGateDefinitionId: "g9-v2",
      checkerBindings: [
        { code: "CLOSURE.ARCHIVE.G9", version: 2 },
        { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
      ]
    });
    const listing = buildProjectGateListing({
      definitions: [
        {
          id: "g9-v1",
          projectId: "project-1",
          code: "G9",
          scope: "PROJECT",
          revision: 1,
          checkerBindingsJson: [{ code: "CLOSURE.ARCHIVE.G9", version: 1 }]
        },
        {
          id: "g9-v2",
          projectId: "project-1",
          code: "G9",
          scope: "PROJECT",
          revision: 2,
          checkerBindingsJson: [
            { code: "CLOSURE.ARCHIVE.G9", version: 2 },
            { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
          ]
        }
      ],
      policy: {
        id: "policy-1",
        projectId: "project-1",
        status: "ACTIVE",
        currentVersionId: "policy-version-1",
        currentVersion: {
          id: "policy-version-1",
          status: "ACTIVE",
          sourceGateDefinitionId: "g9-v2",
          archiveCheckerCode: "CLOSURE.ARCHIVE.G9",
          archiveCheckerVersion: 2,
          retrospectiveCheckerCode: "CLOSURE.RETROSPECTIVE.G9",
          retrospectiveCheckerVersion: 1,
          archiveSourceFormulaVersion: "V2",
          bindingChecksum: policyFacts.bindingChecksum,
          policyChecksum: "tampered",
          sourceTemplateSnapshotId: "snapshot-1",
          selfReferenceExclusionVersion: "CLOSURE.SELF_REFERENCE_EXCLUSION@1"
        }
      }
    });

    expect(listing.activeDefinitions).toEqual([]);
    expect(listing.legacyDefinitions).toEqual([
      expect.objectContaining({
        id: "g9-v1",
        executionState: "LEGACY_HISTORY",
        allowedActions: []
      }),
      expect.objectContaining({ id: "g9-v2", executionState: "LEGACY_HISTORY", allowedActions: [] })
    ]);
  });

  it("advertises only the exact V2 policy-bound G9 as executable while retaining V1 as history", () => {
    const policyFacts = buildClosurePolicyVersionFacts({
      projectId: "project-1",
      sourceTemplateSnapshotId: "snapshot-1",
      sourceGateDefinitionId: "g9-v2",
      checkerBindings: [
        { code: "CLOSURE.ARCHIVE.G9", version: 2 },
        { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
      ]
    });
    const listing = buildProjectGateListing({
      definitions: [
        {
          id: "g9-v1",
          projectId: "project-1",
          code: "G9",
          scope: "PROJECT",
          revision: 1,
          checkerBindingsJson: [{ code: "CLOSURE.ARCHIVE.G9", version: 1 }]
        },
        {
          id: "g9-v2",
          projectId: "project-1",
          code: "G9",
          scope: "PROJECT",
          revision: 2,
          checkerBindingsJson: [
            { code: "CLOSURE.ARCHIVE.G9", version: 2 },
            { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
          ]
        }
      ],
      policy: {
        id: "policy-1",
        projectId: "project-1",
        status: "ACTIVE",
        currentVersionId: "policy-version-1",
        currentVersion: {
          id: "policy-version-1",
          status: "ACTIVE",
          sourceGateDefinitionId: "g9-v2",
          archiveCheckerCode: "CLOSURE.ARCHIVE.G9",
          archiveCheckerVersion: 2,
          retrospectiveCheckerCode: "CLOSURE.RETROSPECTIVE.G9",
          retrospectiveCheckerVersion: 1,
          archiveSourceFormulaVersion: "V2",
          bindingChecksum: policyFacts.bindingChecksum,
          policyChecksum: policyFacts.policyChecksum,
          sourceTemplateSnapshotId: "snapshot-1",
          selfReferenceExclusionVersion: "CLOSURE.SELF_REFERENCE_EXCLUSION@1"
        }
      }
    });

    expect(listing.activeDefinitions).toEqual([
      expect.objectContaining({
        id: "g9-v2",
        executionState: "ACTIVE",
        allowedActions: ["RUN_CHECKS", "SUBMIT", "RESUBMIT", "APPROVE"]
      })
    ]);
    expect(listing.legacyDefinitions).toEqual([
      expect.objectContaining({ id: "g9-v1", executionState: "LEGACY_HISTORY", allowedActions: [] })
    ]);
  });
});

describe("APM-104 executable G9 authority", () => {
  const policyFacts = buildClosurePolicyVersionFacts({
    projectId: "project-1",
    sourceTemplateSnapshotId: "snapshot-1",
    sourceGateDefinitionId: "g9-v2",
    checkerBindings: [
      { code: "CLOSURE.ARCHIVE.G9", version: 2 },
      { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
    ]
  });
  const activePolicy = {
    id: "policy-1",
    projectId: "project-1",
    status: "ACTIVE",
    currentVersionId: "policy-version-1",
    currentVersion: {
      id: "policy-version-1",
      status: "ACTIVE",
      sourceGateDefinitionId: "g9-v2",
      archiveCheckerCode: "CLOSURE.ARCHIVE.G9",
      archiveCheckerVersion: 2,
      retrospectiveCheckerCode: "CLOSURE.RETROSPECTIVE.G9",
      retrospectiveCheckerVersion: 1,
      archiveSourceFormulaVersion: "V2",
      bindingChecksum: policyFacts.bindingChecksum,
      policyChecksum: policyFacts.policyChecksum,
      sourceTemplateSnapshotId: "snapshot-1",
      selfReferenceExclusionVersion: "CLOSURE.SELF_REFERENCE_EXCLUSION@1"
    }
  };

  function client(input: {
    definition?: Record<string, unknown> | null;
    policy?: Record<string, unknown> | null;
    instance?: Record<string, unknown> | null;
    queryRaw?: ReturnType<typeof vi.fn>;
  }) {
    return {
      $queryRaw: input.queryRaw ?? vi.fn().mockResolvedValue([]),
      projectGateDefinition: {
        findFirst: vi.fn().mockResolvedValue(
          input.definition ?? {
            id: "g9-v2",
            projectId: "project-1",
            code: "G9",
            checkerBindingsJson: [
              { code: "CLOSURE.ARCHIVE.G9", version: 2 },
              { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
            ]
          }
        )
      },
      projectClosurePolicy: {
        findUnique: vi
          .fn()
          .mockResolvedValue(Object.hasOwn(input, "policy") ? input.policy : activePolicy)
      },
      projectGateInstance: { findFirst: vi.fn().mockResolvedValue(input.instance ?? null) }
    };
  }

  it("returns the exact active V2 policy tuple only for the policy-bound G9 definition", async () => {
    await expect(
      assertExecutableGateDefinition(
        client({
          instance: {
            id: "instance-v2",
            closurePolicyVersionId: "policy-version-1",
            archiveSourceFormulaVersion: "V2",
            closurePolicyChecksum: policyFacts.policyChecksum
          }
        }) as never,
        { projectId: "project-1", definitionId: "g9-v2", instanceId: "instance-v2" }
      )
    ).resolves.toEqual({
      definitionId: "g9-v2",
      closurePolicyVersionId: "policy-version-1",
      closurePolicyChecksum: policyFacts.policyChecksum,
      archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2"
    });
  });

  it("locks the policy and its current version before reading the authoritative G9 tuple", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ id: "policy-1", currentVersionId: "policy-version-1" }])
      .mockResolvedValueOnce([{ id: "policy-version-1" }]);
    const executableClient = client({ queryRaw });

    await expect(
      assertExecutableGateDefinition(executableClient as never, {
        projectId: "project-1",
        definitionId: "g9-v2"
      })
    ).resolves.toMatchObject({ closurePolicyVersionId: "policy-version-1" });

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(String(queryRaw.mock.calls[0]?.[0])).toContain("project_closure_policies");
    expect(String(queryRaw.mock.calls[0]?.[0])).toContain("FOR UPDATE");
    expect(String(queryRaw.mock.calls[1]?.[0])).toContain("project_closure_policy_versions");
    expect(String(queryRaw.mock.calls[1]?.[0])).toContain("FOR UPDATE");
    expect(queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      executableClient.projectClosurePolicy.findUnique.mock.invocationCallOrder[0]!
    );
  });

  it("rejects a root Prisma client because G9 policy locks require an interactive transaction", async () => {
    const rootClient = { ...client({}), $transaction: vi.fn() };

    await expect(
      assertExecutableGateDefinition(rootClient as never, {
        projectId: "project-1",
        definitionId: "g9-v2"
      })
    ).rejects.toMatchObject({ code: "GATE_TRANSACTION_REQUIRED", status: 500 });

    expect(rootClient.$queryRaw).not.toHaveBeenCalled();
    expect(rootClient.projectClosurePolicy.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    ["legacy G9 has no policy", { policy: null }, "CLOSURE_POLICY_VERSION_REQUIRED"],
    [
      "old G9 revision is not policy authority",
      { definition: { id: "g9-v1", projectId: "project-1", code: "G9" } },
      "CLOSURE_POLICY_STALE"
    ],
    [
      "G9 instance tuple is stale",
      {
        instance: {
          id: "instance-v2",
          closurePolicyVersionId: "policy-version-1",
          archiveSourceFormulaVersion: "V2",
          closurePolicyChecksum: "different"
        }
      },
      "CLOSURE_POLICY_BINDING_MISMATCH"
    ]
  ])("rejects %s", async (_label, input, code) => {
    await expect(
      assertExecutableGateDefinition(client(input as never) as never, {
        projectId: "project-1",
        definitionId: "g9-v2",
        instanceId: "instance-v2"
      })
    ).rejects.toMatchObject({ code, status: 409 } satisfies Partial<GateServiceError>);
  });

  it("rejects a G9 definition whose checker bindings no longer equal the policy's frozen tuple", async () => {
    await expect(
      assertExecutableGateDefinition(
        client({
          definition: {
            id: "g9-v2",
            projectId: "project-1",
            code: "G9",
            checkerBindingsJson: [{ code: "CLOSURE.ARCHIVE.G9", version: 2 }]
          }
        }) as never,
        { projectId: "project-1", definitionId: "g9-v2" }
      )
    ).rejects.toMatchObject({ code: "CLOSURE_POLICY_BINDING_MISMATCH", status: 409 });
  });
});
