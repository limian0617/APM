import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const contractPath = fileURLToPath(new URL("./uph-test-batch-http.ts", import.meta.url));

type ContractModule = Record<string, { parse(value: unknown): unknown }>;

async function loadContracts(): Promise<ContractModule | null> {
  if (!existsSync(contractPath)) return null;
  return (await import(/* @vite-ignore */ pathToFileURL(contractPath).href)) as ContractModule;
}

async function requireContracts(): Promise<ContractModule | null> {
  const contracts = await loadContracts();
  expect(contracts, "APM-081 must provide strict HTTP DTO contracts").not.toBeNull();
  return contracts;
}

function schema(contracts: ContractModule, name: string) {
  const value = contracts[name];
  expect(value, `APM-081 DTO ${name} is required`).toBeDefined();
  return value;
}

const createBody = {
  batchNumber: "UPH-LINE-A-001",
  topologyRootNodeId: "line-a",
  plannedProductionSeconds: 3600,
  planDeclarationReason: "Initial controlled production declaration",
  observationStartedAt: "2026-08-25T08:00:00.000Z",
  observationEndedAt: null,
  timezone: "Asia/Shanghai"
};

const appendExclusionReasonCodes = [
  "SETUP_OR_CHANGEOVER",
  "EXTERNAL_WAITING",
  "UPSTREAM_MATERIAL_STARVATION",
  "DOWNSTREAM_BLOCKAGE",
  "SAFETY_INTERLOCK",
  "CAPTURE_DEVICE_FAULT",
  "OBSERVATION_INTERRUPTED"
] as const;

