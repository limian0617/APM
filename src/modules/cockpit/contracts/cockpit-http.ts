import { CockpitProjectionError } from "../application/cockpit-projection-service";
import { parseDto } from "@/modules/platform-api/contracts/dto";
import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";
import { cockpitRefreshBodySchema } from "@/modules/platform-api/contracts/internal-routes";

export function parseCockpitRefreshPayload(value: unknown) {
  return parseDto(cockpitRefreshBodySchema, value, "body");
}

export function cockpitProjectionErrorResponse(error: unknown): Response | null {
  if (!(error instanceof CockpitProjectionError)) return null;
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}
