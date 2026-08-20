import { describe, expect, it } from "vitest";

import {
  assertRetrospectiveInputArchive,
  buildRetrospectiveInputSnapshot,
  readRetrospectiveInput
} from "./retrospective-input-reader";

describe("RETROSPECTIVE.INPUT@1", () => {
  it("normalizes arrays deterministically and excludes closure G9 facts", () => {
    const actual = buildRetrospectiveInputSnapshot({
      project: {
        id: "p",
        code: "P",
        name: "项目",
        type: "CUSTOMER_DELIVERY",
        status: "ACTIVE",
        mainControlStageCode: "S2"
      },
      deliveryUnits: [
        { id: "du-2", code: "B", type: "MACHINE", status: "ACTIVE", version: 1 },
        { id: "du-1", code: "A", type: "MACHINE", status: "ACTIVE", version: 2 }
      ],
      projectStages: [],
      issues: [],
      acceptance: [],
      residuals: [],
      nonClosureGates: [
        {
          code: "G9",
          revision: 2,
          latestSubmissionId: "g9",
          status: "APPROVED",
          resultChecksum: "c".repeat(64)
        },
        {
          code: "G8",
          revision: 1,
          latestSubmissionId: "g8",
          status: "APPROVED",
          resultChecksum: "d".repeat(64)
        }
      ]
    });

    expect(actual.snapshot.formulaVersion).toBe("RETROSPECTIVE.INPUT@1");
    expect(actual.snapshot.deliveryUnits.map((unit) => unit.id)).toEqual(["du-1", "du-2"]);
    expect(actual.snapshot.nonClosureGates.map((gate) => gate.code)).toEqual(["G8"]);
    expect(actual.watermark).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects legacy or not-applicable archive A inputs", () => {
    expect(() =>
      assertRetrospectiveInputArchive({
        archiveSourceFormulaVersion: "ARCHIVE.SOURCE@1",
        retrospectiveInputApplicability: "NOT_APPLICABLE"
      })
    ).toThrowError(expect.objectContaining({ code: "RETROSPECTIVE_INPUT_ARCHIVE_NOT_APPLICABLE" }));
    expect(() =>
      assertRetrospectiveInputArchive({
        archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
        retrospectiveInputApplicability: "NOT_APPLICABLE"
      })
    ).toThrowError(expect.objectContaining({ code: "RETROSPECTIVE_INPUT_ARCHIVE_NOT_APPLICABLE" }));
  });

  it("freezes only the contracted fields instead of leaking mutable query rows", async () => {
    const actual = await readRetrospectiveInput({
      projectId: "p",
      client: {
        project: {
          findUnique: async () => ({
            id: "p",
            code: "P",
            name: "项目",
            projectType: "CUSTOMER_DELIVERY",
            status: "ACTIVE",
            mainControlStageCode: "S2",
            updatedAt: new Date("2026-08-13T00:00:00Z")
          })
        },
        deliveryUnit: {
          findMany: async () => [
            {
              id: "du-1",
              code: "DU-1",
              unitType: "MACHINE",
              status: "ACTIVE",
              version: 2,
              updatedAt: new Date("2026-08-13T00:00:00Z")
            }
          ]
        },
        projectStage: {
          findMany: async () => [
            { id: "stage-1", code: "S1", status: "COMPLETED", version: 3, name: "概念" }
          ]
        },
        issue: {
          findMany: async () => [
            {
              id: "issue-1",
              category: "FUNCTION",
              severity: "HIGH",
              status: "CLOSED",
              version: 4,
              title: "不得进入快照",
              history: [
                {
                  id: "history-1",
                  sequence: 4,
                  snapshotJson: { status: "CLOSED", verificationEvidence: "证据" },
                  createdAt: new Date("2026-08-13T00:00:00Z")
                }
              ]
            }
          ]
        },
        acceptanceBatch: {
          findMany: async () => [
            {
              id: "batch-1",
              acceptanceType: "SAT",
              status: "LOCKED",
              version: 5,
              templateVersionId: "template-v1",
              results: []
            }
          ]
        },
        projectGateDefinition: {
          findMany: async () => [
            {
              code: "G8",
              revision: 1,
              instances: [
                {
                  submissions: [
                    {
                      id: "submission-1",
                      sequence: 2,
                      status: "APPROVED",
                      gateCheckSnapshot: { resultChecksum: "c".repeat(64) }
                    }
                  ]
                }
              ]
            }
          ]
        },
        residualItem: {
          findMany: async () => [{ id: "residual-1", status: "CLOSED", version: 2, title: "隐藏" }]
        }
      }
    });

    expect(actual.snapshot).toMatchObject({
      deliveryUnits: [{ id: "du-1", code: "DU-1", type: "MACHINE", status: "ACTIVE", version: 2 }],
      projectStages: [{ id: "stage-1", code: "S1", status: "COMPLETED", version: 3 }],
      issues: [
        {
          id: "issue-1",
          category: "FUNCTION",
          severity: "HIGH",
          status: "CLOSED",
          version: 4,
          latestHistory: {
            id: "history-1",
            sequence: 4,
            snapshotChecksum: expect.stringMatching(/^[0-9a-f]{64}$/u)
          }
        }
      ],
      acceptance: [
        {
          type: "SAT",
          batchId: "batch-1",
          status: "LOCKED",
          version: 5,
          summaryChecksum: expect.stringMatching(/^[0-9a-f]{64}$/u)
        }
      ],
      nonClosureGates: [
        {
          code: "G8",
          revision: 1,
          latestSubmissionId: "submission-1",
          status: "APPROVED",
          resultChecksum: "c".repeat(64)
        }
      ],
      residuals: [{ id: "residual-1", status: "CLOSED", version: 2 }]
    });
    expect(JSON.stringify(actual.snapshot)).not.toContain("不得进入快照");
    expect(JSON.stringify(actual.snapshot)).not.toContain("updatedAt");
  });
});
