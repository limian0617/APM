/**
 * APM-082's no-I/O deterministic calculation boundary. All CT, capacity and
 * ratio arithmetic stays in BigInt rationals; numeric(20,6) values are only
 * rendered with HALF_UP after exact comparisons have completed.
 */
export const UPH_ANALYSIS_ENGINE = "UPH_ANALYSIS@1";
export const CANONICAL_UPH_FORMULA = "CANONICAL_UPH_V1";
export const ANALYSIS_DECIMAL_SCALE = "numeric(20,6) HALF_UP";

const MICRO = 1_000_000n;
const MAX_NUMERIC_20_6_MICRO = 99_999_999_999_999_999_999n;
const CHECKSUM = /^[0-9a-f]{64}$/u;

export type AnalysisIssueCode = "ANALYSIS_INPUT_INVALID" | "ANALYSIS_FORMULA_UNSUPPORTED";
export type AnalysisIssue = { code: AnalysisIssueCode; message: string };
type Rational = { numerator: bigint; denominator: bigint };
type IntegerFact = string | bigint;

/** Exact APM-081 topology nodes in the selected batch root subtree. */
export type LockedUphTopologyNode = {
  id: string;
  parentNodeId: string | null;
  parentRelation: "ROOT" | "MANDATORY" | "PARALLEL";
  topologyPath: string;
  sourceType: string;
  sourceId: string;
};

/** A leaf is a frozen module binding and its exact CT/statistics facts. */
export type LockedUphAnalysisLeaf = {
  topologyNodeId: string;
  p90Seconds: string | null;
  intrinsicCtSeconds: string | null;
  outputPerCycleTotal: IntegerFact;
  parallelChannelCount: IntegerFact;
  /** Source fact only; outputPerCycleTotal already accounts for it. */
  cavityCount: IntegerFact;
  includedSampleCount: IntegerFact;
};

export type LockedUphModuleQuality = {
  moduleId: string;
  qualityInputCount: IntegerFact;
  firstPassGoodCount: IntegerFact;
};

export type LockedUphAnalysisInput = {
  engineCode: string;
  formulaCode: string;
  lockedChecksum: string | null;
  confirmedInputChecksum: string | null;
  statisticsChecksum: string | null;
  minimumIncludedSampleCount: IntegerFact;
  topologyRootNodeId: string;
  topologyNodes: LockedUphTopologyNode[];
  leaves: LockedUphAnalysisLeaf[];
  rootProduction: {
    actualGrossOutputCount: IntegerFact;
    finalGoodOutputCount: IntegerFact;
    plannedProductionSeconds: IntegerFact;
  };
  moduleQuality: LockedUphModuleQuality[];
};

export type AnalysisSource = {
  topologyPath: string;
  sourceType: string;
  sourceId: string;
};

export type AnalysisCandidate = AnalysisSource & {
  relation: "LEAF" | "MANDATORY" | "PARALLEL";
  /** Parent-scoped; sibling PARALLEL sources never share a cross-parent key. */
  parallelGroupId: string | null;
  exactComparisonValue: string;
  capacityUph: string;
  members: AnalysisSource[];
};

export type AnalysisReductionLevel = {
  nodeId: string;
  topologyPath: string;
  sourceType: string;
  sourceId: string;
  candidates: AnalysisCandidate[];
  selectedCapacityExact: string;
  selectedCapacityUph: string;
};

export type LockedUphAnalysisResult =
  | { ok: false; issues: AnalysisIssue[] }
  | {
      ok: true;
      status: "COMPUTED" | "NO_OUTPUT";
      engineCode: typeof UPH_ANALYSIS_ENGINE;
      formulaCode: typeof CANONICAL_UPH_FORMULA;
      rootMeasuredCapacityUph: string;
      actualGoodUph: string;
      a: string;
      A: string;
      moduleFpy: Array<{ moduleId: string; fpy: string | null }>;
      rootFpy: "NOT_APPLICABLE";
      capacityTimesATimesFpy: "NOT_APPLICABLE";
      bottleneck: AnalysisCandidate[];
      secondBottleneck: AnalysisCandidate[] | null;
      reductionLevels: AnalysisReductionLevel[];
      warnings: string[];
    };

type ExactCandidate = AnalysisCandidate & { value: Rational };
type NodeReduction = {
  node: LockedUphTopologyNode;
  value: Rational;
  members: AnalysisSource[];
  levels: AnalysisReductionLevel[];
};

