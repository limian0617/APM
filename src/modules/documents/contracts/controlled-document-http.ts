import { ControlledDocumentError } from "../domain/controlled-document";

export function controlledDocumentErrorResponse(error: unknown): Response | null {
  if (!(error instanceof ControlledDocumentError)) return null;
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status }
  );
}
