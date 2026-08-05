export const RESOURCE_LOAD_FIXTURES = [
  "normal",
  "loading",
  "empty",
  "error",
  "denied",
  "stale",
  "aggregate-only",
  "not-available"
] as const;

export type ResourceLoadFixture = (typeof RESOURCE_LOAD_FIXTURES)[number];

export function isResourceLoadFixture(value: string | undefined): value is ResourceLoadFixture {
  return value !== undefined && RESOURCE_LOAD_FIXTURES.includes(value as ResourceLoadFixture);
}

export type ResourceLoadTaskDto = {
  taskId: string;
  taskCode: string;
  taskName: string;
  plannedStartAt: string;
  plannedFinishAt: string;
  plannedDays: number;
};

export type ResourceLoadPersonDto = {
  ownerMembershipId: string;
  personId: string;
  personName: string;
  plannedDays: number;
  activeTaskCount: number;
  tasks: ResourceLoadTaskDto[];
};

export type ResourceLoadDisciplineDto = {
  discipline: string;
  plannedDays: number;
  activeTaskCount: number;
  people: ResourceLoadPersonDto[];
};

export type ResourceLoadDepartmentDto = {
  departmentId: string;
  plannedDays: number;
  activeTaskCount: number;
  disciplines: ResourceLoadDisciplineDto[];
};

export type ResourceLoadProjectionDto = {
  projectionId: string;
  projectId: string;
  sourceChecksum: string;
  calculatedAt: string;
  peopleCount: number;
  departments: ResourceLoadDepartmentDto[];
};

export type ResourceLoadDto = {
  status: "READY" | "STALE";
  projection: ResourceLoadProjectionDto;
  peopleIncluded: boolean;
};

export type ResourceLoadResponseData =
  ResourceLoadDto | { status: "NOT_AVAILABLE"; projection: null; peopleIncluded: false };

export type ResourceLoadFetchResult =
  | { kind: "loading" }
  | { kind: "error"; status: number; message: string }
  | { kind: "success"; data: ResourceLoadResponseData };

export type ResourceLoadPageState =
  | { kind: "loading" }
  | { kind: "denied" }
  | { kind: "error"; message: string; retryable: boolean }
  | { kind: "not-available" }
  | {
      kind: "empty";
      freshness: "READY" | "STALE";
      calculatedAt: string;
      peopleIncluded: boolean;
    }
  | {
      kind: "populated";
      freshness: "READY" | "STALE";
      calculatedAt: string;
      projectionId: string;
      peopleIncluded: boolean;
      departments: ResourceLoadDepartmentDto[];
      plannedDays: number;
    };

function redactPeople(
  departments: ResourceLoadDepartmentDto[],
  peopleIncluded: boolean
): ResourceLoadDepartmentDto[] {
  if (peopleIncluded) return departments;
  return departments.map((department) => ({
    ...department,
    disciplines: department.disciplines.map((discipline) => ({ ...discipline, people: [] }))
  }));
}

export function buildResourceLoadPageState(input: ResourceLoadFetchResult): ResourceLoadPageState {
  if (input.kind === "loading") return { kind: "loading" };
  if (input.kind === "error") {
    if (input.status === 401 || input.status === 403) return { kind: "denied" };
    return { kind: "error", message: input.message, retryable: input.status >= 500 };
  }
  if (!input.data.projection) return { kind: "not-available" };

  const { projection, peopleIncluded, status } = input.data;
  const departments = redactPeople(projection.departments, peopleIncluded);
  if (departments.length === 0) {
    return {
      kind: "empty",
      freshness: status,
      calculatedAt: projection.calculatedAt,
      peopleIncluded
    };
  }
  return {
    kind: "populated",
    freshness: status,
    calculatedAt: projection.calculatedAt,
    projectionId: projection.projectionId,
    peopleIncluded,
    departments,
    plannedDays: departments.reduce((total, department) => total + department.plannedDays, 0)
  };
}

export function findResourceLoadPerson(
  state: ResourceLoadPageState,
  selection: { departmentId: string; discipline: string; ownerMembershipId: string }
): ResourceLoadPersonDto | null {
  const discipline = findResourceLoadDiscipline(state, selection);
  return (
    discipline?.people.find(
      (candidate) => candidate.ownerMembershipId === selection.ownerMembershipId
    ) ?? null
  );
}

export function findResourceLoadDiscipline(
  state: ResourceLoadPageState,
  selection: { departmentId: string; discipline: string }
): ResourceLoadDisciplineDto | null {
  if (state.kind !== "populated" || !state.peopleIncluded) return null;
  const department = state.departments.find(
    (candidate) => candidate.departmentId === selection.departmentId
  );
  return (
    department?.disciplines.find((candidate) => candidate.discipline === selection.discipline) ??
    null
  );
}
