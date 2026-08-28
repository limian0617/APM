import { beforeEach, describe, expect, it, vi } from "vitest";

import { ManufacturingClassificationError } from "@/modules/drawings/domain/manufacturing-classification";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const drawingService = vi.hoisted(() => ({
  createMechanicalDrawing: vi.fn(),
  listMechanicalDrawings: vi.fn()
}));
const idempotent = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/drawings/application/mechanical-drawing-service", () => drawingService);
vi.mock("@/modules/platform-api/application/idempotent-command", () => idempotent);

import { POST } from "./route";

describe("mechanical drawing create route", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    drawingService.createMechanicalDrawing.mockReset();
    idempotent.idempotentCommandResponse.mockReset();
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "engineer-1" },
      project: { id: "project-1", departmentId: "engineering" }
    });
    idempotent.idempotentCommandResponse.mockImplementation(async ({ execute }) => execute({}));
  });

  it("maps a disabled manufacturing category to a deterministic 409 response", async () => {
    drawingService.createMechanicalDrawing.mockRejectedValue(
      new ManufacturingClassificationError(
        "INACTIVE_CLASSIFICATION",
        "制造分类 MACHINING 已停用，不能用于新图纸。",
        409
      )
    );

    const response = await POST(
      new Request("http://localhost/api/projects/project-1/drawings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "disabled-manufacturing-category"
        },
        body: JSON.stringify({
          drawingNumber: "DWG-001",
          title: "Disabled category drawing",
          drawingType: "PART",
          manufacturingCategoryCode: "MACHINING",
          cadSourceFileId: "cad-file-1",
          pdfPreviewFileId: null,
          stepExchangeFileIds: [],
          reason: "reject disabled manufacturing category"
        })
      }),
      { params: Promise.resolve({ projectId: "project-1" }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INACTIVE_CLASSIFICATION" }
    });
  });
});
