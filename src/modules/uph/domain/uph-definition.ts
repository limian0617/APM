export type UphVersionState = "DRAFT" | "PUBLISHED" | "SUPERSEDED";

export type TopologyRelation = "ROOT" | "MANDATORY" | "PARALLEL";
export type TopologySourceType = "LINE" | "AREA" | "MACHINE" | "MODULE";

export type TopologyNode = {
  sourceId: string;
  sourceType: TopologySourceType;
  parentSourceId: string | null;
  relation: TopologyRelation;
  capacity?: number;
  children?: TopologyNode[];
};

export type TopologyForest = {
  projectShape: "SINGLE_MACHINE" | "LINE";
  roots: TopologyNode[];
};

export type ModuleCapacityInput = {
  intrinsicCtSeconds: number;
  outputPerCycleTotal: number;
  parallelChannelCount: number;
  cavityCount: number;
};

export type VersionTransitionInput = {
  status: UphVersionState;
  commissioningSigned: boolean;
};

export type VersionTransition = "PATCH" | "PUBLISH" | "SUPERSEDE";

export function calculateModuleCapacity(input: ModuleCapacityInput): number {
  assertPositive(input.intrinsicCtSeconds, "INTRINSIC_CT_INVALID");
  assertPositiveInteger(input.outputPerCycleTotal, "OUTPUT_PER_CYCLE_INVALID");
  assertPositiveInteger(input.parallelChannelCount, "PARALLEL_CHANNEL_INVALID");
  assertPositiveInteger(input.cavityCount, "CAVITY_COUNT_INVALID");
  return (3600 * input.outputPerCycleTotal * input.parallelChannelCount) / input.intrinsicCtSeconds;
}

export function validateTopologyForest(forest: TopologyForest): void {
  if (!forest.roots.length) throw new Error("TOPOLOGY_ROOT_REQUIRED");
  const seen = new Set<string>();
  const rootIds = new Set(forest.roots.map((root) => root.sourceId));
  if (rootIds.size !== forest.roots.length) throw new Error("TOPOLOGY_DUPLICATE_SOURCE");

  for (const root of forest.roots) {
    if (root.relation !== "ROOT" || root.parentSourceId !== null)
      throw new Error("TOPOLOGY_ROOT_INVALID");
    if (forest.projectShape === "SINGLE_MACHINE" && root.sourceType !== "MACHINE") {
      throw new Error("SINGLE_MACHINE_ROOT_INVALID");
    }
    if (forest.projectShape === "LINE" && root.sourceType !== "LINE") {
      throw new Error("LINE_ROOT_INVALID");
    }
    validateNode(root, null, seen, new Set<string>());
  }
  if (forest.projectShape === "SINGLE_MACHINE" && forest.roots.length !== 1) {
    throw new Error("SINGLE_MACHINE_ROOT_COUNT_INVALID");
  }
}

export function calculateTopologyForestCapacity(
  forest: TopologyForest
): Array<{ rootSourceId: string; capacity: number }> {
  validateTopologyForest(forest);
  return forest.roots.map((root) => ({
    rootSourceId: root.sourceId,
    capacity: calculateNodeCapacity(root)
  }));
}

export function transitionUphVersion(
  version: VersionTransitionInput,
  transition: VersionTransition
): VersionTransitionInput {
  if (transition === "SUPERSEDE") throw new Error("CONTROLLED_REPLACEMENT_REQUIRED");
  if (version.status !== "DRAFT") throw new Error("VERSION_IMMUTABLE");
  if (transition === "PATCH") {
    if (version.commissioningSigned) throw new Error("VERSION_IMMUTABLE");
    return { ...version };
  }
  if (!version.commissioningSigned) throw new Error("COMMISSIONING_REQUIRED");
  return { status: "PUBLISHED", commissioningSigned: true };
}

export function replaceSignedDraft(input: {
  rootVersion: number;
  currentWork: {
    id: string;
    status: UphVersionState;
    commissioningSigned: boolean;
    contentChecksum: string;
  };
  replacement: { contentChecksum: string; reasonCode: string; reason: string };
}) {
  if (input.currentWork.status !== "DRAFT" || !input.currentWork.commissioningSigned) {
    throw new Error("SIGNED_DRAFT_REQUIRED");
  }
  if (input.replacement.reasonCode !== "DRAFT_CORRECTION" || !input.replacement.reason.trim()) {
    throw new Error("REPLACEMENT_REASON_INVALID");
  }
  if (
    !input.replacement.contentChecksum ||
    input.replacement.contentChecksum === input.currentWork.contentChecksum
  ) {
    throw new Error("REPLACEMENT_CONTENT_INVALID");
  }
  return {
    rootVersion: input.rootVersion + 1,
    oldStatus: "SUPERSEDED" as const,
    successorStatus: "DRAFT" as const,
    supersedesVersionId: input.currentWork.id,
    reasonCode: "DRAFT_CORRECTION" as const
  };
}

function validateNode(
  node: TopologyNode,
  expectedParent: string | null,
  seen: Set<string>,
  path: Set<string>
): void {
  const raw = node as unknown as Record<string, unknown>;
  if ("parallelGroups" in raw || "groupKey" in raw)
    throw new Error("UNSUPPORTED_PARALLEL_TOPOLOGY");
  if (path.has(node.sourceId)) throw new Error("TOPOLOGY_CYCLE");
  if (seen.has(node.sourceId)) throw new Error("TOPOLOGY_DUPLICATE_SOURCE");
  if (node.parentSourceId !== expectedParent) throw new Error("TOPOLOGY_PARENT_MISMATCH");
  if (node.relation === "ROOT" && expectedParent !== null) throw new Error("TOPOLOGY_ROOT_INVALID");
  if (node.relation !== "ROOT" && expectedParent === null) throw new Error("TOPOLOGY_ROOT_INVALID");
  if (node.capacity !== undefined) assertPositive(node.capacity, "TOPOLOGY_CAPACITY_INVALID");

  seen.add(node.sourceId);
  path.add(node.sourceId);
  for (const child of node.children ?? []) validateNode(child, node.sourceId, seen, path);
  path.delete(node.sourceId);
}

function calculateNodeCapacity(node: TopologyNode): number {
  const children = node.children ?? [];
  if (!children.length) {
    if (node.capacity === undefined) throw new Error("TOPOLOGY_CAPACITY_REQUIRED");
    return node.capacity;
  }
  const mandatory = children
    .filter((child) => child.relation === "MANDATORY")
    .map(calculateNodeCapacity);
  const parallel = children
    .filter((child) => child.relation === "PARALLEL")
    .map(calculateNodeCapacity);
  const mandatoryCapacity = mandatory.length ? Math.min(...mandatory) : undefined;
  const parallelCapacity = parallel.length
    ? parallel.reduce((sum, value) => sum + value, 0)
    : undefined;
  if (mandatoryCapacity !== undefined && parallelCapacity !== undefined) {
    return Math.min(mandatoryCapacity, parallelCapacity);
  }
  if (mandatoryCapacity !== undefined) return mandatoryCapacity;
  if (parallelCapacity !== undefined) return parallelCapacity;
  throw new Error("TOPOLOGY_RELATION_REQUIRED");
}

function assertPositive(value: number, code: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(code);
}

function assertPositiveInteger(value: number, code: string): void {
  assertPositive(value, code);
  if (!Number.isInteger(value)) throw new Error(code);
}
