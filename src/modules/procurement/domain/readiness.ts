import {
  QUANTITY_SCALE,
  QuantityError,
  convertQuantity,
  formatQuantity,
  parseQuantity,
  type FrozenUnitConversion
} from "./quantity";

export const READINESS_STATUSES = ["READY", "BLOCKED", "EMPTY", "INVALID_INPUT", "STALE"] as const;

export type ReadinessStatus = (typeof READINESS_STATUSES)[number];
export type ReadinessEventType =
  | "PURCHASE_ARRIVED"
  | "OUTSOURCED_DISPATCHED"
  | "OUTSOURCED_COMPLETED"
  | "OUTSOURCED_RETURNED"
  | "ACCEPTED"
  | "MARKED_USABLE"
  | "REJECTED"
  | "RETURNED"
  | "REVERSED";

export type ReadinessUnitConversion = FrozenUnitConversion &
  Readonly<{
    fromUnit: string;
    toUnit: string;
  }>;

export type ReadinessEvent = Readonly<{
  id: string;
  eventType: ReadinessEventType;
  quantity: string;
  trackingUnit: string;
  reversesEventId?: string | null;
  unitConversion?: ReadinessUnitConversion | null;
}>;

export type ReadinessRequirementLine = Readonly<{
  id: string;
  trackingUnit: string;
  requiredQuantity: string;
  isCritical: boolean;
  isEffective: boolean;
  requiredOn?: string | null;
  availableOn?: string | null;
  events: readonly ReadinessEvent[];
}>;

export type ReadinessDataError = Readonly<{
  code:
    | "PROC_UNIT_CONVERSION_REQUIRED"
    | "PROC_UNIT_CONVERSION_INVALID"
    | "PROC_EVENT_REFERENCE_INVALID"
    | "PROC_EVENT_BALANCE_INVALID"
    | "PROC_QUANTITY_INVALID";
}>;

export type RequirementReadiness = Readonly<{
  requirementId: string;
  arrivedQuantity: string;
  usableQuantity: string;
  rejectedReturnedQuantity: string;
  gapQuantity: string;
  isReady: boolean;
  isOnTime: boolean | null;
  dataError: ReadinessDataError | null;
}>;

export type ReadinessCalculation = Readonly<{
  status: ReadinessStatus;
  totalLines: number;
  readyLines: number;
  readinessRate: string;
  criticalTotalLines: number;
  criticalReadyLines: number;
  criticalReadinessRate: string;
  blockingCriticalLines: number;
  invalidRequirementIds: readonly string[];
  sourceSyncedAt: string | null;
  isStale: boolean;
  lines: readonly RequirementReadiness[];
}>;

export type CalculateReadinessInput = Readonly<{
  lines: readonly ReadinessRequirementLine[];
  sourceSyncedAt?: string | null;
  staleAfterDays?: number;
  now?: string;
}>;

const trackedUnitPattern = /^[A-Z][A-Z0-9._-]{0,31}$/u;

class MissingFrozenUnitConversionError extends Error {
  constructor() {
    super("缺少已冻结单位换算快照。");
    this.name = "MissingFrozenUnitConversionError";
  }
}

function dataError(code: ReadinessDataError["code"]): ReadinessDataError {
  return { code };
}

