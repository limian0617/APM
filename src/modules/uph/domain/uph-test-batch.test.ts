import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const domainPath = fileURLToPath(new URL("./uph-test-batch.ts", import.meta.url));

type TestBatchDomain = Record<string, unknown>;

async function loadDomain(): Promise<TestBatchDomain | null> {
  if (!existsSync(domainPath)) return null;
  return (await import(/* @vite-ignore */ pathToFileURL(domainPath).href)) as TestBatchDomain;
}

async function requireDomain(): Promise<TestBatchDomain | null> {
  const domain = await loadDomain();
  expect(domain, "APM-081 must provide an executable UPH test-batch domain module").not.toBeNull();
  return domain;
}

function requiredFunction<T extends (...args: never[]) => unknown>(
  domain: TestBatchDomain,
  name: string
): T {
  const candidate = domain[name];
  expect(candidate, `APM-081 domain export ${name} is required`).toBeTypeOf("function");
  return candidate as T;
}

const eightExclusionReasonCodes = [
  "SETUP_OR_CHANGEOVER",
  "EXTERNAL_WAITING",
  "UPSTREAM_MATERIAL_STARVATION",
  "DOWNSTREAM_BLOCKAGE",
  "SAFETY_INTERLOCK",
  "CAPTURE_DEVICE_FAULT",
  "OBSERVATION_INTERRUPTED",
  "MANUAL_ENTRY_CORRECTION"
] as const;

function deviceSample(ordinal: number, cycleDurationSeconds = `${ordinal}.000000`) {
  return {
    id: `sample-${ordinal}`,
    ordinal,
    sourceEventId: `device-event-${ordinal}`,
    cycleDurationSeconds,
    observedAt: `2026-08-25T08:${String(ordinal).padStart(2, "0")}:00.000Z`,
    captureMethod: "DEVICE_EVENT" as const,
    disposition: "INCLUDED" as const,
    exclusionReasonCode: null
  };
}

const tenIncludedSamples = Array.from({ length: 10 }, (_, index) => deviceSample(index + 1));

const serverDerivedFrozenSourceBinding = {
  topologyVersionId: "topology-published-v1",
  formulaVersionId: "formula-published-v1",
  ctVersionIds: ["ct-module-a-published-v1", "ct-module-b-published-v1"]
};

