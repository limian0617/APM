import { describe, expect, it } from "vitest";

import { payloadHash } from "@/modules/governance/domain/idempotency";

import {
  buildPlanningChangeRevision,
  canonicalizePlanningChangeDelta,
  DEFAULT_PLANNING_CHANGE_CLASSIFICATION_POLICY,
  evaluatePlanningChangeDecision,
  PlanningChangeError,
  requiredBaselineVersion,
  resolvePlanningChangeApprovers,
  type PlanningChangeRevisionInput
} from "./planning-change";

function expectError(error: unknown, code: string, status: number) {
  expect(error).toBeInstanceOf(PlanningChangeError);
  const planningError = error as PlanningChangeError;
  expect(planningError.code).toBe(code);
  expect(planningError.status).toBe(status);
}

function revisionInput(
  overrides: Partial<PlanningChangeRevisionInput> = {}
): PlanningChangeRevisionInput {
  return {
    revision: 1,
    classification: "FORMAL",
    reason: "客户确认合同交期顺延两周",
    planningInputVersion: 3,
    resultingPlanningInputVersion: 4,
    delta: { deliveryDate: { from: "2026-10-01", to: "2026-10-15" } },
    ...overrides
  };
}

describe("APM-024 planning change classification policy", () => {
  it("returns the declared classification unchanged", () => {
    for (const classification of ["FORMAL", "FORECAST_ONLY"] as const) {
      expect(
        DEFAULT_PLANNING_CHANGE_CLASSIFICATION_POLICY.classify({
          declaredClassification: classification,
          affectsContractScope: true,
          affectsContractDelivery: true
        })
      ).toBe(classification);
    }
  });

  it("never promotes an undeclared change to FORMAL", () => {
    const policy = DEFAULT_PLANNING_CHANGE_CLASSIFICATION_POLICY;
    expect(
      policy.classify({
        declaredClassification: null,
        affectsContractScope: true,
        affectsContractDelivery: true
      })
    ).toBe("NOT_DECLARED");
  });

  it("declares a stable code and version so callers can pin the policy", () => {
    expect(DEFAULT_PLANNING_CHANGE_CLASSIFICATION_POLICY.code).toBe(
      "PLANNING.CHANGE.CLASSIFICATION@1"
    );
    expect(DEFAULT_PLANNING_CHANGE_CLASSIFICATION_POLICY.version).toBe(1);
  });
});

describe("APM-024 planning change approver snapshot", () => {
  const members = [
    { membershipId: "m-2", userId: "user-b", projectRole: "PROJECT_MANAGER" },
    { membershipId: "m-1", userId: "user-a", projectRole: "PROJECT_MANAGER" },
    { membershipId: "m-3", userId: "user-a", projectRole: "ENGINEERING_LEAD" },
    { membershipId: "m-4", userId: "user-c", projectRole: "MEMBER" }
  ];

  it("freezes members matching the configured roles, grouped by user", () => {
    const snapshots = resolvePlanningChangeApprovers({
      approverProjectRoles: ["PROJECT_MANAGER", "ENGINEERING_LEAD"],
      activeMembers: members
    });

    expect(snapshots).toEqual([
      {
        userId: "user-a",
        membershipIds: ["m-1", "m-3"],
        projectRoles: ["ENGINEERING_LEAD", "PROJECT_MANAGER"]
      },
      { userId: "user-b", membershipIds: ["m-2"], projectRoles: ["PROJECT_MANAGER"] }
    ]);
  });

  it("is stable across member order and role order", () => {
    const forward = resolvePlanningChangeApprovers({
      approverProjectRoles: ["PROJECT_MANAGER", "ENGINEERING_LEAD"],
      activeMembers: members
    });
    const reversed = resolvePlanningChangeApprovers({
      approverProjectRoles: ["ENGINEERING_LEAD", "PROJECT_MANAGER"],
      activeMembers: [...members].reverse()
    });

    expect(reversed).toEqual(forward);
  });

  it("rejects an empty or blank role configuration", () => {
    for (const approverProjectRoles of [[], ["   "]]) {
      try {
        resolvePlanningChangeApprovers({ approverProjectRoles, activeMembers: members });
        throw new Error("expected resolvePlanningChangeApprovers to throw");
      } catch (error) {
        expectError(error, "PLANNING_CHANGE_APPROVER_CONFIGURATION_INVALID", 422);
      }
    }
  });

  it("rejects a configuration whose roles resolve to no active member", () => {
    try {
      resolvePlanningChangeApprovers({
        approverProjectRoles: ["QUALITY_LEAD"],
        activeMembers: members
      });
      throw new Error("expected resolvePlanningChangeApprovers to throw");
    } catch (error) {
      expectError(error, "PLANNING_CHANGE_APPROVER_EMPTY", 422);
    }
  });

  it("returns no approver when there are no members at all", () => {
    try {
      resolvePlanningChangeApprovers({
        approverProjectRoles: ["PROJECT_MANAGER"],
        activeMembers: []
      });
      throw new Error("expected resolvePlanningChangeApprovers to throw");
    } catch (error) {
      expectError(error, "PLANNING_CHANGE_APPROVER_EMPTY", 422);
    }
  });
});

