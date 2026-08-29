import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("APM-062 asset Release API", () => {
  it("default-denies an unauthenticated Release creation before parsing or writing", async () => {
    await expect(
      POST(
        new Request("http://localhost/api/technical-assets/asset-1/releases", {
          method: "POST",
          body: "not-json"
        }),
        { params: Promise.resolve({ technicalAssetId: "asset-1" }) }
      )
    ).resolves.toMatchObject({ status: 401 });
  });
});
