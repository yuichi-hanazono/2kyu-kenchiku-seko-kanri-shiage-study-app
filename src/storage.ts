import {
  EMPTY_PROGRESS,
  EMPTY_STATE,
  type QuestionProgress,
  type QuizResult,
  type Rating,
  type StudyState,
} from './types';
import { validateQuestionBank, type QuestionBank } from './questionBank';
import { createUuid } from './uuid';
import { deduplicateStudyEvents, localDataSignature, localSyncSignature, validateStudyEvent, type StudyEvent } from './syncDomain';

const DATABASE_NAME = 'building-management-study-app';
const DATABASE_VERSION = 1;
const STORE_NAME = 'app-state';
const STATE_KEY = 'study-progress';
const QUESTION_BANK_KEY = 'private-question-bank';
const OUTBOX_KEY = 'study-event-outbox';
const SYNC_METADATA_KEY = 'cloud-sync-metadata';
const DEVICE_ID_KEY = 'sync-device-id';

export type LocalSyncMetadata = {
  schemaVersion: 1;
  userId: string;
  bankId: string;
  bankHash: string;
  knownEventIds: string[];
};

export function validateLocalSyncMetadata(value: unknown): LocalSyncMetadata {
  if (
    !isObjectRecord(value) || value.schemaVersion !== 1 || typeof value.userId !== 'string' || value.userId.length < 1
    || typeof value.bankId !== 'string' || !/^bank-[\da-f]{64}$/iu.test(value.bankId)
    || typeof value.bankHash !== 'string' || !/^[\da-f]{64}$/iu.test(value.bankHash)
    || value.bankId !== `bank-${value.bankHash.toLowerCase()}`
    || !Array.isArray(value.knownEventIds) || !value.knownEventIds.every((id) => typeof id === 'string')
  ) {
    throw new Error('端末の同期情報を読み取れません。既存データは変更していません。');
  }
  return value as LocalSyncMetadata;
}

export type LocalSyncSnapshot = {
  bank: QuestionBank | null;
  state: StudyState;
  outbox: StudyEvent[];
  signature: string;
  syncSignature: string;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('このブラウザーではIndexedDBを利用できません。'));
      return;
    }

    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('保存領域を開けませんでした。'));
    request.onblocked = () => reject(new Error('別のタブが保存領域を使用中です。タブを閉じて再読み込みしてください。'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error('保存データを読み書きできませんでした。'));
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error('保存処理に失敗しました。'));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error('保存処理が中断されました。'));
    };
    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };
  });
}

function isRating(value: unknown): value is Rating {
  return value === 'good' || value === 'unsure' || value === 'weak';
}

