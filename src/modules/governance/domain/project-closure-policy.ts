import { payloadHash } from "./idempotency";

export const CLOSURE_POLICY_BINDINGS = [
  { code: "CLOSURE.ARCHIVE.G9", version: 2 },
  { code: "CLOSURE.RETROSPECTIVE.G9", version: 1 }
] as const;

export const CLOSURE_POLICY_ARCHIVE_FORMULA = "ARCHIVE.SOURCE@2" as const;
export const CLOSURE_POLICY_SELF_REFERENCE_EXCLUSION =
  "CLOSURE.SELF_REFERENCE_EXCLUSION@1" as const;

export class ClosurePolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "ClosurePolicyError";
  }
}

function required(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 191) {
    throw new ClosurePolicyError("CLOSURE_POLICY_INPUT_INVALID", `${field} 无效。`, 422);
  }
  return normalized;
}

function canonicalBindings(bindings: readonly { code: string; version: number }[]) {
  const actual = bindings
    .map((binding) => ({ code: binding.code, version: binding.version }))
    .sort((left, right) => left.code.localeCompare(right.code) || left.version - right.version);
  const expected = [...CLOSURE_POLICY_BINDINGS].sort((left, right) =>
    left.code.localeCompare(right.code)
  );
  if (
    actual.length !== expected.length ||
    actual.some(
      (binding, index) =>
        binding.code !== expected[index]?.code || binding.version !== expected[index]?.version
    )
  ) {
    throw new ClosurePolicyError(
      "CLOSURE_POLICY_BINDINGS_INVALID",
      "关项策略必须精确冻结归档 V2 和复盘 V1 检查器。"
    );
  }
  return actual;
}

export function buildClosurePolicyVersionFacts(input: {
  projectId: string;
  sourceTemplateSnapshotId: string;
  sourceGateDefinitionId: string;
  checkerBindings: readonly { code: string; version: number }[];
}) {
  const checkerBindings = canonicalBindings(input.checkerBindings);
  const binding = payloadHash({
    checkerBindings,
    archiveSourceFormulaVersion: CLOSURE_POLICY_ARCHIVE_FORMULA,
    selfReferenceExclusionVersion: CLOSURE_POLICY_SELF_REFERENCE_EXCLUSION
  });
  const facts = {
    projectId: required(input.projectId, "projectId"),
    sourceTemplateSnapshotId: required(input.sourceTemplateSnapshotId, "sourceTemplateSnapshotId"),
    sourceGateDefinitionId: required(input.sourceGateDefinitionId, "sourceGateDefinitionId"),
    archiveCheckerCode: CLOSURE_POLICY_BINDINGS[0].code,
    archiveCheckerVersion: CLOSURE_POLICY_BINDINGS[0].version,
    retrospectiveCheckerCode: CLOSURE_POLICY_BINDINGS[1].code,
    retrospectiveCheckerVersion: CLOSURE_POLICY_BINDINGS[1].version,
    archiveSourceFormulaVersion: CLOSURE_POLICY_ARCHIVE_FORMULA,
    selfReferenceExclusionVersion: CLOSURE_POLICY_SELF_REFERENCE_EXCLUSION,
    bindingChecksum: binding.hash
  };
  return { ...facts, policyChecksum: payloadHash(facts).hash };
}
