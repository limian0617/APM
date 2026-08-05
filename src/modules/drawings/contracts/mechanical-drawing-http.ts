import { DrawingError } from "../domain/mechanical-drawing";

export function mechanicalDrawingErrorResponse(error: unknown): Response | null {
  if (!(error instanceof DrawingError)) return null;
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status }
  );
}
