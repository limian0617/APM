import {
  issueApm104BrowserIdentityToken,
  provisionApm104BrowserFixture
} from "@/modules/retrospectives/infrastructure/apm-104-browser-fixture-loader";

export async function POST() {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const fixture = await provisionApm104BrowserFixture();
  return Response.json({
    ...fixture,
    identityTokens: {
      sourceManager: issueApm104BrowserIdentityToken(fixture.users.sourceManagerId),
      retrospectiveReviewer: issueApm104BrowserIdentityToken(fixture.users.retrospectiveReviewerId),
      knowledgeReviewer: issueApm104BrowserIdentityToken(fixture.users.knowledgeReviewerId),
      targetManager: issueApm104BrowserIdentityToken(fixture.users.targetManagerId)
    }
  });
}
