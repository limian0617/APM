import { beforeEach, describe, expect, it, vi } from "vitest";

import { ManufacturingClassificationError } from "@/modules/drawings/domain/manufacturing-classification";

const projectGuard = vi.hoisted(() => ({ authorizeProjectRequest: vi.fn() }));
const drawingService = vi.hoisted(() => ({ confirmMechanicalDrawingImportBatch: vi.fn() }));
const idempotent = vi.hoisted(() => ({ idempotentCommandResponse: vi.fn() }));

vi.mock("@/lib/auth/project-guard", () => projectGuard);
vi.mock("@/modules/drawings/application/mechanical-drawing-service", () => drawingService);
vi.mock("@/modules/platform-api/application/idempotent-command", () => idempotent);

import { POST } from "./route";

describe("mechanical drawing import confirmation route", () => {
  beforeEach(() => {
    projectGuard.authorizeProjectRequest.mockReset();
    drawingService.confirmMechanicalDrawingImportBatch.mockReset();
    idempotent.idempotentCommandResponse.mockReset();
    projectGuard.authorizeProjectRequest.mockResolvedValue({
      authorized: true,
      actor: { id: "engineer-1" },
      project: { id: "project-1", departmentId: "engineering" }
    });
    idempotent.idempotentCommandResponse.mockImplementation(async ({ execute }) => execute({}));
  });

  it("maps a disabled manufacturing category to a deterministic 409 response", async () => {
    drawingService.confirmMechanicalDrawingImportBatch.mockRejectedValue(
      new ManufacturingClassificationError(
        "INACTIVE_CLASSIFICATION",
        "制造分类 MACHINING 已停用，不能用于新图纸。",
        409
      )
    );

    const response = await POST(
      new Request("http://localhost/api/projects/project-1/drawing-imports/batch-1/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "disabled-import-manufacturing-category"
        },
        body: JSON.stringify({
          version: 1,
          decisions: [
            {
              itemId: "item-1",
              action: "CONFIRM",
              drawingNumber: "DWG-001",
              title: "Disabled category drawing",
              drawingType: "PART",
              manufacturingCategoryCode: "MACHINING"
            }
          ],
          reason: "reject disabled manufacturing category"
        })
      }),
      { params: Promise.resolve({ projectId: "project-1", batchId: "batch-1" }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INACTIVE_CLASSIFICATION" }
    });
  });
});
