export type UphBatchSummary = {
  id: string;
  batchNumber: string;
  currentWorkRevisionId: string | null;
  currentLockedRevisionId: string | null;
  resourceVersion: number;
};

export type UphRevisionSummary = {
  id: string;
  projectId: string;
  batchId: string;
  revisionNumber: number;
  status: string;
  resourceVersion: number;
  topologyRootNodeId: string;
  topologyVersionId: string;
  formulaVersionId: string;
  processOwnerUserId: string;
  pmConfirmerUserId: string | null;
  qualityLockerUserId: string | null;
  moduleBindings: Array<{
    id: string;
    projectModuleId: string;
    ctDefinitionId: string;
    ctVersionId: string;
  }>;
};

export type UphAnalysisSnapshotDto = {
  analysisId: string;
  projectId: string;
  batchId: string;
  revisionId: string;
  lockedChecksum: string;
  formulaVersionId: string;
  formulaChecksum: string;
  engineCode: string;
  status: "COMPUTED" | "NO_OUTPUT" | string;
  warnings: unknown;
  rootMeasuredCapacityUph: unknown;
  actualGoodUph: unknown;
  a: unknown;
  resourceVersion: unknown;
  createdById: unknown;
  createdAt: unknown;
  inputSnapshot: unknown;
  resultSnapshot: unknown;
};

export type UphAnalysisListDto = {
  items: UphAnalysisSnapshotDto[];
  nextCursor: string | null;
};

export type AnalysisCandidateView = {
  sourceType: string;
  sourceId: string;
  relation: string;
  capacityUph: string;
  members: string[];
};

export type ReductionLevelView = {
  nodeId: string;
  topologyPath: string;
  sourceType: string;
  sourceId: string;
  selectedCapacityUph: string;
  candidates: AnalysisCandidateView[];
};

export type AnalysisView = {
  id: string;
  status: string;
  engineCode: string;
  formulaVersionId: string;
  formulaChecksum: string;
  lockedChecksum: string;
  createdById: string | null;
  createdAt: string | null;
  rootMeasuredCapacityUph: string | null;
  actualGoodUph: string | null;
  a: string | null;
  warnings: string[];
  moduleFpy: Array<{ moduleId: string; fpy: string | null }>;
  moduleCycleTimes: Array<{
    moduleId: string;
    intrinsicCtSeconds: string | null;
    p90Seconds: string | null;
  }>;
  bottleneck: AnalysisCandidateView[];
  secondBottleneck: AnalysisCandidateView[];
  reductionLevels: ReductionLevelView[];
  statistics: {
    validSampleCount: string | null;
    p50Seconds: string | null;
    p90Seconds: string | null;
    maxSeconds: string | null;
  };
};

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function candidate(value: unknown): AnalysisCandidateView | null {
  const item = record(value);
  if (!item) return null;
  const sourceType = stringValue(item.sourceType);
  const sourceId = stringValue(item.sourceId);
  if (!sourceType || !sourceId) return null;
  const members = Array.isArray(item.members)
    ? item.members.flatMap((member) => {
        const source = record(member);
        const id = source ? stringValue(source.sourceId) : null;
        return id ? [id] : [];
      })
    : [];
  return {
    sourceType,
    sourceId,
    relation: stringValue(item.relation) ?? "无数据",
    capacityUph: stringValue(item.capacityUph) ?? "无数据",
    members
  };
}

function candidates(value: unknown): AnalysisCandidateView[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const parsed = candidate(item);
        return parsed ? [parsed] : [];
      })
    : [];
}

function reductionLevels(value: unknown): ReductionLevelView[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = record(entry);
    if (!item) return [];
    const nodeId = stringValue(item.nodeId);
    if (!nodeId) return [];
    return [
      {
        nodeId,
        topologyPath: stringValue(item.topologyPath) ?? "无数据",
        sourceType: stringValue(item.sourceType) ?? "无数据",
        sourceId: stringValue(item.sourceId) ?? "无数据",
        selectedCapacityUph: stringValue(item.selectedCapacityUph) ?? "无数据",
        candidates: candidates(item.candidates)
      }
    ];
  });
}

function sourceStatistics(inputSnapshot: unknown) {
  const input = record(inputSnapshot);
  const bindings = input && Array.isArray(input.bindings) ? input.bindings : [];
  const first = record(bindings[0]);
  return {
    validSampleCount: stringValue(first?.validSampleCount),
    p50Seconds: stringValue(first?.p50Seconds),
    p90Seconds: stringValue(first?.p90Seconds),
    maxSeconds: stringValue(first?.maxSeconds)
  };
}

function moduleCycleTimes(inputSnapshot: unknown) {
  const input = record(inputSnapshot);
  const bindings = input && Array.isArray(input.bindings) ? input.bindings : [];
  return bindings.flatMap((entry) => {
    const item = record(entry);
    const moduleId = stringValue(item?.projectModuleId);
    if (!moduleId) return [];
    return [
      {
        moduleId,
        intrinsicCtSeconds: stringValue(item?.intrinsicCtSeconds),
        p90Seconds: stringValue(item?.p90Seconds)
      }
    ];
  });
}

/** Converts an untrusted API snapshot to a display-only view without recalculation. */
export function toAnalysisView(snapshot: UphAnalysisSnapshotDto): AnalysisView {
  const result = record(snapshot.resultSnapshot);
  const moduleFpy = Array.isArray(result?.moduleFpy)
    ? result.moduleFpy.flatMap((entry) => {
        const item = record(entry);
        const moduleId = stringValue(item?.moduleId);
        if (!moduleId) return [];
        return [{ moduleId, fpy: stringValue(item?.fpy) }];
      })
    : [];
  return {
    id: stringValue(snapshot.analysisId) ?? "无数据",
    status: stringValue(snapshot.status) ?? "无数据",
    engineCode: stringValue(snapshot.engineCode) ?? "无数据",
    formulaVersionId: stringValue(snapshot.formulaVersionId) ?? "无数据",
    formulaChecksum: stringValue(snapshot.formulaChecksum) ?? "无数据",
    lockedChecksum: stringValue(snapshot.lockedChecksum) ?? "无数据",
    createdById: stringValue(snapshot.createdById),
    createdAt: stringValue(snapshot.createdAt),
    rootMeasuredCapacityUph: stringValue(snapshot.rootMeasuredCapacityUph),
    actualGoodUph: stringValue(snapshot.actualGoodUph),
    a: stringValue(snapshot.a),
    warnings: stringArray(snapshot.warnings),
    moduleFpy,
    moduleCycleTimes: moduleCycleTimes(snapshot.inputSnapshot),
    bottleneck: candidates(result?.bottleneck),
    secondBottleneck: candidates(result?.secondBottleneck),
    reductionLevels: reductionLevels(result?.reductionLevels),
    statistics: sourceStatistics(snapshot.inputSnapshot)
  };
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "无数据";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "无数据";
}

export function statusLabel(status: string): string {
  return (
    (
      {
        LOCKED: "已锁定",
        SUPERSEDED: "已被后续版本替代",
        DRAFT: "草稿",
        PM_CONFIRMED: "PM已确认",
        COMPUTED: "已计算",
        NO_OUTPUT: "无产出"
      } as Record<string, string>
    )[status] ?? status
  );
}
