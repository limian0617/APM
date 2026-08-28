import {
  CLOSURE_POLICY_SELF_REFERENCE_EXCLUSION,
  buildClosurePolicyVersionFacts
} from "./project-closure-policy";

export type ClosureCheckerBinding = { code: string; version: number };

export type PersistedClosurePolicyBinding = {
  archiveCheckerCode: string;
  archiveCheckerVersion: number;
  retrospectiveCheckerCode: string;
  retrospectiveCheckerVersion: number;
  archiveSourceFormulaVersion: string;
  selfReferenceExclusionVersion: string;
  bindingChecksum: string;
  policyChecksum: string;
};

export function parseClosureCheckerBindings(value: unknown): ClosureCheckerBinding[] | null {
  if (!Array.isArray(value)) return null;
  const bindings = value.flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof (entry as Record<string, unknown>).code !== "string" ||
      !Number.isInteger((entry as Record<string, unknown>).version)
    ) {
      return [];
    }
    return [
      {
        code: (entry as Record<string, unknown>).code as string,
        version: (entry as Record<string, unknown>).version as number
      }
    ];
  });
  return bindings.length === value.length ? bindings : null;
}

function hasExactClosureBindings(bindings: ClosureCheckerBinding[] | null): boolean {
  if (!bindings) return false;
  try {
    buildClosurePolicyVersionFacts({
      projectId: "binding-check-project",
      sourceTemplateSnapshotId: "binding-check-template",
      sourceGateDefinitionId: "binding-check-definition",
      checkerBindings: bindings
    });
    return true;
  } catch {
    return false;
  }
}

export function evaluateClosurePolicyBinding(input: {
  projectId: string;
  sourceTemplateSnapshotId: string;
  sourceGateDefinitionId: string;
  sourceGateDefinitionBindings: ClosureCheckerBinding[] | null;
  snapshotBindings: ClosureCheckerBinding[] | null;
  persisted: PersistedClosurePolicyBinding | null;
}) {
  const sourceGateDefinitionBindingsValid = hasExactClosureBindings(
    input.sourceGateDefinitionBindings
  );
  const snapshotCheckerBindingsValid = hasExactClosureBindings(input.snapshotBindings);
  try {
    const snapshotFacts =
      input.persisted && input.snapshotBindings
        ? buildClosurePolicyVersionFacts({
            projectId: input.projectId,
            sourceTemplateSnapshotId: input.sourceTemplateSnapshotId,
            sourceGateDefinitionId: input.sourceGateDefinitionId,
            checkerBindings: input.snapshotBindings
          })
        : null;
    const sourceDefinitionFacts =
      input.persisted && input.sourceGateDefinitionBindings
        ? buildClosurePolicyVersionFacts({
            projectId: input.projectId,
            sourceTemplateSnapshotId: input.sourceTemplateSnapshotId,
            sourceGateDefinitionId: input.sourceGateDefinitionId,
            checkerBindings: input.sourceGateDefinitionBindings
          })
        : null;
    return {
      sourceGateDefinitionBindingsValid,
      snapshotCheckerBindingsValid,
      policyFactsValid: Boolean(
        snapshotFacts &&
        sourceDefinitionFacts &&
        input.persisted?.bindingChecksum === snapshotFacts.bindingChecksum &&
        input.persisted.policyChecksum === snapshotFacts.policyChecksum &&
        sourceDefinitionFacts.bindingChecksum === snapshotFacts.bindingChecksum &&
        sourceDefinitionFacts.policyChecksum === snapshotFacts.policyChecksum &&
        input.persisted.archiveCheckerCode === snapshotFacts.archiveCheckerCode &&
        input.persisted.archiveCheckerVersion === snapshotFacts.archiveCheckerVersion &&
        input.persisted.retrospectiveCheckerCode === snapshotFacts.retrospectiveCheckerCode &&
        input.persisted.retrospectiveCheckerVersion === snapshotFacts.retrospectiveCheckerVersion &&
        input.persisted.archiveSourceFormulaVersion === "V2" &&
        input.persisted.selfReferenceExclusionVersion === CLOSURE_POLICY_SELF_REFERENCE_EXCLUSION
      )
    };
  } catch {
    return {
      sourceGateDefinitionBindingsValid,
      snapshotCheckerBindingsValid,
      policyFactsValid: false
    };
  }
}

type ActiveClosurePolicy = {
  projectId: string;
  status: string;
  currentVersionId: string | null;
  currentVersion:
    | (PersistedClosurePolicyBinding & {
        id: string;
        status: string;
        sourceTemplateSnapshotId: string;
        sourceGateDefinitionId: string;
        sourceGateDefinition: {
          id: string;
          projectId?: string;
          code: string;
          scope: string;
          checkerBindingsJson: unknown;
        } | null;
        sourceTemplateSnapshot: { id: string; projectId?: string } | null;
      })
    | null;
};

export function resolveExactActiveClosurePolicy(
  policy: ActiveClosurePolicy | null,
  projectId: string
) {
  const version = policy?.currentVersion;
  if (
    !policy ||
    policy.projectId !== projectId ||
    policy.status !== "ACTIVE" ||
    !version ||
    policy.currentVersionId !== version.id ||
    version.status !== "ACTIVE" ||
    !version.sourceTemplateSnapshot ||
    version.sourceTemplateSnapshot.id !== version.sourceTemplateSnapshotId ||
    (version.sourceTemplateSnapshot.projectId !== undefined &&
      version.sourceTemplateSnapshot.projectId !== projectId) ||
    !version.sourceGateDefinition ||
    version.sourceGateDefinition.id !== version.sourceGateDefinitionId ||
    (version.sourceGateDefinition.projectId !== undefined &&
      version.sourceGateDefinition.projectId !== projectId) ||
    version.sourceGateDefinition.code !== "G9" ||
    version.sourceGateDefinition.scope !== "PROJECT"
  ) {
    return null;
  }
  const bindings = parseClosureCheckerBindings(version.sourceGateDefinition.checkerBindingsJson);
  const evaluation = evaluateClosurePolicyBinding({
    projectId,
    sourceTemplateSnapshotId: version.sourceTemplateSnapshotId,
    sourceGateDefinitionId: version.sourceGateDefinitionId,
    sourceGateDefinitionBindings: bindings,
    snapshotBindings: bindings,
    persisted: version
  });
  return evaluation.sourceGateDefinitionBindingsValid &&
    evaluation.snapshotCheckerBindingsValid &&
    evaluation.policyFactsValid
    ? version
    : null;
}
