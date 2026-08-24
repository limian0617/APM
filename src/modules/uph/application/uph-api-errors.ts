import { Prisma } from "@prisma/client";

import {
  apiContractErrorResponse,
  apiErrorResponse
} from "@/modules/platform-api/contracts/errors";

import { UphDefinitionServiceError } from "./uph-definition-service";

export function uphApiErrorResponse(error: unknown): Response | null {
  const contract = apiContractErrorResponse(error);
  if (contract) return contract;
  if (error instanceof UphDefinitionServiceError) {
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
