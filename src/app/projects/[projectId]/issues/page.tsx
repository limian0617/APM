import { IssueCapturePageClient } from "./issue-capture-page-client";

type IssuesPageProps = Readonly<{
  params: Promise<{ projectId: string }>;
}>;

export default async function IssuesPage({ params }: IssuesPageProps) {
  const { projectId } = await params;
  return <IssueCapturePageClient projectId={projectId} />;
}
