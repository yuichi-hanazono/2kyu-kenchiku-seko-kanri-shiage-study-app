import { EMPTY_PROGRESS, type QuestionProgress, type QuizResult, type Rating, type StudyState } from './types';
import type { QuestionBank } from './questionBank';
import { createUuid } from './uuid';

type StudyEventBase = {
  schemaVersion: 1;
  eventId: string;
  deviceId: string;
  questionId: string;
  occurredAt: string;
};

export type StudyEvent = StudyEventBase & (
  | { kind: 'first_study'; studiedOn: string; completedAt: string }
  | { kind: 'written_test'; studiedOn: string }
  | { kind: 'memory_rating'; studiedOn: string; countTest: boolean; rating: Rating; nextReviewOn: string }
  | { kind: 'rating'; studiedOn: string; rating: Rating; nextReviewOn: string }
  | { kind: 'quiz_answer'; studiedOn: string; correct: boolean; rating: Rating; nextReviewOn: string }
  | { kind: 'difficulty_set'; isDifficult: boolean }
);

export type NewStudyEvent =
  | { kind: 'first_study'; questionId: string; studiedOn: string; completedAt: string }
  | { kind: 'written_test'; questionId: string; studiedOn: string }
  | { kind: 'memory_rating'; questionId: string; studiedOn: string; countTest: boolean; rating: Rating; nextReviewOn: string }
  | { kind: 'rating'; questionId: string; studiedOn: string; rating: Rating; nextReviewOn: string }
  | { kind: 'quiz_answer'; questionId: string; studiedOn: string; correct: boolean; rating: Rating; nextReviewOn: string }
  | { kind: 'difficulty_set'; questionId: string; isDifficult: boolean };

export type EventConflict = { questionId: string; field: 'rating' | 'isDifficult' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(value);
}

function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
  return date.getUTCFullYear() === Number(yearText)
    && date.getUTCMonth() === Number(monthText) - 1
    && date.getUTCDate() === Number(dayText);
}

function isIsoDateTime(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function isRating(value: unknown): value is Rating {
  return value === 'good' || value === 'unsure' || value === 'weak';
}

function assertKeys(value: Record<string, unknown>, allowed: string[], required: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !(key in value))) {
    throw new Error('学習イベントに未知または不足している項目があります。');
  }
}

export function validateStudyEvent(value: unknown): StudyEvent {
  if (!isRecord(value)) throw new Error('学習イベントの形式が不正です。');
  if (
    value.schemaVersion !== 1 || !isUuid(value.eventId) || !isUuid(value.deviceId)
    || typeof value.questionId !== 'string' || value.questionId.length < 1 || value.questionId.length > 200
    || !isIsoDateTime(value.occurredAt)
  ) {
    throw new Error('学習イベントの共通項目が不正です。');
  }

  const baseKeys = ['schemaVersion', 'eventId', 'deviceId', 'questionId', 'occurredAt'];
  switch (value.kind) {
    case 'first_study':
      assertKeys(value, [...baseKeys, 'kind', 'studiedOn', 'completedAt'], [...baseKeys, 'kind', 'studiedOn', 'completedAt']);
      if (!isDateKey(value.studiedOn) || !isIsoDateTime(value.completedAt)) throw new Error('初回学習イベントの日付が不正です。');
      break;
    case 'written_test':
      assertKeys(value, [...baseKeys, 'kind', 'studiedOn'], [...baseKeys, 'kind', 'studiedOn']);
      if (!isDateKey(value.studiedOn)) throw new Error('記述テストイベントの日付が不正です。');
      break;
    case 'memory_rating':
      assertKeys(value, [...baseKeys, 'kind', 'studiedOn', 'countTest', 'rating', 'nextReviewOn'], [...baseKeys, 'kind', 'studiedOn', 'countTest', 'rating', 'nextReviewOn']);
      if (!isDateKey(value.studiedOn) || typeof value.countTest !== 'boolean' || !isRating(value.rating) || !isDateKey(value.nextReviewOn)) {
        throw new Error('暗記確認イベントの値が不正です。');
      }
      break;
    case 'rating':
      assertKeys(value, [...baseKeys, 'kind', 'studiedOn', 'rating', 'nextReviewOn'], [...baseKeys, 'kind', 'studiedOn', 'rating', 'nextReviewOn']);
      if (!isDateKey(value.studiedOn) || !isRating(value.rating) || !isDateKey(value.nextReviewOn)) throw new Error('評価イベントの値が不正です。');
      break;
    case 'quiz_answer':
      assertKeys(value, [...baseKeys, 'kind', 'studiedOn', 'correct', 'rating', 'nextReviewOn'], [...baseKeys, 'kind', 'studiedOn', 'correct', 'rating', 'nextReviewOn']);
      if (!isDateKey(value.studiedOn) || typeof value.correct !== 'boolean' || !isRating(value.rating) || !isDateKey(value.nextReviewOn)) {
        throw new Error('4択回答イベントの値が不正です。');
      }
      break;
    case 'difficulty_set':
      assertKeys(value, [...baseKeys, 'kind', 'isDifficult'], [...baseKeys, 'kind', 'isDifficult']);
      if (typeof value.isDifficult !== 'boolean') throw new Error('苦手設定イベントの値が不正です。');
      break;
    default:
      throw new Error('未対応の学習イベントです。');
  }

  return value as StudyEvent;
}

