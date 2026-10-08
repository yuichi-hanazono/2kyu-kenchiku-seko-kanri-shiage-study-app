import {
  EMPTY_PROGRESS,
  EMPTY_STATE,
  type QuestionProgress,
  type QuizResult,
  type Rating,
  type StudyState,
} from './types';

const DATABASE_NAME = 'building-management-study-app';
const DATABASE_VERSION = 1;
const STORE_NAME = 'app-state';
const STATE_KEY = 'study-progress';

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

export function normalizeState(value: unknown, questionIds: Set<string>): StudyState {
  if (!isObjectRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || !isObjectRecord(value.records)) {
    return EMPTY_STATE;
  }

  const version = value.schemaVersion;
  const sourceRecords = value.records;
  const records: StudyState['records'] = {};
  for (const questionId of questionIds) {
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
  return normalizeState(saved, questionIds);
}

export async function saveStudyState(state: StudyState): Promise<void> {
  await withStore('readwrite', (store) => store.put(state, STATE_KEY));
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
