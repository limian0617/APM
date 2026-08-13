import { consumeApm104BrowserIdentityToken } from "@/modules/retrospectives/infrastructure/apm-104-browser-fixture-loader";

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const body = (await request.json()) as { identityToken?: unknown };
  const userId =
    typeof body.identityToken === "string" && body.identityToken.trim()
      ? consumeApm104BrowserIdentityToken(body.identityToken.trim())
      : null;
  if (!userId) {
    return Response.json({ error: { code: "VALIDATION_FAILED" } }, { status: 422 });
  }
  const headers = new Headers({ "content-type": "application/json" });
  headers.append(
    "set-cookie",
    `apm-dev-user-id=${encodeURIComponent(userId)}; HttpOnly; Path=/; SameSite=Lax`
  );
  return new Response(JSON.stringify({ userId }), { status: 200, headers });
}
