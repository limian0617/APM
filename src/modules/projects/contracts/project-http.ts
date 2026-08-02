import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";

import { ProjectCreationError } from "../domain/project-template-snapshot";

export function projectCreationErrorResponse(error: unknown): Response | null {
  if (!(error instanceof ProjectCreationError)) return null;
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}