describe("APM-024 planning change decision evaluation", () => {
  const approverUserIds = ["user-a", "user-b"];

  it("stays SUBMITTED while an ALL approval is incomplete", () => {
    expect(
      evaluatePlanningChangeDecision({
        approvalMode: "ALL",
        approverUserIds,
        decisions: [{ userId: "user-a", decision: "APPROVED" }]
      })
    ).toBe("SUBMITTED");
  });

  it("approves an ALL approval only when every frozen approver approves", () => {
    expect(
      evaluatePlanningChangeDecision({
        approvalMode: "ALL",
        approverUserIds,
        decisions: [
          { userId: "user-a", decision: "APPROVED" },
          { userId: "user-b", decision: "APPROVED" }
        ]
      })
    ).toBe("APPROVED");
  });

  it("approves an ANY approval on the first approval", () => {
    expect(
      evaluatePlanningChangeDecision({
        approvalMode: "ANY",
        approverUserIds,
        decisions: [{ userId: "user-b", decision: "APPROVED" }]
      })
    ).toBe("APPROVED");
  });

  it("rejects immediately on a single rejection regardless of mode", () => {
    for (const approvalMode of ["ALL", "ANY"] as const) {
      expect(
        evaluatePlanningChangeDecision({
          approvalMode,
          approverUserIds,
          decisions: [
            { userId: "user-a", decision: "APPROVED" },
            { userId: "user-b", decision: "REJECTED" }
          ]
        })
      ).toBe("REJECTED");
    }
  });

  it("keeps a rejected decision terminal even if everyone else approves", () => {
    expect(
      evaluatePlanningChangeDecision({
        approvalMode: "ANY",
        approverUserIds,
        decisions: [
          { userId: "user-a", decision: "REJECTED" },
          { userId: "user-b", decision: "APPROVED" }
        ]
      })
    ).toBe("REJECTED");
  });

  it("does not treat an approval from a non-frozen user as an approval", () => {
    expect(
      evaluatePlanningChangeDecision({
        approvalMode: "ANY",
        approverUserIds: [],
        decisions: [{ userId: "user-outsider", decision: "APPROVED" }]
      })
    ).toBe("APPROVED");
    expect(
      evaluatePlanningChangeDecision({
        approvalMode: "ALL",
        approverUserIds,
        decisions: [{ userId: "user-outsider", decision: "APPROVED" }]
      })
    ).toBe("SUBMITTED");
  });
});

describe("APM-024 required baseline version", () => {
  it("never requires a baseline for a forecast-only change", () => {
    expect(requiredBaselineVersion("FORECAST_ONLY")).toBeNull();
  });

  it("requires baseline V2 for a formal change", () => {
    expect(requiredBaselineVersion("FORMAL")).toBe(2);
  });
});

