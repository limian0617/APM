import { parseDto } from "@/modules/platform-api/contracts/dto";
import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  alertTransitionBodySchema,
  createProjectAlertRuleBodySchema,
  updateProjectAlertRuleBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

import { AlertServiceError } from "../application/alert-service";
import { AlertValidationError } from "../domain/alert-policy";

export function parseAlertRulePayload(value: unknown) {
  return parseDto(createProjectAlertRuleBodySchema, value, "body");
}

export function parseAlertRuleUpdatePayload(value: unknown) {
  return parseDto(updateProjectAlertRuleBodySchema, value, "body");
}

export function parseAlertTransitionPayload(value: unknown) {
  return parseDto(alertTransitionBodySchema, value, "body");
}

export function alertServiceErrorResponse(error: unknown): Response | null {
  if (error instanceof AlertServiceError) {
    return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
  }
  if (error instanceof AlertValidationError) {
    return apiErrorResponse({ status: 422, code: "ALERT_INVALID_INPUT", message: error.message });
  }
  return null;
}
