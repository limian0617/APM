import { describe, expect, it } from "vitest";

import {
  ManufacturingClassificationError,
  assertDrawingSelectionPurpose,
  assertSelectionMutable,
  matchesSupplierCapability,
  normalizeDrawingClassification,
  normalizeManufacturingCategoryCodes,
  validateDrawingSelectionQuantities,
  validateSupplierExceptionReason
} from "./manufacturing-classification";

describe("APM-053 manufacturing classification rules", () => {
  it("normalizes one primary category and several unique process tags", () => {
    expect(
      normalizeDrawingClassification({
        categoryCode: " machining ",
        processTagCodes: ["turning", " Milling "]
      })
    ).toEqual({ categoryCode: "MACHINING", processTagCodes: ["MILLING", "TURNING"] });
  });

  it("rejects invalid category codes and duplicate normalized category or process-tag codes", () => {
    expect(() =>
      normalizeDrawingClassification({ categoryCode: "machine shop", processTagCodes: [] })
    ).toThrowError(
      expect.objectContaining({ code: "MANUFACTURING_CATEGORY_CODE_INVALID", status: 422 })
    );
    expect(() => normalizeManufacturingCategoryCodes(["machining", " MACHINING "])).toThrowError(
      expect.objectContaining({ code: "MANUFACTURING_CATEGORY_CODE_DUPLICATE", status: 409 })
    );
    expect(() =>
      normalizeDrawingClassification({
        categoryCode: "MACHINING",
        processTagCodes: ["turning", " TURNING "]
      })
    ).toThrowError(expect.objectContaining({ code: "PROCESS_TAG_CODE_DUPLICATE", status: 409 }));
  });

  it("requires category equality and coverage for every drawing process tag", () => {
    expect(
      matchesSupplierCapability(
        { categoryCode: "MACHINING", processTagCodes: ["MILLING", "TURNING"] },
        { categoryCode: "MACHINING", processTagCodes: ["TURNING", "MILLING", "GRINDING"] }
      )
    ).toBe(true);
    expect(
      matchesSupplierCapability(
        { categoryCode: "MACHINING", processTagCodes: ["MILLING"] },
        { categoryCode: "MACHINING", processTagCodes: [] }
      )
    ).toBe(false);
    expect(
      matchesSupplierCapability(
        { categoryCode: "SHEET_METAL", processTagCodes: [] },
        { categoryCode: "MACHINING", processTagCodes: ["MILLING"] }
      )
    ).toBe(false);
  });

  it("matches zero-tag machining and sheet-metal drawings by category alone", () => {
    expect(
      matchesSupplierCapability(
        { categoryCode: "MACHINING", processTagCodes: [] },
        { categoryCode: "MACHINING", processTagCodes: [] }
      )
    ).toBe(true);
    expect(
      matchesSupplierCapability(
        { categoryCode: "SHEET_METAL", processTagCodes: [] },
        { categoryCode: "SHEET_METAL", processTagCodes: ["BENDING"] }
      )
    ).toBe(true);
  });

  it("accepts only explicit selection purposes and valid quantities", () => {
    expect(assertDrawingSelectionPurpose("manufacturing")).toBe("MANUFACTURING");
    expect(validateDrawingSelectionQuantities({ quantity: 2.5, spareQuantity: 0 })).toEqual({
      quantity: 2.5,
      spareQuantity: 0
    });
    expect(() => assertDrawingSelectionPurpose("RFQ")).toThrowError(
      expect.objectContaining({ code: "DRAWING_SELECTION_PURPOSE_INVALID", status: 422 })
    );
    expect(() =>
      validateDrawingSelectionQuantities({ quantity: 0, spareQuantity: 0 })
    ).toThrowError(
      expect.objectContaining({ code: "DRAWING_SELECTION_QUANTITY_INVALID", status: 422 })
    );
    expect(() =>
      validateDrawingSelectionQuantities({ quantity: 1, spareQuantity: -1 })
    ).toThrowError(
      expect.objectContaining({ code: "DRAWING_SELECTION_SPARE_QUANTITY_INVALID", status: 422 })
    );
  });

  it("requires an exception reason for an unmatched chosen supplier", () => {
    expect(
      validateSupplierExceptionReason({
        supplierReferenceId: "supplier-1",
        isDefaultMatch: false,
        exceptionReason: "Approved for its existing fixture."
      })
    ).toBe("Approved for its existing fixture.");
    expect(() =>
      validateSupplierExceptionReason({
        supplierReferenceId: "supplier-1",
        isDefaultMatch: false,
        exceptionReason: " "
      })
    ).toThrowError(
      expect.objectContaining({ code: "SUPPLIER_EXCEPTION_REASON_REQUIRED", status: 422 })
    );
  });

  it("rejects mutation of locked selection sets with a stable typed error", () => {
    expect(assertSelectionMutable("DRAFT")).toBeUndefined();
    expect(() => assertSelectionMutable("LOCKED")).toThrowError(ManufacturingClassificationError);
    expect(() => assertSelectionMutable("LOCKED")).toThrowError(
      expect.objectContaining({ code: "DRAWING_SELECTION_LOCKED", status: 409 })
    );
  });
});
