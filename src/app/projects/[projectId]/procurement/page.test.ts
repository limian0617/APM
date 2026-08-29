import { describe, expect, it } from "vitest";

import { developmentProcurementFixture } from "./page";

describe("developmentProcurementFixture", () => {
  it("supplies an explicit ready change-impact area for normal browser acceptance", () => {
    const state = developmentProcurementFixture("project-1", "normal");

    expect(state).toMatchObject({
      status: "ready",
      changeImpacts: {
        status: "ready",
        data: { impacts: [{ id: "impact-demo-1", status: "OPEN" }] }
      }
    });
  });
});