function isQuizResult(value: unknown): value is QuizResult {
  return value === 'correct' || value === 'incorrect';
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function normalizeProgress(value: unknown, version: 1 | 2): QuestionProgress | null {
  if (!isObjectRecord(value)) return null;
  const candidate = value;
  if (version === 1) {
    return {
      ...EMPTY_PROGRESS,
      lastStudiedOn: isDateKey(candidate.lastStudiedOn) ? candidate.lastStudiedOn : null,
      rating: isRating(candidate.rating) ? candidate.rating : null,
      isDifficult: typeof candidate.isDifficult === 'boolean' ? candidate.isDifficult : false,
      // v1 did not distinguish initial learning from tests; preserve its count without reclassifying it.
      legacyAttempts: normalizeCount(candidate.attempts),
    };
  }
  return {
    firstStudyCount: normalizeCount(candidate.firstStudyCount),
    firstStudyCompletedAt: typeof candidate.firstStudyCompletedAt === 'string' && Number.isFinite(Date.parse(candidate.firstStudyCompletedAt)) ? candidate.firstStudyCompletedAt : null,
    memoryTestCount: normalizeCount(candidate.memoryTestCount),
    quizTestCount: normalizeCount(candidate.quizTestCount),
    writtenTestCount: normalizeCount(candidate.writtenTestCount),
    quizCorrectCount: normalizeCount(candidate.quizCorrectCount),
    quizIncorrectCount: normalizeCount(candidate.quizIncorrectCount),
    quizCorrectStreak: normalizeCount(candidate.quizCorrectStreak),
    lastQuizResult: isQuizResult(candidate.lastQuizResult) ? candidate.lastQuizResult : null,
    nextReviewOn: isDateKey(candidate.nextReviewOn) ? candidate.nextReviewOn : null,
    lastStudiedOn: isDateKey(candidate.lastStudiedOn) ? candidate.lastStudiedOn : null,
    rating: isRating(candidate.rating) ? candidate.rating : null,
    isDifficult: typeof candidate.isDifficult === 'boolean' ? candidate.isDifficult : false,
    legacyAttempts: normalizeCount(candidate.legacyAttempts),
  };
}

export function normalizeState(value: unknown, questionIds: Set<string>, preserveUnmatchedRecords = false): StudyState {
  if (!isObjectRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || !isObjectRecord(value.records)) {
    return EMPTY_STATE;
  }

  const version = value.schemaVersion;
  const sourceRecords = value.records;
  const records = Object.create(null) as StudyState['records'];
  const idsToNormalize = preserveUnmatchedRecords
    ? new Set([...questionIds, ...Object.keys(sourceRecords)])
    : questionIds;
  for (const questionId of idsToNormalize) {
    const normalized = normalizeProgress(sourceRecords[questionId], version);
    if (normalized) records[questionId] = normalized;
  }
  return { schemaVersion: 2, records };
}

export async function loadStudyState(questionIds: Set<string>): Promise<StudyState> {
  const saved = await withStore('readonly', (store) => store.get(STATE_KEY));
  if (saved === undefined) return EMPTY_STATE;
  if (!isObjectRecord(saved) || (saved.schemaVersion !== 1 && saved.schemaVersion !== 2) || !isObjectRecord(saved.records)) {
    throw new Error('保存データ形式を認識できません。既存データは変更していません。');
  }
  return normalizeState(saved, questionIds, true);
}

export async function saveStudyState(state: StudyState): Promise<void> {
  await withStore('readwrite', (store) => store.put(state, STATE_KEY));
}

export function makeDeviceBackup(
  state: StudyState,
  bank: QuestionBank | null,
  outbox: readonly StudyEvent[] = [],
  syncMetadata: LocalSyncMetadata | null = null,
): string {
  return JSON.stringify({
    app: 'building-management-study-app',
    schemaVersion: 2,
    backupType: 'device-sync-backup-v1',
    exportedAt: new Date().toISOString(),
    progress: state,
    questionBank: bank,
    outbox: deduplicateStudyEvents(outbox),
    syncMetadata,
  }, null, 2);
}

export async function restoreLocalStudyData(
  state: StudyState,
  bank?: QuestionBank | null,
  outbox: readonly StudyEvent[] = [],
  syncMetadata: LocalSyncMetadata | null = null,
): Promise<void> {
  const checkedOutbox = deduplicateStudyEvents(outbox);
  const checkedSyncMetadata = syncMetadata === null ? null : validateLocalSyncMetadata(syncMetadata);
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    store.put(state, STATE_KEY);
    if (bank !== undefined) {
      if (bank) store.put(bank, QUESTION_BANK_KEY);
      else store.delete(QUESTION_BANK_KEY);
    }
    // A normal JSON restore starts a new local lineage. A device backup may carry
    // its pending events and link so they can be retried without double counting.
    store.put(checkedOutbox, OUTBOX_KEY);
    if (checkedSyncMetadata) store.put(checkedSyncMetadata, SYNC_METADATA_KEY);
    else store.delete(SYNC_METADATA_KEY);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error('バックアップからの復元に失敗しました。'));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error('バックアップからの復元を中断しました。'));
    };
  });
}

export async function loadQuestionBank(): Promise<QuestionBank | null> {
  const saved: unknown = await withStore('readonly', (store) => store.get(QUESTION_BANK_KEY));
  return saved === undefined ? null : validateQuestionBank(saved);
}

export async function saveQuestionBank(value: unknown): Promise<QuestionBank> {
  const bank = validateQuestionBank(value);
  await withStore('readwrite', (store) => store.put(bank, QUESTION_BANK_KEY));
  return bank;
}

export async function loadStudyEventOutbox(): Promise<StudyEvent[]> {
  const saved: unknown = await withStore('readonly', (store) => store.get(OUTBOX_KEY));
  if (saved === undefined) return [];
  if (!Array.isArray(saved)) throw new Error('未同期イベントの保存形式が不正です。既存データは変更していません。');
  return deduplicateStudyEvents(saved.map(validateStudyEvent));
}