function invalid(message: string): LockedUphAnalysisResult {
  return { ok: false, issues: [{ code: "ANALYSIS_INPUT_INVALID", message }] };
}

function unsupported(message: string): LockedUphAnalysisResult {
  return { ok: false, issues: [{ code: "ANALYSIS_FORMULA_UNSUPPORTED", message }] };
}

function positiveInteger(value: IntegerFact): bigint | null {
  const normalized = String(value);
  return /^[1-9]\d*$/u.test(normalized) ? BigInt(normalized) : null;
}

function nonnegativeInteger(value: IntegerFact): bigint | null {
  const normalized = String(value);
  return /^(?:0|[1-9]\d*)$/u.test(normalized) ? BigInt(normalized) : null;
}

function fixedMicro(value: string | null): bigint | null {
  if (!value || !/^\d{1,14}(?:\.\d{1,6})?$/u.test(value) || /^0+(?:\.0+)?$/u.test(value)) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, "0"));
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new Error("RATIONAL_DENOMINATOR_REQUIRED");
  const sign = denominator < 0n ? -1n : 1n;
  const normalizedNumerator = numerator * sign;
  const normalizedDenominator = denominator * sign;
  const divisor = gcd(normalizedNumerator, normalizedDenominator);
  return { numerator: normalizedNumerator / divisor, denominator: normalizedDenominator / divisor };
}

function compare(left: Rational, right: Rational): -1 | 0 | 1 {
  const comparison = left.numerator * right.denominator - right.numerator * left.denominator;
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
}

