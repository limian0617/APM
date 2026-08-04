import { describe, expect, it } from "vitest";

import { buildProjectGateMaterialization } from "./project-gate-definition-service";

describe("APM-031 project Gate materialization", () => {
  it("freezes legacy Gate bindings and creates only project-scoped instances", () => {
    expect(
      buildProjectGateMaterialization({
        components: [
          {
            id: "gate-component",
            componentType: "GATE",
            contentJson: {
              gates: [
                {
                  code: "G1",
                  name: "基线批准",
                  stageCode: "S0",
                  requiredCheckerCodes: ["DOCUMENTS.COMPLETE"]
                },
                {
                  code: "G2",
                  name: "模块确认",
                  stageCode: "S1",
                  scope: "MODULE",
                  checkers: [{ code: "STAGE.AWAITING_GATE", version: 1 }]
                }
              ]
            }
          }
        ],
        stages: [
          { id: "stage-s0", code: "S0" },
          { id: "stage-s1", code: "S1" }
        ]
      })
    ).toEqual([
      {
        sourceSnapshotComponentId: "gate-component",
        projectStageId: "stage-s0",
        code: "G1",
        name: "基线批准",
        scope: "PROJECT",
        definitionJson: {
          code: "G1",
          name: "基线批准",
          stageCode: "S0",
          requiredCheckerCodes: ["DOCUMENTS.COMPLETE"]
        },
        checkerBindings: [{ code: "DOCUMENTS.COMPLETE", version: 1 }],
        createProjectInstance: true
      },
      {
        sourceSnapshotComponentId: "gate-component",
        projectStageId: "stage-s1",
        code: "G2",
        name: "模块确认",
        scope: "MODULE",
        definitionJson: {
          code: "G2",
          name: "模块确认",
          stageCode: "S1",
          scope: "MODULE",
          checkers: [{ code: "STAGE.AWAITING_GATE", version: 1 }]
        },
        checkerBindings: [{ code: "STAGE.AWAITING_GATE", version: 1 }],
        createProjectInstance: false
      }
    ]);
  });
});
