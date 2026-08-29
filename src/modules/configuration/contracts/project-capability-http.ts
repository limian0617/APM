import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";

import { ProjectCapabilityError } from "../domain/project-capability";

export function projectCapabilityErrorResponse(error: unknown): Response | null {
  if (!(error instanceof ProjectCapabilityError)) return null;
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}
