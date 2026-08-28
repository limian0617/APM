import { parseDto } from "@/modules/platform-api/contracts/dto";
import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  createStageReleaseBodySchema,
  projectStageTransitionBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

import { ProjectStageError } from "../domain/project-stage";

export function parseStageTransitionPayload(value: unknown) {
  return parseDto(projectStageTransitionBodySchema, value, "body");
}

export function parseStageReleasePayload(value: unknown) {
  return parseDto(createStageReleaseBodySchema, value, "body");
}

export function projectStageErrorResponse(error: unknown): Response | null {
  if (!(error instanceof ProjectStageError)) return null;
  return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
}
