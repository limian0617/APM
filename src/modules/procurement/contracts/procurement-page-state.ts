export const PROCUREMENT_PAGE_VIEWS = [
  "overview",
  "requirements",
  "tracking",
  "arrivals",
  "readiness"
] as const;

export type ProcurementPageView = (typeof PROCUREMENT_PAGE_VIEWS)[number];

export const PROCUREMENT_FIXTURES = [
  "normal",
  "loading",
  "empty",
  "error",
  "denied",
  "stale",
  "pending",
  "failed",
  "partial-denied"
] as const;

export type ProcurementFixture = (typeof PROCUREMENT_FIXTURES)[number];

type ProcurementBody = Readonly<Record<string, unknown>>;

export type ProcurementFetchResult =
  | { kind: "ok"; body: ProcurementBody; fetchedAt?: string }
  | { kind: "error"; status: number; retryable: boolean; code?: string }
  | { kind: "loading" }
  | { kind: "pending" }
  | { kind: "failed"; retryable: boolean };

export type ProcurementOptionalArea =
  | { status: "loading" }
  | { status: "ready"; data: ProcurementBody }
  | { status: "restricted" }
  | { status: "error"; retryable: boolean };

type ProcurementBaseState = { projectId: string };

export type ProcurementPageState =
  | (ProcurementBaseState & { status: "loading" })
  | (ProcurementBaseState & { status: "pending" })
  | (ProcurementBaseState & { status: "failed"; retryable: boolean })
  | (ProcurementBaseState & { status: "denied" })
  | (ProcurementBaseState & { status: "not-available" })
  | (ProcurementBaseState & { status: "empty"; timestamps: ProcurementTimestamps })
  | (ProcurementBaseState & {
      status: "error";
      retryable: boolean;
    })
  | (ProcurementBaseState & {
      status: "ready";
      overview: ProcurementBody;
      readiness: ProcurementBody;
      suppliers?: ProcurementOptionalArea;
      timestamps: ProcurementTimestamps;
    })
  | (ProcurementBaseState & {
      status: "stale";
      overview: ProcurementBody;
      readiness: ProcurementBody;
      suppliers?: ProcurementOptionalArea;
      timestamps: ProcurementTimestamps;
    })
  | (ProcurementBaseState & {
      status: "partial-denied";
      overview: ProcurementBody;
      readiness: ProcurementBody;
      suppliers: { status: "restricted" };
      timestamps: ProcurementTimestamps;
    });

export type ProcurementDataState = Extract<
  ProcurementPageState,
  { status: "ready" | "stale" | "partial-denied" }
>;

export type ProcurementTimestamps = Readonly<{
  overview: string | null;
  readiness: string | null;
}>;

export function resolveProcurementFixture(
  value: string | null | undefined,
  environment = process.env.NODE_ENV
): ProcurementFixture | null {
  if (environment !== "development") return null;
  return isProcurementFixture(value) ? value : null;
}

export function isProcurementPageView(
  value: string | null | undefined
): value is ProcurementPageView {
  return typeof value === "string" && (PROCUREMENT_PAGE_VIEWS as readonly string[]).includes(value);
}

export function selectedProcurementView(value: string | null | undefined): ProcurementPageView {
  return isProcurementPageView(value) ? value : "overview";
}

export function procurementPageHref(
  projectId: string,
  view: ProcurementPageView,
  fixture?: string | null,
  scopeId?: string
): string {
  const params = new URLSearchParams({ view });
  if (scopeId && isSafeIdentifier(scopeId)) params.set("scopeId", scopeId);
  const allowedFixture = resolveProcurementFixture(fixture);
  if (allowedFixture) params.set("fixture", allowedFixture);
  return `/projects/${encodeURIComponent(projectId)}/procurement?${params.toString()}`;
}

export function toProcurementFetchResult(input: {
  status: number | "loading" | "pending" | "failed";
  body?: unknown;
  fetchedAt?: string;
}): ProcurementFetchResult {
  if (input.status === "loading") return { kind: "loading" };
  if (input.status === "pending") return { kind: "pending" };
  if (input.status === "failed") return { kind: "failed", retryable: true };
  if (input.status >= 200 && input.status < 300) {
    return {
      kind: "ok",
      body: isRecord(input.body) ? input.body : {},
      ...(input.fetchedAt ? { fetchedAt: input.fetchedAt } : {})
    };
  }
  return {
    kind: "error",
    status: input.status,
    retryable:
      input.status === 408 ||
      input.status === 409 ||
      input.status === 425 ||
      input.status === 429 ||
      input.status >= 500,
    ...(isRecord(input.body) && typeof input.body.code === "string"
      ? { code: input.body.code }
      : {})
  };
}

