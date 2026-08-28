import { describe, expect, it, vi } from "vitest";

import {
  ProjectWritePolicyError,
  assertProjectWritable,
  assertProjectWritableById
} from "./project-write-policy";

describe("project write policy", () => {
  it("rejects all business writes after closure or cancellation", () => {
    for (const status of ["CLOSED", "CANCELED"] as const) {
      expect(() => assertProjectWritable(status)).toThrowError(
        expect.objectContaining({ code: "PROJECT_READ_ONLY", status: 409 })
      );
    }
    expect(() => assertProjectWritable("IN_PROGRESS")).not.toThrow();
  });

  it("reads the project status at the server boundary before a drawing write", async () => {
    const findUnique = vi.fn(async () => ({ status: "CLOSED" }));
    await expect(
      assertProjectWritableById({ project: { findUnique } }, "p1")
    ).rejects.toMatchObject({
      code: "PROJECT_READ_ONLY",
      status: 409
    });
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "p1" }, select: { status: true } });
  });
});
