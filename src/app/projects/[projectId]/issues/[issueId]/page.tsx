import { IssueDetailPageClient } from "./issue-detail-page-client";

type IssueDetailPageProps = Readonly<{
  params: Promise<{ projectId: string; issueId: string }>;
}>;

export default async function IssueDetailPage({ params }: IssueDetailPageProps) {
  const { projectId, issueId } = await params;
  return <IssueDetailPageClient projectId={projectId} issueId={issueId} />;
}
