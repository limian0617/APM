import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";

import { ProjectCreationError } from "../domain/project-template-snapshot";
import { ProjectStructureError } from "../domain/project-structure";
import { ResponsibilityPackageError } from "../domain/responsibility-package";

export function projectCreationErrorResponse(error: unknown): Response | null {
  if (!(error instanceof ProjectCreationError)) return null;
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}

export function projectStructureErrorResponse(error: unknown): Response | null {
  if (!(error instanceof ProjectStructureError)) return null;
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}

export function responsibilityPackageErrorResponse(error: unknown): Response | null {
  if (!(error instanceof ResponsibilityPackageError)) return null;
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}
