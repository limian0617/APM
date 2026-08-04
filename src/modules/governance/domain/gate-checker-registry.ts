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

function registryKey(code: string, version: number) {
  return `${code}@${version}`;
}

export const GATE_CHECKER_REGISTRY: ReadonlyMap<string, GateChecker> = new Map(
  [stageAwaitingGateChecker, documentsCompleteChecker].map((checker) => [
    registryKey(checker.code, checker.version),
    checker
  ])
);

export function resolveGateChecker(code: string, version = 1): GateChecker | undefined {
  return GATE_CHECKER_REGISTRY.get(registryKey(code, version));
}