function add(left: Rational, right: Rational): Rational {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

function canonicalRational(value: Rational): string {
  const normalized = rational(value.numerator, value.denominator);
  return `${normalized.numerator}/${normalized.denominator}`;
}

function halfUpMicro(value: Rational): bigint {
  if (value.numerator < 0n) {
    return -halfUpMicro(rational(-value.numerator, value.denominator));
  }
  return (value.numerator * (MICRO * 2n) + value.denominator) / (value.denominator * 2n);
}

function fitsNumeric20_6(value: Rational): boolean {
  const rounded = halfUpMicro(value);
  const absolute = rounded < 0n ? -rounded : rounded;
  return absolute <= MAX_NUMERIC_20_6_MICRO;
}

function formatSix(value: Rational): string | null {
  const micro = halfUpMicro(value);
  const absolute = micro < 0n ? -micro : micro;
  if (absolute > MAX_NUMERIC_20_6_MICRO) return null;
  return `${micro < 0n ? "-" : ""}${absolute / MICRO}.${(absolute % MICRO)
    .toString()
    .padStart(6, "0")}`;
}

function stableSourceOrder(left: AnalysisSource, right: AnalysisSource): number {
  const leftKey = `${left.topologyPath}\u0000${left.sourceType}\u0000${left.sourceId}`;
  const rightKey = `${right.topologyPath}\u0000${right.sourceType}\u0000${right.sourceId}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function stableNodeOrder(left: LockedUphTopologyNode, right: LockedUphTopologyNode): number {
  const sourceOrder = stableSourceOrder(left, right);
  return sourceOrder || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function stableCandidateOrder(left: AnalysisCandidate, right: AnalysisCandidate): number {
  return stableSourceOrder(left, right) || (left.relation < right.relation ? -1 : 1);
}

function uniqueSources(sources: AnalysisSource[]): AnalysisSource[] {
  const byKey = new Map<string, AnalysisSource>();
  for (const source of sources) {
    byKey.set(`${source.topologyPath}\u0000${source.sourceType}\u0000${source.sourceId}`, source);
  }
  return [...byKey.values()].sort(stableSourceOrder);
}

function leafCapacity(leaf: LockedUphAnalysisLeaf, seconds: string | null): Rational | null {
  const duration = fixedMicro(seconds);
  const output = positiveInteger(leaf.outputPerCycleTotal);
  const channels = positiveInteger(leaf.parallelChannelCount);
  const cavity = positiveInteger(leaf.cavityCount);
  if (!duration || !output || !channels || !cavity) return null;
  // The exact CT version has already included cavityCount in outputPerCycleTotal.
  return rational(3_600n * output * channels * MICRO, duration);
}

function candidate(
  source: AnalysisSource,
  relation: AnalysisCandidate["relation"],
  parallelGroupId: string | null,
  value: Rational,
  members: AnalysisSource[]
): ExactCandidate | null {
  const capacityUph = formatSix(value);
  // The persisted root metric has a strict positive numeric(20,6) CHECK. A
  // positive rational that rounds to 0.000000 is not a representable analysis
  // capacity, so reject it at the deterministic boundary instead of deferring
  // the contract failure to persistence.
  if (!capacityUph || halfUpMicro(value) <= 0n) return null;
  return {
    ...source,
    relation,
    parallelGroupId,
    exactComparisonValue: canonicalRational(value),
    capacityUph,
    members: uniqueSources(members),
    value
  };
}

function withoutExact(candidateValue: ExactCandidate): AnalysisCandidate {
  const { value: _value, ...display } = candidateValue;
  return display;
}

function validChecksum(value: string | null): value is string {
  return typeof value === "string" && CHECKSUM.test(value);
}

function collectTree(input: LockedUphAnalysisInput): {
  root: LockedUphTopologyNode;
  childrenByParent: Map<string, LockedUphTopologyNode[]>;
  leafByNode: Map<string, LockedUphAnalysisLeaf>;
} | null {
  const nodeById = new Map<string, LockedUphTopologyNode>();
  const sourceKeys = new Set<string>();
  const pathKeys = new Set<string>();
  const roots: LockedUphTopologyNode[] = [];
  for (const node of input.topologyNodes) {
    if (
      !node.id ||
      !node.topologyPath ||
      !node.sourceType ||
      !node.sourceId ||
      nodeById.has(node.id) ||
      sourceKeys.has(`${node.sourceType}\u0000${node.sourceId}`) ||
      pathKeys.has(node.topologyPath)
    ) {
      return null;
    }
    if (
      (node.parentRelation === "ROOT" && node.parentNodeId !== null) ||
      (node.parentRelation !== "ROOT" &&
        (!node.parentNodeId || !["MANDATORY", "PARALLEL"].includes(node.parentRelation)))
    ) {
      return null;
    }
    nodeById.set(node.id, node);
    sourceKeys.add(`${node.sourceType}\u0000${node.sourceId}`);
    pathKeys.add(node.topologyPath);
    if (node.parentRelation === "ROOT") roots.push(node);
  }
  if (roots.length !== 1 || roots[0]!.id !== input.topologyRootNodeId) return null;

  const childrenByParent = new Map<string, LockedUphTopologyNode[]>();
  for (const node of input.topologyNodes) {
    if (node.parentNodeId) {
      if (!nodeById.has(node.parentNodeId)) return null;
      childrenByParent.set(node.parentNodeId, [
        ...(childrenByParent.get(node.parentNodeId) ?? []),
        node
      ]);
    }
  }
  for (const children of childrenByParent.values()) children.sort(stableNodeOrder);

  const leafByNode = new Map<string, LockedUphAnalysisLeaf>();
  for (const leaf of input.leaves) {
    const node = nodeById.get(leaf.topologyNodeId);
    if (!node || node.sourceType !== "PROJECT_MODULE" || leafByNode.has(leaf.topologyNodeId)) {
      return null;
    }
    leafByNode.set(leaf.topologyNodeId, leaf);
  }
  for (const node of input.topologyNodes) {
    const hasChildren = (childrenByParent.get(node.id)?.length ?? 0) > 0;
    if (hasChildren === leafByNode.has(node.id)) return null;
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (node: LockedUphTopologyNode): boolean => {
    if (visiting.has(node.id) || visited.has(node.id)) return false;
    visiting.add(node.id);
    for (const child of childrenByParent.get(node.id) ?? []) {
      if (!visit(child)) return false;
    }
    visiting.delete(node.id);
    visited.add(node.id);
    return true;
  };
  if (!visit(roots[0]!) || visited.size !== input.topologyNodes.length) return null;
  return { root: roots[0]!, childrenByParent, leafByNode };
}

/** Executes the frozen UPH_ANALYSIS@1 / CANONICAL_UPH_V1 calculation. */
export function analyzeLockedUph(input: LockedUphAnalysisInput): LockedUphAnalysisResult {
  if (input.engineCode !== UPH_ANALYSIS_ENGINE)
    return unsupported("UPH_ANALYSIS@1 engine is required");
  if (input.formulaCode !== CANONICAL_UPH_FORMULA)
    return unsupported("CANONICAL_UPH_V1 formula is required");
  if (
    !validChecksum(input.lockedChecksum) ||
    !validChecksum(input.confirmedInputChecksum) ||
    !validChecksum(input.statisticsChecksum)
  ) {
    return invalid("locked checksum chain must contain canonical lowercase SHA-256 values");
  }

  const minimum = positiveInteger(input.minimumIncludedSampleCount);
  const tree = collectTree(input);
  if (!minimum || minimum !== 10n || !tree)
    return invalid("locked analysis topology or protocol is invalid");

  const warnings = new Set<string>();
  const reduceNode = (node: LockedUphTopologyNode): NodeReduction | null => {
    const children = tree.childrenByParent.get(node.id) ?? [];
    if (!children.length) {
      const leaf = tree.leafByNode.get(node.id);
      if (!leaf) return null;
      const included = nonnegativeInteger(leaf.includedSampleCount);
      const measured = leafCapacity(leaf, leaf.p90Seconds);
      const intrinsic = leafCapacity(leaf, leaf.intrinsicCtSeconds);
      if (
        !included ||
        included < minimum ||
        !measured ||
        !intrinsic ||
        !fitsNumeric20_6(measured)
      ) {
        return null;
      }
      if (compare(measured, intrinsic) > 0) {
        warnings.add(`MEASURED_CAPACITY_GT_INTRINSIC:${node.sourceType}:${node.sourceId}`);
      }
      const source: AnalysisSource = {
        topologyPath: node.topologyPath,
        sourceType: node.sourceType,
        sourceId: node.sourceId
      };
      const leafCandidate = candidate(source, "LEAF", null, measured, [source]);
      if (!leafCandidate) return null;
      return {
        node,
        value: measured,
        members: [source],
        levels: [
          {
            nodeId: node.id,
            ...source,
            candidates: [withoutExact(leafCandidate)],
            selectedCapacityExact: canonicalRational(measured),
            selectedCapacityUph: leafCandidate.capacityUph
          }
        ]
      };
    }

    const childResults = children.map(reduceNode);
    if (childResults.some((result) => !result)) return null;
    const reductions = childResults as NodeReduction[];
    const candidates: ExactCandidate[] = [];
    for (const child of reductions.filter((result) => result.node.parentRelation === "MANDATORY")) {
      const childSource: AnalysisSource = {
        topologyPath: child.node.topologyPath,
        sourceType: child.node.sourceType,
        sourceId: child.node.sourceId
      };
      const mandatoryCandidate = candidate(
        childSource,
        "MANDATORY",
        null,
        child.value,
        child.members
      );
      if (!mandatoryCandidate) return null;
      candidates.push(mandatoryCandidate);
    }
    const parallel = reductions.filter((result) => result.node.parentRelation === "PARALLEL");
    if (parallel.length) {
      const parallelValue = parallel.reduce(
        (sum, result) => add(sum, result.value),
        rational(0n, 1n)
      );
      const parallelCandidate = candidate(
        {
          topologyPath: node.topologyPath,
          sourceType: "PARALLEL_GROUP",
          sourceId: node.id
        },
        "PARALLEL",
        node.id,
        parallelValue,
        parallel.flatMap((result) => result.members)
      );
      if (!parallelCandidate) return null;
      candidates.push(parallelCandidate);
    }
    if (!candidates.length || children.some((child) => child.parentRelation === "ROOT"))
      return null;
    candidates.sort(stableCandidateOrder);
    const selectedValue = candidates.reduce((minimumCandidate, current) =>
      compare(current.value, minimumCandidate.value) < 0 ? current : minimumCandidate
    ).value;
    if (!fitsNumeric20_6(selectedValue)) return null;
    const selected = candidates.filter((item) => compare(item.value, selectedValue) === 0);
    const selectedCapacityUph = formatSix(selectedValue);
    if (!selectedCapacityUph) return null;
    const source: AnalysisSource = {
      topologyPath: node.topologyPath,
      sourceType: node.sourceType,
      sourceId: node.sourceId
    };
    return {
      node,
      value: selectedValue,
      members: uniqueSources(selected.flatMap((item) => item.members)),
      levels: [
        ...reductions.flatMap((result) => result.levels),
        {
          nodeId: node.id,
          ...source,
          candidates: candidates.map(withoutExact),
          selectedCapacityExact: canonicalRational(selectedValue),
          selectedCapacityUph
        }
      ]
    };
  };

  const root = reduceNode(tree.root);
  if (!root) return invalid("P90 capacity input is statistically invalid or cannot be reduced");
  const rootLevel = root.levels.find((level) => level.nodeId === tree.root.id);
  if (!rootLevel) return invalid("root comparison level is required");
  const exactByCandidate = new Map<string, Rational>();
  const candidateKey = (item: AnalysisCandidate) =>
    `${item.topologyPath}\u0000${item.sourceType}\u0000${item.sourceId}\u0000${item.relation}`;
  for (const display of rootLevel.candidates) {
    const [numerator, denominator] = display.exactComparisonValue.split("/");
    exactByCandidate.set(candidateKey(display), rational(BigInt(numerator!), BigInt(denominator!)));
  }
  const rootCandidates = [...rootLevel.candidates].sort(stableCandidateOrder);
  const bottleneck = rootCandidates.filter((item) => {
    const value = exactByCandidate.get(candidateKey(item));
    return value ? compare(value, root.value) === 0 : false;
  });
  const secondValue = rootCandidates
    .map((item) => exactByCandidate.get(candidateKey(item)))
    .filter((value): value is Rational => Boolean(value))
    .filter((value) => compare(value, root.value) > 0)
    .sort(compare)[0];
  const secondBottleneck = secondValue
    ? rootCandidates.filter((item) => {
        const value = exactByCandidate.get(candidateKey(item));
        return value ? compare(value, secondValue) === 0 : false;
      })
    : null;

  const moduleIds = new Set<string>();
  const moduleFpy: Array<{ moduleId: string; fpy: string | null }> = [];
  for (const quality of input.moduleQuality) {
    const qualityInput = nonnegativeInteger(quality.qualityInputCount);
    const firstPassGood = nonnegativeInteger(quality.firstPassGoodCount);
    if (
      !quality.moduleId ||
      moduleIds.has(quality.moduleId) ||
      qualityInput === null ||
      firstPassGood === null ||
      firstPassGood > qualityInput
    ) {
      return invalid("module quality facts are invalid");
    }
    moduleIds.add(quality.moduleId);
    if (qualityInput === 0n) {
      moduleFpy.push({ moduleId: quality.moduleId, fpy: null });
      warnings.add(`NO_QUALITY_INPUT:${quality.moduleId}`);
    } else {
      const fpy = formatSix(rational(firstPassGood, qualityInput));
      if (!fpy) return invalid("module FPY is outside numeric(20,6)");
      moduleFpy.push({ moduleId: quality.moduleId, fpy });
    }
  }
  const leafModuleIds = [...tree.leafByNode.keys()].map(
    (nodeId) => input.topologyNodes.find((item) => item.id === nodeId)?.sourceId
  );
  if (
    leafModuleIds.some((id) => !id || !moduleIds.has(id)) ||
    moduleIds.size !== leafModuleIds.length
  ) {
    return invalid("each frozen module binding requires exactly one module quality fact");
  }

  const gross = nonnegativeInteger(input.rootProduction.actualGrossOutputCount);
  const good = nonnegativeInteger(input.rootProduction.finalGoodOutputCount);
  const planned = positiveInteger(input.rootProduction.plannedProductionSeconds);
  if (gross === null || good === null || !planned || good > gross)
    return invalid("root production facts are invalid");
  const actualGood = rational(good * 3_600n, planned);
  const a = rational(gross * 3_600n * root.value.denominator, root.value.numerator * planned);
  const rootMeasuredCapacityUph = formatSix(root.value);
  const actualGoodUph = formatSix(actualGood);
  const aText = formatSix(a);
  if (!rootMeasuredCapacityUph || !actualGoodUph || !aText) {
    return invalid("analysis result exceeds numeric(20,6)");
  }
  if (compare(a, rational(1n, 1n)) > 0) warnings.add("A_GT_ONE");
  const status = gross === 0n && good === 0n ? "NO_OUTPUT" : "COMPUTED";
  if (status === "NO_OUTPUT") warnings.add("NO_OUTPUT");
  return {
    ok: true,
    status,
    engineCode: UPH_ANALYSIS_ENGINE,
    formulaCode: CANONICAL_UPH_FORMULA,
    rootMeasuredCapacityUph,
    actualGoodUph,
    a: aText,
    A: aText,
    moduleFpy: moduleFpy.sort((left, right) =>
      left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0
    ),
    rootFpy: "NOT_APPLICABLE",
    capacityTimesATimesFpy: "NOT_APPLICABLE",
    bottleneck,
    secondBottleneck,
    reductionLevels: [...root.levels].sort((left, right) => {
      const sourceOrder = stableSourceOrder(left, right);
      return sourceOrder || (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0);
    }),
    warnings: [...warnings].sort()
  };
}

export const calculateLockedUphAnalysis = analyzeLockedUph;