describe("APM-081 UPH test-batch domain contract", () => {
  it("creates only a TOPOLOGY_ROOT DRAFT from a clearly server-derived frozen binding", async () => {
    const domain = await requireDomain();
    if (!domain) return;
    const createTestBatchDraft = requiredFunction<(input: unknown) => unknown>(
      domain,
      "createTestBatchDraft"
    );

    expect(
      createTestBatchDraft({
        projectId: "project-1",
        batchNumber: "UPH-LINE-A-001",
        projectShape: "LINE",
        topologyRootNodeId: "line-a",
        physicalRootNodeIds: ["line-a", "line-b"],
        serverDerivedFrozenSourceBinding,
        plan: {
          plannedProductionSeconds: 3600,
          planDeclarationReason: "Initial controlled production declaration",
          observationStartedAt: "2026-08-25T08:00:00.000Z",
          observationEndedAt: null,
          timezone: "Asia/Shanghai"
        }
      })
    ).toMatchObject({
      scope: "TOPOLOGY_ROOT",
      topologyRootNodeId: "line-a",
      status: "DRAFT"
    });

    expect(() =>
      createTestBatchDraft({
        projectId: "project-1",
        batchNumber: "UPH-PROJECT-001",
        projectShape: "LINE",
        topologyRootNodeId: "project-1",
        physicalRootNodeIds: ["line-a", "line-b"],
        serverDerivedFrozenSourceBinding,
        plan: {
          plannedProductionSeconds: 3600,
          planDeclarationReason: "Initial controlled production declaration",
          observationStartedAt: "2026-08-25T08:00:00.000Z",
          observationEndedAt: null,
          timezone: "Asia/Shanghai"
        }
      })
    ).toThrow("TOPOLOGY_ROOT_SCOPE_REQUIRED");
    expect(() =>
      createTestBatchDraft({
        projectId: "project-1",
        batchNumber: "UPH-SINGLE-001",
        projectShape: "SINGLE_MACHINE",
        topologyRootNodeId: "line-a",
        physicalRootNodeIds: ["machine-1"],
        serverDerivedFrozenSourceBinding,
        plan: {
          plannedProductionSeconds: 3600,
          planDeclarationReason: "Initial controlled production declaration",
          observationStartedAt: "2026-08-25T08:00:00.000Z",
          observationEndedAt: null,
          timezone: "Asia/Shanghai"
        }
      })
    ).toThrow("TOPOLOGY_ROOT_INVALID");
  });

  it("uses R-7 and final six-place HALF_UP for n=1, odd, even, and duplicate values", async () => {
    const domain = await requireDomain();
    if (!domain) return;
    const calculateLockedModuleStatistics = requiredFunction<(input: unknown) => unknown>(
      domain,
      "calculateLockedModuleStatistics"
    );

    const calculate = (durations: string[]) =>
      calculateLockedModuleStatistics({
        moduleId: "module-1",
        minimumIncludedSampleCount: 1,
        samples: durations.map((duration, index) => ({
          ...deviceSample(index + 1, duration),
          sourceEventId: `stat-event-${index + 1}`
        }))
      });

    expect(calculate(["1.234567"])).toMatchObject({
      validSampleCount: 1,
      arithmeticMeanSeconds: "1.234567",
      p50Seconds: "1.234567",
      p90Seconds: "1.234567",
      maxSeconds: "1.234567",
      spreadP90MinusP50Seconds: "0.000000"
    });
    expect(calculate([...Array<string>(9).fill("1.000000"), "1.000006"])).toMatchObject({
      arithmeticMeanSeconds: "1.000001",
      p50Seconds: "1.000000",
      p90Seconds: "1.000001",
      maxSeconds: "1.000006",
      spreadP90MinusP50Seconds: "0.000001"
    });
    expect(calculate(["1", "2", "3"])).toMatchObject({
      p50Seconds: "2.000000",
      p90Seconds: "2.800000",
      maxSeconds: "3.000000",
      spreadP90MinusP50Seconds: "0.800000"
    });
    expect(calculate(["1", "2", "3", "4"])).toMatchObject({
      p50Seconds: "2.500000",
      p90Seconds: "3.700000",
      maxSeconds: "4.000000",
      spreadP90MinusP50Seconds: "1.200000"
    });
    expect(calculate(["1", "1", "1", "1", "1", "1", "1", "1", "2", "2"])).toMatchObject({
      arithmeticMeanSeconds: "1.200000",
      p50Seconds: "1.000000",
      p90Seconds: "2.000000",
      maxSeconds: "2.000000",
      spreadP90MinusP50Seconds: "1.000000"
    });
  });

  it("rounds spread once from raw R-7 percentiles and rejects unsafe batch inputs", async () => {
    const domain = await requireDomain();
    if (!domain) return;
    const calculateLockedModuleStatistics = requiredFunction<(input: unknown) => unknown>(
      domain,
      "calculateLockedModuleStatistics"
    );
    const createTestBatchDraft = requiredFunction<(input: unknown) => unknown>(
      domain,
      "createTestBatchDraft"
    );
    const validateCycleSamples = requiredFunction<(input: unknown) => unknown>(
      domain,
      "validateCycleSamples"
    );
    const validateBatchCounts = requiredFunction<(input: unknown) => unknown>(
      domain,
      "validateBatchCounts"
    );

    expect(
      calculateLockedModuleStatistics({
        moduleId: "module-raw-spread",
        minimumIncludedSampleCount: 1,
        samples: ["1.000001", "1.000001", "1.000002", "1.000002"].map((duration, index) => ({
          ...deviceSample(index + 1, duration),
          sourceEventId: `raw-spread-event-${index + 1}`
        }))
      })
    ).toMatchObject({
      p50Seconds: "1.000002",
      p90Seconds: "1.000002",
      spreadP90MinusP50Seconds: "0.000001"
    });

    const draftInput = {
      projectId: "project-1",
      batchNumber: "UPH-LINE-A-002",
      projectShape: "LINE" as const,
      topologyRootNodeId: "line-a",
      physicalRootNodeIds: ["line-a"],
      serverDerivedFrozenSourceBinding,
      plan: {
        plannedProductionSeconds: 3600,
        planDeclarationReason: "Controlled production declaration",
        observationStartedAt: "2026-08-25T08:00:00.000Z",
        observationEndedAt: null,
        timezone: "Asia/Shanghai"
      }
    };
    expect(() =>
      createTestBatchDraft({
        ...draftInput,
        plan: { ...draftInput.plan, timezone: "Mars/Factory" }
      })
    ).toThrow("PLAN_DECLARATION_INVALID");
    expect(() =>
      createTestBatchDraft({
        ...draftInput,
        plan: {
          ...draftInput.plan,
          plannedProductionSeconds: Number.MAX_SAFE_INTEGER + 1
        }
      })
    ).toThrow("PLAN_DECLARATION_INVALID");
    expect(() =>
      validateCycleSamples({
        minimumIncludedSampleCount: 1,
        samples: [deviceSample(1, "123456789012345")]
      })
    ).toThrow("CYCLE_DURATION_INVALID");
    expect(() =>
      validateBatchCounts({
        rootProduction: {
          actualGrossOutputCount: Number.MAX_SAFE_INTEGER + 1,
          finalGoodOutputCount: 0
        },
        moduleQuality: {
          qualityInputCount: 1,
          firstPassGoodCount: 1,
          firstPassNonconformingCount: 0,
          reworkInputCount: 0,
          reworkRecoveredGoodCount: 0
        }
      })
    ).toThrow("ROOT_PRODUCTION_COUNT_INVALID");
    expect(() =>
      validateBatchCounts({
        rootProduction: { actualGrossOutputCount: 1, finalGoodOutputCount: 1 },
        moduleQuality: {
          qualityInputCount: Number.MAX_SAFE_INTEGER + 1,
          firstPassGoodCount: Number.MAX_SAFE_INTEGER + 1,
          firstPassNonconformingCount: 0,
          reworkInputCount: 0,
          reworkRecoveredGoodCount: 0
        }
      })
    ).toThrow("MODULE_QUALITY_COUNT_INVALID");
  });

  it("requires ten INCLUDED samples while accepting each exact protocol exclusion code", async () => {
    const domain = await requireDomain();
    if (!domain) return;
    const validateCycleSamples = requiredFunction<(input: unknown) => unknown>(
      domain,
      "validateCycleSamples"
    );

    expect(() => validateCycleSamples({ minimumIncludedSampleCount: 10, samples: [] })).toThrow(
      "MIN_INCLUDED_SAMPLES_NOT_MET"
    );
    expect(() =>
      validateCycleSamples({
        minimumIncludedSampleCount: 10,
        samples: tenIncludedSamples.slice(0, 9)
      })
    ).toThrow("MIN_INCLUDED_SAMPLES_NOT_MET");
    expect(() =>
      validateCycleSamples({
        minimumIncludedSampleCount: 10,
        samples: [
          ...tenIncludedSamples.slice(0, 9),
          {
            ordinal: 10,
            sourceEventId: null,
            cycleDurationSeconds: "1.000000",
            observedAt: "2026-08-25T09:00:00.000Z",
            captureMethod: "MANUAL_ENTRY",
            disposition: "EXCLUDED",
            exclusionReasonCode: "SETUP_OR_CHANGEOVER"
          }
        ]
      })
    ).toThrow("MIN_INCLUDED_SAMPLES_NOT_MET");
    for (const [index, exclusionReasonCode] of eightExclusionReasonCodes.entries()) {
      expect(
        validateCycleSamples({
          minimumIncludedSampleCount: 10,
          samples: [
            ...tenIncludedSamples,
            {
              ...deviceSample(index + 11),
              sourceEventId: null,
              captureMethod: "MANUAL_ENTRY",
              disposition: "EXCLUDED",
              exclusionReasonCode
            }
          ]
        })
      ).toMatchObject({ includedSampleCount: 10, excludedSampleCount: 1 });
    }
    expect(() =>
      validateCycleSamples({
        minimumIncludedSampleCount: 10,
        samples: [
          ...tenIncludedSamples,
          {
            ordinal: 11,
            sourceEventId: null,
            cycleDurationSeconds: "1.000000",
            observedAt: "2026-08-25T09:00:00.000Z",
            captureMethod: "MANUAL_ENTRY",
            disposition: "EXCLUDED",
            exclusionReasonCode: "DUPLICATE_SOURCE_EVENT"
          }
        ]
      })
    ).toThrow("EXCLUSION_REASON_INVALID");
    expect(() =>
      validateCycleSamples({
        minimumIncludedSampleCount: 10,
        samples: [
          ...tenIncludedSamples,
          {
            ordinal: 11,
            sourceEventId: null,
            cycleDurationSeconds: "1.000000",
            observedAt: "2026-08-25T09:00:00.000Z",
            captureMethod: "MANUAL_ENTRY",
            disposition: "EXCLUDED",
            exclusionReasonCode: "UNKNOWN_REASON"
          }
        ]
      })
    ).toThrow("EXCLUSION_REASON_INVALID");
    expect(() =>
      validateCycleSamples({
        minimumIncludedSampleCount: 10,
        samples: [...tenIncludedSamples.slice(0, 9), { ...deviceSample(10), sourceEventId: null }]
      })
    ).toThrow("SOURCE_EVENT_REQUIRED");
    expect(() =>
      validateCycleSamples({
        minimumIncludedSampleCount: 10,
        samples: [
          ...tenIncludedSamples.slice(0, 9),
          { ...deviceSample(10), sourceEventId: "device-event-1" }
        ]
      })
    ).toThrow("SOURCE_EVENT_DUPLICATE");
  });

  it("uses append-only manual correction and separates root production from module quality", async () => {
    const domain = await requireDomain();
    if (!domain) return;
    const planManualCycleCorrection = requiredFunction<(input: unknown) => unknown>(
      domain,
      "planManualCycleCorrection"
    );
    const validateBatchCounts = requiredFunction<(input: unknown) => unknown>(
      domain,
      "validateBatchCounts"
    );

    const correction = planManualCycleCorrection({
      samples: tenIncludedSamples,
      sampleId: "sample-1",
      replacement: {
        cycleDurationSeconds: "1.250000",
        observedAt: "2026-08-25T08:01:30.000Z",
        captureMethod: "MANUAL_ENTRY"
      }
    }) as { samples: unknown[]; correctedSampleId: string };
    expect(correction).toMatchObject({ correctedSampleId: "sample-1" });
    expect(correction.samples).toHaveLength(11);
    const correctedSamples = correction.samples as Array<Record<string, unknown>>;
    const corrected = correctedSamples.find((sample) => sample.id === "sample-1");
    expect(corrected).toMatchObject({
      id: "sample-1",
      ordinal: 1,
      cycleDurationSeconds: "1.000000",
      observedAt: "2026-08-25T08:01:00.000Z",
      captureMethod: "DEVICE_EVENT",
      sourceEventId: "device-event-1",
      disposition: "EXCLUDED",
      exclusionReasonCode: "MANUAL_ENTRY_CORRECTION"
    });
    const replacement = correctedSamples.find((sample) => sample.ordinal === 11);
    expect(replacement).toMatchObject({
      captureMethod: "MANUAL_ENTRY",
      cycleDurationSeconds: "1.250000",
      observedAt: "2026-08-25T08:01:30.000Z",
      sourceEventId: null,
      disposition: "INCLUDED"
    });
    expect(replacement?.id).toBeDefined();
    expect(replacement?.id).not.toBe("sample-1");

    expect(
      validateBatchCounts({
        rootProduction: { actualGrossOutputCount: 0, finalGoodOutputCount: 0 },
        moduleQuality: {
          qualityInputCount: 10,
          firstPassGoodCount: 8,
          firstPassNonconformingCount: 2,
          reworkInputCount: 2,
          reworkRecoveredGoodCount: 1
        }
      })
    ).toMatchObject({ valid: true });
    expect(
      validateBatchCounts({
        rootProduction: { actualGrossOutputCount: 27, finalGoodOutputCount: 23 },
        moduleQuality: {
          qualityInputCount: 10,
          firstPassGoodCount: 8,
          firstPassNonconformingCount: 2,
          reworkInputCount: 2,
          reworkRecoveredGoodCount: 1
        }
      })
    ).toMatchObject({ valid: true });
    expect(() =>
      validateBatchCounts({
        rootProduction: { actualGrossOutputCount: 0, finalGoodOutputCount: 1 },
        moduleQuality: {
          qualityInputCount: 10,
          firstPassGoodCount: 8,
          firstPassNonconformingCount: 2,
          reworkInputCount: 2,
          reworkRecoveredGoodCount: 1
        }
      })
    ).toThrow("ROOT_PRODUCTION_COUNT_INVALID");
    expect(() =>
      validateBatchCounts({
        rootProduction: { actualGrossOutputCount: 10, finalGoodOutputCount: 8 },
        moduleQuality: {
          qualityInputCount: 10,
          firstPassGoodCount: 8,
          firstPassNonconformingCount: 3,
          reworkInputCount: 2,
          reworkRecoveredGoodCount: 1
        }
      })
    ).toThrow("MODULE_QUALITY_COUNT_INVALID");
    expect(() =>
      validateBatchCounts({
        rootProduction: { actualGrossOutputCount: 10, finalGoodOutputCount: 8 },
        moduleQuality: {
          qualityInputCount: 10,
          firstPassGoodCount: 8,
          firstPassNonconformingCount: 2,
          reworkInputCount: 3,
          reworkRecoveredGoodCount: 3
        }
      })
    ).toThrow("MODULE_QUALITY_COUNT_INVALID");
  });

  it("rejects a non-manual replacement at the domain boundary", async () => {
    const domain = await requireDomain();
    if (!domain) return;
    const planManualCycleCorrection = requiredFunction<(input: unknown) => unknown>(
      domain,
      "planManualCycleCorrection"
    );

    expect(() =>
      planManualCycleCorrection({
        samples: tenIncludedSamples,
        sampleId: "sample-1",
        replacement: {
          cycleDurationSeconds: "1.250000",
          observedAt: "2026-08-25T08:01:30.000Z",
          captureMethod: "DEVICE_EVENT"
        }
      })
    ).toThrow("CYCLE_SAMPLE_CORRECTION_INVALID");
  });

  it("enforces pointer states, non-aliasing, and successor fact clearing across confirmation and lock", async () => {
    const domain = await requireDomain();
    if (!domain) return;
    const validateTestBatchPointers = requiredFunction<(input: unknown) => unknown>(
      domain,
      "validateTestBatchPointers"
    );
    const planRevisionTransition = requiredFunction<(input: unknown) => unknown>(
      domain,
      "planRevisionTransition"
    );

    expect(
      validateTestBatchPointers({
        currentWork: { id: "draft-v1", status: "DRAFT" },
        currentLocked: null
      })
    ).toMatchObject({ valid: true });
    expect(
      validateTestBatchPointers({
        currentWork: { id: "confirmed-v1", status: "PM_CONFIRMED" },
        currentLocked: { id: "locked-v0", status: "LOCKED" }
      })
    ).toMatchObject({ valid: true });
    expect(() =>
      validateTestBatchPointers({
        currentWork: { id: "locked-v0", status: "LOCKED" },
        currentLocked: { id: "locked-v0", status: "LOCKED" }
      })
    ).toThrow("CURRENT_POINTER_ALIAS_FORBIDDEN");
    expect(() =>
      validateTestBatchPointers({
        currentWork: { id: "draft-v1", status: "DRAFT" },
        currentLocked: { id: "draft-v1", status: "DRAFT" }
      })
    ).toThrow("CURRENT_LOCKED_STATUS_INVALID");
    expect(() =>
      planRevisionTransition({
        command: "LOCK",
        currentWork: { id: "draft-v1", status: "DRAFT" },
        currentLocked: null
      })
    ).toThrow("PM_CONFIRMATION_REQUIRED");
    expect(
      planRevisionTransition({
        command: "PM_CONFIRM",
        currentWork: { id: "draft-v1", status: "DRAFT" },
        currentLocked: null
      })
    ).toMatchObject({ currentWorkStatus: "PM_CONFIRMED", currentLockedId: null });
    expect(
      planRevisionTransition({
        command: "LOCK",
        currentWork: { id: "confirmed-v1", status: "PM_CONFIRMED" },
        currentLocked: null
      })
    ).toMatchObject({ currentWorkId: null, currentLockedId: "confirmed-v1" });
    expect(
      planRevisionTransition({
        command: "REPLACE_CONFIRMED",
        currentWork: {
          id: "confirmed-v1",
          status: "PM_CONFIRMED",
          pmConfirmerId: "pm-1",
          confirmedInputChecksum: "confirmed",
          qualityLockerId: null,
          statisticsChecksum: null,
          lockedChecksum: null
        },
        currentLocked: { id: "locked-v0", status: "LOCKED" }
      })
    ).toMatchObject({
      supersededRevisionId: "confirmed-v1",
      successor: {
        status: "DRAFT",
        supersedesRevisionId: "confirmed-v1",
        pmConfirmerId: null,
        qualityLockerId: null,
        confirmedInputChecksum: null,
        statisticsChecksum: null,
        lockedChecksum: null
      },
      currentWorkStatus: "DRAFT",
      currentLockedId: "locked-v0"
    });
    expect(
      planRevisionTransition({
        command: "LOCK_SUCCESSOR",
        currentWork: {
          id: "successor-v2",
          status: "PM_CONFIRMED",
          supersedesRevisionId: "locked-v0"
        },
        currentLocked: { id: "locked-v0", status: "LOCKED" }
      })
    ).toMatchObject({
      supersededRevisionId: "locked-v0",
      lockedRevisionId: "successor-v2",
      currentWorkId: null,
      currentLockedId: "successor-v2"
    });
  });

  it("derives actions from lifecycle responsibility facts for active, granted, independent project members", async () => {
    const domain = await requireDomain();
    if (!domain) return;
    const deriveTestBatchAllowedActions = requiredFunction<(input: unknown) => string[]>(
      domain,
      "deriveTestBatchAllowedActions"
    );
    const draftResponsibilities = {
      processOwnerUserId: "engineer-1",
      pmConfirmerUserId: null,
      qualityLockerUserId: null
    };
    const confirmedResponsibilities = {
      processOwnerUserId: "engineer-1",
      pmConfirmerUserId: "pm-1",
      qualityLockerUserId: null
    };
    const lockedResponsibilities = {
      processOwnerUserId: "engineer-1",
      pmConfirmerUserId: "pm-1",
      qualityLockerUserId: "quality-1"
    };
    const actor = (
      userId: string,
      memberRoles: string[],
      grants: string[],
      activeProjectMembership = true
    ) => ({ userId, memberRoles, grants, activeProjectMembership });
    expect(
      deriveTestBatchAllowedActions({
        revisionStatus: "DRAFT",
        actor: actor("engineer-1", ["ENGINEER"], ["PROJECT_UPH_BATCH_MANAGE"]),
        responsibilities: draftResponsibilities
      })
    ).toEqual([
      "PATCH_DRAFT_METADATA",
      "APPEND_CYCLE_SAMPLE",
      "CORRECT_CYCLE_SAMPLE",
      "UPDATE_PRODUCTION_COUNT",
      "UPDATE_MODULE_QUALITY_COUNT",
      "ATTACH_EVIDENCE"
    ]);
    expect(
      deriveTestBatchAllowedActions({
        revisionStatus: "DRAFT",
        actor: actor("pm-2", ["PROJECT_MANAGER"], ["PROJECT_UPH_BATCH_CONFIRM"]),
        responsibilities: draftResponsibilities
      })
    ).toEqual(["PM_CONFIRM"]);
    expect(
      deriveTestBatchAllowedActions({
        revisionStatus: "DRAFT",
        actor: actor(
          "engineer-1",
          ["ENGINEER", "PROJECT_MANAGER"],
          ["PROJECT_UPH_BATCH_MANAGE", "PROJECT_UPH_BATCH_CONFIRM"]
        ),
        responsibilities: draftResponsibilities
      })
    ).not.toContain("PM_CONFIRM");
    expect(
      deriveTestBatchAllowedActions({
        revisionStatus: "PM_CONFIRMED",
        actor: actor("quality-1", ["QUALITY"], ["PROJECT_UPH_BATCH_LOCK"]),
        responsibilities: confirmedResponsibilities
      })
    ).toEqual(["LOCK"]);
    expect(
      deriveTestBatchAllowedActions({
        revisionStatus: "PM_CONFIRMED",
        actor: actor("engineer-1", ["ENGINEER"], ["PROJECT_UPH_BATCH_MANAGE"]),
        responsibilities: confirmedResponsibilities
      })
    ).toEqual(["REPLACE_PM_CONFIRMED"]);
    expect(
      deriveTestBatchAllowedActions({
        revisionStatus: "LOCKED",
        actor: actor("engineer-1", ["ENGINEER"], ["PROJECT_UPH_BATCH_MANAGE"]),
        responsibilities: lockedResponsibilities
      })
    ).toEqual(["CORRECT_LOCKED"]);
    for (const input of [
      {
        revisionStatus: "DRAFT",
        actor: actor("quality-1", ["QUALITY"], ["PROJECT_UPH_BATCH_MANAGE"]),
        responsibilities: draftResponsibilities
      },
      {
        revisionStatus: "PM_CONFIRMED",
        actor: actor("pm-1", ["QUALITY"], ["PROJECT_UPH_BATCH_LOCK"]),
        responsibilities: confirmedResponsibilities
      },
      {
        revisionStatus: "SUPERSEDED",
        actor: actor("engineer-1", ["ENGINEER"], ["PROJECT_UPH_BATCH_MANAGE"]),
        responsibilities: lockedResponsibilities
      },
      {
        revisionStatus: "DRAFT",
        actor: actor("engineer-1", ["ENGINEER"], [], true),
        responsibilities: draftResponsibilities
      },
      {
        revisionStatus: "DRAFT",
        actor: actor("engineer-1", [], ["PROJECT_UPH_BATCH_MANAGE"]),
        responsibilities: draftResponsibilities
      },
      {
        revisionStatus: "DRAFT",
        actor: actor("engineer-1", ["ENGINEER"], ["PROJECT_UPH_BATCH_MANAGE"], false),
        responsibilities: draftResponsibilities
      },
      {
        revisionStatus: "DRAFT",
        actor: actor("engineer-2", ["ENGINEER"], ["PROJECT_UPH_BATCH_MANAGE"]),
        responsibilities: draftResponsibilities
      },
      {
        revisionStatus: "DRAFT",
        actor: actor("pm-1", ["PROJECT_MANAGER"], ["PROJECT_UPH_BATCH_CONFIRM"]),
        responsibilities: { ...draftResponsibilities, pmConfirmerUserId: "pm-1" }
      },
      {
        revisionStatus: "DRAFT",
        actor: actor("quality-1", ["QUALITY"], ["PROJECT_UPH_BATCH_LOCK"]),
        responsibilities: { ...draftResponsibilities, qualityLockerUserId: "quality-1" }
      },
      {
        revisionStatus: "PM_CONFIRMED",
        actor: actor("quality-1", ["QUALITY"], ["PROJECT_UPH_BATCH_LOCK"]),
        responsibilities: { ...confirmedResponsibilities, qualityLockerUserId: "quality-1" }
      },
      {
        revisionStatus: "PM_CONFIRMED",
        actor: actor("engineer-1", ["ENGINEER"], ["PROJECT_UPH_BATCH_MANAGE"]),
        responsibilities: { ...draftResponsibilities, pmConfirmerUserId: "engineer-1" }
      },
      {
        revisionStatus: "PM_CONFIRMED",
        actor: actor("quality-1", ["QUALITY"], ["PROJECT_UPH_BATCH_LOCK"]),
        responsibilities: { ...confirmedResponsibilities, processOwnerUserId: "quality-1" }
      },
      {
        revisionStatus: "PM_CONFIRMED",
        actor: actor("pm-1", ["QUALITY"], ["PROJECT_UPH_BATCH_LOCK"]),
        responsibilities: { ...confirmedResponsibilities, processOwnerUserId: "pm-1" }
      },
      {
        revisionStatus: "LOCKED",
        actor: actor("engineer-1", ["ENGINEER"], ["PROJECT_UPH_BATCH_MANAGE"]),
        responsibilities: { ...lockedResponsibilities, qualityLockerUserId: null }
      },
      {
        revisionStatus: "LOCKED",
        actor: actor("engineer-1", ["ENGINEER"], ["PROJECT_UPH_BATCH_MANAGE"]),
        responsibilities: { ...lockedResponsibilities, qualityLockerUserId: "pm-1" }
      },
      {
        revisionStatus: "DRAFT",
        actor: actor("reader-1", ["VIEWER"], ["PROJECT_UPH_BATCH_MANAGE"]),
        responsibilities: draftResponsibilities
      }
    ]) {
      expect(deriveTestBatchAllowedActions(input)).toEqual([]);
    }
  });
});
