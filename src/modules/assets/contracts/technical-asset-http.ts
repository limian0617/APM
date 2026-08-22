import { z } from "zod";

import {
  identifierSchema,
  positiveVersionSchema,
  reasonSchema
} from "@/modules/platform-api/contracts/dto";

import { TechnicalAssetError } from "../domain/technical-asset";

export const technicalAssetDeactivatePathSchema = z.strictObject({
  technicalAssetId: identifierSchema
});

export const technicalAssetDeactivateBodySchema = z.strictObject({
  version: positiveVersionSchema,
  reason: reasonSchema
});

export function technicalAssetErrorResponse(error: unknown): Response | null {
  if (!(error instanceof TechnicalAssetError)) return null;
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status }
  );
}
