import type { GateScope } from "@/modules/configuration/domain/template-policy";
import type { JsonValue } from "@/modules/governance/domain/idempotency";
import type { ProjectStageExecutionStatus } from "@/modules/projects/domain/project-stage";

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

function registryKey(code: string, version: number) {
  return `${code}@${version}`;
}

export const GATE_CHECKER_REGISTRY: ReadonlyMap<string, GateChecker> = new Map(
  [stageAwaitingGateChecker, documentsCompleteChecker, procurementReadinessChecker].map(
    (checker) => [registryKey(checker.code, checker.version), checker]
  )
);

export function resolveGateChecker(code: string, version = 1): GateChecker | undefined {
  return GATE_CHECKER_REGISTRY.get(registryKey(code, version));
}
