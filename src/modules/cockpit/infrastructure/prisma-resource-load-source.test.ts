import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { loadResourceLoadProjectionSource } from "./prisma-resource-load-source";

describe("APM-042 resource-load Prisma source", () => {
  it("reads only the current project's active task ownership facts", async () => {
    const findTasks = vi.fn().mockResolvedValue([
      {
        id: "task-1",
        code: "DESIGN",
        name: "Mechanical design",
        version: 3,
        status: "NOT_STARTED",
        plannedStartAt: new Date("2026-08-03T09:00:00.000Z"),
        plannedFinishAt: new Date("2026-08-05T17:00:00.000Z"),
        ownerMembership: {
          id: "membership-1",
          version: 2,
          departmentId: "engineering",
          projectRole: "ENGINEER",
          user: { id: "user-1", name: "Mechanical Engineer" }
        }
      }
    ]);
    const client = {
      project: {
        findUnique: vi.fn().mockResolvedValue({
          id: "project-1",
          version: 4,
          updatedAt: new Date("2026-08-05T00:00:00.000Z")
        })
      },
      planningTask: { findMany: findTasks }
    } as unknown as Prisma.TransactionClient;

    const source = await loadResourceLoadProjectionSource(client, "project-1");

    expect(findTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: "project-1",
          status: { in: ["NOT_STARTED", "IN_PROGRESS"] }
        }
      })
    );
    expect(source).toEqual({
      rows: [
        {
          ownerMembershipId: "membership-1",
          personId: "user-1",
          personName: "Mechanical Engineer",
          departmentId: "engineering",
          discipline: "ENGINEER",
          taskId: "task-1",
          taskCode: "DESIGN",
          taskName: "Mechanical design",
          plannedStartAt: new Date("2026-08-03T09:00:00.000Z"),
          plannedFinishAt: new Date("2026-08-05T17:00:00.000Z")
        }
      ],
      sourceVersions: {
        project: { id: "project-1", version: 4, updatedAt: "2026-08-05T00:00:00.000Z" },
        tasks: [
          {
            taskId: "task-1",
            version: 3,
            status: "NOT_STARTED",
            ownerMembershipId: "membership-1",
            personId: "user-1",
            personName: "Mechanical Engineer",
            membershipVersion: 2,
            departmentId: "engineering",
            discipline: "ENGINEER",
            plannedStartAt: "2026-08-03T09:00:00.000Z",
            plannedFinishAt: "2026-08-05T17:00:00.000Z"
          }
        ]
      }
    });
  });

  it("returns null before querying task ownership when the project does not exist", async () => {
    const findTasks = vi.fn();
    const client = {
      project: { findUnique: vi.fn().mockResolvedValue(null) },
      planningTask: { findMany: findTasks }
    } as unknown as Prisma.TransactionClient;

    await expect(loadResourceLoadProjectionSource(client, "missing-project")).resolves.toBeNull();
    expect(findTasks).not.toHaveBeenCalled();
  });
});