describe("APM-024 planning change revision", () => {
  it("canonicalizes delta keys recursively without reordering arrays", () => {
    const canonical = canonicalizePlanningChangeDelta({
      zeta: 1,
      alpha: { gamma: 3, beta: [{ delta: 4, charlie: 5 }] },
      list: ["b", "a"]
    });

    expect(canonical).toEqual({
      alpha: { beta: [{ charlie: 5, delta: 4 }], gamma: 3 },
      list: ["b", "a"],
      zeta: 1
    });
    expect(Object.keys(canonical as Record<string, unknown>)).toEqual(["alpha", "list", "zeta"]);
  });

  it("produces the same checksum for key-order-equivalent deltas", () => {
    const left = buildPlanningChangeRevision(
      revisionInput({ delta: { scope: { added: ["unit-b", "unit-a"] }, delivery: "2026-10-15" } })
    );
    const right = buildPlanningChangeRevision(
      revisionInput({ delta: { delivery: "2026-10-15", scope: { added: ["unit-b", "unit-a"] } } })
    );

    expect(left.checksum).toBe(right.checksum);
    expect(right.delta).toEqual(left.delta);
  });

  it("changes the checksum when the revision number changes", () => {
    const first = buildPlanningChangeRevision(revisionInput({ revision: 1 }));
    const second = buildPlanningChangeRevision(revisionInput({ revision: 2 }));

    expect(second.checksum).not.toBe(first.checksum);
  });

  it("changes the checksum when a version bound changes", () => {
    const first = buildPlanningChangeRevision(revisionInput());
    const second = buildPlanningChangeRevision(revisionInput({ resultingPlanningInputVersion: 5 }));

    expect(second.checksum).not.toBe(first.checksum);
  });

  it("matches the checksum over the canonicalized payload", () => {
    const snapshot = buildPlanningChangeRevision(revisionInput());

    expect(snapshot.checksum).toBe(
      payloadHash({
        revision: snapshot.revision,
        classification: snapshot.classification,
        planningInputVersion: snapshot.planningInputVersion,
        resultingPlanningInputVersion: snapshot.resultingPlanningInputVersion,
        delta: snapshot.delta
      }).hash
    );
  });

  it("trims the reason and defaults nothing else", () => {
    const snapshot = buildPlanningChangeRevision(revisionInput({ reason: "  交期顺延  " }));

    expect(snapshot.reason).toBe("交期顺延");
    expect(snapshot.revision).toBe(1);
    expect(snapshot.classification).toBe("FORMAL");
  });

  it("rejects a non-positive or non-integer revision number", () => {
    for (const revision of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      try {
        buildPlanningChangeRevision(revisionInput({ revision }));
        throw new Error("expected buildPlanningChangeRevision to throw");
      } catch (error) {
        expectError(error, "PLANNING_CHANGE_REVISION_INVALID", 422);
      }
    }
  });

  it("rejects a blank or overlong reason", () => {
    for (const reason of ["   ", "x".repeat(1025)]) {
      try {
        buildPlanningChangeRevision(revisionInput({ reason }));
        throw new Error("expected buildPlanningChangeRevision to throw");
      } catch (error) {
        expectError(error, "REASON_REQUIRED", 422);
      }
    }
  });

  it("rejects a non-positive planning input version", () => {
    for (const planningInputVersion of [0, -1, 1.5]) {
      try {
        buildPlanningChangeRevision(revisionInput({ planningInputVersion }));
        throw new Error("expected buildPlanningChangeRevision to throw");
      } catch (error) {
        expectError(error, "PLANNING_CHANGE_INPUT_VERSION_INVALID", 422);
      }
    }
  });

  it("rejects a resulting planning input version below the starting one", () => {
    try {
      buildPlanningChangeRevision(revisionInput({ resultingPlanningInputVersion: 2 }));
      throw new Error("expected buildPlanningChangeRevision to throw");
    } catch (error) {
      expectError(error, "PLANNING_CHANGE_INPUT_VERSION_INVALID", 422);
    }
  });

  it("allows the resulting version to equal the starting version", () => {
    const snapshot = buildPlanningChangeRevision(
      revisionInput({ resultingPlanningInputVersion: 3 })
    );

    expect(snapshot.resultingPlanningInputVersion).toBe(3);
  });

  it("rejects a delta that is not a JSON object", () => {
    for (const delta of [null, [1, 2], "text", 7]) {
      try {
        buildPlanningChangeRevision(revisionInput({ delta: delta as never }));
        throw new Error("expected buildPlanningChangeRevision to throw");
      } catch (error) {
        expectError(error, "PLANNING_CHANGE_DELTA_INVALID", 422);
      }
    }
  });

  it("rejects an empty delta object the same way the database does not", () => {
    const snapshot = buildPlanningChangeRevision(revisionInput({ delta: {} }));

    expect(snapshot.delta).toEqual({});
  });
});
