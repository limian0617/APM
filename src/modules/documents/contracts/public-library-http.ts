import { PublicLibraryDocumentError } from "../domain/public-library-document";

export function publicLibraryErrorResponse(error: unknown): Response | null {
  if (!(error instanceof PublicLibraryDocumentError)) return null;
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status }
  );
}
