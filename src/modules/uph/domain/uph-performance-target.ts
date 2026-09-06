const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/u;
const MAX_NUMERIC_20_6 = 99_999_999_999_999_999_999n;

function parse(value: string): bigint {
  if (!DECIMAL_PATTERN.test(value)) throw new Error("UPH_TARGET_INVALID");
  const [whole, fraction = ""] = value.split(".");
  const scaled = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (scaled > MAX_NUMERIC_20_6) throw new Error("UPH_TARGET_INVALID");
  return scaled;
}

function format(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

export function normalizePositiveTargetUph(value: string): string {
  const parsed = parse(value.trim());
  if (parsed <= 0n) throw new Error("UPH_TARGET_MUST_BE_POSITIVE");
  return format(parsed);
}

export function compareDecimalUph(left: string, right: string): -1 | 0 | 1 {
  const difference =
    parse(normalizeNonnegativeUph(left)) - parse(normalizePositiveTargetUph(right));
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function selectApplicableTargetVersion<T extends { targetUph: string; effectiveAt: Date }>(
  versions: T[],
  lockedAt: Date
): T | null {
  return (
    versions
      .filter((version) => version.effectiveAt.getTime() <= lockedAt.getTime())
      .sort((left, right) => right.effectiveAt.getTime() - left.effectiveAt.getTime())[0] ?? null
  );
}

export function decideUphPerformance(input: {
  actualGoodUph: string;
  targetUph: string;
  status: string;
}) {
  const actual = normalizeNonnegativeUph(input.actualGoodUph);
  const target = normalizePositiveTargetUph(input.targetUph);
  const difference = parse(target) - parse(actual);
  return {
    underperforming: difference > 0n,
    shortfallUph: format(difference > 0n ? difference : 0n),
    actualGoodUph: actual,
    targetUph: target,
    status: input.status
  };
}

function normalizeNonnegativeUph(value: string): string {
  if (!DECIMAL_PATTERN.test(value.trim())) throw new Error("UPH_ACTUAL_INVALID");
  return format(parse(value.trim()));
}

export function planTargetDraft(input: {
  projectId: string;
  topologyRootNodeId: string;
  targetUph: string;
  reason: string;
}) {
  if (!input.projectId.trim() || !input.topologyRootNodeId.trim() || !input.reason.trim()) {
    throw new Error("UPH_TARGET_INVALID");
  }
  return {
    projectId: input.projectId.trim(),
    topologyRootNodeId: input.topologyRootNodeId.trim(),
    targetUph: normalizePositiveTargetUph(input.targetUph),
    reason: input.reason.trim(),
    status: "DRAFT" as const
  };
}
