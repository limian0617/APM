import { describe, expect, it } from "vitest";

import { ApiContractError } from "@/modules/platform-api/contracts/errors";

import { parseCockpitRefreshPayload } from "./cockpit-http";

describe("APM-040 cockpit HTTP contract", () => {
  it("accepts a refresh reason but rejects undeclared fields", () => {
    expect(parseCockpitRefreshPayload({ reason: "重新计算驾驶舱投影" })).toEqual({
      reason: "重新计算驾驶舱投影"
    });

    expect(() => parseCockpitRefreshPayload({ reason: "重新计算驾驶舱投影", force: true })).toThrow(
      ApiContractError
    );
  });
});