function maximum(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function eventQuantity(line: ReadinessRequirementLine, event: ReadinessEvent): bigint {
  if (!trackedUnitPattern.test(line.trackingUnit) || !trackedUnitPattern.test(event.trackingUnit)) {
    throw new QuantityError("PROC_UNIT_CONVERSION_INVALID", "项目跟踪单位无效。");
  }
  const quantity = parseQuantity(event.quantity);
  if (event.trackingUnit === line.trackingUnit) return quantity;
  const conversion = event.unitConversion;
  if (!conversion) {
    throw new MissingFrozenUnitConversionError();
  }
  if (conversion.fromUnit !== event.trackingUnit || conversion.toUnit !== line.trackingUnit) {
    throw new QuantityError("PROC_UNIT_CONVERSION_INVALID", "单位换算快照不匹配事件和需求单位。");
  }
  return convertQuantity(quantity, conversion);
}

type ReversalPair = Readonly<{
  reversal: ReadinessEvent;
  target: ReadinessEvent;
}>;

function resolveReversalPairs(events: readonly ReadinessEvent[]): readonly ReversalPair[] | null {
  const eventsById = new Map<string, ReadinessEvent>();
  for (const event of events) {
    if (!event.id || eventsById.has(event.id)) return null;
    eventsById.set(event.id, event);
  }
  const reversedTargetIds = new Set<string>();
  const pairs: ReversalPair[] = [];
  for (const event of events) {
    if (event.eventType !== "REVERSED") continue;
    if (!event.reversesEventId || event.reversesEventId === event.id) return null;
    const target = eventsById.get(event.reversesEventId);
    if (!target || target.eventType === "REVERSED" || reversedTargetIds.has(target.id)) return null;
    reversedTargetIds.add(target.id);
    pairs.push({ reversal: event, target });
  }
  return pairs;
}

function isLate(line: ReadinessRequirementLine, isReady: boolean): boolean | null {
  if (!isReady) return false;
  if (!line.requiredOn) return null;
  if (!line.availableOn) return false;
  const requiredOn = Date.parse(line.requiredOn);
  const availableOn = Date.parse(line.availableOn);
  if (Number.isNaN(requiredOn) || Number.isNaN(availableOn)) return false;
  return availableOn <= requiredOn;
}

function rate(ready: number, total: number): string {
  if (total === 0) return "0";
  return formatQuantity((BigInt(ready) * QUANTITY_SCALE) / BigInt(total));
}

function isStale(input: CalculateReadinessInput): boolean {
  if (!input.sourceSyncedAt || input.staleAfterDays === undefined) return false;
  if (!Number.isInteger(input.staleAfterDays) || input.staleAfterDays < 0) return true;
  const sourceSyncedAt = Date.parse(input.sourceSyncedAt);
  const now = Date.parse(input.now ?? new Date().toISOString());
  if (Number.isNaN(sourceSyncedAt) || Number.isNaN(now)) return true;
  return now - sourceSyncedAt > input.staleAfterDays * 86_400_000;
}

export function calculateRequirementReadiness(
  line: ReadinessRequirementLine
): RequirementReadiness {
  const zeroResult = (error: ReadinessDataError): RequirementReadiness => ({
    requirementId: line.id,
    arrivedQuantity: "0",
    usableQuantity: "0",
    rejectedReturnedQuantity: "0",
    gapQuantity: "0",
    isReady: false,
    isOnTime: false,
    dataError: error
  });
  const reversalPairs = resolveReversalPairs(line.events);
  if (!reversalPairs) return zeroResult(dataError("PROC_EVENT_REFERENCE_INVALID"));

  try {
    const required = parseQuantity(line.requiredQuantity);
    for (const { reversal, target } of reversalPairs) {
      if (eventQuantity(line, reversal) !== eventQuantity(line, target)) {
        return zeroResult(dataError("PROC_EVENT_REFERENCE_INVALID"));
      }
    }
    const reversedIds = new Set(reversalPairs.map(({ target }) => target.id));
    let arrivals = 0n;
    let accepted = 0n;
    let markedUsable = 0n;
    let rejected = 0n;
    let returned = 0n;

    for (const event of line.events) {
      if (event.eventType === "REVERSED" || reversedIds.has(event.id)) continue;
      const quantity = eventQuantity(line, event);
      switch (event.eventType) {
        case "PURCHASE_ARRIVED":
        case "OUTSOURCED_RETURNED":
          arrivals += quantity;
          break;
        case "ACCEPTED":
          accepted += quantity;
          break;
        case "MARKED_USABLE":
          markedUsable += quantity;
          break;
        case "REJECTED":
          rejected += quantity;
          break;
        case "RETURNED":
          returned += quantity;
          break;
      }
    }

    if ((arrivals > 0n && returned > arrivals) || rejected + returned > accepted + markedUsable) {
      return zeroResult(dataError("PROC_EVENT_BALANCE_INVALID"));
    }
    // Persistence prevents a return from exceeding recorded arrivals. The pure
    // calculator can also receive an availability-only projection, so never
    // manufacture a negative arrived total from omitted arrival facts.
    const arrived = maximum(arrivals - returned, 0n);
    const rejectedReturned = rejected + returned;
    const usable = accepted + markedUsable - rejectedReturned;
    const gap = maximum(required - usable, 0n);
    const ready = gap === 0n;
    return {
      requirementId: line.id,
      arrivedQuantity: formatQuantity(arrived),
      usableQuantity: formatQuantity(usable),
      rejectedReturnedQuantity: formatQuantity(rejectedReturned),
      gapQuantity: formatQuantity(gap),
      isReady: ready,
      isOnTime: isLate(line, ready),
      dataError: null
    };
  } catch (error) {
    if (error instanceof MissingFrozenUnitConversionError) {
      return zeroResult(dataError("PROC_UNIT_CONVERSION_REQUIRED"));
    }
    if (error instanceof QuantityError) {
      return zeroResult(
        dataError(
          error.code === "PROC_QUANTITY_INVALID"
            ? "PROC_QUANTITY_INVALID"
            : "PROC_UNIT_CONVERSION_INVALID"
        )
      );
    }
    throw error;
  }
}

export function calculateReadiness(input: CalculateReadinessInput): ReadinessCalculation {
  const effectiveLines = input.lines.filter((line) => line.isEffective);
  const lines = effectiveLines.map(calculateRequirementReadiness);
  const invalidRequirementIds = lines
    .filter((line) => line.dataError !== null)
    .map((line) => line.requirementId);
  const readyLines = lines.filter((line) => line.isReady).length;
  const criticalPairs = effectiveLines
    .map((line, index) => ({ line, result: lines[index]! }))
    .filter(({ line }) => line.isCritical);
  const criticalReadyLines = criticalPairs.filter(({ result }) => result.isReady).length;
  const blockingCriticalLines = criticalPairs.filter(({ result }) => !result.isReady).length;
  const stale = isStale(input);
  const status: ReadinessStatus =
    invalidRequirementIds.length > 0
      ? "INVALID_INPUT"
      : effectiveLines.length === 0
        ? "EMPTY"
        : stale
          ? "STALE"
          : readyLines === effectiveLines.length && blockingCriticalLines === 0
            ? "READY"
            : "BLOCKED";
  return {
    status,
    totalLines: effectiveLines.length,
    readyLines,
    readinessRate: rate(readyLines, effectiveLines.length),
    criticalTotalLines: criticalPairs.length,
    criticalReadyLines,
    criticalReadinessRate: rate(criticalReadyLines, criticalPairs.length),
    blockingCriticalLines,
    invalidRequirementIds,
    sourceSyncedAt: input.sourceSyncedAt ?? null,
    isStale: stale,
    lines
  };
}
