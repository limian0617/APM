import { describe, expect, it } from "vitest";

import { ApiContractError } from "@/modules/platform-api/contracts/errors";

import { parseResourceLoadRefreshPayload } from "./resource-load-http";

describe("APM-042 resource-load HTTP contract", () => {
  it("accepts a refresh reason but rejects undeclared fields", () => {
    expect(parseResourceLoadRefreshPayload({ reason: "Refresh resource load" })).toEqual({
      reason: "Refresh resource load"
    });
    expect(() =>
      parseResourceLoadRefreshPayload({ reason: "Refresh resource load", force: true })
    ).toThrow(ApiContractError);
  });
});
