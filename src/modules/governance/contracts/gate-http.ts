import { parseDto } from "@/modules/platform-api/contracts/dto";
import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  createGateInstanceBodySchema,
  runGateChecksBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

import { GateServiceError } from "../application/gate-service";

export function parseGateInstancePayload(value: unknown) {
  return parseDto(createGateInstanceBodySchema, value, "body");
}

export function parseGateCheckPayload(value: unknown) {
  return parseDto(runGateChecksBodySchema, value, "body");
}

export function gateServiceErrorResponse(error: unknown): Response | null {
  if (!(error instanceof GateServiceError)) return null;
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}
