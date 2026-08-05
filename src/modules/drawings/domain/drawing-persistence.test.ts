import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("APM-052 drawing persistence", () => {
  it("keeps drawing attributes separate from manufacturing and freezes exact version files", async () => {
    const schema = await readFile("prisma/schema.prisma", "utf8");
    const migration = await readFile(
      "prisma/migrations/20260805070000_apm_052_mechanical_drawings/migration.sql",
      "utf8"
    );

    expect(schema).toContain("model MechanicalDrawing {");
    expect(schema).toContain("model MechanicalDrawingVersionFile {");
    expect(schema).toContain("model MechanicalDrawingImportBatch {");
    expect(schema).not.toContain("manufacturingCategory");
    expect(schema).not.toContain("supplierCapability");
    expect(migration).toContain('ON "mechanical_drawings"("project_id", "drawing_number")');
    expect(migration).toContain("mechanical drawing number must equal controlled document code");
    expect(migration).toContain("drawing version file facts are immutable");
    expect(migration).toContain("drawing facts must be retained instead of removed");
  });
});