export async function loadLocalSyncSnapshot(): Promise<LocalSyncSnapshot> {
  const database = await openDatabase();
  const values = await new Promise<{ bank: unknown; state: unknown; outbox: unknown }>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    let bank: unknown;
    let state: unknown;
    let outbox: unknown;
    const requests = [store.get(QUESTION_BANK_KEY), store.get(STATE_KEY), store.get(OUTBOX_KEY)];
    requests[0].onsuccess = () => { bank = requests[0].result; };
    requests[1].onsuccess = () => { state = requests[1].result; };
    requests[2].onsuccess = () => { outbox = requests[2].result; };
    for (const request of requests) {
      request.onerror = () => {
        transaction.abort();
        reject(request.error ?? new Error('端末データを読み込めませんでした。'));
      };
    }
    transaction.oncomplete = () => {
      database.close();
      resolve({ bank, state, outbox });
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error('端末データを読み込めませんでした。'));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error('端末データの読み込みを中断しました。'));
    };
  });

  const bank = values.bank === undefined ? null : validateQuestionBank(values.bank);
  if (
    values.state !== undefined
    && (!isObjectRecord(values.state) || (values.state.schemaVersion !== 1 && values.state.schemaVersion !== 2) || !isObjectRecord(values.state.records))
  ) {
    throw new Error('保存データ形式を認識できません。既存データは変更していません。');
  }
  const state = values.state === undefined ? EMPTY_STATE : normalizeState(values.state, new Set(), true);
  if (values.outbox !== undefined && !Array.isArray(values.outbox)) throw new Error('未同期イベントの保存形式が不正です。');
  const outbox = values.outbox === undefined ? [] : deduplicateStudyEvents((values.outbox as unknown[]).map(validateStudyEvent));
  return {
    bank,
    state,
    outbox,
    signature: localDataSignature(bank, state),
    syncSignature: localSyncSignature(bank, state, outbox),
  };
}

export async function appendStudyEventAndState(event: StudyEvent, state: StudyState): Promise<void> {
  const checkedEvent = validateStudyEvent(event);
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(OUTBOX_KEY);
    request.onsuccess = () => {
      try {
        const saved: unknown = request.result;
        if (saved !== undefined && !Array.isArray(saved)) throw new Error('未同期イベントの保存形式が不正です。');
        const existingEvents = saved === undefined ? [] : (saved as unknown[]).map(validateStudyEvent);
        const outbox = deduplicateStudyEvents([...existingEvents, checkedEvent]);
        store.put(outbox, OUTBOX_KEY);
        store.put(state, STATE_KEY);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    };
    request.onerror = () => {
      transaction.abort();
      reject(request.error ?? new Error('未同期イベントを読み込めませんでした。'));
    };
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error('学習イベントを保存できませんでした。'));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error('学習イベントの保存を中断しました。'));
    };
  });
}

export async function acknowledgeStudyEvents(eventIds: readonly string[]): Promise<void> {
  if (eventIds.length === 0) return;
  const acknowledged = new Set(eventIds);
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(OUTBOX_KEY);
    request.onsuccess = () => {
      const saved: unknown = request.result;
      if (saved === undefined) return;
      if (!Array.isArray(saved)) {
        transaction.abort();
        reject(new Error('未同期イベントの保存形式が不正です。'));
        return;
      }
      try {
        const remaining = deduplicateStudyEvents(saved.map(validateStudyEvent)).filter((event) => !acknowledged.has(event.eventId));
        store.put(remaining, OUTBOX_KEY);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    };
    request.onerror = () => {
      transaction.abort();
      reject(request.error ?? new Error('未同期イベントを更新できませんでした。'));
    };
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error('未同期イベントを更新できませんでした。'));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error('未同期イベントの更新を中断しました。'));
    };
  });
}

export async function loadLocalSyncMetadata(): Promise<LocalSyncMetadata | null> {
  const saved: unknown = await withStore('readonly', (store) => store.get(SYNC_METADATA_KEY));
  if (saved === undefined) return null;
  return validateLocalSyncMetadata(saved);
}

export async function saveLocalSyncMetadata(metadata: LocalSyncMetadata): Promise<void> {
  await withStore('readwrite', (store) => store.put(metadata, SYNC_METADATA_KEY));
}

export async function getOrCreateDeviceId(): Promise<string> {
  const saved: unknown = await withStore('readonly', (store) => store.get(DEVICE_ID_KEY));
  if (typeof saved === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(saved)) return saved;
  const deviceId = createUuid();
  await withStore('readwrite', (store) => store.put(deviceId, DEVICE_ID_KEY));
  return deviceId;
}

