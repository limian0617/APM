import { DrawingWorkspaceClient } from "./drawing-workspace-client";
import {
  buildDrawingWorkspacePageState,
  resolveDrawingWorkspaceFixture,
  toDrawingWorkspaceFetchResult,
  type DrawingWorkspacePageState
} from "@/modules/drawings/contracts/drawing-workspace-page-state";

type PageProps = Readonly<{
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ fixture?: string }>;
}>;

const fixtureTimestamp = "2026-08-11T03:00:00.000Z";

export function developmentDrawingWorkspaceFixture(
  projectId: string,
  fixture: string | undefined
): { state: DrawingWorkspacePageState; commandError: string | null } | null {
  const allowed = resolveDrawingWorkspaceFixture(fixture, process.env.NODE_ENV);
  if (!allowed) return null;
  if (allowed === "loading") return { state: { projectId, status: "loading" }, commandError: null };
  if (allowed === "denied") return { state: { projectId, status: "denied" }, commandError: null };
  if (allowed === "error") {
    return { state: { projectId, status: "error", retryable: true }, commandError: null };
  }
  const drawings =
    allowed === "empty"
      ? []
      : [
          {
            id: "drawing-demo-1",
            projectId,
            drawingNumber: "DWG-DEMO-001",
            drawingType: "PART",
            version: 2,
            resourceVersion: 2,
            allowedActions: ["UPDATE_CLASSIFICATION"],
            document: { currentPublishedVersionId: "drawing-document-version-demo-1" },
            classification: {
              category: { id: "category-machining", code: "MACHINING", name: "机加工" },
              processTags: [{ id: "tag-milling", code: "MILLING", name: "铣削" }]
            }
          }
        ];
  const selections =
    allowed === "empty"
      ? []
      : [
          {
            id: "selection-demo-1",
            projectId,
            code: "SELECT-DEMO-001",
            title: "内部制造准备",
            status: "DRAFT",
            version: 1,
            allowedActions: ["ADD_ITEM", "LOCK"],
            items: []
          }
        ];
  const configuration = [
    { id: "category-machining", code: "MACHINING", name: "机加工", isActive: true },
    { id: "category-sheet-metal", code: "SHEET_METAL", name: "钣金", isActive: true }
  ];
  const processTags = [{ id: "tag-milling", code: "MILLING", name: "铣削", isActive: true }];
  const state = buildDrawingWorkspacePageState({
    projectId,
    drawings: toDrawingWorkspaceFetchResult({
      status: 200,
      body: { drawings },
      fetchedAt: fixtureTimestamp,
      stale: allowed === "stale"
    }),
    selections: toDrawingWorkspaceFetchResult({
      status: 200,
      body: { selectionSets: selections, allowedActions: ["CREATE_SELECTION"] },
      fetchedAt: fixtureTimestamp
    }),
    categories: toDrawingWorkspaceFetchResult({
      status: 200,
      body: configuration,
      fetchedAt: fixtureTimestamp
    }),
    processTags: toDrawingWorkspaceFetchResult({
      status: 200,
      body: processTags,
      fetchedAt: fixtureTimestamp
    }),
    suppliers: toDrawingWorkspaceFetchResult({
      status: 200,
      body: {
        matches:
          allowed === "no-match" || allowed === "empty"
            ? []
            : [
                {
                  supplierReferenceId: "supplier-demo-1",
                  supplierName: "示例机加工供应商",
                  categoryCode: "MACHINING",
                  supplierMatchState: "DEFAULT_MATCH"
                }
              ]
      },
      fetchedAt: fixtureTimestamp
    })
  });
  return {
    state,
    commandError: allowed === "conflict" ? "数据已被其他成员更新，请刷新后重试。" : null
  };
}

export default async function DrawingsPage({ params, searchParams }: PageProps) {
  const { projectId } = await params;
  const { fixture } = await searchParams;
  const developmentFixture = developmentDrawingWorkspaceFixture(projectId, fixture);
  return (
    <DrawingWorkspaceClient
      projectId={projectId}
      initialState={developmentFixture?.state ?? null}
      initialCommandError={developmentFixture?.commandError}
    />
  );
}
