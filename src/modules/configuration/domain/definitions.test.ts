import { describe, expect, it } from "vitest";

import {
  ConfigurationValidationError,
  isCapabilityCode,
  isRuntimeSettingKey,
  validateReason,
  validateRuntimeSettingValue,
  validateVersion
} from "./definitions";

describe("APM-004 configuration definitions", () => {
  it("accepts only registered stable keys and capability codes", () => {
    expect(isRuntimeSettingKey("jobs.defaultMaxAttempts")).toBe(true);
    expect(isRuntimeSettingKey("jobs.unknown")).toBe(false);
    expect(isCapabilityCode("UPH_ANALYSIS")).toBe(true);
    expect(isCapabilityCode("UNREGISTERED_CAPABILITY")).toBe(false);
  });

  it("enforces integer type and per-key bounds", () => {
    expect(validateRuntimeSettingValue("jobs.claimBatchSize", 50)).toBe(50);
    for (const value of [0, 1.5, "20", 501]) {
      expect(() => validateRuntimeSettingValue("jobs.claimBatchSize", value)).toThrow(
        ConfigurationValidationError
      );
    }
  });

  it("requires positive versions and non-empty reasons", () => {
    expect(validateVersion(3)).toBe(3);
    expect(validateReason("  扩大作业批次  ")).toBe("扩大作业批次");
    expect(() => validateVersion(0)).toThrowError(/正整数/);
    expect(() => validateReason("   ")).toThrowError(/修改原因/);
  });
});
