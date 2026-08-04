import { describe, expect, it } from "vitest";

import { AlertServiceError } from "../application/alert-service";

import {
  alertServiceErrorResponse,
  parseAlertRulePayload,
  parseAlertRuleUpdatePayload,
  parseAlertTransitionPayload
} from "./alert-http";

describe("APM-034 alert HTTP contracts", () => {
  const rule = {
    code: "SCHEDULE.STALE",
    name: "计划预测数据过期",
    sourceType: "SCHEDULE_FORECAST_STALE",
    condition: { maximumAgeDays: 2 },
    probability: "MEDIUM",
    impact: "HIGH",
    ownerMembershipId: "member-owner",
    escalationMembershipId: "member-escalation",
    escalationAfterDays: 3
  };

  it("accepts only registered rule sources and a configured whole-day threshold", () => {
    expect(parseAlertRulePayload(rule)).toEqual(rule);
    expect(() =>
      parseAlertRulePayload({
        ...rule,
        sourceType: "UNREGISTERED",
        condition: {}
      })
    ).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED", status: 422 }));
    expect(() => parseAlertRulePayload({ ...rule, condition: { maximumAgeDays: 0 } })).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED", status: 422 })
    );
  });

  it("requires optimistic versions and a reason when updating or disabling a rule", () => {
    expect(
      parseAlertRuleUpdatePayload({
        version: 2,
        reason: "调整升级责任人",
        ...rule,
        status: "DISABLED"
      })
    ).toMatchObject({ version: 2, status: "DISABLED", code: rule.code });
    expect(() => parseAlertRuleUpdatePayload({ ...rule, version: 0, reason: "调整" })).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED", status: 422 })
    );
  });

  it("accepts only controlled alert lifecycle actions with a version and reason", () => {
    expect(
      parseAlertTransitionPayload({
        version: 1,
        action: "ACKNOWLEDGE",
        reason: "已收到，正在确认。"
      })
    ).toEqual({ version: 1, action: "ACKNOWLEDGE", reason: "已收到，正在确认。" });
    expect(() =>
      parseAlertTransitionPayload({ version: 1, action: "DELETE", reason: "不允许" })
    ).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED", status: 422 }));
  });

  it("maps typed application failures to the standard error envelope", async () => {
    const response = alertServiceErrorResponse(
      new AlertServiceError("ALERT_NOT_FOUND", "预警不存在或不属于该项目。", 404)
    );

    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: "ALERT_NOT_FOUND", message: "预警不存在或不属于该项目。" }
    });
  });
});
