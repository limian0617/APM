import { describe, expect, it, vi } from "vitest";

import {
  GateServiceError,
  assertExecutableGateDefinition,
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
  }) {
    return {
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
