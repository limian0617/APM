import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ProjectAssetUsageError } from "../domain/project-asset-usage";
import { canonicalJson } from "@/modules/governance/domain/idempotency";
import {
  getAssetUsageSnapshotForAcceptance,
  selectAssetUsageSnapshotRows
} from "./project-asset-usage-service";

const rows = [
  {
    id: "project",
    scopeType: "PROJECT",
    scopeId: "project-1",
    deliveryUnitId: null,
    moduleId: null
  },
  {
    id: "unit",
    scopeType: "DELIVERY_UNIT",
    scopeId: "unit-1",
    deliveryUnitId: "unit-1",
    moduleId: null
  },
  {
    id: "module-a",
    scopeType: "MODULE",
    scopeId: "module-a",
    deliveryUnitId: "unit-1",
    moduleId: "module-a"
  },
  {
    id: "module-b",
    scopeType: "MODULE",
    scopeId: "module-b",
    deliveryUnitId: "unit-1",
    moduleId: "module-b"
  }
] as const;

const frozenAt = new Date("2026-08-20T10:00:00.000Z");

type SnapshotUsage = {
  id: string;
  version: number;
  usageKey: string;
  quantity: { toString(): string };
  configurationJson: Record<string, unknown>;
  scopeType: "PROJECT" | "DELIVERY_UNIT" | "MODULE";
  scopeId: string;
  deliveryUnitId: string | null;
  moduleId: string | null;
  referenceId: string;
  technicalAssetId: string;
  assetReleaseId: string;
  assetReleaseVersionId: string;
  releaseRevision: number;
  snapshotChecksum: string;
  sourceWatermark: string;
  componentSnapshotId: string;
  status: "ACTIVE" | "RETIRED";
  createdAt: Date;
  retiredAt: Date | null;
};

function usage(overrides: Partial<SnapshotUsage> = {}): SnapshotUsage {
  return {
    id: "usage-1",
    version: 7,
    usageKey: "USAGE-001",
    quantity: { toString: () => "1.250000" },
    configurationJson: { purpose: "FAT fixture", parameters: { axis: "X", enabled: true } },
    scopeType: "PROJECT",
    scopeId: "project-1",
    deliveryUnitId: null,
    moduleId: null,
    referenceId: "reference-1",
    technicalAssetId: "asset-1",
    assetReleaseId: "release-1",
    assetReleaseVersionId: "release-version-1",
    releaseRevision: 3,
    snapshotChecksum: "a".repeat(64),
    sourceWatermark: "release-watermark-1",
    componentSnapshotId: "component-1",
    status: "ACTIVE",
    createdAt: new Date("2026-08-20T09:00:00.000Z"),
    retiredAt: null,
    ...overrides
  };
}

function snapshotClient(input: {
  rows: SnapshotUsage[];
  unit?: { unitType: string; status: string } | null;
  module?: {
    deliveryUnitId: string;
    status: string;
    deliveryUnit: { projectId: string; status: string };
  } | null;
}) {
  const calls = { moduleReads: 0, usageWhere: null as unknown };
  return {
    calls,
    client: {
      deliveryUnit: {
        findFirst: async () => input.unit ?? { unitType: "MACHINE", status: "ACTIVE" }
      },
      projectModule: {
        findFirst: async () => {
          calls.moduleReads += 1;
          return (
            input.module ?? {
              deliveryUnitId: "unit-1",
              status: "ACTIVE",
              deliveryUnit: { projectId: "project-1", status: "ACTIVE" }
            }
          );
        }
      },
      projectAssetUsage: {
        findMany: async ({
          where
        }: {
          where: {
            createdAt: { lte: Date };
            OR: Array<{ status: "ACTIVE" } | { status: "RETIRED"; retiredAt: { gt: Date } }>;
          };
        }) => {
          calls.usageWhere = where;
          return input.rows.filter(
            (row) =>
              row.createdAt <= where.createdAt.lte &&
              (row.status === "ACTIVE" ||
                (row.retiredAt !== null && row.retiredAt > where.createdAt.lte))
          );
        }
      }
    } as never
  };
}

