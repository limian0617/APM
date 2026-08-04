import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { loadCockpitProjectionSource } from "./prisma-cockpit-source";

describe("APM-040 cockpit Prisma source", () => {
  it("reads only persisted active alert statuses", async () => {
    const findAlerts = vi.fn().mockResolvedValue([]);
    const client = {
      project: {
        findUnique: vi.fn().mockResolvedValue({
          id: "project-1",
          version: 1,
          updatedAt: new Date("2026-08-05T00:00:00.000Z")
        })
      },
      projectScheduleState: { findUnique: vi.fn().mockResolvedValue(null) },
      projectGateInstance: { findMany: vi.fn().mockResolvedValue([]) },
      projectAlert: { findMany: findAlerts },
      projectMilestone: { findMany: vi.fn().mockResolvedValue([]) },
      projectAlertScan: { findFirst: vi.fn().mockResolvedValue(null) }
    } as unknown as Prisma.TransactionClient;

    await loadCockpitProjectionSource(client, "project-1", new Date("2026-08-05T00:00:00.000Z"));

    expect(findAlerts).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["TRIGGERED", "ACKNOWLEDGED", "IN_PROGRESS"] }
        })
      })
    );
  });
});
