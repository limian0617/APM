import { parseDto } from "@/modules/platform-api/contracts/dto";
import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  createGateInstanceBodySchema,
  gateSubmissionCommandBodySchema,
  runGateChecksBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

import { GateServiceError } from "../application/gate-service";
import { GateSubmissionServiceError } from "../application/gate-submission-service";

export function parseGateInstancePayload(value: unknown) {
  return parseDto(createGateInstanceBodySchema, value, "body");
}

export function parseGateCheckPayload(value: unknown) {
  return parseDto(runGateChecksBodySchema, value, "body");
}

export function parseGateSubmissionCommandPayload(value: unknown) {
  return parseDto(gateSubmissionCommandBodySchema, value, "body");
}

export function gateServiceErrorResponse(error: unknown): Response | null {
  if (!(error instanceof GateServiceError) && !(error instanceof GateSubmissionServiceError)) {
    return null;
  }
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}