describe("APM-081 UPH test-batch HTTP contracts", () => {
  it("accepts a client create body without server-owned source, scope, actor, or IDs", async () => {
    const contracts = await requireContracts();
    if (!contracts) return;
    const body = schema(contracts, "createUphTestBatchBodySchema");

    expect(body.parse(createBody)).toMatchObject({
      batchNumber: "UPH-LINE-A-001",
      topologyRootNodeId: "line-a"
    });
    for (const [field, value] of Object.entries({
      source: { topologyVersionId: "client-v1" },
      scope: "PROJECT",
      actorId: "client-actor",
      membershipId: "client-membership",
      projectId: "client-project",
      topologyVersionId: "topology-client-v1",
      formulaVersionId: "formula-client-v1",
      ctVersionIds: ["ct-client-v1"],
      planSnapshotJson: { forged: true },
      planSnapshotChecksum: "0".repeat(64),
      unknown: true
    })) {
      expect(() => body.parse({ ...createBody, [field]: value }), field).toThrow();
    }
    const { planDeclarationReason: _reason, ...missingPlanReason } = createBody;
    for (const bodyWithInvalidPlanReason of [
      missingPlanReason,
      { ...createBody, planDeclarationReason: "" },
      { ...createBody, planDeclarationReason: "x".repeat(1025) }
    ]) {
      expect(() => body.parse(bodyWithInvalidPlanReason)).toThrow();
    }
  });

  it("keeps DRAFT metadata PATCH strict and optimistic", async () => {
    const contracts = await requireContracts();
    if (!contracts) return;
    const body = schema(contracts, "patchUphTestBatchRevisionBodySchema");

    const validPatch = {
      resourceVersion: 3,
      plannedProductionSeconds: 5400,
      planDeclarationReason: "Adjusted controlled production declaration",
      observationStartedAt: "2026-08-25T08:00:00.000Z",
      observationEndedAt: "2026-08-25T09:30:00.000Z",
      timezone: "Asia/Shanghai"
    };
    expect(body.parse(validPatch)).toMatchObject({
      resourceVersion: 3,
      plannedProductionSeconds: 5400
    });
    for (const value of [
      { resourceVersion: 3, actorId: "client-actor" },
      { resourceVersion: 3, memberRoles: ["QUALITY"] },
      { resourceVersion: 3, membershipId: "client-membership" },
      { resourceVersion: 3, topologyVersionId: "client-v1" },
      { resourceVersion: 3, planSnapshotJson: { forged: true } },
      { ...validPatch, planDeclarationReason: "" },
      { ...validPatch, planDeclarationReason: "x".repeat(1025) },
      (() => {
        const { planDeclarationReason: _reason, ...missingReason } = validPatch;
        return missingReason;
      })()
    ]) {
      expect(() => body.parse(value)).toThrow();
    }
  });

  it("requires IANA timezones and API-safe numeric values", async () => {
    const contracts = await requireContracts();
    if (!contracts) return;
    const create = schema(contracts, "createUphTestBatchBodySchema");
    const patch = schema(contracts, "patchUphTestBatchRevisionBodySchema");
    const append = schema(contracts, "appendUphCycleSampleBodySchema");
    const production = schema(contracts, "updateUphTestBatchProductionCountBodySchema");
    const quality = schema(contracts, "updateUphTestBatchModuleQualityCountBodySchema");
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
    const validPatch = {
      resourceVersion: 3,
      plannedProductionSeconds: 5400,
      planDeclarationReason: "Adjusted controlled production declaration",
      observationStartedAt: "2026-08-25T08:00:00.000Z",
      observationEndedAt: "2026-08-25T09:30:00.000Z",
      timezone: "Asia/Shanghai"
    };

    expect(() => create.parse({ ...createBody, timezone: "Mars/Factory" })).toThrow();
    expect(() =>
      create.parse({ ...createBody, plannedProductionSeconds: unsafeInteger })
    ).toThrow();
    expect(() => patch.parse({ ...validPatch, timezone: "Mars/Factory" })).toThrow();
    expect(() => patch.parse({ ...validPatch, plannedProductionSeconds: unsafeInteger })).toThrow();
    expect(() =>
      append.parse({
        resourceVersion: 1,
        ordinal: 8,
        sourceEventId: "device-event-8",
        cycleDurationSeconds: "123456789012345",
        observedAt: "2026-08-25T08:05:00.000Z",
        captureMethod: "DEVICE_EVENT",
        disposition: "INCLUDED"
      })
    ).toThrow();
    expect(() =>
      production.parse({
        resourceVersion: 2,
        actualGrossOutputCount: unsafeInteger,
        finalGoodOutputCount: 0
      })
    ).toThrow();
    expect(() =>
      quality.parse({
        resourceVersion: 2,
        qualityInputCount: unsafeInteger,
        firstPassGoodCount: unsafeInteger,
        firstPassNonconformingCount: 0,
        reworkInputCount: 0,
        reworkRecoveredGoodCount: 0
      })
    ).toThrow();
  });

  it("uses the exact cycle-sample vocabulary and accepts each appendable field exclusion code", async () => {
    const contracts = await requireContracts();
    if (!contracts) return;
    const append = schema(contracts, "appendUphCycleSampleBodySchema");

    expect(
      append.parse({
        resourceVersion: 1,
        projectModuleId: "module-1",
        ordinal: 1,
        sourceEventId: "device-event-1",
        cycleDurationSeconds: "12.125000",
        observedAt: "2026-08-25T08:05:00.000Z",
        captureMethod: "DEVICE_EVENT",
        disposition: "INCLUDED"
      })
    ).toMatchObject({
      projectModuleId: "module-1",
      captureMethod: "DEVICE_EVENT",
      cycleDurationSeconds: "12.125000"
    });
    expect(
      append.parse({
        resourceVersion: 1,
        projectModuleId: "module-1",
        ordinal: 2,
        cycleDurationSeconds: "12.125000",
        observedAt: "2026-08-25T08:05:00.000Z",
        captureMethod: "MANUAL_ENTRY",
        disposition: "INCLUDED"
      })
    ).toMatchObject({ captureMethod: "MANUAL_ENTRY" });
    expect(() =>
      append.parse({
        resourceVersion: 1,
        projectModuleId: "module-1",
        ordinal: 3,
        cycleDurationSeconds: "12.125000",
        observedAt: "2026-08-25T08:05:00.000Z",
        captureMethod: "DEVICE_EVENT",
        disposition: "INCLUDED"
      })
    ).toThrow();
    for (const exclusionReasonCode of appendExclusionReasonCodes) {
      expect(
        append.parse({
          resourceVersion: 1,
          projectModuleId: "module-1",
          ordinal: 4,
          cycleDurationSeconds: "12.125000",
          observedAt: "2026-08-25T08:05:00.000Z",
          captureMethod: "MANUAL_ENTRY",
          disposition: "EXCLUDED",
          exclusionReasonCode
        })
      ).toMatchObject({ exclusionReasonCode });
    }
    for (const exclusionReasonCode of [
      "MANUAL_ENTRY_CORRECTION",
      "DUPLICATE_SOURCE_EVENT",
      "UNKNOWN_REASON"
    ]) {
      expect(() =>
        append.parse({
          resourceVersion: 1,
          projectModuleId: "module-1",
          ordinal: 5,
          cycleDurationSeconds: "12.125000",
          observedAt: "2026-08-25T08:05:00.000Z",
          captureMethod: "MANUAL_ENTRY",
          disposition: "EXCLUDED",
          exclusionReasonCode
        })
      ).toThrow();
    }
    for (const cycleDurationSeconds of [12.125, "0", "-1.000000", "12.1234567"]) {
      expect(() =>
        append.parse({
          resourceVersion: 1,
          projectModuleId: "module-1",
          ordinal: 6,
          sourceEventId: "device-event-6",
          cycleDurationSeconds,
          observedAt: "2026-08-25T08:05:00.000Z",
          captureMethod: "DEVICE_EVENT",
          disposition: "INCLUDED"
        })
      ).toThrow();
    }
    expect(() =>
      append.parse({
        projectModuleId: "module-1",
        ordinal: 7,
        sourceEventId: "device-event-7",
        cycleDurationSeconds: "12.125000",
        observedAt: "2026-08-25T08:05:00.000Z",
        captureMethod: "DEVICE_EVENT",
        disposition: "INCLUDED"
      })
    ).toThrow();
    for (const [field, value] of Object.entries({
      moduleBindingId: "client-binding",
      ctDefinitionId: "client-ct-definition",
      ctVersionId: "client-ct-version"
    })) {
      expect(() =>
        append.parse({
          resourceVersion: 1,
          projectModuleId: "module-1",
          ordinal: 8,
          sourceEventId: "device-event-8",
          cycleDurationSeconds: "12.125000",
          observedAt: "2026-08-25T08:05:00.000Z",
          captureMethod: "DEVICE_EVENT",
          disposition: "INCLUDED",
          [field]: value
        })
      ).toThrow();
    }
    expect(() =>
      append.parse({
        resourceVersion: 1,
        ordinal: 8,
        sourceEventId: "device-event-8",
        cycleDurationSeconds: "12.125000",
        observedAt: "2026-08-25T08:05:00.000Z",
        captureMethod: "DEVICE_EVENT",
        disposition: "INCLUDED"
      })
    ).toThrow();
  });

  it("keeps every external write DTO strict and path-owned identifiers out of bodies", async () => {
    const contracts = await requireContracts();
    if (!contracts) return;

    const correct = schema(contracts, "correctUphCycleSampleBodySchema");
    const correction = {
      resourceVersion: 2,
      replacement: {
        cycleDurationSeconds: "12.000000",
        observedAt: "2026-08-25T08:06:00.000Z",
        captureMethod: "MANUAL_ENTRY"
      }
    };
    expect(correct.parse(correction)).toMatchObject({ resourceVersion: 2 });
    for (const [field, value] of Object.entries({
      sampleId: "client-sample",
      actorId: "client",
      membershipId: "member",
      projectId: "project",
      source: {},
      versionId: "v1",
      unknown: true
    })) {
      expect(() => correct.parse({ ...correction, [field]: value }), `correct.${field}`).toThrow();
    }
    for (const [name, body, forgedFields] of [
      [
        "updateUphTestBatchProductionCountBodySchema",
        { resourceVersion: 2, actualGrossOutputCount: 10, finalGoodOutputCount: 8 },
        {
          actorId: "client",
          membershipId: "member",
          projectId: "project",
          source: {},
          versionId: "v1"
        }
      ],
      [
        "updateUphTestBatchModuleQualityCountBodySchema",
        {
          resourceVersion: 2,
          qualityInputCount: 10,
          firstPassGoodCount: 8,
          firstPassNonconformingCount: 2,
          reworkInputCount: 2,
          reworkRecoveredGoodCount: 1
        },
        {
          actorId: "client",
          membershipId: "member",
          projectId: "project",
          source: {},
          ctVersionId: "v1"
        }
      ],
      [
        "attachUphTestBatchRevisionEvidenceBodySchema",
        {
          resourceVersion: 2,
          fileObjectId: "file-1",
          sampleId: "sample-1"
        },
        {
          actorId: "client",
          membershipId: "member",
          projectId: "project",
          source: {},
          versionId: "v1"
        }
      ]
    ] as const) {
      const write = schema(contracts, name);
      expect(write.parse(body)).toMatchObject(body);
      for (const [field, value] of Object.entries({ ...forgedFields, unknown: true })) {
        expect(() => write.parse({ ...body, [field]: value }), `${name}.${field}`).toThrow();
      }
    }
    const evidence = schema(contracts, "attachUphTestBatchRevisionEvidenceBodySchema");
    expect(evidence.parse({ resourceVersion: 2, fileObjectId: "file-1" })).toMatchObject({
      resourceVersion: 2,
      fileObjectId: "file-1"
    });
    expect(
      evidence.parse({ resourceVersion: 2, fileObjectId: "file-1", purpose: "ROOT_PRODUCTION" })
    ).toMatchObject({ purpose: "ROOT_PRODUCTION" });
    expect(() =>
      evidence.parse({ resourceVersion: 2, fileObjectId: "file-1", purpose: "UNKNOWN_PURPOSE" })
    ).toThrow();
    for (const [name, body] of [
      ["confirmUphTestBatchBodySchema", { resourceVersion: 4 }],
      ["lockUphTestBatchBodySchema", { resourceVersion: 5 }],
      [
        "replaceUphTestBatchRevisionBodySchema",
        { resourceVersion: 4, reason: "Correct a confirmed observation" }
      ]
    ] as const) {
      const write = schema(contracts, name);
      expect(write.parse(body)).toMatchObject(body);
      for (const [field, value] of Object.entries({
        actorId: "client",
        membershipId: "member",
        projectId: "project",
        source: {},
        versionId: "v1",
        unknown: true
      })) {
        expect(() => write.parse({ ...body, [field]: value }), `${name}.${field}`).toThrow();
      }
    }
  });

  it("uses strict list and detail queries without client-owned identity or source fields", async () => {
    const contracts = await requireContracts();
    if (!contracts) return;
    const list = schema(contracts, "listUphTestBatchesQuerySchema");
    const detail = schema(contracts, "getUphTestBatchQuerySchema");
    const listQuery = {
      cursor: "batch-cursor",
      limit: 25,
      status: "LOCKED",
      topologyRootNodeId: "line-a"
    };
    expect(list.parse(listQuery)).toMatchObject(listQuery);
    expect(detail.parse({ selection: "exact", revisionId: "revision-1" })).toMatchObject({
      selection: "exact",
      revisionId: "revision-1"
    });
    for (const [query, validQuery] of [
      [list, listQuery],
      [detail, { selection: "exact", revisionId: "revision-1" }]
    ] as const) {
      for (const [field, value] of Object.entries({
        actorId: "client",
        membershipId: "member",
        projectId: "project",
        source: {},
        versionId: "v1",
        unknown: true
      })) {
        expect(() => query.parse({ ...validQuery, [field]: value }), field).toThrow();
      }
    }
  });
});
