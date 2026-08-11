import { DrawingError } from "../domain/mechanical-drawing";
import { ManufacturingClassificationError } from "../domain/manufacturing-classification";

export function mechanicalDrawingErrorResponse(error: unknown): Response | null {
  if (!(error instanceof DrawingError) && !(error instanceof ManufacturingClassificationError)) {
    return null;
  }
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status }
  );
}
