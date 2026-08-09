import type { GateScope } from "@/modules/configuration/domain/template-policy";
import type { JsonValue } from "@/modules/governance/domain/idempotency";
import type { ProjectStageExecutionStatus } from "@/modules/projects/domain/project-stage";
import {
  evaluateAcceptanceIssueGate,
  type AcceptanceIssueGateInput
} from "./acceptance-issue-gate";
import type {
  AcceptanceIssueCategory,
  AcceptanceIssueSeverity,
  AcceptanceIssueStatus
} from "@/modules/issues/domain/acceptance-issue-policy";

export const GATE_CHECKER_RESULT_STATUSES = {
  PASSED: "PASSED",
  WARNING: "WARNING",
  HARD_FAILED: "HARD_FAILED"
} as const;

export type GateCheckerResultStatus =
  (typeof GATE_CHECKER_RESULT_STATUSES)[keyof typeof GATE_CHECKER_RESULT_STATUSES];

export type GateCheckerInput = {
  projectId: string;
  gateCode: string;
  stageCode: string;
  scope: GateScope;
  stageStatus: ProjectStageExecutionStatus;
  facts?: Readonly<Record<string, JsonValue>> | null;
};

export type GateCheckerResult = {
  status: GateCheckerResultStatus;
  code: string;
  message: string;
  evidence: JsonValue;
};

export type GateChecker = {
  code: string;
  version: number;
  supportedScopes: readonly GateScope[];
  evaluate: (input: GateCheckerInput) => GateCheckerResult;
};

const allGateScopes: readonly GateScope[] = ["PROJECT", "DELIVERY_UNIT", "MODULE"];

const stageAwaitingGateChecker: GateChecker = {
  code: "STAGE.AWAITING_GATE",
  version: 1,
  supportedScopes: allGateScopes,
  evaluate: (input) => {
    if (input.stageStatus === "AWAITING_GATE") {
      return {
        status: "PASSED",
        code: "STAGE_AWAITING_GATE",
        message: "关联阶段正等待 Gate 检查。",
        evidence: {
          expectedStageStatus: "AWAITING_GATE",
          actualStageStatus: input.stageStatus,
          stageCode: input.stageCode
        }
      };
    }
    return {
      status: "HARD_FAILED",
      code: "STAGE_NOT_AWAITING_GATE",
      message: "关联阶段尚未进入等待 Gate 检查状态。",
      evidence: {
        expectedStageStatus: "AWAITING_GATE",
        actualStageStatus: input.stageStatus,
        stageCode: input.stageCode
      }
    };
  }
};

const documentsCompleteChecker: GateChecker = {
  code: "DOCUMENTS.COMPLETE",
  version: 1,
  supportedScopes: allGateScopes,
  evaluate: () => ({
    status: "HARD_FAILED",
    code: "CHECKER_DEPENDENCY_UNAVAILABLE",
    message: "受控文档域尚未提供可用于 Gate 的完成事实。",
    evidence: { dependency: "DOCUMENTS" }
  })
};