export function createStudyEvent(deviceId: string, payload: NewStudyEvent, now = new Date()): StudyEvent {
  if (!isUuid(deviceId)) throw new Error('端末IDを取得できません。');
  return validateStudyEvent({
    schemaVersion: 1,
    eventId: createUuid(),
    deviceId,
    occurredAt: now.toISOString(),
    ...payload,
  });
}

export function serializeStudyEvent(event: StudyEvent): string {
  const checked = validateStudyEvent(event);
  const common = {
    schemaVersion: checked.schemaVersion,
    eventId: checked.eventId,
    deviceId: checked.deviceId,
    questionId: checked.questionId,
    occurredAt: checked.occurredAt,
    kind: checked.kind,
  };
  switch (checked.kind) {
    case 'first_study':
      return JSON.stringify({ ...common, studiedOn: checked.studiedOn, completedAt: checked.completedAt });
    case 'written_test':
      return JSON.stringify({ ...common, studiedOn: checked.studiedOn });
    case 'memory_rating':
      return JSON.stringify({
        ...common, studiedOn: checked.studiedOn, countTest: checked.countTest,
        rating: checked.rating, nextReviewOn: checked.nextReviewOn,
      });
    case 'rating':
      return JSON.stringify({
        ...common, studiedOn: checked.studiedOn, rating: checked.rating, nextReviewOn: checked.nextReviewOn,
      });
    case 'quiz_answer':
      return JSON.stringify({
        ...common, studiedOn: checked.studiedOn, correct: checked.correct,
        rating: checked.rating, nextReviewOn: checked.nextReviewOn,
      });
    case 'difficulty_set':
      return JSON.stringify({ ...common, isDifficult: checked.isDifficult });
  }
}

export function deduplicateStudyEvents(events: readonly StudyEvent[]): StudyEvent[] {
  const byId = new Map<string, StudyEvent>();
  for (const candidate of events) {
    const event = validateStudyEvent(candidate);
    const previous = byId.get(event.eventId);
    if (previous && serializeStudyEvent(previous) !== serializeStudyEvent(event)) {
      throw new Error(`学習イベントIDが別の内容と重複しています: ${event.eventId}`);
    }
    byId.set(event.eventId, event);
  }
  return [...byId.values()].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId));
}

function applyRating(progress: QuestionProgress, rating: Rating, nextReviewOn: string): QuestionProgress {
  return {
    ...progress,
    rating,
    nextReviewOn,
    isDifficult: rating === 'weak' ? true : progress.isDifficult,
  };
}

export function applyStudyEvent(state: StudyState, candidate: StudyEvent): StudyState {
  const event = validateStudyEvent(candidate);
  const previous = state.records[event.questionId] ?? EMPTY_PROGRESS;
  let next: QuestionProgress;

  switch (event.kind) {
    case 'first_study':
      next = {
        ...previous,
        firstStudyCount: previous.firstStudyCount + 1,
        firstStudyCompletedAt: previous.firstStudyCompletedAt ?? event.completedAt,
        lastStudiedOn: event.studiedOn,
      };
      break;
    case 'written_test':
      next = { ...previous, writtenTestCount: previous.writtenTestCount + 1, lastStudiedOn: event.studiedOn };
      break;
    case 'memory_rating':
      next = applyRating({
        ...previous,
        memoryTestCount: previous.memoryTestCount + (event.countTest ? 1 : 0),
        lastStudiedOn: event.studiedOn,
      }, event.rating, event.nextReviewOn);
      break;
    case 'rating':
      next = applyRating({ ...previous, lastStudiedOn: event.studiedOn }, event.rating, event.nextReviewOn);
      break;
    case 'quiz_answer': {
      const result: QuizResult = event.correct ? 'correct' : 'incorrect';
      next = applyRating({
        ...previous,
        quizTestCount: previous.quizTestCount + 1,
        quizCorrectCount: previous.quizCorrectCount + (event.correct ? 1 : 0),
        quizIncorrectCount: previous.quizIncorrectCount + (event.correct ? 0 : 1),
        quizCorrectStreak: event.correct ? previous.quizCorrectStreak + 1 : 0,
        lastQuizResult: result,
        lastStudiedOn: event.studiedOn,
      }, event.rating, event.nextReviewOn);
      break;
    }
    case 'difficulty_set':
      next = { ...previous, isDifficult: event.isDifficult };
      break;
  }

  return { ...state, records: { ...state.records, [event.questionId]: next } };
}

