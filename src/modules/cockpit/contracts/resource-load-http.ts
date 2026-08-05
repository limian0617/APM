import { ResourceLoadProjectionError } from "../application/resource-load-projection-service";
import { parseDto } from "@/modules/platform-api/contracts/dto";
import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";
import { resourceLoadRefreshBodySchema } from "@/modules/platform-api/contracts/internal-routes";

export function parseResourceLoadRefreshPayload(value: unknown) {
  return parseDto(resourceLoadRefreshBodySchema, value, "body");
}

export function resourceLoadProjectionErrorResponse(error: unknown): Response | null {
  if (!(error instanceof ResourceLoadProjectionError)) return null;
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}
