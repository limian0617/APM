const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export type ResourceLoadSourceRow = {
  ownerMembershipId: string;
  personId: string;
  personName: string;
  departmentId: string | null;
  discipline: string;
  taskId: string;
  taskCode: string;
  taskName: string;
  plannedStartAt: Date;
  plannedFinishAt: Date;
};

type ResourceLoadTask = {
  taskId: string;
  taskCode: string;
  taskName: string;
  plannedStartAt: string;
  plannedFinishAt: string;
  plannedDays: number;
};

type ResourceLoadPerson = {
  ownerMembershipId: string;
  personId: string;
  personName: string;
  plannedDays: number;
  activeTaskCount: number;
  tasks: ResourceLoadTask[];
};

type ResourceLoadDiscipline = {
  discipline: string;
  plannedDays: number;
  activeTaskCount: number;
  people: ResourceLoadPerson[];
};

export type ResourceLoadDepartment = {
  departmentId: string;
  plannedDays: number;
  activeTaskCount: number;
  disciplines: ResourceLoadDiscipline[];
};

type MutablePerson = ResourceLoadPerson;
type MutableDiscipline = ResourceLoadDiscipline;
type MutableDepartment = ResourceLoadDepartment;

function utcDateStart(value: Date): number {
  if (Number.isNaN(value.getTime())) {
    throw new TypeError("planned date must be valid");
  }
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

export function plannedLoadDays(plannedStartAt: Date, plannedFinishAt: Date): number {
  const start = utcDateStart(plannedStartAt);
  const finish = utcDateStart(plannedFinishAt);
  if (finish < start) {
    throw new RangeError("planned finish cannot precede planned start");
  }
  return Math.floor((finish - start) / MILLISECONDS_PER_DAY) + 1;
}

function departmentKey(departmentId: string | null): string {
  const normalized = departmentId?.trim();
  return normalized || "UNASSIGNED";
}

function compareDepartment(left: string, right: string): number {
  if (left === "UNASSIGNED") return right === "UNASSIGNED" ? 0 : 1;
  if (right === "UNASSIGNED") return -1;
  return left.localeCompare(right);
}

function compareTasks(left: ResourceLoadTask, right: ResourceLoadTask): number {
  return (
    left.plannedStartAt.localeCompare(right.plannedStartAt) ||
    left.taskCode.localeCompare(right.taskCode) ||
    left.taskId.localeCompare(right.taskId)
  );
}

export function deriveResourceLoad(
  rows: readonly ResourceLoadSourceRow[],
  includePeople: boolean
): ResourceLoadDepartment[] {
  const departments = new Map<string, MutableDepartment>();
  const disciplines = new Map<string, MutableDiscipline>();
  const people = new Map<string, MutablePerson>();

  for (const row of rows) {
    const departmentId = departmentKey(row.departmentId);
    const plannedDays = plannedLoadDays(row.plannedStartAt, row.plannedFinishAt);
    let department = departments.get(departmentId);
    if (!department) {
      department = { departmentId, plannedDays: 0, activeTaskCount: 0, disciplines: [] };
      departments.set(departmentId, department);
    }

    const disciplineKey = `${departmentId}\u0000${row.discipline}`;
    let discipline = disciplines.get(disciplineKey);
    if (!discipline) {
      discipline = { discipline: row.discipline, plannedDays: 0, activeTaskCount: 0, people: [] };
      disciplines.set(disciplineKey, discipline);
      department.disciplines.push(discipline);
    }

    department.plannedDays += plannedDays;
    department.activeTaskCount += 1;
    discipline.plannedDays += plannedDays;
    discipline.activeTaskCount += 1;
    if (!includePeople) continue;

    const personKey = `${disciplineKey}\u0000${row.ownerMembershipId}`;
    let person = people.get(personKey);
    if (!person) {
      person = {
        ownerMembershipId: row.ownerMembershipId,
        personId: row.personId,
        personName: row.personName,
        plannedDays: 0,
        activeTaskCount: 0,
        tasks: []
      };
      people.set(personKey, person);
      discipline.people.push(person);
    }

    person.plannedDays += plannedDays;
    person.activeTaskCount += 1;
    person.tasks.push({
      taskId: row.taskId,
      taskCode: row.taskCode,
      taskName: row.taskName,
      plannedStartAt: row.plannedStartAt.toISOString(),
      plannedFinishAt: row.plannedFinishAt.toISOString(),
      plannedDays
    });
  }

  return [...departments.values()]
    .sort((left, right) => compareDepartment(left.departmentId, right.departmentId))
    .map((department) => ({
      ...department,
      disciplines: department.disciplines
        .sort((left, right) => left.discipline.localeCompare(right.discipline))
        .map((discipline) => ({
          ...discipline,
          people: discipline.people
            .sort(
              (left, right) =>
                left.personName.localeCompare(right.personName) ||
                left.ownerMembershipId.localeCompare(right.ownerMembershipId)
            )
            .map((person) => ({ ...person, tasks: person.tasks.sort(compareTasks) }))
        }))
    }));
}
