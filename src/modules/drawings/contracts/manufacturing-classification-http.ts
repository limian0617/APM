import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";

import { ManufacturingClassificationError } from "../domain/manufacturing-classification";

export function manufacturingClassificationErrorResponse(error: unknown): Response | null {
  if (!(error instanceof ManufacturingClassificationError)) return null;
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}
