import { describe, expect, it } from "vitest";

import { UphAnalysisServiceError } from "./uph-analysis-service";
import { uphApiErrorResponse } from "./uph-api-errors";

describe("uphApiErrorResponse analysis mapping", () => {
  it.each([
    ["AUTHORIZATION_DENIED", 403],
    ["ANALYSIS_NOT_FOUND", 404],
    ["LOCKED_REVISION_REQUIRED", 409],
    ["ANALYSIS_CONFLICT", 409],
    ["ANALYSIS_INPUT_INVALID", 422],
    ["ANALYSIS_FORMULA_UNSUPPORTED", 422]
  ] as const)("maps %s to its stable HTTP %i response", async (code, status) => {
    const response = uphApiErrorResponse(
      new UphAnalysisServiceError(code, `message ${code}`, status)
    );

    expect(response?.status).toBe(status);
    await expect(response?.json()).resolves.toMatchObject({
      error: { code, message: `message ${code}` }
    });
  });

  it("does not classify unknown errors", () => {
    expect(uphApiErrorResponse(new Error("unexpected"))).toBeNull();
  });
});