export function buildProcurementPageState(input: {
  projectId: string;
  overview?: ProcurementFetchResult;
  readiness?: ProcurementFetchResult;
  suppliers?: ProcurementFetchResult;
}): ProcurementPageState {
  const overview = input.overview;
  const readiness = input.readiness;
  if (!overview || !readiness) return { projectId: input.projectId, status: "loading" };

  const primary = [overview, readiness];
  if (primary.some((result) => result.kind === "loading")) {
    return { projectId: input.projectId, status: "loading" };
  }
  if (primary.some((result) => result.kind === "pending")) {
    return { projectId: input.projectId, status: "pending" };
  }
  const failed = primary.find((result) => result.kind === "failed");
  if (failed?.kind === "failed") {
    return { projectId: input.projectId, status: "failed", retryable: failed.retryable };
  }
  const denied = primary.find(
    (result): result is Extract<ProcurementFetchResult, { kind: "error" }> =>
      result.kind === "error" && (result.status === 401 || result.status === 403)
  );
  if (denied) return { projectId: input.projectId, status: "denied" };
  const primaryError = primary.find((result) => result.kind === "error");
  if (primaryError?.kind === "error") {
    return { projectId: input.projectId, status: "error", retryable: primaryError.retryable };
  }

  const overviewBody = overview.kind === "ok" ? overview.body : {};
  const readinessBody = readiness.kind === "ok" ? readiness.body : {};
  if (isNotAvailable(overviewBody) || isNotAvailable(readinessBody)) {
    return { projectId: input.projectId, status: "not-available" };
  }
  if (overviewBody.status === "PENDING" || readinessBody.status === "PENDING") {
    return { projectId: input.projectId, status: "pending" };
  }
  if (overviewBody.status === "FAILED" || readinessBody.status === "FAILED") {
    return { projectId: input.projectId, status: "failed", retryable: false };
  }
  const timestamps = {
    overview: timestampFrom(overviewBody),
    readiness: timestampFrom(readinessBody)
  } satisfies ProcurementTimestamps;
  const supplierArea = toOptionalArea(input.suppliers);
  if (supplierArea?.status === "restricted") {
    return {
      projectId: input.projectId,
      status: "partial-denied",
      overview: overviewBody,
      readiness: readinessBody,
      suppliers: supplierArea,
      timestamps
    };
  }
  if (
    overviewBody.status === "EMPTY" ||
    readinessBody.status === "EMPTY" ||
    (isEmptyBody(overviewBody) && isEmptyBody(readinessBody))
  ) {
    return { projectId: input.projectId, status: "empty", timestamps };
  }
  const stale =
    readinessBody.status === "STALE" ||
    readinessBody.stale === true ||
    overviewBody.status === "STALE" ||
    overviewBody.stale === true;
  return {
    projectId: input.projectId,
    status: stale ? "stale" : "ready",
    overview: overviewBody,
    readiness: readinessBody,
    ...(supplierArea ? { suppliers: supplierArea } : {}),
    timestamps
  };
}

export function safeProcurementDrilldown(
  projectId: string,
  target: { view: ProcurementPageView; scopeId?: string; projectId?: string } | { href: string }
): string | null {
  if (!isSafeIdentifier(projectId)) return null;
  if ("href" in target) {
    const prefix = `/projects/${encodeURIComponent(projectId)}/procurement`;
    if (target.href !== prefix && !target.href.startsWith(`${prefix}?`)) return null;
    try {
      const parsed = new URL(target.href, "http://apm.local");
      if (parsed.origin !== "http://apm.local" || parsed.pathname !== prefix) return null;
      const view = parsed.searchParams.get("view");
      if (!isProcurementPageView(view)) return null;
      const scopeId = parsed.searchParams.get("scopeId");
      if (scopeId !== null && !isSafeIdentifier(scopeId)) return null;
    } catch {
      return null;
    }
    return target.href;
  }
  if (target.projectId !== undefined && target.projectId !== projectId) return null;
  if (target.scopeId !== undefined && !isSafeIdentifier(target.scopeId)) return null;
  const params = new URLSearchParams({ view: target.view });
  if (target.scopeId) params.set("scopeId", target.scopeId);
  return `/projects/${encodeURIComponent(projectId)}/procurement?${params.toString()}`;
}

function toOptionalArea(
  result: ProcurementFetchResult | undefined
): ProcurementOptionalArea | undefined {
  if (!result) return undefined;
  if (result.kind === "loading") return { status: "loading" };
  if (result.kind === "error" && (result.status === 401 || result.status === 403)) {
    return { status: "restricted" };
  }
  if (result.kind === "error") return { status: "error", retryable: result.retryable };
  if (result.kind !== "ok") return { status: "loading" };
  return { status: "ready", data: result.body };
}

function isProcurementFixture(value: string | null | undefined): value is ProcurementFixture {
  return typeof value === "string" && (PROCUREMENT_FIXTURES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotAvailable(body: ProcurementBody) {
  return body.status === "NOT_AVAILABLE" || body.status === "not-available";
}

function isEmptyBody(body: ProcurementBody) {
  return Object.keys(body).length === 0 || ("readiness" in body && body.readiness === null);
}

function timestampFrom(body: ProcurementBody): string | null {
  const timestamp = body.sourceSyncedAt ?? body.updatedAt ?? body.calculatedAt;
  return typeof timestamp === "string" ? timestamp : null;
}

function isSafeIdentifier(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/u.test(value);
}
