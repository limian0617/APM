export const OFFLINE_DRAFT_LOCAL_STATUSES = [
  "LOCAL_ONLY",
  "PENDING_SYNC",
  "SYNC_FAILED",
  "SYNCED"
] as const;

export type OfflineDraftLocalStatus = (typeof OFFLINE_DRAFT_LOCAL_STATUSES)[number];
export type OfflineDraftServerStatus = "PENDING_REVIEW" | "CONFLICT" | "ACCEPTED" | "REJECTED";

export type OfflineSatDraftRecord = Readonly<{
  clientDraftId: string;
  projectId: string;
  batchId: string;
  itemId: string;
  baselineBatchVersion: number;
  baselineResultRevisionId: string | null;
  decision: "PASS" | "FAIL" | "NA";
  measuredValue: string | null;
  measuredUnit: string | null;
  note: string | null;
  capturedAt: string;
  localStatus: OfflineDraftLocalStatus;
  serverStatus: OfflineDraftServerStatus | null;
  submissionId: string | null;
  lastError: string | null;
  updatedAt: string;
}>;

const DATABASE_NAME = "apm-sat-offline-drafts";
const DATABASE_VERSION = 1;
const STORE_NAME = "drafts";

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

export function offlineDraftDisplayState(input: {
  localStatus: OfflineDraftLocalStatus;
  serverStatus: OfflineDraftServerStatus | null;
}): string {
  if (input.localStatus === "LOCAL_ONLY") return "仅本地";
  if (input.localStatus === "PENDING_SYNC") return "待同步";
  if (input.localStatus === "SYNC_FAILED") return "同步失败，可重试";
  if (input.serverStatus === "PENDING_REVIEW") return "待复核";
  if (input.serverStatus === "CONFLICT") return "冲突，保留双方值";
  if (input.serverStatus === "ACCEPTED") return "已接受";
  if (input.serverStatus === "REJECTED") return "已拒绝";
  return "已同步";
}

function openDatabase(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) return Promise.reject(new Error("当前浏览器不支持 IndexedDB。"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("无法打开离线草稿存储。"));
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: "clientDraftId" });
      if (!store.indexNames.contains("projectBatch")) {
        store.createIndex("projectBatch", ["projectId", "batchId"], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function runStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    request.onerror = () => reject(request.error ?? new Error("离线草稿存储操作失败。"));
    request.onsuccess = () => resolve(request.result);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("离线草稿存储事务失败。"));
    };
  });
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空。`);
  return normalized;
}

export function createOfflineSatDraftRecord(
  input: Omit<
    OfflineSatDraftRecord,
    "localStatus" | "serverStatus" | "submissionId" | "lastError" | "updatedAt"
  >
): OfflineSatDraftRecord {
  requiredText(input.clientDraftId, "clientDraftId");
  requiredText(input.projectId, "projectId");
  requiredText(input.batchId, "batchId");
  requiredText(input.itemId, "itemId");
  if (!Number.isSafeInteger(input.baselineBatchVersion) || input.baselineBatchVersion < 1) {
    throw new Error("baselineBatchVersion 无效。");
  }
  if (!Number.isFinite(Date.parse(input.capturedAt))) throw new Error("capturedAt 无效。");
  return {
    ...input,
    localStatus: "LOCAL_ONLY",
    serverStatus: null,
    submissionId: null,
    lastError: null,
    updatedAt: new Date().toISOString()
  };
}

export async function saveOfflineSatDraft(
  record: OfflineSatDraftRecord
): Promise<OfflineSatDraftRecord> {
  const next = { ...record, updatedAt: new Date().toISOString() };
  await runStore("readwrite", (store) => store.put(next));
  return next;
}

export async function getOfflineSatDraft(
  clientDraftId: string
): Promise<OfflineSatDraftRecord | null> {
  const result = await runStore<OfflineSatDraftRecord | undefined>("readonly", (store) =>
    store.get(requiredText(clientDraftId, "clientDraftId"))
  );
  return result ?? null;
}

export async function listOfflineSatDrafts(
  projectId: string,
  batchId: string
): Promise<OfflineSatDraftRecord[]> {
  const records = await runStore<OfflineSatDraftRecord[]>("readonly", (store) =>
    store
      .index("projectBatch")
      .getAll([requiredText(projectId, "projectId"), requiredText(batchId, "batchId")])
  );
  return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function markOfflineSatDraftForSync(
  clientDraftId: string
): Promise<OfflineSatDraftRecord> {
  const current = await getOfflineSatDraft(clientDraftId);
  if (!current) throw new Error("离线草稿不存在。");
  return saveOfflineSatDraft({ ...current, localStatus: "PENDING_SYNC", lastError: null });
}

export async function markOfflineSatDraftSyncResult(input: {
  clientDraftId: string;
  submissionId: string;
  serverStatus: OfflineDraftServerStatus;
}): Promise<OfflineSatDraftRecord> {
  const current = await getOfflineSatDraft(input.clientDraftId);
  if (!current) throw new Error("离线草稿不存在。");
  return saveOfflineSatDraft({
    ...current,
    localStatus: "SYNCED",
    serverStatus: input.serverStatus,
    submissionId: requiredText(input.submissionId, "submissionId"),
    lastError: null
  });
}

export async function markOfflineSatDraftSyncFailed(
  clientDraftId: string,
  message: string
): Promise<OfflineSatDraftRecord> {
  const current = await getOfflineSatDraft(clientDraftId);
  if (!current) throw new Error("离线草稿不存在。");
  return saveOfflineSatDraft({
    ...current,
    localStatus: "SYNC_FAILED",
    lastError: message.trim() || "同步失败，请恢复联网后重试。"
  });
}
