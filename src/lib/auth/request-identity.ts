import { timingSafeEqual } from "node:crypto";

export type RequestIdentityResult =
  | { authenticated: true; userId: string }
  | { authenticated: false; reason: "IDENTITY_MISSING" | "TRUST_SECRET_INVALID" };

type IdentityEnvironment = {
  NODE_ENV?: string;
  AUTH_TRUSTED_HEADER_SECRET?: string;
};

function secretsMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

export function readRequestIdentity(
  request: Request,
  environment: IdentityEnvironment = process.env
): RequestIdentityResult {
  const userId = request.headers.get("x-apm-user-id")?.trim();
  if (!userId) {
    return { authenticated: false, reason: "IDENTITY_MISSING" };
  }

  if (environment.NODE_ENV === "production") {
    const expectedSecret = environment.AUTH_TRUSTED_HEADER_SECRET;
    const suppliedSecret = request.headers.get("x-apm-auth-secret") ?? "";
    if (!expectedSecret || !secretsMatch(expectedSecret, suppliedSecret)) {
      return { authenticated: false, reason: "TRUST_SECRET_INVALID" };
    }
  }

  return { authenticated: true, userId };
}
