import { describe, expect, it } from "vitest";

import {
  TechnicalAssetError,
  allowedRndProjectTransition,
  allowedTechnicalAssetTransition,
  assertIndependentValidator,
  nextTechnicalAssetStatusForValidation
} from "./technical-asset";

describe("APM-061 technical asset lifecycle", () => {
  it("allows only the defined internal R&D lifecycle transitions", () => {
    expect(allowedRndProjectTransition("PROPOSED", "IN_DEVELOPMENT")).toBe(true);
    expect(allowedRndProjectTransition("IN_DEVELOPMENT", "VALIDATION")).toBe(true);
    expect(allowedRndProjectTransition("VALIDATION", "RELEASE_REVIEW")).toBe(true);
    expect(allowedRndProjectTransition("RELEASE_REVIEW", "COMPLETED")).toBe(true);
    expect(allowedRndProjectTransition("PROPOSED", "VALIDATION")).toBe(false);
    expect(allowedRndProjectTransition("COMPLETED", "IN_DEVELOPMENT")).toBe(false);
  });

  it("requires validation-pending assets and maps a validation decision to a master status", () => {
    expect(allowedTechnicalAssetTransition("DRAFT", "VALIDATION_PENDING")).toBe(true);
    expect(allowedTechnicalAssetTransition("DRAFT", "VALIDATED")).toBe(false);
    expect(nextTechnicalAssetStatusForValidation("VALIDATION_PENDING", "PASSED")).toBe("VALIDATED");
    expect(nextTechnicalAssetStatusForValidation("VALIDATION_PENDING", "FAILED")).toBe("DRAFT");
    expect(() => nextTechnicalAssetStatusForValidation("DRAFT", "PASSED")).toThrowError(
      expect.objectContaining({ code: "ASSET_NOT_PENDING_VALIDATION" })
    );
  });

  it("requires an independent active validator", () => {
    expect(() => assertIndependentValidator("owner-1", "owner-1", "ACTIVE")).toThrowError(
      expect.objectContaining({ code: "VALIDATOR_MUST_BE_INDEPENDENT" })
    );
    expect(() => assertIndependentValidator("owner-1", "validator-2", "DISABLED")).toThrowError(
      expect.objectContaining({ code: "VALIDATOR_DISABLED" })
    );
    expect(() => assertIndependentValidator("owner-1", "validator-2", "ACTIVE")).not.toThrow();
  });

  it("makes domain failures structured for HTTP mapping", () => {
    const error = new TechnicalAssetError("INVALID_ASSET_NUMBER", "资产编号无效。", 422);

    expect(error).toMatchObject({
      name: "TechnicalAssetError",
      code: "INVALID_ASSET_NUMBER",
      status: 422,
      message: "资产编号无效。"
    });
  });
});
