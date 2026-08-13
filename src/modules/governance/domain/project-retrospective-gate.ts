import type { GateScope } from "@/modules/configuration/domain/template-policy";

import type { JsonValue } from "./idempotency";
import type { GateChecker } from "./gate-checker-registry";

export type ProjectRetrospectiveGateFacts = {
  factsAvailable: boolean;
  projectId: string;
  scope: GateScope;
  currentVersionId: string | null;
  latestApprovedVersionId: string | null;
  retrospective: {
    id: string | null;
    status: string | null;
    contentChecksum: string | null;
    retrospectiveInputArchiveVersionId: string | null;
    retrospectiveInputManifestChecksum: string | null;
    retrospectiveInputSourceWatermark: string | null;
    retrospectiveInputWatermarkVersion: string | null;
    retrospectiveInputWatermark: string | null;
    independentReviewer: boolean;
    requiredContributionsComplete: boolean;
  } | null;
  archiveA: {
    id: string | null;
    status: string | null;
    archiveSourceFormulaVersion: string | null;
    retrospectiveInputApplicability: string | null;
    retrospectiveInputWatermarkVersion: string | null;
    retrospectiveInputWatermark: string | null;
    manifestChecksum: string | null;
    sourceWatermark: string | null;
  } | null;
  archiveB: {
    id: string | null;
    status: string | null;
    archiveSourceFormulaVersion: string | null;
    retrospectiveInputApplicability: string | null;
    retrospectiveInputWatermarkVersion: string | null;
    retrospectiveInputWatermark: string | null;
    includesRetrospectiveVersion: boolean;
  } | null;
};

export type ProjectRetrospectiveGateResult = {
  status: "PASSED" | "HARD_FAILED";
  code: string;
  message: string;
  evidence: JsonValue;
};

function evidence(facts: ProjectRetrospectiveGateFacts) {
  return {
    projectId: facts.projectId,
    scope: facts.scope,
    retrospectiveVersionId: facts.retrospective?.id ?? null,
    retrospectiveStatus: facts.retrospective?.status ?? null,
    retrospectiveContentChecksum: facts.retrospective?.contentChecksum ?? null,
    currentVersionId: facts.currentVersionId,
    latestApprovedVersionId: facts.latestApprovedVersionId,
    retrospectiveInputArchiveVersionId:
      facts.retrospective?.retrospectiveInputArchiveVersionId ?? null,
    archiveAId: facts.archiveA?.id ?? null,
    archiveBId: facts.archiveB?.id ?? null,
    archiveAInputWatermark: facts.archiveA?.retrospectiveInputWatermark ?? null,
    archiveBInputWatermark: facts.archiveB?.retrospectiveInputWatermark ?? null,
    archiveBIncludesRetrospectiveVersion: facts.archiveB?.includesRetrospectiveVersion ?? false
  } as JsonValue;
}

function failed(
  code: string,
  message: string,
  facts: ProjectRetrospectiveGateFacts
): ProjectRetrospectiveGateResult {
  return { status: "HARD_FAILED", code, message, evidence: evidence(facts) };
}

function isApplicableV2Archive(
  archive: ProjectRetrospectiveGateFacts["archiveA"] | ProjectRetrospectiveGateFacts["archiveB"]
) {
  return Boolean(
    archive &&
    archive.id &&
    archive.status === "READY" &&
    archive.archiveSourceFormulaVersion === "ARCHIVE.SOURCE@2" &&
    archive.retrospectiveInputApplicability === "APPLICABLE" &&
    archive.retrospectiveInputWatermarkVersion === "RETROSPECTIVE.INPUT@1" &&
    archive.retrospectiveInputWatermark
  );
}

export function evaluateProjectRetrospectiveGate(
  facts: ProjectRetrospectiveGateFacts
): ProjectRetrospectiveGateResult {
  if (facts.scope !== "PROJECT") {
    return failed("CLOSURE_RETROSPECTIVE_SCOPE_INVALID", "项目复盘 G9 仅支持项目范围。", facts);
  }
  if (!facts.factsAvailable) {
    return failed("CLOSURE_RETROSPECTIVE_FACTS_UNAVAILABLE", "项目复盘事实不可用。", facts);
  }
  const retrospective = facts.retrospective;
  if (
    !retrospective?.id ||
    retrospective.status !== "APPROVED" ||
    !retrospective.contentChecksum ||
    facts.currentVersionId !== retrospective.id ||
    facts.latestApprovedVersionId !== retrospective.id
  ) {
    return failed("CLOSURE_RETROSPECTIVE_NOT_CURRENT", "项目复盘不是当前批准版本。", facts);
  }
  if (!retrospective.independentReviewer || !retrospective.requiredContributionsComplete) {
    return failed("CLOSURE_RETROSPECTIVE_REVIEW_INVALID", "项目复盘审核或必填贡献不完整。", facts);
  }
  if (!isApplicableV2Archive(facts.archiveA) || !isApplicableV2Archive(facts.archiveB)) {
    return failed(
      "CLOSURE_RETROSPECTIVE_ARCHIVE_INVALID",
      "复盘归档 A/B 未使用适用 V2 公式。",
      facts
    );
  }
  if (
    retrospective.retrospectiveInputArchiveVersionId !== facts.archiveA?.id ||
    retrospective.retrospectiveInputManifestChecksum !== facts.archiveA?.manifestChecksum ||
    retrospective.retrospectiveInputSourceWatermark !== facts.archiveA?.sourceWatermark ||
    retrospective.retrospectiveInputWatermarkVersion !==
      facts.archiveA?.retrospectiveInputWatermarkVersion ||
    retrospective.retrospectiveInputWatermark !== facts.archiveA?.retrospectiveInputWatermark ||
    facts.archiveA?.retrospectiveInputWatermark !== facts.archiveB?.retrospectiveInputWatermark
  ) {
    return failed("CLOSURE_RETROSPECTIVE_INPUT_STALE", "项目复盘输入水位已变化。", facts);
  }
  if (!facts.archiveB?.includesRetrospectiveVersion) {
    return failed("CLOSURE_RETROSPECTIVE_NOT_FROZEN", "最终归档未冻结批准复盘。", facts);
  }
  return {
    status: "PASSED",
    code: "CLOSURE_RETROSPECTIVE_READY",
    message: "当前批准的项目复盘已冻结于最终归档。",
    evidence: evidence(facts)
  };
}

function asFacts(value: unknown, scope: GateScope): ProjectRetrospectiveGateFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const facts = value as ProjectRetrospectiveGateFacts;
  if (typeof facts.factsAvailable !== "boolean" || typeof facts.projectId !== "string") return null;
  return { ...facts, scope };
}

export const projectRetrospectiveGateChecker: GateChecker = {
  code: "CLOSURE.RETROSPECTIVE.G9",
  version: 1,
  supportedScopes: ["PROJECT"] as const,
  evaluate: (input) => {
    const facts = asFacts(input.facts?.closureRetrospective, input.scope);
    if (facts) return evaluateProjectRetrospectiveGate(facts);
    return evaluateProjectRetrospectiveGate({
      factsAvailable: false,
      projectId: input.projectId,
      scope: input.scope,
      currentVersionId: null,
      latestApprovedVersionId: null,
      retrospective: null,
      archiveA: null,
      archiveB: null
    });
  }
};
