import { ControlledDocumentError } from "../domain/controlled-document";
import { DocumentReviewError } from "../domain/document-review";

export function controlledDocumentErrorResponse(error: unknown): Response | null {
  if (!(error instanceof ControlledDocumentError) && !(error instanceof DocumentReviewError))
    return null;
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status }
  );
}
