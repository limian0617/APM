import { describe, expect, it } from "vitest";

import {
  capabilityEffectiveState,
  resolveProjectCapabilitySelections,
  resolveTemplateCapabilityPolicy
} from "./project-capability";

describe("APM-013 project capability rules", () => {
  it("defaults missing template rules to deny all stable capabilities", () => {
    const policies = resolveTemplateCapabilityPolicy([]);
    expect(policies).toHaveLength(5);
    expect(
      policies.every(
        ({ templateAllowed, templateRequired }) => !templateAllowed && !templateRequired
      )
    ).toBe(true);
  });

  it("resolves required and optional rules from exact snapshot components", () => {
    const policies = resolveTemplateCapabilityPolicy([
      {
        id: "snapshot-capability-1",
        contentJson: {
          capabilities: [
            { code: "SUPPLIER_COLLABORATION", required: true },
            { code: "CUSTOMER_PROGRESS_SHARING", required: false }
          ]
        }
      }
    ]);
    expect(policies.find(({ code }) => code === "SUPPLIER_COLLABORATION")).toMatchObject({
      templateAllowed: true,
      templateRequired: true,
      sourceSnapshotComponentId: "snapshot-capability-1"
    });
    expect(policies.find(({ code }) => code === "UPH_ANALYSIS")).toMatchObject({
      templateAllowed: false,
      templateRequired: false,
      sourceSnapshotComponentId: null
    });
  });

  it("rejects malformed and duplicate template capability rules", () => {
    expect(() =>
      resolveTemplateCapabilityPolicy([
        { id: "bad", contentJson: { capabilities: [{ code: "UNKNOWN", required: false }] } }
      ])
    ).toThrowError(expect.objectContaining({ code: "INVALID_TEMPLATE_CAPABILITY_RULE" }));
    expect(() =>
      resolveTemplateCapabilityPolicy([
        {
          id: "first",
          contentJson: {
            capabilities: [{ code: "AI_ISSUE_INTAKE", required: false }]
          }
        },
        {
          id: "second",
          contentJson: {
            capabilities: [{ code: "AI_ISSUE_INTAKE", required: true }]
          }
        }
      ])
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_TEMPLATE_CAPABILITY" }));
  });

  it("applies template defaults and rejects forbidden or required overrides", () => {
    const policies = resolveTemplateCapabilityPolicy([
      {
        id: "snapshot-capability-1",
        contentJson: {
          capabilities: [
            { code: "SUPPLIER_COLLABORATION", required: true },
            { code: "CUSTOMER_PROGRESS_SHARING", required: false }
          ]
        }
      }
    ]);
    const selected = resolveProjectCapabilitySelections(policies, [
      { code: "CUSTOMER_PROGRESS_SHARING", enabled: true }
    ]);
    expect(selected.find(({ code }) => code === "SUPPLIER_COLLABORATION")?.selectedEnabled).toBe(
      true
    );
    expect(selected.find(({ code }) => code === "CUSTOMER_PROGRESS_SHARING")?.selectedEnabled).toBe(
      true
    );
    expect(selected.find(({ code }) => code === "AI_ISSUE_INTAKE")?.selectedEnabled).toBe(false);

    expect(() =>
      resolveProjectCapabilitySelections(policies, [
        { code: "SUPPLIER_COLLABORATION", enabled: false }
      ])
    ).toThrowError(expect.objectContaining({ code: "TEMPLATE_CAPABILITY_REQUIRED" }));
    expect(() =>
      resolveProjectCapabilitySelections(policies, [{ code: "UPH_ANALYSIS", enabled: true }])
    ).toThrowError(expect.objectContaining({ code: "TEMPLATE_CAPABILITY_NOT_ALLOWED" }));
    expect(() =>
      resolveProjectCapabilitySelections(policies, [
        { code: "CUSTOMER_PROGRESS_SHARING", enabled: true },
        { code: "CUSTOMER_PROGRESS_SHARING", enabled: false }
      ])
    ).toThrowError(expect.objectContaining({ code: "DUPLICATE_CAPABILITY_SELECTION" }));
  });

  it("requires all three levels for an effective capability", () => {
    expect(
      capabilityEffectiveState({
        companyEnabled: false,
        templateAllowed: true,
        selectedEnabled: true
      })
    ).toEqual({ effectiveEnabled: false, disabledReasons: ["COMPANY_DISABLED"] });
    expect(
      capabilityEffectiveState({
        companyEnabled: true,
        templateAllowed: false,
        selectedEnabled: false
      })
    ).toEqual({
      effectiveEnabled: false,
      disabledReasons: ["TEMPLATE_NOT_ALLOWED", "PROJECT_NOT_SELECTED"]
    });
    expect(
      capabilityEffectiveState({
        companyEnabled: true,
        templateAllowed: true,
        selectedEnabled: true
      })
    ).toEqual({ effectiveEnabled: true, disabledReasons: [] });
  });
});
