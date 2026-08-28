import { beforeEach, describe, expect, it, vi } from "vitest";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const classification = vi.hoisted(() => ({ getDrawingClassification: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/drawings/application/drawing-classification-service", () => classification);

import { GET } from "./route";

describe("drawing classification route", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    classification.getDrawingClassification.mockReset();
  });

  it("uses project-scoped controlled-document permission and path IDs", async () => {
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "engineer-1" },
      project: { departmentId: "engineering" }
    });
    classification.getDrawingClassification.mockResolvedValue({
      projectId: "project-1",
      drawingId: "drawing-1",
      category: null,
      processTags: []
    });
    const response = await GET(
      new Request("http://localhost/api/projects/project-1/drawings/drawing-1/classification"),
      { params: Promise.resolve({ projectId: "project-1", drawingId: "drawing-1" }) }
    );
    expect(response.status).toBe(200);
    expect(projectGuard.authorizeProjectRequest).toHaveBeenCalledWith(
      expect.any(Request),
      "project-1",
      "CONTROLLED_DOCUMENT_READ"
    );
    expect(classification.getDrawingClassification).toHaveBeenCalledWith({
      projectId: "project-1",
      drawingId: "drawing-1"
    });
  });
});
