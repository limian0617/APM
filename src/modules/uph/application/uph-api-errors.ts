import { Prisma } from "@prisma/client";

import {
  apiContractErrorResponse,
  apiErrorResponse
} from "@/modules/platform-api/contracts/errors";

import { UphDefinitionServiceError } from "./uph-definition-service";
import { UphAnalysisServiceError } from "./uph-analysis-service";
import { UphPerformanceTargetServiceError } from "./uph-performance-target-service";
import { UphPerformanceIssueServiceError } from "./uph-performance-issue-service";
import { UphRetestServiceError } from "./uph-retest-service";

function isUphTestBatchServiceError(
  error: unknown
): error is { name: string; code: string; message: string; status: number } {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return (
    candidate.name === "UphTestBatchServiceError" &&
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    Number.isInteger(candidate.status) &&
    (candidate.status as number) >= 400 &&
    (candidate.status as number) <= 599
  );
}

export function uphApiErrorResponse(error: unknown): Response | null {
  const contract = apiContractErrorResponse(error);
  if (contract) return contract;
  if (isUphTestBatchServiceError(error)) {
    return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
  }
  if (error instanceof UphDefinitionServiceError) {
    return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
  }
  if (error instanceof UphAnalysisServiceError) {
    return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
  }
  if (error instanceof UphPerformanceTargetServiceError) {
    return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
  }
  if (error instanceof UphPerformanceIssueServiceError) {
    return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
  }
  if (error instanceof UphRetestServiceError) {
    return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return apiErrorResponse({
      status: 409,
      code: error.code === "P2002" ? "VERSION_CONFLICT" : "UPH_CONSTRAINT_CONFLICT",
      message: "UPH命令因当前事实或并发状态冲突未完成。"
    });
  }
  return null;
}
