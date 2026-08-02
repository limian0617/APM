import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import { createProjectBodySchema } from "@/modules/platform-api/contracts/internal-routes";

const valid = {
  code: "PRJ-001",
  name: "项目一",
  departmentId: "engineering",
  templateCode: "STANDARD.LINE",
  templateVersion: 1,
  templateChecksum: "a".repeat(64),
  reason: "创建交付项目"
};

describe("APM-011 project create HTTP contract", () => {
  it("accepts the exact published template selector", () => {
    expect(parseDto(createProjectBodySchema, valid, "body")).toEqual(valid);
  });

  it("rejects unknown fields, unstable project codes, and malformed checksums", () => {
    expect(() => parseDto(createProjectBodySchema, { ...valid, extra: true }, "body")).toThrowError(
      ApiContractError
    );
    expect(() =>
      parseDto(createProjectBodySchema, { ...valid, code: "prj-1" }, "body")
    ).toThrowError(ApiContractError);
    expect(() =>
      parseDto(createProjectBodySchema, { ...valid, templateChecksum: "bad" }, "body")
    ).toThrowError(ApiContractError);
  });
});