type ProcurementReadinessFacts = Readonly<{
  readinessResultId: string | null;
  policyVersion: string | null;
  formulaVersion: string | null;
  inputWatermark: string | null;
  calculatedAt: string | null;
  status: string | null;
  criticalGapLines: number | null;
  gapLines: number | null;
  affectedRequirementIds: readonly string[];
  wrongDrawingVersionRequirementIds: readonly string[];
  unresolvedMajorChangeRequirementIds: readonly string[];
  changeFactsAvailability: "AVAILABLE" | "UNAVAILABLE" | null;
  gateThreshold: Readonly<{
    warningGapLines: number | null;
    hardFailureGapLines: number | null;
  }> | null;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    return null;
  }
  return [...new Set(value.map((entry) => entry.trim()))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function procurementReadinessFacts(value: unknown): ProcurementReadinessFacts | null {
  const input = record(value);
  if (!input) return null;
  const affectedRequirementIds = stringArray(
    input.affectedRequirementIds ?? input.gapRequirementIds ?? []
  );
  const wrongDrawingVersionRequirementIds = stringArray(
    input.wrongDrawingVersionRequirementIds ?? input.drawingVersionIssueRequirementIds ?? []
  );
  const unresolvedMajorChangeRequirementIds = stringArray(
    input.unresolvedMajorChangeRequirementIds ?? input.majorChangeRequirementIds ?? []
  );
  if (
    affectedRequirementIds === null ||
    wrongDrawingVersionRequirementIds === null ||
    unresolvedMajorChangeRequirementIds === null
  ) {
    return null;
  }
  const threshold = record(input.gateThreshold ?? input.threshold);
  const gateThreshold =
    threshold === null
      ? null
      : {
          warningGapLines: nonNegativeIntegerOrNull(
            threshold.warningGapLines ?? threshold.warningGapThreshold
          ),
          hardFailureGapLines: nonNegativeIntegerOrNull(
            threshold.hardFailureGapLines ?? threshold.hardFailureGapThreshold
          )
        };
  return {
    readinessResultId: textOrNull(input.readinessResultId),
    policyVersion: textOrNull(input.policyVersion),
    formulaVersion: textOrNull(input.formulaVersion),
    inputWatermark: textOrNull(input.inputWatermark),
    calculatedAt: textOrNull(input.calculatedAt),
    status: textOrNull(input.status ?? input.readinessStatus),
    criticalGapLines: nonNegativeIntegerOrNull(
      input.criticalGapLines ?? input.blockingCriticalLines
    ),
    gapLines: nonNegativeIntegerOrNull(input.gapLines),
    affectedRequirementIds,
    wrongDrawingVersionRequirementIds,
    unresolvedMajorChangeRequirementIds,
    changeFactsAvailability:
      input.changeFactsAvailability === "AVAILABLE" ||
      input.changeFactsAvailability === "UNAVAILABLE"
        ? input.changeFactsAvailability
        : null,
    gateThreshold
  };
}

function procurementEvidence(facts: ProcurementReadinessFacts | null) {
  return {
    readinessResultId: facts?.readinessResultId ?? null,
    policyVersion: facts?.policyVersion ?? null,
    formulaVersion: facts?.formulaVersion ?? null,
    inputWatermark: facts?.inputWatermark ?? null,
    calculatedAt: facts?.calculatedAt ?? null,
    criticalGapLines: facts?.criticalGapLines ?? null,
    affectedRequirementIds: [...(facts?.affectedRequirementIds ?? [])],
    wrongDrawingVersionRequirementIds: [...(facts?.wrongDrawingVersionRequirementIds ?? [])],
    unresolvedMajorChangeRequirementIds: [...(facts?.unresolvedMajorChangeRequirementIds ?? [])],
    changeFactsAvailability: facts?.changeFactsAvailability ?? null
  };
}

function procurementFailure(
  code: string,
  message: string,
  facts: ProcurementReadinessFacts | null
): GateCheckerResult {
  return {
    status: "HARD_FAILED",
    code,
    message,
    evidence: procurementEvidence(facts)
  };
}

const procurementReadinessChecker: GateChecker = {
  code: "PROCUREMENT.READINESS",
  version: 1,
  supportedScopes: allGateScopes,
  evaluate: (input) => {
    const facts = procurementReadinessFacts(input.facts?.procurementReadiness ?? input.facts);
    if (!facts) {
      return procurementFailure(
        "PROCUREMENT_READINESS_FACTS_UNAVAILABLE",
        "未冻结可验证的采购齐套事实。",
        null
      );
    }
    const unavailableChangeFactsFailure = () =>
      procurementFailure(
        "PROCUREMENT_CHANGE_FACTS_UNAVAILABLE",
        "采购重大变更事实不可用，不能放行 Gate。",
        facts
      );
    if (facts.changeFactsAvailability === "UNAVAILABLE") {
      return unavailableChangeFactsFailure();
    }
    if (
      !facts.readinessResultId ||
      !facts.policyVersion ||
      !facts.formulaVersion ||
      !facts.inputWatermark ||
      !facts.calculatedAt ||
      facts.criticalGapLines === null ||
      facts.gapLines === null
    ) {
      return procurementFailure(
        "PROCUREMENT_READINESS_FACTS_INVALID",
        "冻结的采购齐套事实不完整。",
        facts
      );
    }
    if (facts.changeFactsAvailability !== "AVAILABLE") {
      return unavailableChangeFactsFailure();
    }
    if (facts.status !== "READY" && facts.status !== "BLOCKED") {
      return procurementFailure(
        "PROCUREMENT_READINESS_NOT_READY",
        "采购齐套结果不可用于 Gate 放行。",
        facts
      );
    }
    if (facts.criticalGapLines > 0) {
      return procurementFailure(
        "PROCUREMENT_CRITICAL_SHORTAGE",
        "存在关键物料缺口，不能通过 Gate。",
        facts
      );
    }
    if (facts.wrongDrawingVersionRequirementIds.length > 0) {
      return procurementFailure(
        "PROCUREMENT_DRAWING_VERSION_INVALID",
        "存在图纸版本不正确的采购需求，不能通过 Gate。",
        facts
      );
    }
    if (facts.unresolvedMajorChangeRequirementIds.length > 0) {
      return procurementFailure(
        "PROCUREMENT_MAJOR_CHANGE_UNRESOLVED",
        "存在未处置的重大采购变更，不能通过 Gate。",
        facts
      );
    }
    if (facts.gapLines > 0) {
      const threshold = facts.gateThreshold;
      if (
        !threshold ||
        threshold.warningGapLines === null ||
        threshold.hardFailureGapLines === null ||
        threshold.warningGapLines > threshold.hardFailureGapLines
      ) {
        return procurementFailure(
          "PROCUREMENT_GATE_THRESHOLD_INVALID",
          "普通物料缺口缺少有效的冻结 Gate 阈值。",
          facts
        );
      }
      if (facts.gapLines >= threshold.hardFailureGapLines) {
        return procurementFailure(
          "PROCUREMENT_READINESS_GAP_HARD_FAILED",
          "普通物料缺口达到 Gate 硬失败阈值。",
          facts
        );
      }
      if (facts.gapLines >= threshold.warningGapLines) {
        return {
          status: "WARNING",
          code: "PROCUREMENT_READINESS_WARNING",
          message: "普通物料缺口达到 Gate 预警阈值。",
          evidence: procurementEvidence(facts)
        };
      }
    }
    return {
      status: "PASSED",
      code: "PROCUREMENT_READINESS_PASSED",
      message: "冻结的采购齐套事实满足 Gate 要求。",
      evidence: procurementEvidence(facts)
    };
  }
};

function acceptanceIssueFacts(value: unknown): AcceptanceIssueGateInput | null {
  if (!record(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    typeof source.factsAvailable !== "boolean" ||
    typeof source.sourceChecksum !== "string" ||
    typeof source.requiredResultMissing !== "boolean" ||
    !Array.isArray(source.results) ||
    !Array.isArray(source.issues) ||
    !Array.isArray(source.retestPassRevisionIds) ||
    source.retestPassRevisionIds.some((id) => typeof id !== "string")
  ) {
    return null;
  }
  const results = source.results.map((entry) => {
    const value = record(entry);
    if (
      !value ||
      typeof value.resultRevisionId !== "string" ||
      typeof value.itemCode !== "string" ||
      !["PASS", "FAIL", "NA"].includes(value.decision as string) ||
      !Array.isArray(value.issueIds) ||
      value.issueIds.some((id) => typeof id !== "string")
    ) {
      return null;
    }
    return {
      resultRevisionId: value.resultRevisionId,
      itemCode: value.itemCode,
      decision: value.decision as "PASS" | "FAIL" | "NA",
      issueIds: value.issueIds as string[]
    };
  });
  const issues = source.issues.map((entry) => {
    const value = record(entry);
    if (
      !value ||
      typeof value.issueId !== "string" ||
      !["SAFETY", "FUNCTION", "PERFORMANCE", "APPEARANCE", "DELIVERY_COMPLETENESS"].includes(
        value.category as string
      ) ||
      !["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(value.severity as string) ||
      !["PENDING_ACCEPTANCE", "ANALYZING", "PROCESSING", "PENDING_VERIFICATION", "CLOSED"].includes(
        value.status as string
      ) ||
      (value.ownerMembershipId !== null && typeof value.ownerMembershipId !== "string") ||
      (value.verifierMembershipId !== null && typeof value.verifierMembershipId !== "string") ||
      (value.dueDate !== null && typeof value.dueDate !== "string") ||
      (value.verificationPlan !== null && typeof value.verificationPlan !== "string")
    ) {
      return null;
    }
    return {
      issueId: value.issueId,
      category: value.category as AcceptanceIssueCategory,
      severity: value.severity as AcceptanceIssueSeverity,
      status: value.status as AcceptanceIssueStatus,
      ownerMembershipId: value.ownerMembershipId as string | null,
      verifierMembershipId: value.verifierMembershipId as string | null,
      dueDate: value.dueDate as string | null,
      verificationPlan: value.verificationPlan as string | null
    };
  });
  if (results.some((entry) => entry === null) || issues.some((entry) => entry === null))
    return null;
  return {
    factsAvailable: source.factsAvailable,
    acceptanceType:
      source.acceptanceType === "FAT" || source.acceptanceType === "SAT"
        ? source.acceptanceType
        : undefined,
    lockedBatchId: typeof source.lockedBatchId === "string" ? source.lockedBatchId : null,
    lockedBatchChain:
      Array.isArray(source.lockedBatchChain) &&
      source.lockedBatchChain.every((id) => typeof id === "string")
        ? (source.lockedBatchChain as string[])
        : undefined,
    templateVersionId:
      typeof source.templateVersionId === "string" ? source.templateVersionId : null,
    templateChecksum: typeof source.templateChecksum === "string" ? source.templateChecksum : null,
    sourceChecksum: source.sourceChecksum,
    requiredResultMissing: source.requiredResultMissing,
    results: results as NonNullable<(typeof results)[number]>[],
    issues: issues as NonNullable<(typeof issues)[number]>[],
    retestPassRevisionIds: source.retestPassRevisionIds as string[]
  };
}

function acceptanceIssueChecker(acceptanceType: "FAT" | "SAT"): GateChecker {
  const code = `ACCEPTANCE.${acceptanceType}.ISSUES`;
  return {
    code,
    version: 1,
    supportedScopes: allGateScopes,
    evaluate: (input) => {
      const factsRecord = record(input.facts?.acceptanceIssues);
      if (!factsRecord || factsRecord.acceptanceType !== acceptanceType) {
        return {
          status: "HARD_FAILED",
          code: "ACCEPTANCE_TYPE_FACT_MISMATCH",
          message: "冻结的验收类型与 Gate 检查器不匹配。",
          evidence: { expectedAcceptanceType: acceptanceType } as unknown as JsonValue
        };
      }
      const facts = acceptanceIssueFacts(factsRecord);
      if (!facts) {
        return {
          status: "HARD_FAILED",
          code: "ACCEPTANCE_FACTS_UNAVAILABLE",
          message: "未冻结可验证的 FAT/SAT 问题事实。",
          evidence: { acceptanceType } as unknown as JsonValue
        };
      }
      const result = evaluateAcceptanceIssueGate(facts);
      return {
        status: result.status,
        code: result.code,
        message: result.message,
        evidence: {
          ...(result.evidence.acceptanceType
            ? { acceptanceType: result.evidence.acceptanceType }
            : {}),
          ...(result.evidence.lockedBatchId !== undefined
            ? { lockedBatchId: result.evidence.lockedBatchId }
            : {}),
          ...(result.evidence.lockedBatchChain
            ? { lockedBatchChain: [...result.evidence.lockedBatchChain] }
            : {}),
          ...(result.evidence.templateVersionId !== undefined
            ? { templateVersionId: result.evidence.templateVersionId }
            : {}),
          ...(result.evidence.templateChecksum !== undefined
            ? { templateChecksum: result.evidence.templateChecksum }
            : {}),
          sourceChecksum: result.evidence.sourceChecksum,
          resultRevisionIds: [...result.evidence.resultRevisionIds],
          issueIds: [...result.evidence.issueIds],
          warnings: [...result.evidence.warnings],
          retestPassRevisionIds: [...result.evidence.retestPassRevisionIds],
          failureLinks: result.evidence.failureLinks.map((link) => ({
            resultRevisionId: link.resultRevisionId,
            issueIds: [...link.issueIds]
          })),
          issueFacts: result.evidence.issueFacts.map((issue) => ({ ...issue }))
        } as JsonValue
      };
    }
  };
}

const fatAcceptanceIssueChecker = acceptanceIssueChecker("FAT");
const satAcceptanceIssueChecker = acceptanceIssueChecker("SAT");

function registryKey(code: string, version: number) {
  return `${code}@${version}`;
}

export const GATE_CHECKER_REGISTRY: ReadonlyMap<string, GateChecker> = new Map(
  [
    stageAwaitingGateChecker,
    documentsCompleteChecker,
    procurementReadinessChecker,
    fatAcceptanceIssueChecker,
    satAcceptanceIssueChecker
  ].map((checker) => [registryKey(checker.code, checker.version), checker])
);

export function resolveGateChecker(code: string, version = 1): GateChecker | undefined {
  return GATE_CHECKER_REGISTRY.get(registryKey(code, version));
}
