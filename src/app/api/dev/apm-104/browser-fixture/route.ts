import {
  issueApm104BrowserIdentityToken,
  provisionApm104BrowserFixture
} from "@/modules/retrospectives/infrastructure/apm-104-browser-fixture-loader";

export async function POST() {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const fixture = await provisionApm104BrowserFixture();
  return Response.json({
    ...fixture,
    identityToken: issueApm104BrowserIdentityToken(fixture.users.authorId)
  });
}
