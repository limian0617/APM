import { parseDto, parseQuery } from "@/modules/platform-api/contracts/dto";
import { apiErrorResponse } from "@/modules/platform-api/contracts/errors";
import {
  createProjectIssueBodySchema,
  issueRelationBodySchema,
  issueRelationCloseBodySchema,
  issueResponsibilityBodySchema,
  issueTransitionBodySchema,
  projectIssueQuerySchema,
  updateProjectIssueBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

import { IssueServiceError } from "../application/issue-service";

export function parseIssueCreatePayload(value: unknown) {
  return parseDto(createProjectIssueBodySchema, value, "body");
}

export function parseIssueUpdatePayload(value: unknown) {
  return parseDto(updateProjectIssueBodySchema, value, "body");
}

export function parseIssueTransitionPayload(value: unknown) {
  return parseDto(issueTransitionBodySchema, value, "body");
}

export function parseIssueResponsibilityPayload(value: unknown) {
  return parseDto(issueResponsibilityBodySchema, value, "body");
}

export function parseIssueRelationPayload(value: unknown) {
  return parseDto(issueRelationBodySchema, value, "body");
}

export function parseIssueRelationClosePayload(value: unknown) {
  return parseDto(issueRelationCloseBodySchema, value, "body");
}

export function parseIssueListQuery(url: URL) {
  return parseQuery(new Request(url), projectIssueQuerySchema);
}

export function issueServiceErrorResponse(error: unknown): Response | null {
  if (error instanceof IssueServiceError) {
    return apiErrorResponse({ status: error.status, code: error.code, message: error.message });
  }
  return null;
}
