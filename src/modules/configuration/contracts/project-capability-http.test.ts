import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  confirmProjectCapabilitiesBodySchema,
  projectCapabilityBodySchema,
  projectCapabilityPathSchema
} from "@/modules/platform-api/contracts/internal-routes";

describe("APM-013 project capability HTTP contract", () => {
  const confirmation = {
    projectVersion: 1,
    selections: [
      { code: "SUPPLIER_COLLABORATION" as const, enabled: true },
      { code: "CUSTOMER_PROGRESS_SHARING" as const, enabled: false }
    ],
    reason: "确认项目能力"
  };

  it("accepts exact confirmation, path, and update DTOs", () => {
    expect(parseDto(confirmProjectCapabilitiesBodySchema, confirmation, "body")).toEqual(
      confirmation
    );
    expect(
      parseDto(
        projectCapabilityPathSchema,
        { projectId: "project-1", capabilityCode: "UPH_ANALYSIS" },
        "path"
      )
    ).toEqual({ projectId: "project-1", capabilityCode: "UPH_ANALYSIS" });
    expect(
      parseDto(
        projectCapabilityBodySchema,
        { version: 1, enabled: true, reason: "启用UPH" },
        "body"
      )
    ).toEqual({ version: 1, enabled: true, reason: "启用UPH" });
  });

  it("rejects unknown fields, unknown capabilities, and invalid values", () => {
    expect(() =>
      parseDto(confirmProjectCapabilitiesBodySchema, { ...confirmation, extra: true }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(
        confirmProjectCapabilitiesBodySchema,
        {
          ...confirmation,
          selections: [{ code: "UNKNOWN_CAPABILITY", enabled: true }]
        },
        "body"
      )
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(projectCapabilityBodySchema, { version: 0, enabled: "true", reason: "启用" }, "body")
    ).toThrowError(ApiContractError);
  });
});
