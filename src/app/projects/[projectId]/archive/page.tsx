import { ArchivePageClient } from "./archive-page-client";
import {
  buildArchivePageState,
  type ArchivePageState
} from "@/modules/archives/contracts/archive-page-state";

type PageProps = {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ fixture?: string }>;
};

export function resolveArchiveFixture(
  projectId: string,
  name: string | undefined,
  environment: string | undefined = process.env.NODE_ENV
): ArchivePageState | null {
  if (environment !== "development") return null;
  if (name === "loading") return { projectId, status: "loading" };
  if (name === "denied") return { projectId, status: "denied" };
  if (name === "error") return { projectId, status: "error", retryable: true };
  if (name === "empty") return { projectId, status: "empty", allowedActions: ["GENERATE"] };
  if (name === "stale" || name === "normal")
    return buildArchivePageState({
      projectId,
      result: {
        status: 200,
        stale: name === "stale",
        fetchedAt: "2026-08-11T12:00:00.000Z",
        body: {
          archive: {
            id: "archive-demo",
            finalArchiveVersionId: null,
            versions: [
              {
                id: "archive-version-demo",
                projectId,
                version: 1,
                status: "READY",
                manifestChecksum: "a".repeat(64),
                sourceWatermark: "b".repeat(64),
                itemCount: 6,
                latestIntegrityCheck: {
                  id: "check-demo",
                  status: "PASSED",
                  checkedAt: "2026-08-11T12:00:00.000Z"
                }
              }
            ]
          }
        }
      },
      allowedActions: ["GENERATE", "RECHECK", "CLOSE"]
    });
  return null;
}

export default async function ProjectArchivePage({ params, searchParams }: PageProps) {
  const { projectId } = await params;
  const { fixture: fixtureName } = await searchParams;
  const initialState = resolveArchiveFixture(projectId, fixtureName);
  return <ArchivePageClient projectId={projectId} initialState={initialState} />;
}