export function applyStudyEvents(baseState: StudyState, events: readonly StudyEvent[]): StudyState {
  return deduplicateStudyEvents(events).reduce(applyStudyEvent, baseState);
}

function changedSetting(event: StudyEvent): EventConflict['field'] | null {
  if (event.kind === 'difficulty_set') return 'isDifficult';
  if (event.kind === 'memory_rating' || event.kind === 'rating' || event.kind === 'quiz_answer') return 'rating';
  return null;
}

export function findConcurrentSettingConflicts(
  localPending: readonly StudyEvent[],
  newlyReceived: readonly StudyEvent[],
): EventConflict[] {
  const localSettings = new Set<string>();
  for (const event of localPending) {
    const field = changedSetting(event);
    if (field) localSettings.add(`${event.questionId}\u0000${field}\u0000${event.deviceId}`);
  }

  const conflicts = new Map<string, EventConflict>();
  for (const event of newlyReceived) {
    const field = changedSetting(event);
    if (!field) continue;
    const otherDeviceChangedSameField = [...localSettings].some((key) => {
      const [questionId, localField, deviceId] = key.split('\u0000');
      return questionId === event.questionId && localField === field && deviceId !== event.deviceId;
    });
    if (otherDeviceChangedSameField) conflicts.set(`${event.questionId}\u0000${field}`, { questionId: event.questionId, field });
  }
  return [...conflicts.values()];
}

export function bankIdForHash(hash: string): string {
  if (!/^[\da-f]{64}$/iu.test(hash)) throw new Error('問題バンクのSHA-256値が不正です。');
  return `bank-${hash.toLowerCase()}`;
}

export function localDataSignature(bank: QuestionBank | null, state: StudyState): string {
  return JSON.stringify({ bank, state });
}

export function localSyncSignature(bank: QuestionBank | null, state: StudyState, outbox: readonly StudyEvent[]): string {
  return JSON.stringify({ bank, state, outbox: deduplicateStudyEvents(outbox) });
}

export type LocalMigrationInput = {
  userId: string;
  linkedUserId: string | null;
  hasPrivateBank: boolean;
  backupIsCurrent: boolean;
  cloudAlreadyInitialized: boolean;
};

export type MigrationDecision = { allowed: true } | {
  allowed: false;
  reason: 'private_bank_required' | 'backup_required' | 'cloud_exists' | 'already_linked' | 'different_account';
};

export function decideLocalMigration(input: LocalMigrationInput): MigrationDecision {
  if (!input.hasPrivateBank) return { allowed: false, reason: 'private_bank_required' };
  if (!input.backupIsCurrent) return { allowed: false, reason: 'backup_required' };
  if (input.linkedUserId && input.linkedUserId !== input.userId) return { allowed: false, reason: 'different_account' };
  if (input.linkedUserId === input.userId) return { allowed: false, reason: 'already_linked' };
  if (input.cloudAlreadyInitialized) return { allowed: false, reason: 'cloud_exists' };
  return { allowed: true };
}

export type CloudImportInput = {
  userId: string;
  linkedUserId: string | null;
  cloudAvailable: boolean;
  backupIsCurrent: boolean;
  localBankId: string | null;
  cloudBankId: string;
  hasPendingEvents: boolean;
};

export type CloudImportDecision = { allowed: true; replacesDifferentBank: boolean; discardsPendingEvents: boolean } | {
  allowed: false;
  reason: 'cloud_missing' | 'backup_required' | 'already_linked';
};

export function decideCloudImport(input: CloudImportInput): CloudImportDecision {
  if (!input.cloudAvailable) return { allowed: false, reason: 'cloud_missing' };
  if (!input.backupIsCurrent) return { allowed: false, reason: 'backup_required' };
  if (input.linkedUserId === input.userId) return { allowed: false, reason: 'already_linked' };
  return {
    allowed: true,
    replacesDifferentBank: input.localBankId !== null && input.localBankId !== input.cloudBankId,
    discardsPendingEvents: input.hasPendingEvents,
  };
}

export function studyStateHasData(state: StudyState): boolean {
  return Object.keys(state.records).length > 0;
}
