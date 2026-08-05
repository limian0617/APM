import { TechnicalAssetError } from "../domain/technical-asset";

export function technicalAssetErrorResponse(error: unknown): Response | null {
  if (!(error instanceof TechnicalAssetError)) return null;
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status }
  );
}
