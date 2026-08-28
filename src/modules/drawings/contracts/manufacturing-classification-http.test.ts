import { describe, expect, it } from "vitest";

import { parseDto } from "@/modules/platform-api/contracts/dto";
import { ApiContractError } from "@/modules/platform-api/contracts/errors";
import {
  addDrawingSelectionItemBodySchema,
  drawingSupplierMatchQuerySchema,
  drawingSelectionSetPathSchema,
  updateDrawingClassificationBodySchema,
  updateSupplierManufacturingCapabilityBodySchema
} from "@/modules/platform-api/contracts/internal-routes";

import { manufacturingClassificationErrorResponse } from "./manufacturing-classification-http";
import { ManufacturingClassificationError } from "../domain/manufacturing-classification";

describe("APM-053 manufacturing classification HTTP contracts", () => {
  const addSelectionItem = {
    drawingId: "drawing-1",
    documentVersionId: "version-1",
    quantity: 2,
    spareQuantity: 0,
    requiredOn: "2026-09-01",
    supplierReferenceId: null,
    purpose: "INQUIRY",
    exceptionReason: null,
    version: 1,
    reason: "add exact published drawing"
  };

  it("accepts only client-owned drawing selection item fields", () => {
    expect(parseDto(addDrawingSelectionItemBodySchema, addSelectionItem, "body")).toEqual(
      addSelectionItem
    );
    expect(
      parseDto(
        drawingSelectionSetPathSchema,
        { projectId: "project-1", selectionSetId: "selection-1" },
        "path"
      )
    ).toEqual({ projectId: "project-1", selectionSetId: "selection-1" });
  });

  it.each(["2026-02-29", "2026-02-31"])(
    "rejects impossible selection required dates with the 422 DTO contract: %s",
    (requiredOn) => {
      try {
        parseDto(addDrawingSelectionItemBodySchema, { ...addSelectionItem, requiredOn }, "body");
        throw new Error("expected invalid requiredOn date to be rejected");
      } catch (error) {
        expect(error).toMatchObject({
          code: "VALIDATION_FAILED",
          status: 422,
          issues: [expect.objectContaining({ field: "body.requiredOn" })]
        });
      }
    }
  );

  it.each(["0000-01-01", "0099-01-01", "0000-02-29"])(
    "accepts valid proleptic-Gregorian selection required dates: %s",
    (requiredOn) => {
      expect(
        parseDto(addDrawingSelectionItemBodySchema, { ...addSelectionItem, requiredOn }, "body")
      ).toMatchObject({ requiredOn });
    }
  );

  it("rejects a non-leap-day in proleptic year 0099 with the 422 DTO contract", () => {
    try {
      parseDto(
        addDrawingSelectionItemBodySchema,
        { ...addSelectionItem, requiredOn: "0099-02-29" },
        "body"
      );
      throw new Error("expected invalid requiredOn date to be rejected");
    } catch (error) {
      expect(error).toMatchObject({
        code: "VALIDATION_FAILED",
        status: 422,
        issues: [expect.objectContaining({ field: "body.requiredOn" })]
      });
    }
  });

  it("rejects server-calculated classification and supplier snapshots", () => {
    expect(() =>
      parseDto(
        addDrawingSelectionItemBodySchema,
        {
          ...addSelectionItem,
          manufacturingCategoryCodeSnapshot: "MACHINING",
          processTagCodesSnapshot: ["MILLING"],
          supplierCapabilitySnapshotJson: { supplierReferenceId: "supplier-1" }
        },
        "body"
      )
    ).toThrowError(ApiContractError);
  });

  it("requires complete optimistic command bodies and rejects unknown fields", () => {
    expect(
      parseDto(
        updateDrawingClassificationBodySchema,
        { categoryId: "category-1", processTagIds: ["tag-1"], version: 2, reason: "reclassify" },
        "body"
      )
    ).toMatchObject({ version: 2 });
    expect(() =>
      parseDto(
        updateSupplierManufacturingCapabilityBodySchema,
        {
          manufacturingCategoryId: "category-1",
          processTagIds: [],
          version: 1,
          isActive: true,
          reason: "set capability",
          projectId: "project-1"
        },
        "body"
      )
    ).toThrowError(ApiContractError);
  });

  it("parses only a normalized manufacturing match query", () => {
    expect(
      parseDto(
        drawingSupplierMatchQuerySchema,
        { categoryCode: "machining", processTagCodes: "milling, turning" },
        "query"
      )
    ).toEqual({ categoryCode: "MACHINING", processTagCodes: ["MILLING", "TURNING"] });
    expect(() =>
      parseDto(
        drawingSupplierMatchQuerySchema,
        { categoryCode: "MACHINING", ignored: "supplier-1" },
        "query"
      )
    ).toThrowError(ApiContractError);
  });

  it("maps a stale selection version to a 409 API response", async () => {
    const response = manufacturingClassificationErrorResponse(
      new ManufacturingClassificationError("VERSION_CONFLICT", "selection changed", 409)
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toMatchObject({
      error: { code: "VERSION_CONFLICT" }
    });
  });
});
