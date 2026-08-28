import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /api/projects/[projectId]/files/[fileId]/download", () => {
  it("rejects unauthenticated downloads before file or storage lookup", async () => {
    const response = await GET(
      new Request("http://localhost/api/projects/project-1/files/file-1/download"),
      { params: Promise.resolve({ projectId: "project-1", fileId: "file-1" }) }
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "UNAUTHENTICATED" } });
  });
});
