export type CockpitNavigationId = "overview" | "progress" | "risks" | "resource-load";

type CockpitNavigationDefinition = {
  id: CockpitNavigationId;
  label: string;
  path: string;
  available: boolean;
};

export type PublishedCockpitNavigationItem = {
  id: CockpitNavigationId;
  label: string;
  available: true;
  href: string;
};

export type UnpublishedCockpitNavigationItem = {
  id: CockpitNavigationId;
  label: string;
  available: false;
  unavailableLabel: "尚未开放";
};

export type CockpitNavigationItem =
  PublishedCockpitNavigationItem | UnpublishedCockpitNavigationItem;

export const COCKPIT_NAVIGATION = [
  { id: "overview", label: "总览", path: "?view=overview", available: true },
  { id: "progress", label: "进度与里程碑", path: "?view=progress", available: true },
  { id: "risks", label: "风险与问题", path: "?view=risks", available: true },
  { id: "resource-load", label: "资源负荷", path: "resource-load", available: true }
] as const satisfies readonly CockpitNavigationDefinition[];

function normalizedPathname(pathname: string | null | undefined) {
  if (!pathname) return null;
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function cockpitRoot(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}/cockpit`;
}

function itemForProject(
  projectId: string,
  entry: CockpitNavigationDefinition,
  fixture?: string
): CockpitNavigationItem {
  if (!entry.available) {
    return { id: entry.id, label: entry.label, available: false, unavailableLabel: "尚未开放" };
  }
  const href = entry.path.startsWith("?")
    ? `${cockpitRoot(projectId)}${entry.path}`
    : `${cockpitRoot(projectId)}/${entry.path}`;
  return {
    id: entry.id,
    label: entry.label,
    available: true,
    href:
      entry.id !== "resource-load" && isCockpitDashboardFixture(fixture)
        ? `${href}&fixture=${encodeURIComponent(fixture)}`
        : href
  };
}

export function buildCockpitNavigation(
  projectId: string,
  fixture?: string
): CockpitNavigationItem[] {
  return COCKPIT_NAVIGATION.map((entry) => itemForProject(projectId, entry, fixture));
}

export function selectedCockpitNavigation(
  projectId: string,
  pathname: string | null | undefined,
  search = ""
): CockpitNavigationId | null {
  const normalized = normalizedPathname(pathname);
  const root = cockpitRoot(projectId);
  if (!normalized) return null;
  if (normalized === root) {
    const view = new URLSearchParams(search).get("view");
    if (view === "progress" || view === "risks") return view;
    return "overview";
  }
  if (normalized === `${root}/resource-load`) return "resource-load";
  return null;
}
import { isCockpitDashboardFixture } from "./cockpit-dashboard-page-state";
