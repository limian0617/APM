"use client";

import { usePathname, useSearchParams } from "next/navigation";

import {
  buildCockpitNavigation,
  selectedCockpitNavigation,
  type CockpitNavigationItem
} from "@/modules/cockpit/contracts/cockpit-navigation";

type CockpitNavigationContentProps = {
  projectId: string;
  pathname: string | null;
  search?: string;
};

function navigationClassName(item: CockpitNavigationItem, activeId: string | null) {
  return [
    "cockpit-view-navigation-item",
    item.available ? "cockpit-view-navigation-link" : "cockpit-view-navigation-unavailable",
    item.id === activeId ? "is-active" : null
  ]
    .filter(Boolean)
    .join(" ");
}

function NavigationItem({
  item,
  activeId
}: {
  item: CockpitNavigationItem;
  activeId: string | null;
}) {
  const isActive = item.id === activeId;
  const className = navigationClassName(item, activeId);
  if (item.available) {
    return (
      <a className={className} href={item.href} aria-current={isActive ? "page" : undefined}>
        {item.label}
      </a>
    );
  }
  return (
    <span className={className} aria-current={isActive ? "page" : undefined} aria-disabled="true">
      <span>{item.label}</span>
      <small>{item.unavailableLabel}</small>
    </span>
  );
}

export function CockpitNavigationContent({
  projectId,
  pathname,
  search = ""
}: CockpitNavigationContentProps) {
  const fixture = new URLSearchParams(search).get("fixture") ?? undefined;
  const navigation = buildCockpitNavigation(projectId, fixture);
  const activeId = selectedCockpitNavigation(projectId, pathname, search);

  return (
    <nav className="cockpit-view-navigation" aria-label="驾驶舱视图导航">
      <div className="cockpit-view-navigation-list">
        {navigation.map((item) => (
          <NavigationItem activeId={activeId} item={item} key={item.id} />
        ))}
      </div>
    </nav>
  );
}

export function CockpitNavigationClient({ projectId }: { projectId: string }) {
  const searchParams = useSearchParams();
  return (
    <CockpitNavigationContent
      projectId={projectId}
      pathname={usePathname()}
      search={searchParams.toString()}
    />
  );
}
