import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";

import { TemplateValidationError } from "../domain/template-policy";

export function templateErrorResponse(error: unknown): Response | null {
  if (!(error instanceof TemplateValidationError)) return null;
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}