describe("APM-063 AssetUsageSnapshot scope aggregation", () => {
  it("rejects PROJECT scope that does not use the current project ID", () => {
    expect(() =>
      selectAssetUsageSnapshotRows({
        rows: [...rows],
        projectId: "project-1",
        scopeType: "PROJECT",
        scopeId: "other-project"
      })
    ).toThrow(ProjectAssetUsageError);
  });

  it("includes PROJECT usage for delivery-unit and machine scopes", () => {
    for (const scopeType of ["DELIVERY_UNIT", "MACHINE"] as const) {
      expect(
        selectAssetUsageSnapshotRows({
          rows: [...rows],
          projectId: "project-1",
          scopeType,
          scopeId: "unit-1"
        }).map((row) => row.id)
      ).toEqual(["project", "unit", "module-a", "module-b"]);
    }
  });

  it("includes only the parent unit and selected module, never a sibling module", () => {
    expect(
      selectAssetUsageSnapshotRows({
        rows: [...rows],
        projectId: "project-1",
        scopeType: "MODULE",
        scopeId: "module-a",
        parentDeliveryUnitId: "unit-1"
      }).map((row) => row.id)
    ).toEqual(["project", "unit", "module-a"]);
  });

  it("rejects disabled or cross-project module parents at the snapshot service boundary", async () => {
    for (const projectModule of [
      {
        deliveryUnitId: "unit-1",
        status: "ACTIVE",
        deliveryUnit: { projectId: "project-1", status: "DISABLED" }
      },
      {
        deliveryUnitId: "unit-1",
        status: "ACTIVE",
        deliveryUnit: { projectId: "other-project", status: "ACTIVE" }
      }
    ]) {
      const { client } = snapshotClient({ rows: [usage()], module: projectModule });
      await expect(
        getAssetUsageSnapshotForAcceptance(
          {
            projectId: "project-1",
            acceptanceType: "FAT",
            scopeType: "MODULE",
            scopeId: "module-1",
            frozenAt
          },
          client
        )
      ).rejects.toMatchObject({ code: "PROJECT_ASSET_SNAPSHOT_SCOPE_INVALID", status: 404 });
    }
  });

  it("selects the frozen active interval and exposes every exact frozen usage fact", async () => {
    const { client, calls } = snapshotClient({
      rows: [
        usage(),
        usage({
          id: "retired-after",
          usageKey: "USAGE-002",
          status: "RETIRED",
          retiredAt: new Date("2026-08-20T11:00:00.000Z")
        }),
        usage({
          id: "retired-before",
          usageKey: "USAGE-003",
          status: "RETIRED",
          retiredAt: new Date("2026-08-20T09:30:00.000Z")
        }),
        usage({
          id: "created-after",
          usageKey: "USAGE-004",
          createdAt: new Date("2026-08-20T10:30:00.000Z")
        })
      ]
    });

    const result = await getAssetUsageSnapshotForAcceptance(
      {
        projectId: "project-1",
        acceptanceType: "FAT",
        scopeType: "PROJECT",
        scopeId: "project-1",
        frozenAt
      },
      client
    );

    expect(calls.usageWhere).toMatchObject({
      projectId: "project-1",
      createdAt: { lte: frozenAt },
      OR: [{ status: "ACTIVE" }, { status: "RETIRED", retiredAt: { gt: frozenAt } }]
    });
    const entries = (result.snapshot as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries.map((entry) => entry.usageId)).toEqual(["usage-1", "retired-after"]);
    expect(entries[0]).toMatchObject({
      usageId: "usage-1",
      version: 7,
      usageVersion: 7,
      usageKey: "USAGE-001",
      quantity: "1.250000",
      purpose: "FAT fixture",
      configuration: { purpose: "FAT fixture", parameters: { axis: "X", enabled: true } },
      scopeType: "PROJECT",
      scopeId: "project-1",
      deliveryUnitId: null,
      moduleId: null,
      referenceId: "reference-1",
      technicalAssetId: "asset-1",
      assetReleaseId: "release-1",
      assetReleaseVersionId: "release-version-1",
      revision: 3,
      snapshotChecksum: "a".repeat(64),
      sourceWatermark: "release-watermark-1",
      componentSnapshotId: "component-1"
    });
  });

  it("replays the ACTIVE version and checksum when a usage is retired after frozenAt", async () => {
    const activeBeforeRetire = snapshotClient({ rows: [usage({ version: 1 })] });
    const retiredAfterFrozenAt = snapshotClient({
      rows: [
        usage({
          version: 2,
          status: "RETIRED",
          retiredAt: new Date("2026-08-20T11:00:00.000Z")
        })
      ]
    });
    const before = await getAssetUsageSnapshotForAcceptance(
      {
        projectId: "project-1",
        acceptanceType: "FAT",
        scopeType: "PROJECT",
        scopeId: "project-1",
        frozenAt
      },
      activeBeforeRetire.client
    );
    const historical = await getAssetUsageSnapshotForAcceptance(
      {
        projectId: "project-1",
        acceptanceType: "FAT",
        scopeType: "PROJECT",
        scopeId: "project-1",
        frozenAt
      },
      retiredAfterFrozenAt.client
    );
    const current = await getAssetUsageSnapshotForAcceptance(
      {
        projectId: "project-1",
        acceptanceType: "FAT",
        scopeType: "PROJECT",
        scopeId: "project-1",
        frozenAt: new Date("2026-08-20T12:00:00.000Z")
      },
      retiredAfterFrozenAt.client
    );
    const historicalEntries = (historical.snapshot as { entries: Array<Record<string, unknown>> })
      .entries;
    const currentEntries = (current.snapshot as { entries: Array<Record<string, unknown>> })
      .entries;

    expect(historicalEntries).toEqual([
      expect.objectContaining({ usageId: "usage-1", version: 1, usageVersion: 1 })
    ]);
    expect(historical.usageSnapshotChecksum).toBe(before.usageSnapshotChecksum);
    expect(currentEntries).toEqual([]);
  });

  it("hashes the canonical UTF-8 serialized snapshot without drifting on JSON key order", async () => {
    const first = snapshotClient({
      rows: [
        usage({
          configurationJson: { purpose: "FAT fixture", parameters: { axis: "X", enabled: true } }
        })
      ]
    });
    const second = snapshotClient({
      rows: [
        usage({
          configurationJson: { parameters: { enabled: true, axis: "X" }, purpose: "FAT fixture" }
        })
      ]
    });
    const input = {
      projectId: "project-1",
      acceptanceType: "FAT" as const,
      scopeType: "PROJECT" as const,
      scopeId: "project-1",
      frozenAt
    };
    const [one, two] = await Promise.all([
      getAssetUsageSnapshotForAcceptance(input, first.client),
      getAssetUsageSnapshotForAcceptance(input, second.client)
    ]);

    expect(one.snapshot).toEqual(two.snapshot);
    expect(one.usageSnapshotChecksum).toBe(two.usageSnapshotChecksum);
    expect(one.usageSnapshotChecksum).toBe(
      createHash("sha256").update(canonicalJson(one.snapshot).serialized, "utf8").digest("hex")
    );
  });

  it("records every external or Acceptance snapshot read in the supplied transaction without an Outbox event", async () => {
    const { client } = snapshotClient({ rows: [usage()] });
    const auditEvents: Array<Record<string, unknown>> = [];
    const auditedClient = {
      ...(client as object),
      auditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          auditEvents.push(data);
          return { id: "audit-snapshot-1" };
        }
      }
    };

    const result = await getAssetUsageSnapshotForAcceptance(
      {
        projectId: "project-1",
        acceptanceType: "FAT",
        scopeType: "PROJECT",
        scopeId: "project-1",
        frozenAt,
        readAudit: {
          actorId: "reader-1",
          auditContext: {
            actorId: "reader-1",
            requestId: "request-1",
            traceId: "trace-1",
            source: "API",
            sourceIp: null,
            userAgent: null,
            reason: "read asset usage snapshot",
            projectId: "project-1",
            departmentId: "engineering",
            operationId: null
          }
        }
      },
      auditedClient as never
    );

    expect(result).toMatchObject({ auditId: "audit-snapshot-1", outboxEventId: null });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      actorId: "reader-1",
      action: "PROJECT_ASSET_USAGE_SNAPSHOT_READ",
      objectType: "PROJECT_ASSET_USAGE_SNAPSHOT",
      objectId: "project-1"
    });
  });
});
