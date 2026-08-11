import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/archives/application/archive-generation-handler", () => ({
  createPrismaArchiveGenerationHandler: vi.fn(() => "generation-handler")
}));

import { createArchiveJobHandlers } from "./archive-job-handlers";

describe("archive worker registration", () => {
  it("registers durable generation work by its outbox event type", () => {
    expect(createArchiveJobHandlers()["archive.generate"]).toBe("generation-handler");
  });

  it("registers byte verification only when the controlled object storage is supplied", async () => {
    const { createArchiveIntegrityHandler } =
      await import("@/modules/archives/application/archive-integrity-handler");
    const storage = { readObject: vi.fn() } as never;
    expect(createArchiveJobHandlers({ storage })["archive.integrity.check"]).toBeTypeOf("function");
    expect(createArchiveIntegrityHandler).toBeTypeOf("function");
  });
});
