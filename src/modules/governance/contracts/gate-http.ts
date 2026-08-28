import { parseDto } from "@/modules/platform-api/contracts/dto";
import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  conditionalReleaseBodySchema,
  createGateInstanceBodySchema,
  gateSubmissionCommandBodySchema,
  residualItemCommandBodySchema,
  runGateChecksBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

import { GateServiceError } from "../application/gate-service";
import { GateSubmissionServiceError } from "../application/gate-submission-service";
import { GateConditionalReleaseError } from "../domain/gate-conditional-release";

export function parseGateInstancePayload(value: unknown) {
  return parseDto(createGateInstanceBodySchema, value, "body");
}

export function parseGateCheckPayload(value: unknown) {
  return parseDto(runGateChecksBodySchema, value, "body");
}

export function parseGateSubmissionCommandPayload(value: unknown) {
  return parseDto(gateSubmissionCommandBodySchema, value, "body");
}

export function parseConditionalReleasePayload(value: unknown) {
  return parseDto(conditionalReleaseBodySchema, value, "body");
}

export function parseResidualItemCommandPayload(value: unknown) {
  return parseDto(residualItemCommandBodySchema, value, "body");
}

export function gateServiceErrorResponse(error: unknown): Response | null {
  if (
    !(error instanceof GateServiceError) &&
    !(error instanceof GateSubmissionServiceError) &&
    !(error instanceof GateConditionalReleaseError)
  ) {
    return null;
  }
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}
