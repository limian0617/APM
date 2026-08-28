import type { GateScope } from "@/modules/configuration/domain/template-policy";

import type { JsonValue } from "./idempotency";
import type { GateChecker } from "./gate-checker-registry";

export type ProjectArchiveGateV2Facts = {
  factsAvailable: boolean;
  projectId: string;
  scope: GateScope;
  archiveA: {
    id: string | null;
    status: string | null;
    archiveSourceFormulaVersion: string | null;
    retrospectiveInputApplicability: string | null;
    retrospectiveInputWatermarkVersion: string | null;
    retrospectiveInputWatermark: string | null;
  } | null;
  archiveB: {
    id: string | null;
    status: string | null;
    archiveSourceFormulaVersion: string | null;
    retrospectiveInputApplicability: string | null;
    retrospectiveInputWatermarkVersion: string | null;
    retrospectiveInputWatermark: string | null;
    manifestChecksum: string | null;
    sourceWatermark: string | null;
    latestIntegrityCheck: { id: string | null; status: string | null } | null;
    sourceFactsCurrent: boolean;
  } | null;
  approvedRetrospective: {
    id: string | null;
    status: string | null;
    contentChecksum: string | null;
    retrospectiveInputArchiveVersionId: string | null;
  } | null;
  currentRetrospectiveVersionId: string | null;
  latestApprovedRetrospectiveVersionId: string | null;
  archiveBIncludesRetrospectiveVersion: boolean;
  openResidualItemIds: readonly string[];
};

export type ProjectArchiveGateV2Result = {
  status: "PASSED" | "HARD_FAILED";
  code: string;
  message: string;
  evidence: JsonValue;
};

function evidence(facts: ProjectArchiveGateV2Facts) {
  return {
    projectId: facts.projectId,
    scope: facts.scope,
    archiveAId: facts.archiveA?.id ?? null,
    archiveBId: facts.archiveB?.id ?? null,
    archiveSourceFormulaVersion: facts.archiveB?.archiveSourceFormulaVersion ?? null,
    archiveAInputWatermark: facts.archiveA?.retrospectiveInputWatermark ?? null,
    archiveBInputWatermark: facts.archiveB?.retrospectiveInputWatermark ?? null,
    manifestChecksum: facts.archiveB?.manifestChecksum ?? null,
    sourceWatermark: facts.archiveB?.sourceWatermark ?? null,
    integrityCheckId: facts.archiveB?.latestIntegrityCheck?.id ?? null,
    integrityStatus: facts.archiveB?.latestIntegrityCheck?.status ?? null,
    sourceFactsCurrent: facts.archiveB?.sourceFactsCurrent ?? false,
    retrospectiveVersionId: facts.approvedRetrospective?.id ?? null,
    currentRetrospectiveVersionId: facts.currentRetrospectiveVersionId,
    latestApprovedRetrospectiveVersionId: facts.latestApprovedRetrospectiveVersionId,
    archiveBIncludesRetrospectiveVersion: facts.archiveBIncludesRetrospectiveVersion,
    openResidualItemIds: [...facts.openResidualItemIds]
  } as JsonValue;
}

function failed(
  code: string,
  message: string,
  facts: ProjectArchiveGateV2Facts
): ProjectArchiveGateV2Result {
  return { status: "HARD_FAILED", code, message, evidence: evidence(facts) };
}

function validInputWatermark(archive: ProjectArchiveGateV2Facts["archiveA"]): boolean {
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

export function evaluateProjectArchiveGateV2(
  facts: ProjectArchiveGateV2Facts
): ProjectArchiveGateV2Result {
  if (facts.scope !== "PROJECT") {
    return failed("CLOSURE_ARCHIVE_V2_SCOPE_INVALID", "结项归档 V2 仅支持项目范围。", facts);
  }
  if (!facts.factsAvailable) {
    return failed("CLOSURE_ARCHIVE_V2_FACTS_UNAVAILABLE", "结项归档 V2 事实不可用。", facts);
  }
  if (!validInputWatermark(facts.archiveA)) {
    return failed("CLOSURE_ARCHIVE_A_INVALID", "复盘输入归档 A 不满足 V2 要求。", facts);
  }
  if (!validInputWatermark(facts.archiveB) || facts.archiveB?.status !== "READY") {
    return failed("CLOSURE_ARCHIVE_B_NOT_READY", "最终归档 B 未达到 READY。", facts);
  }
  if (facts.archiveA?.retrospectiveInputWatermark !== facts.archiveB?.retrospectiveInputWatermark) {
    return failed(
      "CLOSURE_ARCHIVE_RETROSPECTIVE_INPUT_STALE",
      "归档 A 与 B 的复盘输入水位不一致。",
      facts
    );
  }
  if (
    !facts.archiveB.manifestChecksum ||
    !facts.archiveB.sourceWatermark ||
    facts.archiveB.latestIntegrityCheck?.status !== "PASSED"
  ) {
    return failed("CLOSURE_ARCHIVE_INTEGRITY_NOT_PASSED", "最终归档完整性检查未通过。", facts);
  }
  if (!facts.archiveB.sourceFactsCurrent) {
    return failed("CLOSURE_ARCHIVE_SOURCE_STALE", "最终归档来源事实已变化。", facts);
  }
  if (
    !facts.approvedRetrospective?.id ||
    facts.approvedRetrospective.status !== "APPROVED" ||
    !facts.approvedRetrospective.contentChecksum ||
    facts.approvedRetrospective.retrospectiveInputArchiveVersionId !== facts.archiveA.id ||
    facts.currentRetrospectiveVersionId !== facts.approvedRetrospective.id ||
    facts.latestApprovedRetrospectiveVersionId !== facts.approvedRetrospective.id
  ) {
    return failed("CLOSURE_ARCHIVE_RETROSPECTIVE_NOT_CURRENT", "项目复盘不是当前批准版本。", facts);
  }
  if (!facts.archiveBIncludesRetrospectiveVersion) {
    return failed(
      "CLOSURE_ARCHIVE_RETROSPECTIVE_NOT_FROZEN",
      "最终归档未冻结批准复盘版本。",
      facts
    );
  }
  if (facts.openResidualItemIds.length > 0) {
    return failed("CLOSURE_ARCHIVE_RESIDUALS_OPEN", "仍存在未闭环遗留项。", facts);
  }
  return {
    status: "PASSED",
    code: "CLOSURE_ARCHIVE_V2_READY",
    message: "归档 B、复盘输入与完整性事实满足结项 G9 V2。",
    evidence: evidence(facts)
  };
}

function asFacts(value: unknown, scope: GateScope): ProjectArchiveGateV2Facts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const facts = value as ProjectArchiveGateV2Facts;
  if (typeof facts.factsAvailable !== "boolean" || typeof facts.projectId !== "string") return null;
  return { ...facts, scope };
}

export const projectArchiveGateV2Checker: GateChecker = {
  code: "CLOSURE.ARCHIVE.G9",
  version: 2,
  supportedScopes: ["PROJECT"] as const,
  evaluate: (input) => {
    const facts = asFacts(input.facts?.closureArchiveV2, input.scope);
    if (facts) return evaluateProjectArchiveGateV2(facts);
    return evaluateProjectArchiveGateV2({
      factsAvailable: false,
      projectId: input.projectId,
      scope: input.scope,
      archiveA: null,
      archiveB: null,
      approvedRetrospective: null,
      currentRetrospectiveVersionId: null,
      latestApprovedRetrospectiveVersionId: null,
      archiveBIncludesRetrospectiveVersion: false,
      openResidualItemIds: []
    });
  }
};