export async function replaceLocalCloudData(
  bank: QuestionBank,
  state: StudyState,
  metadata: LocalSyncMetadata,
  expectedSyncSignature: string,
): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    let localBank: unknown;
    let localState: unknown;
    let localOutbox: unknown;
    let readCount = 0;
    let failure: unknown;
    const commitIfUnchanged = () => {
      readCount += 1;
      if (readCount !== 3) return;
      try {
        const checkedBank = localBank === undefined ? null : validateQuestionBank(localBank);
        if (
          localState !== undefined
          && (!isObjectRecord(localState) || (localState.schemaVersion !== 1 && localState.schemaVersion !== 2) || !isObjectRecord(localState.records))
        ) throw new Error('保存データ形式を認識できません。既存データは変更していません。');
        const checkedState = localState === undefined ? EMPTY_STATE : normalizeState(localState, new Set(), true);
        if (localOutbox !== undefined && !Array.isArray(localOutbox)) throw new Error('未同期イベントの保存形式が不正です。');
        const checkedOutbox = localOutbox === undefined
          ? []
          : deduplicateStudyEvents((localOutbox as unknown[]).map(validateStudyEvent));
        if (localSyncSignature(checkedBank, checkedState, checkedOutbox) !== expectedSyncSignature) {
          throw new Error('クラウドからの取得中に端末データが更新されました。現在データを守るため復元を中止しました。もう一度バックアップして実行してください。');
        }
        store.put(bank, QUESTION_BANK_KEY);
        store.put(state, STATE_KEY);
        store.put([], OUTBOX_KEY);
        store.put(metadata, SYNC_METADATA_KEY);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    const bankRequest = store.get(QUESTION_BANK_KEY);
    const stateRequest = store.get(STATE_KEY);
    const outboxRequest = store.get(OUTBOX_KEY);
    bankRequest.onsuccess = () => { localBank = bankRequest.result; commitIfUnchanged(); };
    stateRequest.onsuccess = () => { localState = stateRequest.result; commitIfUnchanged(); };
    outboxRequest.onsuccess = () => { localOutbox = outboxRequest.result; commitIfUnchanged(); };
    for (const request of [bankRequest, stateRequest, outboxRequest]) {
      request.onerror = () => {
        failure = request.error ?? new Error('端末データを読み込めませんでした。');
        transaction.abort();
      };
    }
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error('クラウドデータの保存に失敗しました。'));
    };
    transaction.onabort = () => {
      database.close();
      reject(failure ?? transaction.error ?? new Error('クラウドデータの保存を中断しました。'));
    };
  });
}

export async function saveMigratedLocalLink(metadata: LocalSyncMetadata, baselineEventIds: readonly string[]): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const baseline = new Set(baselineEventIds);
    const outboxRequest = store.get(OUTBOX_KEY);
    outboxRequest.onsuccess = () => {
      const saved: unknown = outboxRequest.result;
      if (saved !== undefined && !Array.isArray(saved)) {
        transaction.abort();
        reject(new Error('未同期イベントの保存形式が不正です。'));
        return;
      }
      try {
        const outbox = saved === undefined ? [] : deduplicateStudyEvents((saved as unknown[]).map(validateStudyEvent));
        store.put(outbox.filter((event) => !baseline.has(event.eventId)), OUTBOX_KEY);
        store.put(metadata, SYNC_METADATA_KEY);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    };
    outboxRequest.onerror = () => {
      transaction.abort();
      reject(outboxRequest.error ?? new Error('未同期イベントを読み込めませんでした。'));
    };
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error('同期情報を保存できませんでした。'));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error('同期情報の保存を中断しました。'));
    };
  });
}

export function progressFor(state: StudyState, questionId: string): QuestionProgress {
  return state.records[questionId] ?? EMPTY_PROGRESS;
}

export function makeBackup(state: StudyState): string {
  return JSON.stringify(
    {
      app: 'building-management-study-app',
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      progress: state,
    },
    null,
    2,
  );
}

export function readBackup(value: unknown, questionIds: Set<string>): StudyState {
  if (!isObjectRecord(value)) throw new Error('JSONの内容を読み取れません。');
  const backup = value;
  if (backup.app !== 'building-management-study-app' || (backup.schemaVersion !== 1 && backup.schemaVersion !== 2)) {
    throw new Error('このアプリのバックアップ形式ではありません。');
  }
  if (
    !isObjectRecord(backup.progress) ||
    !isObjectRecord(backup.progress.records) ||
    backup.progress.schemaVersion !== backup.schemaVersion
  ) {
    throw new Error('バックアップ内に有効な学習データがありません。');
  }
  const state = normalizeState(backup.progress, questionIds);
  return state;
}
