import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("POST /api/notification-templates/[code]/versions", () => {
  it("rejects unauthenticated template publication", async () => {
    const response = await POST(
      new Request("http://localhost/api/notification-templates/TEST/versions", {
        method: "POST",
        body: JSON.stringify({})
      }),
      { params: Promise.resolve({ code: "TEST" }) }
    );
    expect(response.status).toBe(401);
  });
});
