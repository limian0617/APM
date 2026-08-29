import { describe, expect, it } from "vitest";

import {
  ALERT_RISK_LEVELS,
  ALERT_SOURCE_TYPES,
  AlertValidationError,
  buildAlertSourceKey,
  nextAlertStatus,
  validateAlertRuleConfig
} from "./alert-policy";

describe("APM-034 alert policy", () => {
  it("requires a bounded threshold for time-based alert sources", () => {
    expect(
      validateAlertRuleConfig(ALERT_SOURCE_TYPES.CRITICAL_TASK_DELAY, { thresholdDays: 2 })
    ).toEqual({ thresholdDays: 2 });
    expect(
      validateAlertRuleConfig(ALERT_SOURCE_TYPES.SCHEDULE_FORECAST_STALE, { maximumAgeDays: 1 })
    ).toEqual({ maximumAgeDays: 1 });
    expect(() =>
      validateAlertRuleConfig(ALERT_SOURCE_TYPES.MILESTONE_OVERDUE, { thresholdDays: -1 })
    ).toThrow(AlertValidationError);
    expect(() => validateAlertRuleConfig(ALERT_SOURCE_TYPES.CRITICAL_TASK_DELAY, {})).toThrow(
      "thresholdDays"
    );
  });

  it("uses only the approved 3x3 risk-matrix values", () => {
    expect(ALERT_RISK_LEVELS).toEqual(["LOW", "MEDIUM", "HIGH"]);
    expect(() => validateAlertRuleConfig("UNREGISTERED", {})).toThrow(AlertValidationError);
  });

  it("registers procurement readiness sources with the existing empty condition rule", () => {
    const procurementSources = [
      "PROCUREMENT_NOT_ORDERED",
      "PROCUREMENT_LATE",
      "PROCUREMENT_PENDING_ACCEPTANCE",
      "PROCUREMENT_CRITICAL_SHORTAGE",
      "PROCUREMENT_CHANGE_BLOCKED",
      "PROCUREMENT_DATA_STALE"
    ];

    expect(
      Object.values(ALERT_SOURCE_TYPES).filter((source) => source.startsWith("PROCUREMENT_"))
    ).toEqual(procurementSources);
    for (const source of procurementSources) {
      expect(validateAlertRuleConfig(source, {})).toEqual({});
    }
  });

  it("registers asset impact as an empty-condition source", () => {
    expect(ALERT_SOURCE_TYPES.ASSET_IMPACT).toBe("ASSET_IMPACT");
    expect(validateAlertRuleConfig(ALERT_SOURCE_TYPES.ASSET_IMPACT, {})).toEqual({});
  });

  it("builds a stable source key scoped by the registered source type", () => {
    expect(buildAlertSourceKey(ALERT_SOURCE_TYPES.GATE_HARD_FAILURE, " gate-check-1 ")).toBe(
      "GATE_HARD_FAILURE:gate-check-1"
    );
    expect(() => buildAlertSourceKey(ALERT_SOURCE_TYPES.GATE_HARD_FAILURE, "")).toThrow(
      AlertValidationError
    );
  });

  it("does not treat acknowledgement as resolution", () => {
    expect(nextAlertStatus("TRIGGERED", "ACKNOWLEDGE")).toBe("ACKNOWLEDGED");
    expect(nextAlertStatus("ACKNOWLEDGED", "START")).toBe("IN_PROGRESS");
    expect(nextAlertStatus("IN_PROGRESS", "RESOLVE")).toBe("RESOLVED");
    expect(nextAlertStatus("RESOLVED", "CLOSE")).toBe("CLOSED");
    expect(() => nextAlertStatus("ACKNOWLEDGED", "CLOSE")).toThrow("不能执行");
  });

  it("returns a triggered status only when a resolved source recurs", () => {
    expect(nextAlertStatus("RESOLVED", "RETRIGGER")).toBe("TRIGGERED");
    expect(() => nextAlertStatus("CLOSED", "RETRIGGER")).toThrow(AlertValidationError);
  });
});
