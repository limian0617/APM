import type { GateScope } from "@/modules/configuration/domain/template-policy";
import type { JsonValue } from "./idempotency";
import type { GateChecker } from "./gate-checker-registry";

export type ProjectArchiveGateFacts = {
  factsAvailable: boolean;
  projectId: string;
  scope: GateScope;
  archiveVersionId: string | null;
  archiveStatus: string | null;
  manifestChecksum: string | null;
  sourceWatermark: string | null;
  integrityCheckId: string | null;
  integrityStatus: string | null;
  sourceFactsCurrent: boolean;
  openResidualItemIds: readonly string[];
};

export type ProjectArchiveGateResult = {
  status: "PASSED" | "HARD_FAILED";
  code: string;
  message: string;
  evidence: JsonValue;
};

function failure(
  code: string,
  message: string,
  facts: ProjectArchiveGateFacts
): ProjectArchiveGateResult {
  return {
    status: "HARD_FAILED",
    code,
    message,
    evidence: {
      projectId: facts.projectId,
      scope: facts.scope,
      archiveVersionId: facts.archiveVersionId,
      archiveStatus: facts.archiveStatus,
      integrityCheckId: facts.integrityCheckId,
      integrityStatus: facts.integrityStatus,
      sourceFactsCurrent: facts.sourceFactsCurrent,
      openResidualItemIds: [...facts.openResidualItemIds]
    }
  };
}

export function evaluateProjectArchiveGate(
  facts: ProjectArchiveGateFacts
): ProjectArchiveGateResult {
  if (facts.scope !== "PROJECT") {
    return failure("CLOSURE_ARCHIVE_SCOPE_INVALID", "结项归档 G9 只允许项目范围。", facts);
  }
  if (!facts.factsAvailable) {
    return failure("CLOSURE_ARCHIVE_FACTS_UNAVAILABLE", "结项归档事实不可用，不能通过 G9。", facts);
  }
  if (
    !facts.archiveVersionId ||
    facts.archiveStatus !== "READY" ||
    !facts.manifestChecksum ||
    !facts.sourceWatermark ||
    !facts.integrityCheckId ||
    facts.integrityStatus !== "PASSED"
  ) {
    return failure("CLOSURE_ARCHIVE_NOT_READY", "归档版本或完整性检查未达到 READY。", facts);
  }
  if (!facts.sourceFactsCurrent) {
    return failure("CLOSURE_ARCHIVE_SOURCE_STALE", "归档来源事实已发生变化，必须重新生成。", facts);
  }
  if (facts.openResidualItemIds.length > 0) {
    return failure("CLOSURE_ARCHIVE_RESIDUALS_OPEN", "仍存在未闭环遗留项，不能通过 G9。", facts);
  }
  return {
    status: "PASSED",
    code: "CLOSURE_ARCHIVE_READY",
    message: "结项归档版本和完整性事实满足 G9。",
    evidence: {
      projectId: facts.projectId,
      scope: facts.scope,
      archiveVersionId: facts.archiveVersionId,
      manifestChecksum: facts.manifestChecksum,
      sourceWatermark: facts.sourceWatermark,
      integrityCheckId: facts.integrityCheckId,
      integrityStatus: facts.integrityStatus,
      openResidualItemIds: []
    }
  };
}

export const projectArchiveGateChecker: GateChecker = {
  code: "CLOSURE.ARCHIVE.G9",
  version: 1,
  supportedScopes: ["PROJECT"] as const,
  evaluate: (input) => {
    const value = input.facts?.closureArchive;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return failure("CLOSURE_ARCHIVE_FACTS_UNAVAILABLE", "结项归档事实不可用，不能通过 G9。", {
        factsAvailable: false,
        projectId: "unknown",
        scope: input.scope,
        archiveVersionId: null,
        archiveStatus: null,
        manifestChecksum: null,
        sourceWatermark: null,
        integrityCheckId: null,
        integrityStatus: null,
        sourceFactsCurrent: false,
        openResidualItemIds: []
      });
    }
    const facts = value as Record<string, unknown>;
    const normalized: ProjectArchiveGateFacts = {
      factsAvailable: facts.factsAvailable === true,
      projectId: typeof facts.projectId === "string" ? facts.projectId : "unknown",
      scope: input.scope,
      archiveVersionId: typeof facts.archiveVersionId === "string" ? facts.archiveVersionId : null,
      archiveStatus: typeof facts.archiveStatus === "string" ? facts.archiveStatus : null,
      manifestChecksum: typeof facts.manifestChecksum === "string" ? facts.manifestChecksum : null,
      sourceWatermark: typeof facts.sourceWatermark === "string" ? facts.sourceWatermark : null,
      integrityCheckId: typeof facts.integrityCheckId === "string" ? facts.integrityCheckId : null,
      integrityStatus: typeof facts.integrityStatus === "string" ? facts.integrityStatus : null,
      sourceFactsCurrent: facts.sourceFactsCurrent === true,
      openResidualItemIds: Array.isArray(facts.openResidualItemIds)
        ? facts.openResidualItemIds.filter((id): id is string => typeof id === "string")
        : []
    };
    return evaluateProjectArchiveGate(normalized);
  }
};
