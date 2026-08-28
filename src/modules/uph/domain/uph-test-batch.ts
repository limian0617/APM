const EXCLUSION_REASON_CODES = new Set([
  "SETUP_OR_CHANGEOVER",
  "EXTERNAL_WAITING",
  "UPSTREAM_MATERIAL_STARVATION",
  "DOWNSTREAM_BLOCKAGE",
  "SAFETY_INTERLOCK",
  "CAPTURE_DEVICE_FAULT",
  "OBSERVATION_INTERRUPTED",
  "MANUAL_ENTRY_CORRECTION"
]);

type Sample = {
  id?: string;
  ordinal: number;
  sourceEventId: string | null;
  cycleDurationSeconds: string;
  observedAt: string;
  captureMethod: "DEVICE_EVENT" | "MANUAL_ENTRY";
  disposition: "INCLUDED" | "EXCLUDED";
  exclusionReasonCode: string | null;
};

type RationalMicroseconds = {
  numerator: bigint;
  denominator: bigint;
};

function fail(code: string): never {
  throw new Error(code);
}

function parseSeconds(value: string): bigint {
  if (!/^\d{1,14}(?:\.\d{1,6})?$/u.test(value) || /^0+(?:\.0+)?$/u.test(value)) {
    return fail("CYCLE_DURATION_INVALID");
  }
  const [integer, fraction = ""] = value.split(".");
  return BigInt(integer) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function formatSeconds(value: bigint): string {
  const integer = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return `${integer}.${fraction}`;
}

function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function formatRationalSeconds(value: RationalMicroseconds): string {
  return formatSeconds(divideHalfUp(value.numerator, value.denominator));
}

function subtractRationals(
  left: RationalMicroseconds,
  right: RationalMicroseconds
): RationalMicroseconds {
  return {
    numerator: left.numerator * right.denominator - right.numerator * left.denominator,
    denominator: left.denominator * right.denominator
  };
}

function percentileR7(sorted: bigint[], numerator: bigint): RationalMicroseconds {
  if (sorted.length === 1) return { numerator: sorted[0]!, denominator: 1n };
  const denominator = 100n;
  const scaledRank = BigInt(sorted.length - 1) * numerator;
  const lowerIndex = Number(scaledRank / denominator);
  const remainder = scaledRank % denominator;
  const lower = sorted[lowerIndex]!;
  const upper = sorted[Math.min(lowerIndex + 1, sorted.length - 1)]!;
  return {
    numerator: lower * denominator + (upper - lower) * remainder,
    denominator
  };
}

function hasValidIanaTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function createTestBatchDraft(input: {
  projectId: string;
  batchNumber: string;
  projectShape: "LINE" | "SINGLE_MACHINE";
  topologyRootNodeId: string;
  physicalRootNodeIds: string[];
  serverDerivedFrozenSourceBinding: {
    topologyVersionId: string;
    formulaVersionId: string;
    ctVersionIds: string[];
  };
  plan: {
    plannedProductionSeconds: number;
    planDeclarationReason: string;
    observationStartedAt: string;
    observationEndedAt: string | null;
    timezone: string;
  };
}) {
  if (
    input.projectShape === "SINGLE_MACHINE" &&
    (input.physicalRootNodeIds.length !== 1 ||
      input.physicalRootNodeIds[0] !== input.topologyRootNodeId)
  ) {
    return fail("TOPOLOGY_ROOT_INVALID");
  }
  if (!input.physicalRootNodeIds.includes(input.topologyRootNodeId)) {
    return fail("TOPOLOGY_ROOT_SCOPE_REQUIRED");
  }
  if (!input.serverDerivedFrozenSourceBinding.ctVersionIds.length)
    return fail("SOURCE_BINDING_REQUIRED");
  if (
    !Number.isSafeInteger(input.plan.plannedProductionSeconds) ||
    input.plan.plannedProductionSeconds <= 0
  ) {
    return fail("PLAN_DECLARATION_INVALID");
  }
  if (
    !input.plan.planDeclarationReason.trim() ||
    input.plan.planDeclarationReason.trim().length > 1024 ||
    !input.plan.observationStartedAt ||
    !input.plan.timezone ||
    !hasValidIanaTimeZone(input.plan.timezone)
  ) {
    return fail("PLAN_DECLARATION_INVALID");
  }
  return {
    projectId: input.projectId,
    batchNumber: input.batchNumber,
    scope: "TOPOLOGY_ROOT" as const,
    topologyRootNodeId: input.topologyRootNodeId,
    status: "DRAFT" as const,
    sourceBinding: input.serverDerivedFrozenSourceBinding,
    plan: input.plan
  };
}

export function validateCycleSamples(input: {
  minimumIncludedSampleCount: number;
  samples: Sample[];
}) {
  const sourceEventIds = new Set<string>();
  let includedSampleCount = 0;
  let excludedSampleCount = 0;
  for (const sample of input.samples) {
    parseSeconds(sample.cycleDurationSeconds);
    if (sample.captureMethod === "DEVICE_EVENT" && !sample.sourceEventId) {
      return fail("SOURCE_EVENT_REQUIRED");
    }
    if (sample.sourceEventId) {
      if (sourceEventIds.has(sample.sourceEventId)) return fail("SOURCE_EVENT_DUPLICATE");
      sourceEventIds.add(sample.sourceEventId);
    }
    if (sample.disposition === "EXCLUDED") {
      if (!sample.exclusionReasonCode || !EXCLUSION_REASON_CODES.has(sample.exclusionReasonCode)) {
        return fail("EXCLUSION_REASON_INVALID");
      }
      excludedSampleCount += 1;
    } else {
      if (sample.exclusionReasonCode) return fail("EXCLUSION_REASON_INVALID");
      includedSampleCount += 1;
    }
  }
  if (includedSampleCount < input.minimumIncludedSampleCount)
    return fail("MIN_INCLUDED_SAMPLES_NOT_MET");
  return { includedSampleCount, excludedSampleCount };
}

export function calculateLockedModuleStatistics(input: {
  moduleId: string;
  minimumIncludedSampleCount: number;
  samples: Sample[];
}) {
  const counts = validateCycleSamples(input);
  const durations = input.samples
    .filter((sample) => sample.disposition === "INCLUDED")
    .map((sample) => parseSeconds(sample.cycleDurationSeconds))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const mean = divideHalfUp(
    durations.reduce((sum, duration) => sum + duration, 0n),
    BigInt(durations.length)
  );
  const p50 = percentileR7(durations, 50n);
  const p90 = percentileR7(durations, 90n);
  return {
    moduleId: input.moduleId,
    validSampleCount: counts.includedSampleCount,
    excludedSampleCount: counts.excludedSampleCount,
    arithmeticMeanSeconds: formatSeconds(mean),
    p50Seconds: formatRationalSeconds(p50),
    p90Seconds: formatRationalSeconds(p90),
    maxSeconds: formatSeconds(durations[durations.length - 1]!),
    spreadP90MinusP50Seconds: formatRationalSeconds(subtractRationals(p90, p50))
  };
}

export function planManualCycleCorrection(input: {
  samples: Sample[];
  sampleId: string;
  replacement: Pick<Sample, "cycleDurationSeconds" | "observedAt"> & {
    captureMethod: "MANUAL_ENTRY";
  };
}) {
  const original = input.samples.find((sample) => sample.id === input.sampleId);
  if (!original) return fail("CYCLE_SAMPLE_NOT_FOUND");
  if (input.replacement.captureMethod !== "MANUAL_ENTRY") {
    return fail("CYCLE_SAMPLE_CORRECTION_INVALID");
  }
  parseSeconds(input.replacement.cycleDurationSeconds);
  const nextOrdinal = Math.max(...input.samples.map((sample) => sample.ordinal)) + 1;
  return {
    correctedSampleId: input.sampleId,
    samples: [
      ...input.samples.map((sample) =>
        sample.id === input.sampleId
          ? {
              ...sample,
              disposition: "EXCLUDED" as const,
              exclusionReasonCode: "MANUAL_ENTRY_CORRECTION"
            }
          : sample
      ),
      {
        id: `replacement-${input.sampleId}-${nextOrdinal}`,
        ordinal: nextOrdinal,
        sourceEventId: null,
        cycleDurationSeconds: input.replacement.cycleDurationSeconds,
        observedAt: input.replacement.observedAt,
        captureMethod: input.replacement.captureMethod,
        disposition: "INCLUDED" as const,
        exclusionReasonCode: null
      }
    ]
  };
}

export function validateBatchCounts(input: {
  rootProduction: { actualGrossOutputCount: number; finalGoodOutputCount: number };
  moduleQuality: {
    qualityInputCount: number;
    firstPassGoodCount: number;
    firstPassNonconformingCount: number;
    reworkInputCount: number;
    reworkRecoveredGoodCount: number;
  };
}) {
  const { actualGrossOutputCount, finalGoodOutputCount } = input.rootProduction;
  if (
    !Number.isSafeInteger(actualGrossOutputCount) ||
    !Number.isSafeInteger(finalGoodOutputCount) ||
    actualGrossOutputCount < 0 ||
    finalGoodOutputCount < 0 ||
    finalGoodOutputCount > actualGrossOutputCount
  ) {
    return fail("ROOT_PRODUCTION_COUNT_INVALID");
  }
  const quality = input.moduleQuality;
  if (
    !Object.values(quality).every((value) => Number.isSafeInteger(value) && value >= 0) ||
    quality.qualityInputCount !==
      quality.firstPassGoodCount + quality.firstPassNonconformingCount ||
    quality.reworkRecoveredGoodCount > quality.reworkInputCount ||
    quality.reworkInputCount > quality.firstPassNonconformingCount
  ) {
    return fail("MODULE_QUALITY_COUNT_INVALID");
  }
  return { valid: true };
}

type Pointer = { id: string; status: string } | null;

export function validateTestBatchPointers(input: { currentWork: Pointer; currentLocked: Pointer }) {
  if (input.currentLocked && input.currentLocked.status !== "LOCKED") {
    return fail("CURRENT_LOCKED_STATUS_INVALID");
  }
  if (input.currentWork?.id && input.currentWork.id === input.currentLocked?.id) {
    return fail("CURRENT_POINTER_ALIAS_FORBIDDEN");
  }
  if (input.currentWork && !["DRAFT", "PM_CONFIRMED"].includes(input.currentWork.status)) {
    return fail("CURRENT_WORK_STATUS_INVALID");
  }
  return { valid: true };
}

export function planRevisionTransition(input: {
  command: "PM_CONFIRM" | "LOCK" | "REPLACE_CONFIRMED" | "LOCK_SUCCESSOR";
  currentWork: (Record<string, unknown> & { id: string; status: string }) | null;
  currentLocked: Pointer;
}) {
  validateTestBatchPointers(input);
  const work = input.currentWork;
  if (!work) return fail("CURRENT_WORK_REQUIRED");
  if (input.command === "PM_CONFIRM") {
    if (work.status !== "DRAFT") return fail("PM_CONFIRMATION_INVALID");
    return {
      currentWorkId: work.id,
      currentWorkStatus: "PM_CONFIRMED",
      currentLockedId: input.currentLocked?.id ?? null
    };
  }
  if (input.command === "LOCK") {
    if (work.status !== "PM_CONFIRMED") return fail("PM_CONFIRMATION_REQUIRED");
    return { currentWorkId: null, currentLockedId: work.id, lockedRevisionId: work.id };
  }
  if (input.command === "REPLACE_CONFIRMED") {
    if (work.status !== "PM_CONFIRMED") return fail("PM_CONFIRMATION_REQUIRED");
    return {
      supersededRevisionId: work.id,
      successor: {
        status: "DRAFT",
        supersedesRevisionId: work.id,
        pmConfirmerId: null,
        qualityLockerId: null,
        confirmedInputChecksum: null,
        statisticsChecksum: null,
        lockedChecksum: null
      },
      currentWorkStatus: "DRAFT",
      currentLockedId: input.currentLocked?.id ?? null
    };
  }
  if (work.status !== "PM_CONFIRMED" || !input.currentLocked)
    return fail("PM_CONFIRMATION_REQUIRED");
  return {
    supersededRevisionId: input.currentLocked.id,
    lockedRevisionId: work.id,
    currentWorkId: null,
    currentLockedId: work.id
  };
}

export function deriveTestBatchAllowedActions(input: {
  revisionStatus: string;
  actor: {
    userId: string;
    memberRoles: string[];
    grants: string[];
    activeProjectMembership: boolean;
  };
  responsibilities: {
    processOwnerUserId: string;
    pmConfirmerUserId: string | null;
    qualityLockerUserId: string | null;
  };
}): string[] {
  const { actor, responsibilities } = input;
  const validUserId = (userId: string | null) =>
    typeof userId === "string" && userId.trim().length > 0;
  if (
    !actor.activeProjectMembership ||
    !validUserId(actor.userId) ||
    !validUserId(responsibilities.processOwnerUserId) ||
    (responsibilities.pmConfirmerUserId !== null &&
      (!validUserId(responsibilities.pmConfirmerUserId) ||
        responsibilities.pmConfirmerUserId === responsibilities.processOwnerUserId)) ||
    (responsibilities.qualityLockerUserId !== null &&
      (!validUserId(responsibilities.qualityLockerUserId) ||
        responsibilities.qualityLockerUserId === responsibilities.processOwnerUserId ||
        responsibilities.qualityLockerUserId === responsibilities.pmConfirmerUserId))
  ) {
    return [];
  }
  const has = (role: string, grant: string) =>
    actor.memberRoles.includes(role) && actor.grants.includes(grant);
  const isProcessOwner = actor.userId === responsibilities.processOwnerUserId;
  if (input.revisionStatus === "DRAFT") {
    if (
      responsibilities.pmConfirmerUserId !== null ||
      responsibilities.qualityLockerUserId !== null
    ) {
      return [];
    }
    if (isProcessOwner && has("ENGINEER", "PROJECT_UPH_BATCH_MANAGE")) {
      return [
        "PATCH_DRAFT_METADATA",
        "APPEND_CYCLE_SAMPLE",
        "CORRECT_CYCLE_SAMPLE",
        "UPDATE_PRODUCTION_COUNT",
        "UPDATE_MODULE_QUALITY_COUNT",
        "ATTACH_EVIDENCE"
      ];
    }
    if (!isProcessOwner && has("PROJECT_MANAGER", "PROJECT_UPH_BATCH_CONFIRM")) {
      return ["PM_CONFIRM"];
    }
  }
  if (input.revisionStatus === "PM_CONFIRMED") {
    if (
      responsibilities.pmConfirmerUserId === null ||
      responsibilities.qualityLockerUserId !== null
    ) {
      return [];
    }
    if (isProcessOwner && has("ENGINEER", "PROJECT_UPH_BATCH_MANAGE")) {
      return ["REPLACE_PM_CONFIRMED"];
    }
    if (
      actor.userId !== responsibilities.pmConfirmerUserId &&
      !isProcessOwner &&
      has("QUALITY", "PROJECT_UPH_BATCH_LOCK")
    ) {
      return ["LOCK"];
    }
  }
  if (
    input.revisionStatus === "LOCKED" &&
    responsibilities.pmConfirmerUserId !== null &&
    responsibilities.qualityLockerUserId !== null &&
    isProcessOwner &&
    has("ENGINEER", "PROJECT_UPH_BATCH_MANAGE")
  ) {
    return ["CORRECT_LOCKED"];
  }
  return [];
}
