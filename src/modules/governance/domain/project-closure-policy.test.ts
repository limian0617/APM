import { describe, expect, it } from "vitest";

import {
  CLOSURE_POLICY_BINDINGS,
  ClosurePolicyError,
  buildClosurePolicyVersionFacts
} from "./project-closure-policy";

describe("project closure policy", () => {
  it("freezes the exact V2 checker, archive formula and exclusion facts deterministically", () => {
    const input = {
      projectId: "project-1",
      sourceTemplateSnapshotId: "snapshot-1",
      sourceGateDefinitionId: "g9-definition-v2",
      checkerBindings: [...CLOSURE_POLICY_BINDINGS]
    };
    const first = buildClosurePolicyVersionFacts(input);
    const second = buildClosurePolicyVersionFacts({
      ...input,
      checkerBindings: [...input.checkerBindings].reverse()
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      archiveCheckerCode: "CLOSURE.ARCHIVE.G9",
      archiveCheckerVersion: 2,
      retrospectiveCheckerCode: "CLOSURE.RETROSPECTIVE.G9",
      retrospectiveCheckerVersion: 1,
      archiveSourceFormulaVersion: "ARCHIVE.SOURCE@2",
      selfReferenceExclusionVersion: "CLOSURE.SELF_REFERENCE_EXCLUSION@1",
      bindingChecksum: expect.stringMatching(/^[0-9a-f]{64}$/u),
      policyChecksum: expect.stringMatching(/^[0-9a-f]{64}$/u)
    });
  });

  it("rejects legacy, missing, duplicate and extra checker bindings", () => {
    for (const checkerBindings of [
      [{ code: "CLOSURE.ARCHIVE.G9", version: 1 }],
      [{ code: "CLOSURE.ARCHIVE.G9", version: 2 }],
      [
        { code: "CLOSURE.ARCHIVE.G9", version: 2 },
        { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 },
        { code: "OTHER", version: 1 }
      ]
    ]) {
      expect(() =>
        buildClosurePolicyVersionFacts({
          projectId: "project-1",
          sourceTemplateSnapshotId: "snapshot-1",
          sourceGateDefinitionId: "g9-definition-v2",
          checkerBindings
        })
      ).toThrowError(
        expect.objectContaining<Partial<ClosurePolicyError>>({
          code: "CLOSURE_POLICY_BINDINGS_INVALID"
        })
      );
    }
  });
});
