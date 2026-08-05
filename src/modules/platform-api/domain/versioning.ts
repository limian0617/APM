export const INTERNAL_API_PREFIX = "/api";
export const EXTERNAL_API_V1_PREFIX = "/api/external/v1";

export type ApiBoundary = "internal" | "external-v1" | "outside-api";

export function classifyApiPath(pathname: string): ApiBoundary {
  if (pathname === EXTERNAL_API_V1_PREFIX || pathname.startsWith(`${EXTERNAL_API_V1_PREFIX}/`)) {
    return "external-v1";
  }
  if (pathname === INTERNAL_API_PREFIX || pathname.startsWith(`${INTERNAL_API_PREFIX}/`)) {
    return "internal";
  }
  return "outside-api";
}
