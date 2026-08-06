"use client";

import { usePathname } from "next/navigation";

import {
  buildProjectNavigation,
  selectedProjectNavigation,
  type ProjectNavigationItem
} from "@/modules/projects/contracts/project-navigation";

type ProjectNavigationContentProps = {
  projectId: string;
  pathname: string | null;
};

function navigationClassName(item: ProjectNavigationItem<string>, activeId: string | null) {
  return [
    "project-navigation-item",
    item.available ? "project-navigation-link" : "project-navigation-unavailable",
    item.id === activeId ? "is-active" : null
  ]
    .filter(Boolean)
    .join(" ");
}

function NavigationItem({
  item,
  activeId
}: {
  item: ProjectNavigationItem<string>;
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

export function ProjectNavigationContent({ projectId, pathname }: ProjectNavigationContentProps) {
  const navigation = buildProjectNavigation(projectId);
  const activeId = selectedProjectNavigation(projectId, pathname);

  return (
    <nav className="project-navigation" aria-label="项目导航">
      <div className="project-navigation-primary">
        {navigation.primary.map((item) => (
          <NavigationItem activeId={activeId} item={item} key={item.id} />
        ))}
      </div>
      <details className="project-navigation-more">
        <summary>更多</summary>
        <div className="project-navigation-more-menu" aria-label="更多项目入口">
          {navigation.more.map((item) => (
            <NavigationItem activeId={null} item={item} key={item.id} />
          ))}
        </div>
      </details>
    </nav>
  );
}

export function ProjectNavigationClient({ projectId }: { projectId: string }) {
  return <ProjectNavigationContent projectId={projectId} pathname={usePathname()} />;
}
