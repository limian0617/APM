import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";

import { PlanningError } from "../domain/planning-task";

export function planningErrorResponse(error: unknown): Response | null {
  if (!(error instanceof PlanningError)) return null;
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}
