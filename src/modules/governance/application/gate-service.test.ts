import { describe, expect, it } from "vitest";

import { resolveAcceptanceConfirmationScope } from "./gate-service";

describe("APM-102 acceptance confirmation Gate scope", () => {
  it("maps a module Gate target to its matching MACHINE acceptance scope", () => {
    expect(
      resolveAcceptanceConfirmationScope({
        projectId: "project-1",
        scope: { scope: "MODULE", deliveryUnitId: "delivery-1", moduleId: "machine-1" }
      })
    ).toEqual({ scopeType: "MACHINE", scopeId: "machine-1" });
  });
});
