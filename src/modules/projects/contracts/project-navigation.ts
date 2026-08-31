export type ProjectPrimaryNavigationId =
  | "overview"
  | "plan"
  | "responsibility-packages"
  | "deliverables"
  | "issues"
  | "procurement"
  | "uph"
  | "acceptance";

export type ProjectMoreNavigationId = "changes" | "governance" | "settings";

type ProjectNavigationDefinition<Id extends string> = {
  id: Id;
  label: string;
  path: string;
  available: boolean;
};

export type PublishedProjectNavigationItem<Id extends string> = {
  id: Id;
  label: string;
  available: true;
  href: string;
};

export type UnpublishedProjectNavigationItem<Id extends string> = {
  id: Id;
  label: string;
  available: false;
  unavailableLabel: "尚未开放";
};

export type ProjectNavigationItem<Id extends string> =
  PublishedProjectNavigationItem<Id> | UnpublishedProjectNavigationItem<Id>;

export const PROJECT_PRIMARY_NAVIGATION = [
  { id: "overview", label: "总览", path: "cockpit?view=overview", available: true },
  { id: "plan", label: "计划", path: "execution", available: true },
  {
    id: "responsibility-packages",
    label: "责任包",
    path: "responsibility-packages",
    available: false
  },
  { id: "deliverables", label: "交付物", path: "deliverables", available: false },
  { id: "issues", label: "问题", path: "issues", available: true },
  { id: "procurement", label: "采购", path: "procurement?view=overview", available: true },
  { id: "uph", label: "UPH", path: "uph", available: true },
  { id: "acceptance", label: "FAT/SAT", path: "acceptance", available: true }
] as const satisfies readonly ProjectNavigationDefinition<ProjectPrimaryNavigationId>[];

export const PROJECT_MORE_NAVIGATION = [
  { id: "changes", label: "变更", path: "changes", available: false },
  { id: "governance", label: "审批与记录", path: "governance", available: true },
  { id: "settings", label: "项目设置", path: "settings", available: false }
] as const satisfies readonly ProjectNavigationDefinition<ProjectMoreNavigationId>[];

function normalizedPathname(pathname: string | null | undefined) {
  if (!pathname) return null;
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function projectRoot(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}`;
}

function itemForProject<Id extends string>(
  projectId: string,
  entry: ProjectNavigationDefinition<Id>
): ProjectNavigationItem<Id> {
  if (!entry.available) {
    return { id: entry.id, label: entry.label, available: false, unavailableLabel: "尚未开放" };
  }
  return {
    id: entry.id,
    label: entry.label,
    available: true,
    href: `${projectRoot(projectId)}/${entry.path}`
  };
}

export function buildProjectNavigation(projectId: string) {
  return {
    primary: PROJECT_PRIMARY_NAVIGATION.map((entry) => itemForProject(projectId, entry)),
    more: PROJECT_MORE_NAVIGATION.map((entry) => itemForProject(projectId, entry))
  };
}

export function selectedProjectNavigation(
  projectId: string,
  pathname: string | null | undefined
): ProjectPrimaryNavigationId | ProjectMoreNavigationId | null {
  const normalized = normalizedPathname(pathname);
  const root = projectRoot(projectId);
  if (!normalized || !normalized.startsWith(`${root}/`)) return null;
  if (normalized === `${root}/cockpit` || normalized.startsWith(`${root}/cockpit/`)) {
    return "overview";
  }
  if (normalized === `${root}/execution` || normalized.startsWith(`${root}/execution/`)) {
    return "plan";
  }
  if (normalized === `${root}/procurement` || normalized.startsWith(`${root}/procurement/`)) {
    return "procurement";
  }
  if (normalized === `${root}/issues` || normalized.startsWith(`${root}/issues/`)) {
    return "issues";
  }
  if (normalized === `${root}/acceptance` || normalized.startsWith(`${root}/acceptance/`)) {
    return "acceptance";
  }
  if (normalized === `${root}/uph` || normalized.startsWith(`${root}/uph/`)) {
    return "uph";
  }
  if (normalized === `${root}/governance` || normalized.startsWith(`${root}/governance/`)) {
    return "governance";
  }
  return null;
}
