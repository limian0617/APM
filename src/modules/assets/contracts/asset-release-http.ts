import { AssetReleaseError } from "../domain/asset-release";

export function assetReleaseErrorResponse(error: unknown): Response | null {
  if (!(error instanceof AssetReleaseError)) return null;
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status }
  );
}
