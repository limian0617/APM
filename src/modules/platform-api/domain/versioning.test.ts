import { describe, expect, it } from "vitest";

import { EXTERNAL_API_V1_PREFIX, classifyApiPath } from "./versioning";

describe("API version boundaries", () => {
  it("keeps external v1 separate from compatible internal APIs", () => {
    expect(EXTERNAL_API_V1_PREFIX).toBe("/api/external/v1");
    expect(classifyApiPath("/api/projects/project-1")).toBe("internal");
    expect(classifyApiPath("/api/external/v1/supplier-packages")).toBe("external-v1");
    expect(classifyApiPath("/projects/project-1")).toBe("outside-api");
  });
});
